//! The Beacon side of stage b2 (PROTOCOL.md Part C): devices attach to their Beacon
//! over a client link; per room, Beacons keep one link to each other Beacon their
//! clients listed; a Beacon keeps frames for its offline clients and relays
//! invitation redemptions to the inviter's device. MLS stays on the devices: a
//! Beacon carries sealed frames and cannot read them.
//!
//! Routing: a frame from a client goes to the Beacon's other clients in the room
//! and to every linked Beacon of the room; a frame from a Beacon goes to local
//! clients only (nothing is forwarded twice, so there are no loops). Frames are
//! deduplicated by hash (bounded). Two links to the same Beacon: both keep the one
//! dialled by the smaller onion, as in the app mesh.
//!
//! The stream source is pluggable ([`Dialer`] out, [`Relay::serve`] in), so tests
//! run Beacons over duplex pipes or loopback TCP, and an app running its own Beacon
//! attaches in-process.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use anyhow::{anyhow, Result};
use ed25519_dalek::{Signer as _, SigningKey};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::{oneshot, Notify};
use tokio::task::JoinHandle;

use crate::link::{run_link, BoxRead, BoxWrite, Dialer, LinkCfg};
use crate::proto::{beacon_message, client_message, is_hex64, BeaconOp, ClientOp, LinkHello, CLIENT_COVER, SKEW_SECS};
use crate::queue::QueueStore;
use crate::{read_frame, redial_backoff, verify_device, write_frame_bounded, Ready, COVER, OUTBOX_CAP};

/// Frame hashes remembered per room for deduplication.
const SEEN_CAP: usize = 4096;
const SWEEP_EVERY: Duration = Duration::from_secs(600);

/// A Beacon's settings.
#[derive(Clone, Debug)]
pub struct RelayConfig {
    /// This Beacon's onion (what clients and Beacons dial, what hellos are bound to).
    pub onion: String,
    /// Frame cap, write timeout, cover interval.
    pub link: LinkCfg,
    /// A silent peer must not hang a handshake.
    pub handshake_timeout: Duration,
    /// Redial delay after `n` failed attempts.
    pub redial: fn(u32) -> Duration,
    /// Devices attached at once.
    pub max_clients: usize,
    /// Beacons one `join` may list.
    pub max_peers: usize,
}

impl RelayConfig {
    /// The defaults the mesh uses: 16 MiB frames, 20 s writes, 30 s handshakes and cover.
    #[must_use]
    pub fn new(onion: &str) -> Self {
        Self {
            onion: onion.to_string(),
            link: LinkCfg { max_frame: 16 * 1024 * 1024, write_timeout: Duration::from_secs(20), cover_every: 30 },
            handshake_timeout: Duration::from_secs(30),
            redial: redial_backoff,
            max_clients: 1024,
            max_peers: 64,
        }
    }
}

struct Session {
    id: u64,
    tx: UnboundedSender<String>,
    /// Rooms delivered live on this link.
    rooms: HashSet<String>,
    kill: Option<oneshot::Sender<()>>,
}

struct BLink {
    seq: u64,
    dialed_by: String,
    tx: UnboundedSender<String>,
    task: JoinHandle<()>,
}

#[derive(Default)]
struct Seen {
    set: HashSet<[u8; 32]>,
    order: VecDeque<[u8; 32]>,
}

impl Seen {
    /// `true` the first time.
    fn insert(&mut self, frame: &str) -> bool {
        let h = *blake3::hash(frame.trim_end().as_bytes()).as_bytes();
        if !self.set.insert(h) {
            return false;
        }
        self.order.push_back(h);
        if self.order.len() > SEEN_CAP {
            if let Some(o) = self.order.pop_front() {
                self.set.remove(&o);
            }
        }
        true
    }
}

struct RoomSt {
    /// Local member device → the Beacons it listed.
    members: HashMap<String, Vec<String>>,
    links: HashMap<String, BLink>,
    dialers: HashMap<String, JoinHandle<()>>,
    outbox: HashMap<String, VecDeque<String>>,
    seen: Seen,
    changed: Arc<Notify>,
}

impl RoomSt {
    fn new() -> Self {
        Self { members: HashMap::new(), links: HashMap::new(), dialers: HashMap::new(), outbox: HashMap::new(), seen: Seen::default(), changed: Arc::new(Notify::new()) }
    }
    fn wanted(&self) -> HashSet<String> {
        self.members.values().flatten().cloned().collect()
    }
    fn stop(&mut self) {
        for (_, t) in self.dialers.drain() {
            t.abort();
        }
        for (_, l) in self.links.drain() {
            l.task.abort();
        }
        self.outbox.clear();
        self.changed.notify_waiters();
    }
}

#[derive(Default)]
struct State {
    sessions: HashMap<String, Session>,
    rooms: HashMap<String, RoomSt>,
    /// Device → (first attached, last seen) this run, in Unix seconds.
    seen: HashMap<String, (u64, u64)>,
    events: VecDeque<RelayEvent>,
    next_event: u64,
}

/// Events kept for a management UI.
const EVENTS_CAP: usize = 500;

/// What happened on a relay, for an operator (counts and ids only, never content).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayEvent {
    /// Increasing per relay.
    pub seq: u64,
    /// Unix seconds.
    pub at: u64,
    pub kind: EventKind,
}

/// The kinds of [`RelayEvent`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventKind {
    ClientAttached { device: String },
    ClientDetached { device: String },
    /// A client hello refused: `why` is "bad signature" or "full".
    ClientRefused { why: String },
    LinkUp { room: String, peer: String },
    LinkDown { room: String, peer: String },
    /// A Beacon hello refused: "bad signature", "not listed" or "key changed".
    BeaconRefused { peer: String, why: String },
}

/// One device as the relay sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientStat {
    pub device: String,
    pub online: bool,
    /// Unix seconds; now for an attached device; 0 if not seen this run.
    pub last_seen: u64,
    pub rooms: usize,
    pub queued_frames: usize,
    pub queued_bytes: usize,
}

/// One room (route id) as the relay sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomStat {
    pub room: String,
    /// Local member devices (attached or not).
    pub members: usize,
    /// Local members attached now.
    pub online: usize,
    pub linked: Vec<String>,
    /// Beacons its members listed.
    pub wanted: usize,
    pub queued_frames: usize,
    pub queued_bytes: usize,
}

/// A snapshot of a relay.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelayStats {
    pub clients: Vec<ClientStat>,
    pub rooms: Vec<RoomStat>,
}

/// A running Beacon relay.
pub struct Relay {
    cfg: RelayConfig,
    key: SigningKey,
    node: String,
    dialer: Arc<dyn Dialer>,
    store: Arc<dyn QueueStore>,
    st: Mutex<State>,
    me: Weak<Relay>,
    sweeper: Mutex<Option<JoinHandle<()>>>,
    /// Set by [`Relay::stop`]: no new links after it.
    stopped: AtomicBool,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

/// Unix seconds.
#[must_use]
pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn op(o: &BeaconOp) -> String {
    serde_json::to_string(o).unwrap_or_default()
}

impl Relay {
    /// Starts a relay: brings back the memberships the store kept and dials their
    /// Beacons. Call inside a tokio runtime.
    pub fn start(cfg: RelayConfig, node_seed: &[u8; 32], dialer: Arc<dyn Dialer>, store: Arc<dyn QueueStore>) -> Arc<Self> {
        let key = SigningKey::from_bytes(node_seed);
        let node = hex::encode(key.verifying_key().to_bytes());
        let relay = Arc::new_cyclic(|me| Self { cfg, key, node, dialer, store, st: Mutex::new(State::default()), me: me.clone(), sweeper: Mutex::new(None), stopped: AtomicBool::new(false) });
        {
            let mut st = relay.lock();
            for (dev, room, peers) in relay.store.members() {
                st.rooms.entry(room).or_insert_with(RoomSt::new).members.insert(dev, peers);
            }
            let rooms: Vec<String> = st.rooms.keys().cloned().collect();
            for r in rooms {
                relay.sync_dialers(&mut st, &r);
            }
        }
        let weak = relay.me.clone();
        let sweeper = tokio::spawn(async move {
            loop {
                tokio::time::sleep(SWEEP_EVERY).await;
                let Some(r) = weak.upgrade() else { break };
                r.store.sweep(now_secs());
            }
        });
        *relay.sweeper.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(sweeper);
        relay
    }

    /// This Beacon's onion.
    #[must_use]
    pub fn onion(&self) -> &str {
        &self.cfg.onion
    }

    /// Its node key (64 hex).
    #[must_use]
    pub fn node_id(&self) -> &str {
        &self.node
    }

    /// Devices attached now.
    #[must_use]
    pub fn online(&self) -> Vec<String> {
        let mut v: Vec<String> = self.lock().sessions.keys().cloned().collect();
        v.sort();
        v
    }

    /// The Beacons linked for a room now.
    #[must_use]
    pub fn linked(&self, room: &str) -> Vec<String> {
        let st = self.lock();
        let mut v: Vec<String> = st.rooms.get(room).map(|r| r.links.keys().cloned().collect()).unwrap_or_default();
        v.sort();
        v
    }

    /// Who is attached, who was, every room and what is queued (no content).
    #[must_use]
    pub fn stats(&self) -> RelayStats {
        let now = now_secs();
        let st = self.lock();
        let mut q: HashMap<(String, String), (usize, usize)> = HashMap::new();
        for (room, r) in &st.rooms {
            for dev in r.members.keys() {
                let p = self.store.pending(dev, room, now);
                q.insert((dev.clone(), room.clone()), (p.len(), p.iter().map(|(_, f)| f.len()).sum()));
            }
        }
        let mut devices: HashSet<String> = st.sessions.keys().cloned().collect();
        devices.extend(st.seen.keys().cloned());
        for r in st.rooms.values() {
            devices.extend(r.members.keys().cloned());
        }
        let mut clients: Vec<ClientStat> = devices
            .into_iter()
            .map(|d| {
                let online = st.sessions.contains_key(&d);
                let mine: Vec<&(usize, usize)> = q.iter().filter(|((dv, _), _)| *dv == d).map(|(_, v)| v).collect();
                ClientStat {
                    last_seen: if online { now } else { st.seen.get(&d).map_or(0, |s| s.1) },
                    online,
                    rooms: mine.len(),
                    queued_frames: mine.iter().map(|v| v.0).sum(),
                    queued_bytes: mine.iter().map(|v| v.1).sum(),
                    device: d,
                }
            })
            .collect();
        clients.sort_by(|a, b| b.online.cmp(&a.online).then(b.last_seen.cmp(&a.last_seen)).then(a.device.cmp(&b.device)));
        let mut rooms: Vec<RoomStat> = st
            .rooms
            .iter()
            .map(|(room, r)| {
                let mut linked: Vec<String> = r.links.keys().cloned().collect();
                linked.sort();
                let mine: Vec<&(usize, usize)> = q.iter().filter(|((_, rm), _)| rm == room).map(|(_, v)| v).collect();
                RoomStat {
                    room: room.clone(),
                    members: r.members.len(),
                    online: r.members.keys().filter(|d| st.sessions.contains_key(*d)).count(),
                    linked,
                    wanted: r.wanted().len(),
                    queued_frames: mine.iter().map(|v| v.0).sum(),
                    queued_bytes: mine.iter().map(|v| v.1).sum(),
                }
            })
            .collect();
        rooms.sort_by(|a, b| a.room.cmp(&b.room));
        RelayStats { clients, rooms }
    }

    /// Events after `seq` (0 for all kept), oldest first.
    #[must_use]
    pub fn events_since(&self, seq: u64) -> Vec<RelayEvent> {
        self.lock().events.iter().filter(|e| e.seq > seq).cloned().collect()
    }

    fn event(&self, kind: EventKind) {
        let mut st = self.lock();
        Self::push_event(&mut st, kind);
    }

    fn push_event(st: &mut State, kind: EventKind) {
        st.next_event += 1;
        let e = RelayEvent { seq: st.next_event, at: now_secs(), kind };
        st.events.push_back(e);
        if st.events.len() > EVENTS_CAP {
            st.events.pop_front();
        }
    }

    /// Stopped ([`Relay::stop`]): it takes no new links.
    #[must_use]
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Stops every link, dialer and session.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let mut st = self.lock();
        for r in st.rooms.values_mut() {
            r.stop();
        }
        st.rooms.clear();
        for (_, mut s) in st.sessions.drain() {
            if let Some(k) = s.kill.take() {
                let _ = k.send(());
            }
        }
        if let Some(t) = self.sweeper.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
            t.abort();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn arc(&self) -> Option<Arc<Self>> {
        self.me.upgrade()
    }

    /// Serves one inbound stream: reads its hello, then runs it as a client link or a
    /// Beacon link (or refuses it).
    pub async fn serve(&self, mut rd: BoxRead, wr: BoxWrite) {
        let Ok(Ok(text)) = tokio::time::timeout(self.cfg.handshake_timeout, read_frame(&mut rd, 64 * 1024)).await else { return };
        self.serve_hello(&text, rd, wr).await;
    }

    /// Serves a stream whose hello was already read (`text`).
    pub async fn serve_hello(&self, text: &str, rd: BoxRead, wr: BoxWrite) {
        if self.is_stopped() {
            return;
        }
        let Some(me) = self.arc() else { return };
        match serde_json::from_str::<LinkHello>(text) {
            Ok(LinkHello::Client { device, ts, sig }) => me.serve_client(device, ts, &sig, rd, wr).await,
            Ok(LinkHello::Beacon { onion, node, room, ts, sig }) => me.serve_beacon(onion, &node, room, ts, &sig, rd, wr).await,
            Err(_) => {
                let mut wr = wr;
                let _ = write_frame_bounded(&mut wr, r#"{"ok":false}"#, self.cfg.link.write_timeout).await;
            }
        }
    }

    fn client_ok(&self, device: &str, ts: u64, sig: &str) -> bool {
        if !is_hex64(device) || now_secs().abs_diff(ts) > SKEW_SECS {
            return false;
        }
        let Some(sig) = hex::decode(sig).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()) else { return false };
        verify_device(device, &client_message(&self.cfg.onion, ts), &sig)
    }

    async fn serve_client(self: Arc<Self>, device: String, ts: u64, sig: &str, rd: BoxRead, mut wr: BoxWrite) {
        let mut ok = self.client_ok(&device, ts, sig);
        if !ok {
            self.event(EventKind::ClientRefused { why: "bad signature".into() });
        } else {
            let mut st = self.lock();
            ok = st.sessions.contains_key(&device) || st.sessions.len() < self.cfg.max_clients;
            if !ok {
                Self::push_event(&mut st, EventKind::ClientRefused { why: "full".into() });
            }
        }
        let ready = serde_json::to_string(&Ready { ok }).unwrap_or_default();
        if write_frame_bounded(&mut wr, &ready, self.cfg.link.write_timeout).await.is_err() || !ok {
            return;
        }
        let (tx, rx) = unbounded_channel();
        let (kill_tx, kill_rx) = oneshot::channel();
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let stale_rooms = {
            let mut st = self.lock();
            let old = st.sessions.insert(device.clone(), Session { id, tx: tx.clone(), rooms: HashSet::new(), kill: Some(kill_tx) });
            let now = now_secs();
            st.seen.entry(device.clone()).or_insert((now, now)).1 = now;
            Self::push_event(&mut st, EventKind::ClientAttached { device: device.clone() });
            old.map(|mut o| {
                if let Some(k) = o.kill.take() {
                    let _ = k.send(());
                }
                o.rooms
            })
        };
        for r in stale_rooms.unwrap_or_default() {
            self.status(&r);
        }
        for m in self.store.take_held(&device, now_secs()) {
            let _ = tx.send(m);
        }
        drop(tx);
        let me = self.clone();
        let dev = device.clone();
        tokio::select! {
            () = run_link(rd, wr, rx, self.cfg.link.clone(), CLIENT_COVER, move |f| me.on_client_op(&dev, id, &f)) => {}
            _ = kill_rx => {}
        }
        let rooms = {
            let mut st = self.lock();
            if st.sessions.get(&device).is_some_and(|s| s.id == id) {
                let now = now_secs();
                st.seen.entry(device.clone()).or_insert((now, now)).1 = now;
                Self::push_event(&mut st, EventKind::ClientDetached { device: device.clone() });
                st.sessions.remove(&device).map(|s| s.rooms).unwrap_or_default()
            } else {
                HashSet::new()
            }
        };
        for r in rooms {
            self.status(&r);
        }
    }

    fn reply(&self, st: &State, device: &str, sid: u64, o: &BeaconOp) {
        if let Some(s) = st.sessions.get(device).filter(|s| s.id == sid) {
            let _ = s.tx.send(op(o));
        }
    }

    /// One op from a client.
    fn on_client_op(&self, device: &str, sid: u64, text: &str) {
        let Ok(o) = serde_json::from_str::<ClientOp>(text) else { return };
        let now = now_secs();
        match o {
            ClientOp::Join { room, peers } => {
                if !is_hex64(&room) {
                    return;
                }
                let mut peers: Vec<String> = peers.into_iter().map(|p| p.trim().to_string()).filter(|p| !p.is_empty() && p.len() <= 128 && *p != self.cfg.onion).collect();
                peers.sort();
                peers.dedup();
                peers.truncate(self.cfg.max_peers);
                self.store.set_member(device, &room, &peers);
                {
                    let mut st = self.lock();
                    st.rooms.entry(room.clone()).or_insert_with(RoomSt::new).members.insert(device.to_string(), peers);
                    let live = match st.sessions.get_mut(device).filter(|s| s.id == sid) {
                        Some(s) => {
                            s.rooms.insert(room.clone());
                            Some(s.tx.clone())
                        }
                        None => None,
                    };
                    if let Some(tx) = live {
                        for (seq, frame) in self.store.pending(device, &room, now) {
                            let _ = tx.send(op(&BeaconOp::Frame { room: room.clone(), seq, frame }));
                        }
                    }
                    self.sync_dialers(&mut st, &room);
                }
                self.status(&room);
            }
            ClientOp::Close { room } => {
                if let Some(s) = self.lock().sessions.get_mut(device).filter(|s| s.id == sid) {
                    s.rooms.remove(&room);
                }
                self.status(&room);
            }
            ClientOp::Leave { room } => {
                self.store.remove_member(device, &room);
                {
                    let mut st = self.lock();
                    if let Some(s) = st.sessions.get_mut(device).filter(|s| s.id == sid) {
                        s.rooms.remove(&room);
                    }
                    let empty = st.rooms.get_mut(&room).map(|r| {
                        r.members.remove(device);
                        r.members.is_empty()
                    });
                    match empty {
                        Some(true) => {
                            if let Some(mut r) = st.rooms.remove(&room) {
                                r.stop();
                            }
                        }
                        Some(false) => self.sync_dialers(&mut st, &room),
                        None => {}
                    }
                }
                self.status(&room);
            }
            ClientOp::Send { room, frame, n } => {
                let mut st = self.lock();
                if frame.len() + 1024 > self.cfg.link.max_frame {
                    self.reply(&st, device, sid, &BeaconOp::Refused { n, why: "too large".into() });
                    return;
                }
                let member = st.rooms.get(&room).is_some_and(|r| r.members.contains_key(device));
                if !member {
                    self.reply(&st, device, sid, &BeaconOp::Refused { n, why: "not in room".into() });
                    return;
                }
                let fresh = st.rooms.get_mut(&room).is_some_and(|r| r.seen.insert(&frame));
                if fresh {
                    self.deliver_local(&mut st, &room, &frame, Some(device), now);
                    if let Some(r) = st.rooms.get_mut(&room) {
                        let wanted = r.wanted();
                        for peer in wanted {
                            let sent = r.links.get(&peer).is_some_and(|l| l.tx.send(frame.clone()).is_ok());
                            if !sent {
                                let q = r.outbox.entry(peer).or_default();
                                if q.len() >= OUTBOX_CAP {
                                    q.pop_front();
                                }
                                q.push_back(frame.clone());
                            }
                        }
                    }
                }
                self.reply(&st, device, sid, &BeaconOp::Sent { n });
            }
            ClientOp::Ack { room, upto } => self.store.ack(device, &room, upto),
            ClientOp::Redeem { id, inviter_device, home, payload, n } => {
                let good_id = (16..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit());
                if !good_id || !is_hex64(&inviter_device) || home.len() > 128 || payload.len() + 1024 > self.cfg.link.max_frame {
                    self.reply(&self.lock(), device, sid, &BeaconOp::Refused { n, why: "bad redeem".into() });
                    return;
                }
                match self.store.route(&id, now) {
                    Some((r, _)) if r != device => {
                        self.reply(&self.lock(), device, sid, &BeaconOp::Refused { n, why: "id taken".into() });
                        return;
                    }
                    Some(_) => {} // a resend: already on its way
                    None => {
                        self.store.set_route(&id, device, &inviter_device, now);
                        self.to_device(&inviter_device, &BeaconOp::Redeem { id, from: device.to_string(), home, payload }, now);
                    }
                }
                self.reply(&self.lock(), device, sid, &BeaconOp::Sent { n });
            }
            ClientOp::RedeemAnswer { id, payload, n } => {
                match self.store.route(&id, now) {
                    Some((redeemer, inviter)) if inviter == device => {
                        self.to_device(&redeemer, &BeaconOp::RedeemAnswer { id, payload }, now);
                        self.reply(&self.lock(), device, sid, &BeaconOp::Sent { n });
                    }
                    _ => self.reply(&self.lock(), device, sid, &BeaconOp::Refused { n, why: "no such redemption".into() }),
                }
            }
        }
    }

    /// To a device now if it is attached, else held for when it comes.
    fn to_device(&self, device: &str, o: &BeaconOp, now: u64) {
        let text = op(o);
        let st = self.lock();
        let sent = st.sessions.get(device).is_some_and(|s| s.tx.send(text.clone()).is_ok());
        if !sent {
            self.store.hold(device, &text, now);
        }
    }

    /// Into every local member's queue (but `except`), and live to those attached.
    fn deliver_local(&self, st: &mut State, room: &str, frame: &str, except: Option<&str>, now: u64) {
        let Some(r) = st.rooms.get(room) else { return };
        let devices: Vec<String> = r.members.keys().filter(|d| Some(d.as_str()) != except).cloned().collect();
        for d in devices {
            let seq = self.store.push(&d, room, frame, now);
            if let Some(s) = st.sessions.get(&d).filter(|s| s.rooms.contains(room)) {
                let _ = s.tx.send(op(&BeaconOp::Frame { room: room.to_string(), seq, frame: frame.to_string() }));
            }
        }
    }

    /// Tells the room's attached clients its state.
    fn status(&self, room: &str) {
        let st = self.lock();
        let mut linked: Vec<String> = st.rooms.get(room).map(|r| r.links.keys().cloned().collect()).unwrap_or_default();
        linked.sort();
        let live: Vec<&Session> = st.sessions.values().filter(|s| s.rooms.contains(room)).collect();
        let local = live.len().saturating_sub(1) as u32;
        let text = op(&BeaconOp::Status { room: room.to_string(), linked, local });
        for s in live {
            let _ = s.tx.send(text.clone());
        }
    }

    /// Keeps one dialer per wanted Beacon of the room, none for the others.
    fn sync_dialers(&self, st: &mut State, room: &str) {
        let Some(r) = st.rooms.get_mut(room) else { return };
        let wanted = r.wanted();
        let gone: Vec<String> = r.dialers.keys().filter(|k| !wanted.contains(*k)).cloned().collect();
        for peer in gone {
            if let Some(t) = r.dialers.remove(&peer) {
                t.abort();
            }
            r.outbox.remove(&peer);
        }
        let stale: Vec<String> = r.links.keys().filter(|k| !wanted.contains(*k)).cloned().collect();
        for peer in stale {
            if let Some(l) = r.links.remove(&peer) {
                l.task.abort();
            }
        }
        for peer in wanted {
            if !r.dialers.contains_key(&peer) {
                let t = tokio::spawn(dialer_task(self.me.clone(), room.to_string(), peer.clone(), r.changed.clone()));
                r.dialers.insert(peer, t);
            }
        }
    }

    fn has_link(&self, room: &str, peer: &str) -> bool {
        self.lock().rooms.get(room).is_some_and(|r| r.links.contains_key(peer))
    }

    async fn dial_beacon(&self, room: &str, peer: &str) -> Result<(BoxRead, BoxWrite)> {
        let ts = now_secs();
        let sig = hex::encode(self.key.sign(&beacon_message(peer, &self.cfg.onion, room, ts)).to_bytes());
        let hello = LinkHello::Beacon { onion: self.cfg.onion.clone(), node: self.node.clone(), room: room.to_string(), ts, sig };
        let t = self.cfg.handshake_timeout;
        let (mut rd, mut wr) = tokio::time::timeout(t, self.dialer.dial(peer)).await.map_err(|_| anyhow!("dial timed out"))??;
        write_frame_bounded(&mut wr, &serde_json::to_string(&hello)?, self.cfg.link.write_timeout).await?;
        let text = tokio::time::timeout(t, read_frame(&mut rd, 64 * 1024)).await.map_err(|_| anyhow!("handshake timed out"))??;
        if !serde_json::from_str::<Ready>(&text).is_ok_and(|r| r.ok) {
            return Err(anyhow!("{peer} refused the link"));
        }
        Ok((rd, wr))
    }

    #[allow(clippy::too_many_arguments)]
    async fn serve_beacon(self: Arc<Self>, onion: String, node: &str, room: String, ts: u64, sig: &str, rd: BoxRead, mut wr: BoxWrite) {
        let signed = is_hex64(node)
            && now_secs().abs_diff(ts) <= SKEW_SECS
            && !onion.is_empty()
            && onion != self.cfg.onion
            && hex::decode(sig).ok().and_then(|b| <[u8; 64]>::try_from(b).ok()).is_some_and(|s| verify_device(node, &beacon_message(&self.cfg.onion, &onion, &room, ts), &s));
        // Only a Beacon one of our own clients in the room listed.
        let listed = signed && self.lock().rooms.get(&room).is_some_and(|r| r.wanted().contains(&onion));
        let ok = listed && self.store.pin(&onion, node);
        if !ok {
            let why = if !signed { "bad signature" } else if !listed { "not listed" } else { "key changed" };
            self.event(EventKind::BeaconRefused { peer: onion.clone(), why: why.into() });
        }
        let ready = serde_json::to_string(&Ready { ok }).unwrap_or_default();
        if write_frame_bounded(&mut wr, &ready, self.cfg.link.write_timeout).await.is_err() || !ok {
            return;
        }
        self.add_link(&room, &onion, onion.clone(), rd, wr);
    }

    /// Keeps a new Beacon link, or drops it if a better one is up.
    fn add_link(&self, room: &str, peer: &str, dialed_by: String, rd: BoxRead, wr: BoxWrite) {
        let Some(me) = self.arc() else { return };
        {
            let mut st = self.lock();
            let Some(r) = st.rooms.get_mut(room) else { return };
            if !r.wanted().contains(peer) {
                return;
            }
            let preferred = std::cmp::min(self.cfg.onion.as_str(), peer).to_string();
            if let Some(existing) = r.links.get(peer) {
                if existing.dialed_by == preferred && dialed_by != preferred && !existing.task.is_finished() {
                    return;
                }
                if let Some(old) = r.links.remove(peer) {
                    old.task.abort();
                }
            }
            let seq = NEXT.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = unbounded_channel();
            for f in r.outbox.remove(peer).unwrap_or_default() {
                let _ = tx.send(f);
            }
            let (room_s, peer_s) = (room.to_string(), peer.to_string());
            let cfg = self.cfg.link.clone();
            let task = tokio::spawn(async move {
                let m = me.clone();
                let rm = room_s.clone();
                run_link(rd, wr, rx, cfg, COVER, move |f| m.from_beacon(&rm, &f)).await;
                me.drop_link(&room_s, &peer_s, seq);
            });
            r.links.insert(peer.to_string(), BLink { seq, dialed_by, tx, task });
            r.changed.notify_waiters();
            Self::push_event(&mut st, EventKind::LinkUp { room: room.to_string(), peer: peer.to_string() });
        }
        self.status(room);
    }

    fn drop_link(&self, room: &str, peer: &str, seq: u64) {
        let dropped = {
            let mut st = self.lock();
            match st.rooms.get_mut(room) {
                Some(r) if r.links.get(peer).is_some_and(|l| l.seq == seq) => {
                    r.links.remove(peer);
                    r.changed.notify_waiters();
                    Self::push_event(&mut st, EventKind::LinkDown { room: room.to_string(), peer: peer.to_string() });
                    true
                }
                _ => false,
            }
        };
        if dropped {
            self.status(room);
        }
    }

    /// A frame from another Beacon: local clients only, never forwarded again.
    fn from_beacon(&self, room: &str, frame: &str) {
        let mut st = self.lock();
        let fresh = st.rooms.get_mut(room).is_some_and(|r| r.seen.insert(frame));
        if fresh {
            self.deliver_local(&mut st, room, frame.trim_end(), None, now_secs());
        }
    }
}

/// Keeps a link to one wanted Beacon of a room for as long as it is wanted.
async fn dialer_task(relay: Weak<Relay>, room: String, peer: String, changed: Arc<Notify>) {
    let mut attempt: u32 = 0;
    loop {
        let notified = changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let Some(me) = relay.upgrade() else { break };
        if me.has_link(&room, &peer) {
            attempt = 0;
            drop(me);
            notified.await;
            continue;
        }
        match me.dial_beacon(&room, &peer).await {
            Ok((rd, wr)) => {
                attempt = 0;
                me.add_link(&room, &peer, me.cfg.onion.clone(), rd, wr);
            }
            Err(_) => {
                attempt += 1;
                let d = (me.cfg.redial)(attempt);
                drop(me);
                tokio::select! {
                    () = tokio::time::sleep(d) => {}
                    () = notified => {}
                }
            }
        }
    }
}

/// An in-process path to a set of relays (tests; an app running its own Beacon):
/// dialling an onion opens a duplex pipe served by that relay.
#[derive(Default, Clone)]
pub struct Directory(Arc<Mutex<HashMap<String, Weak<Relay>>>>);

impl Directory {
    /// Adds a relay under its onion.
    pub fn add(&self, relay: &Arc<Relay>) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(relay.onion().to_string(), Arc::downgrade(relay));
    }
    /// Takes an onion off (it becomes unreachable).
    pub fn remove(&self, onion: &str) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(onion);
    }
}

impl Dialer for Directory {
    fn dial(&self, onion: &str) -> crate::BoxFuture<Result<(BoxRead, BoxWrite)>> {
        let relay = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(onion).and_then(Weak::upgrade);
        let o = onion.to_string();
        Box::pin(async move {
            let relay = relay.ok_or_else(|| anyhow!("{o} is not reachable"))?;
            let (a, b) = tokio::io::duplex(256 * 1024);
            let (rd, wr) = crate::link::boxed(b);
            tokio::spawn(async move { relay.serve(rd, wr).await });
            Ok(crate::link::boxed(a))
        })
    }
}
