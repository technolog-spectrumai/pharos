//! Everything outside the room engine: Tor, the Beacon, the transport the engine talks
//! through. [`DemoBackend`] runs it all in memory (an in-memory `Hub` and a simulated second
//! device, "Ann", who answers). [`RealBackend`] is the stage 2/5 placeholder: it connects to
//! nothing and says so.

use std::sync::Arc;

use enigma_core::mem::{Hub, MemKv, MemStore};
use enigma_core::{Config, Deps, Ed25519Signer, Engine, Event, LinkStatus, Mailbox, MessageKind, OpenedRoom, SystemClock, Transport};
use rand_core::{OsRng, RngCore};
use serde_json::Value;

use crate::codes::{self, Invitation};
pub use crate::real::{InviteRecord, MyBeacon};
use crate::vault::Vault;
use enigma_core::Kv;
use enigmatite::mls::Store;

/// The Tor client's state, for the top bar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TorState {
    /// Not started / not connected.
    Off,
    /// Bootstrapping (percent).
    Bootstrapping(u8),
    /// Ready (circuits up).
    Ready,
    /// In-memory simulation, no Tor at all.
    Simulated,
    /// Failed.
    Error(String),
}

impl TorState {
    /// For the top bar.
    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Off => "off".into(),
            Self::Bootstrapping(p) => format!("bootstrapping {p}%"),
            Self::Ready => "ready".into(),
            Self::Simulated => "simulated (demo)".into(),
            Self::Error(e) => format!("error: {e}"),
        }
    }
}

/// The app's outside.
pub trait Backend {
    /// Tor's state.
    fn tor_state(&self) -> TorState;
    /// The transport the engine uses.
    fn transport(&self) -> Arc<dyn Transport + Send + Sync>;
    /// The Beacon mailbox, if attached.
    fn mailbox(&self) -> Option<Arc<dyn Mailbox + Send + Sync>>;
    /// Whether rooms reach the others through a Beacon (else direct).
    fn via_beacon(&self) -> bool;
    /// Called after the engine is built: seed state (demo) or connect.
    fn start(&mut self, _me: &mut Engine) {}
    /// Pump incoming frames into the engine (called every tick).
    fn poll(&mut self, me: &mut Engine);
    /// Redeem an invitation code.
    ///
    /// # Errors
    /// Why it could not.
    fn redeem(&mut self, me: &mut Engine, inv: &Invitation) -> Result<(), String>;
    /// A code to paste into Join, for the demo hint.
    fn sample_invitation(&self) -> Option<String> {
        None
    }
    /// Texts the simulated peer received (demo; empty otherwise).
    fn peer_texts(&self) -> Vec<String> {
        vec![]
    }
    /// Friends this backend knows from the start: (device id, name).
    fn seed_friends(&self) -> Vec<(String, String)> {
        vec![]
    }
    /// Where the engine keeps its state and the device key seed (`None`: memory, a fresh key).
    fn storage(&self) -> Option<(Box<dyn Kv + Send>, Arc<dyn Store + Send + Sync>, [u8; 32])> {
        None
    }
    /// The profile vault, when there is one.
    fn vault(&self) -> Option<&Vault> {
        None
    }
    /// The engine must be rebuilt (its transport changed: a new home Beacon).
    fn take_rebuild(&mut self) -> bool {
        false
    }
    /// Status lines since the last call (redemptions, refusals).
    fn take_status(&mut self) -> Vec<String> {
        vec![]
    }
    /// Your Beacon (the client link's home), when set.
    fn my_beacon(&self) -> Option<MyBeacon> {
        None
    }
    /// Set or clear Your Beacon.
    ///
    /// # Errors
    /// Not a Beacon code.
    fn set_my_beacon(&mut self, _code: Option<&str>) -> Result<Option<MyBeacon>, String> {
        Err("not in this build".into())
    }
    /// Make an invitation for the current room (`ttl` s, 0 = none; a friend for a personal one).
    ///
    /// # Errors
    /// No room or no Beacon.
    fn make_invite(&mut self, me: &Engine, ttl: u64, friend: Option<(&str, &str)>) -> Result<Invitation, String> {
        let room = me.current_room().ok_or("no room")?.to_string();
        let name = me.rooms().iter().find(|r| r.room == room).map(|r| r.name.clone()).unwrap_or_default();
        let mut id = [0u8; 16];
        OsRng.fill_bytes(&mut id);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        Ok(Invitation {
            name,
            room,
            onion: me.my_onion().to_string(),
            device: me.device_id().to_string(),
            id: hex::encode(id),
            expires: if ttl > 0 { now + ttl } else { 0 },
            for_device: friend.map(|f| f.0.to_string()).unwrap_or_default(),
        })
    }
    /// Offline mode (no Tor, no link).
    fn offline(&self) -> bool {
        false
    }
    /// Go offline / online.
    fn set_offline(&mut self, _on: bool) {}
    /// Connection timeout (s).
    fn connect_timeout(&self) -> u64 {
        crate::real::DEFAULT_CONNECT_TIMEOUT
    }
    /// Set it.
    fn set_connect_timeout(&mut self, _secs: u64) {}
    /// This device's discovery key for Your Beacon ("only my phones"), when known.
    fn discovery_key(&mut self) -> Option<String> {
        None
    }
    /// The invitations made here.
    fn invites(&self) -> Vec<InviteRecord> {
        vec![]
    }
    /// Withdraw one.
    fn revoke_invite(&mut self, _id: &str) {}
}

/// Builds the engine on a backend: its storage (the vault) or memory.
#[must_use]
pub fn build_engine(b: &dyn Backend, name: &str) -> Engine {
    let (kv, store, seed) = b.storage().unwrap_or_else(|| {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        (Box::new(MemKv::default()), Arc::new(MemStore::default()), seed)
    });
    let mut e = Engine::new(
        Deps {
            transport: Box::new(ArcTransport(b.transport())),
            signer: Box::new(Ed25519Signer::from_seed(&seed)),
            kv,
            store,
            mailbox: b.mailbox().map(|m| Box::new(ArcMailbox(m)) as _),
            clock: Box::new(SystemClock),
        },
        Config::default(),
    );
    e.set_user_name(name);
    e
}

struct ArcTransport(Arc<dyn Transport + Send + Sync>);

impl Transport for ArcTransport {
    fn create_room(&self, name: &str) -> Result<OpenedRoom, String> {
        self.0.create_room(name)
    }
    fn join_room(&self, name: &str, peers: &[String]) -> Result<OpenedRoom, String> {
        self.0.join_room(name, peers)
    }
    fn set_peers(&self, room: &str, peers: &[String]) {
        self.0.set_peers(room, peers);
    }
    fn cancel_join(&self) {
        self.0.cancel_join();
    }
    fn leave_room(&self, room: &str) {
        self.0.leave_room(room);
    }
    fn forget_onion(&self, name: &str) {
        self.0.forget_onion(name);
    }
    fn send(&self, room: &str, payload: &str) {
        self.0.send(room, payload);
    }
    fn last_status(&self, room: &str) -> Option<LinkStatus> {
        self.0.last_status(room)
    }
}

struct ArcMailbox(Arc<dyn Mailbox + Send + Sync>);

impl Mailbox for ArcMailbox {
    fn post(&self, body: &Value) -> Result<(), String> {
        self.0.post(body)
    }
    fn fetch(&self, after: u64, room: &str) -> Result<Vec<(u64, String)>, String> {
        self.0.fetch(after, room)
    }
    fn every_ms(&self) -> u64 {
        self.0.every_ms()
    }
}

// ── demo ─────────────────────────────────────────────────────────────────────

const ME: &str = "me";
const ANN: &str = "ann";

/// Everything in memory: a `Hub` mesh, and Ann on a second engine who answers.
pub struct DemoBackend {
    hub: Hub,
    ann: Engine,
    beacon: Option<MyBeacon>,
    replies: usize,
}

impl Default for DemoBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl DemoBackend {
    /// A fresh demo world.
    #[must_use]
    pub fn new() -> Self {
        let hub = Hub::default();
        let mut ann = Engine::new(
            Deps {
                transport: Box::new(hub.transport(ANN)),
                signer: Box::new(Ed25519Signer::from_seed(&[0xA7; 32])),
                kv: Box::new(MemKv::default()),
                store: Arc::new(MemStore::default()),
                mailbox: None,
                clock: Box::new(SystemClock),
            },
            Config::default(),
        );
        ann.set_user_name("Ann");
        Self { hub, ann, beacon: None, replies: 0 }
    }

    /// Ann's engine (tests).
    #[must_use]
    pub fn ann(&self) -> &Engine {
        &self.ann
    }

    fn link(me: &mut Engine, ann: &mut Engine) {
        if let Some(r) = me.current_room().map(str::to_string) {
            me.handle_status(&r, LinkStatus::Connected, Some("ann.onion"), &["ann.onion".to_string()]);
        }
        if let Some(r) = ann.current_room().map(str::to_string) {
            ann.handle_status(&r, LinkStatus::Connected, Some("me.onion"), &["me.onion".to_string()]);
        }
    }

    /// Ann hosts `name` and lets `me` in (Ann's side of an invitation).
    fn ann_admits(&mut self, me: &mut Engine, name: &str) -> Result<(), String> {
        let slug = self.ann.create_room(name).ok_or("Ann could not open the room")?;
        let kp = me.invite_key_package("scratch")?;
        let grant = self.ann.admit_invited(&slug, &kp).ok_or("Ann refused the key package")?;
        self.pump(me);
        if !me.join_by_invite(&grant, "scratch") {
            return Err(me.error().unwrap_or("the invitation would not open").to_string());
        }
        self.pump(me);
        Self::link(me, &mut self.ann);
        self.pump(me);
        Ok(())
    }

    /// Deliver queued frames until quiet; Ann answers texts.
    fn pump(&mut self, me: &mut Engine) {
        for _ in 0..50 {
            let mut n = 0;
            while let Some((to, room, p)) = self.hub.pop() {
                n += 1;
                match to.as_str() {
                    ME => me.handle_frame(&room, &p),
                    ANN => self.ann.handle_frame(&room, &p),
                    _ => {}
                }
            }
            let heard: Vec<String> = self
                .ann
                .drain_events()
                .into_iter()
                .filter_map(|e| match e {
                    Event::MessageAdded(m) if !m.is_self && m.kind == MessageKind::Text => Some(m.content),
                    _ => None,
                })
                .collect();
            for t in &heard {
                self.replies += 1;
                let tail = match self.replies % 3 {
                    1 => "Welcome aboard.",
                    2 => "Loud and clear, end to end.",
                    _ => "The lighthouse is on. Talk soon!",
                };
                let answer = format!("Got it: \u{201c}{t}\u{201d} {tail}");
                self.ann.send_text(&answer);
            }
            if n == 0 && heard.is_empty() {
                break;
            }
        }
    }
}

impl Backend for DemoBackend {
    fn tor_state(&self) -> TorState {
        TorState::Simulated
    }
    fn transport(&self) -> Arc<dyn Transport + Send + Sync> {
        Arc::new(self.hub.transport(ME))
    }
    fn mailbox(&self) -> Option<Arc<dyn Mailbox + Send + Sync>> {
        None
    }
    fn via_beacon(&self) -> bool {
        self.beacon.is_some()
    }
    fn my_beacon(&self) -> Option<MyBeacon> {
        self.beacon.clone()
    }
    fn set_my_beacon(&mut self, code: Option<&str>) -> Result<Option<MyBeacon>, String> {
        self.beacon = code.map(crate::real::parse_beacon_code).transpose()?;
        Ok(self.beacon.clone())
    }
    fn start(&mut self, me: &mut Engine) {
        me.create_room("Harbour");
        if self.ann_admits(me, "Lighthouse").is_ok() {
            self.ann.send_text("Hi! Ann here. This room is end-to-end encrypted.");
            self.pump(me);
            me.send_text("Hello Ann, the console works.");
            self.pump(me);
        }
        let _ = self.ann.drain_events();
    }
    fn poll(&mut self, me: &mut Engine) {
        self.ann.tick();
        self.pump(me);
    }
    fn redeem(&mut self, me: &mut Engine, inv: &Invitation) -> Result<(), String> {
        self.ann_admits(me, &inv.name)
    }
    fn sample_invitation(&self) -> Option<String> {
        Some(codes::encode_invitation(&Invitation { name: "Ann's Garden".into(), room: "topic-Ann's Garden".into(), onion: "ann.onion".into(), ..Invitation::default() }))
    }
    fn peer_texts(&self) -> Vec<String> {
        self.ann.messages().iter().filter(|m| !m.is_self && m.kind == MessageKind::Text).map(|m| m.content.clone()).collect()
    }
    fn seed_friends(&self) -> Vec<(String, String)> {
        vec![(self.ann.device_id().to_string(), "Ann".into())]
    }
}

// ── real ─────────────────────────────────────────────────────────────────────

pub use crate::real::{Net, RealBackend, NO_BEACON};
