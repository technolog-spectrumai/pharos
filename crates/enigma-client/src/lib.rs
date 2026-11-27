//! Enigma's client link to its home Beacon (stage b2, PROTOCOL.md Part C).
//!
//! A device attaches to one Beacon (its own or a friend's) with a signed hello and
//! then speaks JSON ops: `join` / `close` / `leave` a room (by its route id, never
//! its slug), `send` a sealed frame, `ack` what arrived. The Beacon meshes with the
//! room's other Beacons and keeps frames while the device is away.
//!
//! [`Client`] runs the link on a tokio runtime: it dials (over Tor with
//! [`TorDialer`], or in-process with [`in_process`] when the app runs the Beacon
//! itself), redials with backoff, re-joins the open rooms and resends every op the
//! Beacon has not confirmed. [`Client::transport`] is an
//! [`enigma_core::Transport`]: synchronous, it only queues. Frames and link status
//! come back through [`Client::drain`] or straight into an engine with
//! [`Client::pump`]. Presence then carries the home Beacon's onion as a member's
//! `onion`, and `set_peers` hands the other members' Beacons to the link.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Result};
use beacon_node::link::{run_link, BoxRead, BoxWrite, Dialer, LinkCfg};
use beacon_node::proto::{client_message, route_id, BeaconOp, ClientOp, LinkHello, CLIENT_COVER};
use beacon_node::relay::{Directory, Relay};
use beacon_node::{read_frame, room_for, write_frame_bounded, BoxFuture, Ready};
use ed25519_dalek::{Signer as _, SigningKey};
use enigma_core::{Engine, LinkStatus, OpenedRoom, Transport};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

/// The link's settings.
#[derive(Clone, Debug)]
pub struct ClientConfig {
    /// The home Beacon's onion.
    pub home: String,
    /// Frame cap, write timeout, cover interval.
    pub link: LinkCfg,
    /// Dial + hello + `Ready`.
    pub handshake_timeout: Duration,
    /// Redial delay after `n` failed attempts.
    pub redial: fn(u32) -> Duration,
    /// How long a redemption through another Beacon waits for its answer.
    pub redeem_wait: Duration,
}

impl ClientConfig {
    /// Defaults: 16 MiB frames, 20 s writes, 60 s handshakes (Tor), 30 s cover.
    #[must_use]
    pub fn new(home: &str) -> Self {
        Self {
            home: home.to_string(),
            link: LinkCfg { max_frame: 16 * 1024 * 1024, write_timeout: Duration::from_secs(20), cover_every: 30 },
            handshake_timeout: Duration::from_secs(60),
            redial: beacon_node::redial_backoff,
            redeem_wait: Duration::from_secs(30 * 60),
        }
    }
}

/// What comes back from the Beacon.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Incoming {
    /// A frame for a room (by slug).
    Frame {
        /// Slug.
        room: String,
        /// The frame.
        payload: String,
    },
    /// A room's link state, as the engine takes it.
    Status {
        /// Slug.
        room: String,
        /// Connected / waiting / connecting.
        status: LinkStatus,
        /// The Beacon whose link changed, if one did.
        peer: Option<String>,
        /// Linked Beacons (ours too while other local members are online).
        linked: Vec<String>,
    },
    /// The link to the home Beacon came up (`true`) or went (`false`).
    Link(bool),
    /// Someone redeemed one of our invitations (we are the inviter).
    Redeem {
        /// The redemption.
        id: String,
        /// The redeemer's device id.
        from: String,
        /// The redeemer's home Beacon: pass it to `Engine::admit_invited_via`.
        home: String,
        /// Its payload.
        payload: String,
    },
    /// The inviter answered our redemption.
    RedeemAnswer {
        /// The redemption.
        id: String,
        /// The answer.
        payload: String,
    },
    /// The Beacon refused an op.
    Refused(String),
}

struct RoomCl {
    slug: String,
    peers: Vec<String>,
    last_seq: u64,
    status: LinkStatus,
    linked: Vec<String>,
    open: bool,
}

#[derive(Default)]
struct St {
    rooms: HashMap<String, RoomCl>,
    by_slug: HashMap<String, String>,
    outbox: BTreeMap<u64, String>,
    leaving: HashSet<String>,
    next_n: u64,
    tx: Option<UnboundedSender<String>>,
    incoming: VecDeque<Incoming>,
    connected: bool,
    redeems: Vec<JoinHandle<()>>,
}

struct Inner {
    cfg: ClientConfig,
    key: SigningKey,
    device: String,
    dialer: Arc<dyn Dialer>,
    rt: tokio::runtime::Handle,
    st: Mutex<St>,
    notify: Notify,
    task: Mutex<Option<JoinHandle<()>>>,
}

/// The client link (cheap to clone).
#[derive(Clone)]
pub struct Client(Arc<Inner>);

fn text(o: &ClientOp) -> String {
    serde_json::to_string(o).unwrap_or_default()
}

/// Dials `onion` and attaches as `key`'s device.
async fn attach(dialer: &dyn Dialer, key: &SigningKey, onion: &str, cfg: &ClientConfig) -> Result<(BoxRead, BoxWrite)> {
    let t = cfg.handshake_timeout;
    let work = async {
        let (mut rd, mut wr) = dialer.dial(onion).await?;
        let ts = beacon_node::relay::now_secs();
        let sig = hex::encode(key.sign(&client_message(onion, ts)).to_bytes());
        let hello = LinkHello::Client { device: hex::encode(key.verifying_key().to_bytes()), ts, sig };
        write_frame_bounded(&mut wr, &serde_json::to_string(&hello)?, cfg.link.write_timeout).await?;
        let r = read_frame(&mut rd, 64 * 1024).await?;
        if !serde_json::from_str::<Ready>(&r).is_ok_and(|r| r.ok) {
            return Err(anyhow!("{onion} refused this device"));
        }
        Ok((rd, wr))
    };
    tokio::time::timeout(t, work).await.map_err(|_| anyhow!("attaching to {onion} timed out"))?
}

impl Client {
    /// Starts the link to `cfg.home` as the device with this Ed25519 seed, on `rt`.
    #[must_use]
    pub fn start(cfg: ClientConfig, device_seed: &[u8; 32], dialer: Arc<dyn Dialer>, rt: &tokio::runtime::Handle) -> Self {
        let key = SigningKey::from_bytes(device_seed);
        let device = hex::encode(key.verifying_key().to_bytes());
        let inner = Arc::new(Inner { cfg, key, device, dialer, rt: rt.clone(), st: Mutex::new(St::default()), notify: Notify::new(), task: Mutex::new(None) });
        let c = Self(inner);
        let me = c.clone();
        let task = rt.spawn(async move { me.run().await });
        *c.0.task.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task);
        c
    }

    /// This device's id.
    #[must_use]
    pub fn device_id(&self) -> &str {
        &self.0.device
    }

    /// The home Beacon's onion.
    #[must_use]
    pub fn home(&self) -> &str {
        &self.0.cfg.home
    }

    /// Whether the link is up.
    #[must_use]
    pub fn is_connected(&self) -> bool {
        self.lock().connected
    }

    /// Ops sent but not yet confirmed by the Beacon.
    #[must_use]
    pub fn unconfirmed(&self) -> usize {
        self.lock().outbox.len()
    }

    /// The engine's transport.
    #[must_use]
    pub fn transport(&self) -> ClientTransport {
        ClientTransport(self.clone())
    }

    /// Everything that came in since the last call.
    #[must_use]
    pub fn drain(&self) -> Vec<Incoming> {
        self.lock().incoming.drain(..).collect()
    }

    /// Waits until something comes in (or `max` passes).
    pub async fn wait(&self, max: Duration) {
        let n = self.0.notify.notified();
        if !self.lock().incoming.is_empty() {
            return;
        }
        let _ = tokio::time::timeout(max, n).await;
    }

    /// Feeds frames and status into `engine`; returns what the engine does not take
    /// (link changes, redemptions, refusals).
    pub fn pump(&self, engine: &mut Engine) -> Vec<Incoming> {
        let mut rest = vec![];
        for i in self.drain() {
            match i {
                Incoming::Frame { room, payload } => engine.handle_frame(&room, &payload),
                Incoming::Status { room, status, peer, linked } => engine.handle_status(&room, status, peer.as_deref(), &linked),
                other => rest.push(other),
            }
        }
        rest
    }

    /// Redeems an invitation: `payload` goes to `inviter_device` through the inviter's
    /// Beacon `beacon` (our home link if it is our Beacon, else a link of its own
    /// that waits for the answer, redialling, up to `redeem_wait`). The answer comes
    /// back as [`Incoming::RedeemAnswer`].
    pub fn redeem(&self, beacon: &str, inviter_device: &str, id: &str, payload: &str) {
        if beacon == self.0.cfg.home {
            let (i, d, p) = (id.to_string(), inviter_device.to_string(), payload.to_string());
            let h = self.0.cfg.home.clone();
            self.reliable(move |n| ClientOp::Redeem { id: i.clone(), inviter_device: d.clone(), home: h.clone(), payload: p.clone(), n });
            return;
        }
        let me = self.clone();
        let (b, i, d, p) = (beacon.to_string(), id.to_string(), inviter_device.to_string(), payload.to_string());
        let t = self.0.rt.spawn(async move { me.redeem_away(b, i, d, p).await });
        let mut st = self.lock();
        st.redeems.retain(|t| !t.is_finished());
        st.redeems.push(t);
    }

    /// Answers a redemption that came as [`Incoming::Redeem`].
    pub fn answer_redeem(&self, id: &str, payload: &str) {
        let (i, p) = (id.to_string(), payload.to_string());
        self.reliable(move |n| ClientOp::RedeemAnswer { id: i.clone(), payload: p.clone(), n });
    }

    /// Stops the link (and any redemption in flight).
    pub fn stop(&self) {
        if let Some(t) = self.0.task.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
            t.abort();
        }
        let mut st = self.lock();
        for t in st.redeems.drain(..) {
            t.abort();
        }
        st.tx = None;
        st.connected = false;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, St> {
        self.0.st.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn push(&self, st: &mut St, i: Incoming) {
        st.incoming.push_back(i);
        self.0.notify.notify_waiters();
    }

    /// An op the Beacon must confirm (`Sent{n}`): kept and resent until it does.
    fn reliable(&self, build: impl Fn(u64) -> ClientOp) {
        let mut st = self.lock();
        st.next_n += 1;
        let n = st.next_n;
        let t = text(&build(n));
        if let Some(tx) = &st.tx {
            let _ = tx.send(t.clone());
        }
        st.outbox.insert(n, t);
    }

    fn now_or_never(&self, o: &ClientOp) {
        if let Some(tx) = &self.lock().tx {
            let _ = tx.send(text(o));
        }
    }

    fn join_op(route: &str, r: &RoomCl) -> ClientOp {
        ClientOp::Join { room: route.to_string(), peers: r.peers.clone() }
    }

    async fn run(self) {
        let mut attempt = 0u32;
        loop {
            match attach(&*self.0.dialer, &self.0.key, &self.0.cfg.home, &self.0.cfg).await {
                Ok((rd, wr)) => {
                    attempt = 0;
                    let (tx, rx) = unbounded_channel();
                    {
                        let mut st = self.lock();
                        for (route, r) in st.rooms.iter().filter(|r| r.1.open) {
                            let _ = tx.send(text(&Self::join_op(route, r)));
                        }
                        for route in std::mem::take(&mut st.leaving) {
                            let _ = tx.send(text(&ClientOp::Leave { room: route }));
                        }
                        for t in st.outbox.values() {
                            let _ = tx.send(t.clone());
                        }
                        st.tx = Some(tx);
                        st.connected = true;
                        self.push(&mut st, Incoming::Link(true));
                    }
                    let me = self.clone();
                    run_link(rd, wr, rx, self.0.cfg.link.clone(), CLIENT_COVER, move |f| me.on_op(&f)).await;
                    let mut st = self.lock();
                    st.tx = None;
                    st.connected = false;
                    self.push(&mut st, Incoming::Link(false));
                    let changed: Vec<String> = st
                        .rooms
                        .values_mut()
                        .filter(|r| r.open)
                        .map(|r| {
                            r.status = LinkStatus::Connecting;
                            r.linked.clear();
                            r.slug.clone()
                        })
                        .collect();
                    for slug in changed {
                        self.push(&mut st, Incoming::Status { room: slug, status: LinkStatus::Connecting, peer: None, linked: vec![] });
                    }
                }
                Err(_) => attempt += 1,
            }
            tokio::time::sleep((self.0.cfg.redial)(attempt.max(1))).await;
        }
    }

    fn on_op(&self, f: &str) {
        let Ok(o) = serde_json::from_str::<BeaconOp>(f) else { return };
        let mut st = self.lock();
        match o {
            BeaconOp::Frame { room, seq, frame } => {
                let Some(r) = st.rooms.get_mut(&room).filter(|r| r.open) else { return };
                let fresh = seq > r.last_seq;
                if fresh {
                    r.last_seq = seq;
                }
                let slug = r.slug.clone();
                if let Some(tx) = &st.tx {
                    let _ = tx.send(text(&ClientOp::Ack { room, upto: seq }));
                }
                if fresh {
                    self.push(&mut st, Incoming::Frame { room: slug, payload: frame });
                }
            }
            BeaconOp::Status { room, linked, local } => {
                let home = self.0.cfg.home.clone();
                let Some(r) = st.rooms.get_mut(&room).filter(|r| r.open) else { return };
                let mut now = linked;
                if local > 0 {
                    now.push(home);
                }
                let status = if now.is_empty() { LinkStatus::Waiting } else { LinkStatus::Connected };
                let peer = now.iter().find(|p| !r.linked.contains(p)).or_else(|| r.linked.iter().find(|p| !now.contains(p))).cloned();
                r.status = status;
                r.linked = now.clone();
                let slug = r.slug.clone();
                self.push(&mut st, Incoming::Status { room: slug, status, peer, linked: now });
            }
            BeaconOp::Sent { n } => {
                st.outbox.remove(&n);
            }
            BeaconOp::Refused { n, why } => {
                st.outbox.remove(&n);
                self.push(&mut st, Incoming::Refused(why));
            }
            BeaconOp::Redeem { id, from, home, payload } => self.push(&mut st, Incoming::Redeem { id, from, home, payload }),
            BeaconOp::RedeemAnswer { id, payload } => self.push(&mut st, Incoming::RedeemAnswer { id, payload }),
        }
    }

    /// A redemption through a Beacon that is not ours: its own link, kept until the
    /// answer comes.
    async fn redeem_away(self, beacon: String, id: String, inviter: String, payload: String) {
        let deadline = tokio::time::Instant::now() + self.0.cfg.redeem_wait;
        let mut attempt = 0u32;
        while tokio::time::Instant::now() < deadline {
            if let Ok((rd, wr)) = attach(&*self.0.dialer, &self.0.key, &beacon, &self.0.cfg).await {
                attempt = 0;
                let (tx, rx) = unbounded_channel();
                let _ = tx.send(text(&ClientOp::Redeem { id: id.clone(), inviter_device: inviter.clone(), home: self.0.cfg.home.clone(), payload: payload.clone(), n: 1 }));
                let answer: Arc<Mutex<Option<Incoming>>> = Arc::default();
                let got = answer.clone();
                let done = Arc::new(Notify::new());
                let d2 = done.clone();
                let want = id.clone();
                let link = run_link(rd, wr, rx, self.0.cfg.link.clone(), CLIENT_COVER, move |f| match serde_json::from_str::<BeaconOp>(&f) {
                    Ok(BeaconOp::RedeemAnswer { id, payload }) if id == want => {
                        *got.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Incoming::RedeemAnswer { id, payload });
                        d2.notify_one();
                    }
                    Ok(BeaconOp::Refused { why, .. }) => {
                        *got.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Incoming::Refused(why));
                        d2.notify_one();
                    }
                    _ => {}
                });
                tokio::select! {
                    () = link => {}
                    () = done.notified() => {}
                    () = tokio::time::sleep_until(deadline) => {}
                }
                drop(tx);
                let got = answer.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
                if let Some(i) = got {
                    let mut st = self.lock();
                    self.push(&mut st, i);
                    return;
                }
            } else {
                attempt += 1;
            }
            tokio::time::sleep((self.0.cfg.redial)(attempt.max(1))).await;
        }
        let mut st = self.lock();
        self.push(&mut st, Incoming::Refused("redemption timed out".into()));
    }
}

/// [`enigma_core::Transport`] over the [`Client`]: every call only queues.
pub struct ClientTransport(Client);

impl ClientTransport {
    fn open(&self, name: &str, peers: &[String]) -> OpenedRoom {
        let c = &self.0;
        let slug = room_for(name);
        let route = route_id(&slug);
        let home = c.0.cfg.home.clone();
        let peers: Vec<String> = peers.iter().filter(|p| **p != home && !p.is_empty()).cloned().collect();
        let mut st = c.lock();
        st.leaving.remove(&route);
        let r = st.rooms.entry(route.clone()).or_insert(RoomCl { slug: slug.clone(), peers: vec![], last_seq: 0, status: LinkStatus::Connecting, linked: vec![], open: true });
        r.open = true;
        for p in peers {
            if !r.peers.contains(&p) {
                r.peers.push(p);
            }
        }
        let join = Client::join_op(&route, r);
        if !st.connected {
            r_status(&mut st, &route, LinkStatus::Connecting);
        }
        st.by_slug.insert(slug.clone(), route);
        if let Some(tx) = &st.tx {
            let _ = tx.send(text(&join));
        }
        OpenedRoom { room: slug, name: name.to_string(), onion: home }
    }

    fn route_of(&self, slug: &str) -> Option<String> {
        self.0.lock().by_slug.get(slug).cloned()
    }
}

fn r_status(st: &mut St, route: &str, s: LinkStatus) {
    if let Some(r) = st.rooms.get_mut(route) {
        r.status = s;
    }
}

impl Transport for ClientTransport {
    fn create_room(&self, name: &str) -> Result<OpenedRoom, String> {
        Ok(self.open(name, &[]))
    }
    fn join_room(&self, name: &str, peers: &[String]) -> Result<OpenedRoom, String> {
        Ok(self.open(name, peers))
    }
    fn set_peers(&self, room: &str, peers: &[String]) {
        let Some(route) = self.route_of(room) else { return };
        let home = self.0.home().to_string();
        let join = {
            let mut st = self.0.lock();
            let Some(r) = st.rooms.get_mut(&route) else { return };
            let mut next: Vec<String> = peers.iter().filter(|p| **p != home && !p.is_empty()).cloned().collect();
            next.sort();
            next.dedup();
            if next == r.peers {
                return;
            }
            r.peers = next;
            Client::join_op(&route, r)
        };
        self.0.now_or_never(&join);
    }
    fn leave_room(&self, room: &str) {
        let Some(route) = self.route_of(room) else { return };
        if let Some(r) = self.0.lock().rooms.get_mut(&route) {
            r.open = false;
        }
        // Still a member on the Beacon: frames are kept for when the room reopens.
        self.0.now_or_never(&ClientOp::Close { room: route });
    }
    fn forget_onion(&self, name: &str) {
        let slug = room_for(name);
        let route = route_id(&slug);
        let mut st = self.0.lock();
        st.rooms.remove(&route);
        st.by_slug.remove(&slug);
        match &st.tx {
            Some(tx) => {
                let _ = tx.send(text(&ClientOp::Leave { room: route }));
            }
            None => {
                st.leaving.insert(route);
            }
        }
    }
    fn send(&self, room: &str, payload: &str) {
        let Some(route) = self.route_of(room) else { return };
        let p = payload.to_string();
        self.0.reliable(move |n| ClientOp::Send { room: route.clone(), frame: p.clone(), n });
    }
    fn last_status(&self, room: &str) -> Option<LinkStatus> {
        let route = self.route_of(room)?;
        self.0.lock().rooms.get(&route).map(|r| r.status)
    }
}

/// Dialling through the app's own Beacon, in the same process ("Enable Beacon"): no
/// Tor between the app and its Beacon.
#[must_use]
pub fn in_process(relay: &Arc<Relay>) -> Arc<dyn Dialer> {
    let d = Directory::default();
    d.add(relay);
    Arc::new(d)
}

/// Dialling over Tor through pharos-tor (port 80, the Beacon's onion).
pub struct TorDialer(pub Arc<pharos_tor::Tor>);

impl Dialer for TorDialer {
    fn dial(&self, onion: &str) -> BoxFuture<Result<(BoxRead, BoxWrite)>> {
        let (t, o) = (self.0.clone(), onion.to_string());
        Box::pin(async move { Ok(beacon_node::link::boxed(t.dial(&o, pharos_tor::DIAL_TIMEOUT).await?)) })
    }
}
