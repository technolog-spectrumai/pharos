//! The real backend (b2): the device's client link to its Beacon over Tor
//! (`enigma-client` via `pharos-tor`), all state in the [`Vault`]. The client never runs a
//! Beacon itself (b2.md: client and Beacon are separate apps).
//!
//! - **Your Beacon** (`beacon`/`default`/`mine` in the vault, `{onion, name}` as the Tauri
//!   app): the client link's home. Without one nothing is reachable and rooms fail with
//!   [`NO_BEACON`].
//! - **Invitations** go over the client link: the redeemer's key package reaches the
//!   inviter through the inviter's Beacon (`Client::redeem`), the inviter admits it with
//!   `Engine::admit_invited_via` (listing the redeemer's Beacon) and answers with the
//!   Grant (`Client::answer_redeem`).
//!
//! [`Net::Test`] swaps Tor for any [`Dialer`] (tests: beacon-node's in-memory `Directory`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use beacon_node::link::{BoxRead, BoxWrite, Dialer};
use beacon_node::BoxFuture;
use enigma_client::{Client, ClientConfig, ClientTransport, Incoming};
use enigma_core::{Engine, Grant, Kv, LinkStatus, Mailbox, OpenedRoom, Transport};
use enigmatite::mls::Store;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::backend::{Backend, TorState};
use crate::codes::Invitation;
use crate::vault::Vault;

/// Rooms fail with this until a Beacon is set or enabled.
pub const NO_BEACON: &str = "no Beacon yet: set Your Beacon in Settings";

/// Connection timeout default (s): a fresh onion circuit can take a minute.
pub const DEFAULT_CONNECT_TIMEOUT: u64 = 60;

/// How the backend reaches onions.
#[derive(Clone)]
pub enum Net {
    /// Tor (arti), state under the profile folder.
    Tor,
    /// Tests: dial through this (e.g. beacon-node's in-memory `Directory`).
    Test(Arc<dyn Dialer>),
    /// Your Beacon runs in this process (enigma27-combo: its own Lighthouse): dial it
    /// through this, no Tor hop. Production timings, unlike [`Net::Test`].
    Local(Arc<dyn Dialer>),
}

/// Your Beacon, as the vault keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MyBeacon {
    /// Its onion.
    pub onion: String,
    /// Its name.
    #[serde(default)]
    pub name: String,
}

/// Read a `pharos-beacon:` code (or a bare `….onion` address).
///
/// # Errors
/// Not a Beacon code.
pub fn parse_beacon_code(code: &str) -> Result<MyBeacon, String> {
    let c = code.trim();
    if let Ok(b) = pharos_id::BeaconCode::from_text(c) {
        return Ok(MyBeacon { onion: b.onion_address(), name: b.name.clone() });
    }
    let bare = c.strip_suffix(".onion").unwrap_or("");
    if bare.len() == 56 && bare.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)) {
        return Ok(MyBeacon { onion: c.to_string(), name: String::new() });
    }
    Err("not a Beacon code".into())
}

/// The `pharos-beacon:` code for an onion (the bare address when it is not a real key).
#[must_use]
pub fn beacon_code(onion: &str, name: &str) -> String {
    pharos_id::BeaconCode::new(onion, name).map_or_else(|_| onion.to_string(), |c| c.to_text())
}

/// The engine's transport, switchable when the home Beacon changes.
#[derive(Clone, Default)]
pub struct SwitchTransport(Arc<Mutex<Option<ClientTransport>>>);

impl SwitchTransport {
    fn set(&self, t: Option<ClientTransport>) {
        *self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = t;
    }
    fn with<T>(&self, f: impl FnOnce(&ClientTransport) -> T) -> Option<T> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref().map(f)
    }
}

impl Transport for SwitchTransport {
    fn create_room(&self, name: &str) -> Result<OpenedRoom, String> {
        self.with(|t| t.create_room(name)).unwrap_or_else(|| Err(NO_BEACON.into()))
    }
    fn join_room(&self, name: &str, peers: &[String]) -> Result<OpenedRoom, String> {
        self.with(|t| t.join_room(name, peers)).unwrap_or_else(|| Err(NO_BEACON.into()))
    }
    fn set_peers(&self, room: &str, peers: &[String]) {
        self.with(|t| t.set_peers(room, peers));
    }
    fn leave_room(&self, room: &str) {
        self.with(|t| t.leave_room(room));
    }
    fn forget_onion(&self, name: &str) {
        self.with(|t| t.forget_onion(name));
    }
    fn send(&self, room: &str, payload: &str) {
        self.with(|t| t.send(room, payload));
    }
    fn last_status(&self, room: &str) -> Option<LinkStatus> {
        self.with(|t| t.last_status(room)).flatten()
    }
}

#[derive(Default)]
enum TorSlot {
    #[default]
    Off,
    Starting,
    Ready(Arc<pharos_tor::Tor>),
    Failed(String),
}

/// Dials over Tor once it is up (waits for the bootstrap), giving up after the
/// connection timeout setting.
struct LazyTor(Arc<Mutex<TorSlot>>, Duration);

impl Dialer for LazyTor {
    fn dial(&self, onion: &str) -> BoxFuture<anyhow::Result<(BoxRead, BoxWrite)>> {
        let (slot, o, timeout) = (self.0.clone(), onion.to_string(), self.1);
        Box::pin(async move {
            for _ in 0..600 {
                let tor = match &*slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner) {
                    TorSlot::Ready(t) => Some(t.clone()),
                    TorSlot::Failed(e) => return Err(anyhow::anyhow!("tor: {e}")),
                    _ => None,
                };
                if let Some(t) = tor {
                    return Ok(beacon_node::link::boxed(t.dial(&o, timeout).await?));
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(anyhow::anyhow!("tor is not up"))
        })
    }
}

/// What a redemption carries to the inviter.
#[derive(Serialize, Deserialize)]
struct RedeemReq {
    invite: String,
    room: String,
    kp: String,
}

/// What the inviter answers.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum RedeemAns {
    Ok { grant: Grant },
    No { error: String },
}

/// An invitation this device made (kv `invites`/`default`/<id>).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteRecord {
    /// Its id (in the code).
    pub id: String,
    /// Room slug.
    pub room: String,
    /// Room name.
    pub name: String,
    /// Made (unix s).
    pub created: u64,
    /// Valid for (s); 0 = no expiry.
    #[serde(default)]
    pub ttl: u64,
    /// A personal invitation: only this device may redeem it.
    #[serde(default)]
    pub for_device: Option<String>,
    /// For whom (friend name), shown in the list.
    #[serde(default)]
    pub for_name: String,
    /// Redeemed (single use).
    #[serde(default)]
    pub used: bool,
    /// Withdrawn.
    #[serde(default)]
    pub revoked: bool,
}

impl InviteRecord {
    /// "active" / "used" / "expired" / "withdrawn".
    #[must_use]
    pub fn state(&self, now: u64) -> &'static str {
        if self.revoked {
            "withdrawn"
        } else if self.used {
            "used"
        } else if self.ttl > 0 && now >= self.created + self.ttl {
            "expired"
        } else {
            "active"
        }
    }
}

fn now_secs() -> u64 {
    beacon_node::relay::now_secs()
}

fn rand_id() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

/// The real backend.
pub struct RealBackend {
    rt: tokio::runtime::Runtime,
    vault: Vault,
    net: Net,
    seed: [u8; 32],
    tor: Arc<Mutex<TorSlot>>,
    client: Option<Client>,
    transport: SwitchTransport,
    rebuild: bool,
    status: Vec<String>,
    /// Redemptions we are waiting on: id → invitation.
    waiting: HashMap<String, Invitation>,
    /// Redemptions to admit (the room was not ready yet): (id, from, home, req, tries).
    to_admit: Vec<(String, String, String, RedeemReq, u32)>,
    redial: fn(u32) -> Duration,
}

impl RealBackend {
    /// On an unlocked vault. Starts Tor (with [`Net::Tor`]) and the client link to the
    /// saved Beacon, and the in-process Beacon if it was enabled.
    ///
    /// # Errors
    /// The vault is locked, no runtime.
    pub fn new(vault: Vault, net: Net) -> Result<Self, String> {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().map_err(|e| e.to_string())?;
        let seed = vault.device_seed()?;
        let mut b = Self {
            rt,
            vault,
            net,
            seed,
            tor: Arc::default(),
            client: None,
            transport: SwitchTransport::default(),
            rebuild: false,
            status: vec![],
            waiting: HashMap::new(),
            to_admit: vec![],
            redial: beacon_node::redial_backoff,
        };
        if matches!(b.net, Net::Test(_)) {
            b.redial = |n| Duration::from_millis((50 * u64::from(n)).min(400));
        }
        if matches!(b.net, Net::Local(_)) {
            // In-process dials are cheap: back on soon after the Lighthouse restarts.
            b.redial = |n| Duration::from_millis((500 * u64::from(n)).min(3_000));
        }
        if matches!(b.net, Net::Tor) && !b.vault.setting("offline").is_some_and(|v| v == "1") {
            b.start_tor();
        }
        b.reconnect();
        b.rebuild = false;
        Ok(b)
    }

    /// The vault.
    #[must_use]
    pub fn vault(&self) -> &Vault {
        &self.vault
    }

    /// The client link (tests).
    #[must_use]
    pub fn client(&self) -> Option<&Client> {
        self.client.as_ref()
    }

    fn start_tor(&self) {
        {
            let mut s = self.tor.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if matches!(*s, TorSlot::Starting | TorSlot::Ready(_)) {
                return;
            }
            *s = TorSlot::Starting;
        }
        let slot = self.tor.clone();
        let dir = self.vault.dir().join("tor");
        self.rt.spawn(async move {
            let r = pharos_tor::Tor::start(dir.join("state"), dir.join("cache"), false, pharos_tor::Vanguards::Lite).await;
            *slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = match r {
                Ok(t) => TorSlot::Ready(Arc::new(t)),
                Err(e) => TorSlot::Failed(e.to_string()),
            };
        });
    }

    /// Your Beacon from the vault.
    #[must_use]
    pub fn my_beacon(&self) -> Option<MyBeacon> {
        self.vault.kv_get("beacon", "default", "mine").filter(|s| !s.is_empty()).and_then(|s| serde_json::from_str(&s).ok())
    }

    /// The home the client link uses: Your Beacon.
    #[must_use]
    pub fn home(&self) -> Option<String> {
        self.my_beacon().map(|b| b.onion)
    }

    fn dialer(&self) -> Arc<dyn Dialer> {
        match &self.net {
            Net::Tor => Arc::new(LazyTor(self.tor.clone(), Duration::from_secs(self.connect_timeout()))),
            Net::Test(d) | Net::Local(d) => d.clone(),
        }
    }

    /// (Re)start the client link to [`RealBackend::home`]; the engine is rebuilt on the
    /// next tick so its rooms re-open on the new link.
    fn reconnect(&mut self) {
        if let Some(c) = self.client.take() {
            c.stop();
        }
        self.transport.set(None);
        if let Some(home) = self.home().filter(|_| !self.offline()) {
            let mut cfg = ClientConfig::new(&home);
            cfg.redial = self.redial;
            cfg.handshake_timeout = Duration::from_secs(self.connect_timeout());
            if matches!(self.net, Net::Test(_)) {
                cfg.handshake_timeout = Duration::from_secs(5);
                cfg.link.cover_every = 0;
                cfg.redeem_wait = Duration::from_secs(60);
            }
            let c = Client::start(cfg, &self.seed, self.dialer(), self.rt.handle());
            self.transport.set(Some(c.transport()));
            self.client = Some(c);
        }
        self.rebuild = true;
    }

    /// Offline mode: no Tor, no client link (setting `offline`, as the Tauri app).
    #[must_use]
    pub fn offline(&self) -> bool {
        self.vault.setting("offline").as_deref() == Some("1")
    }

    /// Go offline (Tor and the link stop) or back online.
    pub fn set_offline(&mut self, on: bool) {
        self.vault.set_setting("offline", if on { "1" } else { "0" });
        if on {
            *self.tor.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = TorSlot::Off;
        } else if matches!(self.net, Net::Tor) {
            self.start_tor();
        }
        self.reconnect();
    }

    /// Connection timeout, seconds (setting `connect_timeout_secs`; 10..=300, default 60).
    #[must_use]
    pub fn connect_timeout(&self) -> u64 {
        self.vault.setting("connect_timeout_secs").and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_CONNECT_TIMEOUT).clamp(10, 300)
    }

    /// Set it; the link restarts with it.
    pub fn set_connect_timeout(&mut self, secs: u64) {
        self.vault.set_setting("connect_timeout_secs", &secs.clamp(10, 300).to_string());
        self.reconnect();
    }

    /// This device's discovery key for Your Beacon ("only my phones"), once Tor is up:
    /// the text the Beacon's owner adds (`beacon allow NAME KEY`, or the Beacon app's
    /// Phones list). Kept in the vault once known.
    pub fn discovery_key(&mut self) -> Option<String> {
        let onion = self.home()?;
        let k = format!("discovery_key:{onion}");
        if let Some(v) = self.vault.setting(&k) {
            return Some(v);
        }
        let tor = match &*self.tor.lock().unwrap_or_else(std::sync::PoisonError::into_inner) {
            TorSlot::Ready(t) => t.clone(),
            _ => return None,
        };
        let key = tor.discovery_key(&onion).ok()?;
        self.vault.set_setting(&k, &key);
        Some(key)
    }

    /// Set (or clear) Your Beacon.
    ///
    /// # Errors
    /// Not a Beacon code.
    pub fn set_my_beacon(&mut self, code: Option<&str>) -> Result<Option<MyBeacon>, String> {
        let b = match code {
            Some(c) => {
                let b = parse_beacon_code(c)?;
                self.vault.kv_put("beacon", "default", "mine", &serde_json::to_string(&b).unwrap_or_default());
                Some(b)
            }
            None => {
                self.vault.kv_put("beacon", "default", "mine", "");
                None
            }
        };
        self.reconnect();
        Ok(b)
    }

    fn handle(&mut self, me: &mut Engine, i: Incoming) {
        match i {
            Incoming::Redeem { id, from, home, payload } => match serde_json::from_str::<RedeemReq>(&payload) {
                Ok(req) => self.to_admit.push((id, from, home, req, 0)),
                Err(_) => self.answer(&id, Err("not a redemption".into())),
            },
            Incoming::RedeemAnswer { id, payload } => {
                let Some(inv) = self.waiting.remove(&id) else { return };
                match serde_json::from_str::<RedeemAns>(&payload) {
                    Ok(RedeemAns::Ok { grant }) => {
                        if me.join_by_invite(&grant, &scratch(&inv)) {
                            self.status.push(format!("Joined \u{201c}{}\u{201d}.", grant.room_name));
                        } else {
                            self.status.push(format!("Join: {}", me.error().unwrap_or("the invitation would not open")));
                        }
                    }
                    Ok(RedeemAns::No { error }) => self.status.push(format!("Join: {error}")),
                    Err(_) => self.status.push("Join: a bad answer from the inviter".into()),
                }
            }
            Incoming::Refused(why) => self.status.push(format!("Beacon: {why}")),
            Incoming::Link(_) | Incoming::Frame { .. } | Incoming::Status { .. } => {}
        }
    }

    fn answer(&self, id: &str, r: Result<Grant, String>) {
        let a = match r {
            Ok(grant) => RedeemAns::Ok { grant },
            Err(error) => RedeemAns::No { error },
        };
        if let Some(c) = &self.client {
            c.answer_redeem(id, &serde_json::to_string(&a).unwrap_or_default());
        }
    }

    /// Admit what can be admitted now (the room must be open and its MLS ready).
    fn admit(&mut self, me: &mut Engine) {
        let mut later = vec![];
        for (id, from, home, req, tries) in std::mem::take(&mut self.to_admit) {
            let Some(mut rec) = self.vault.kv_get("invites", "default", &req.invite).and_then(|s| serde_json::from_str::<InviteRecord>(&s).ok()) else {
                self.answer(&id, Err("this invitation is not known".into()));
                continue;
            };
            let state = rec.state(now_secs());
            if state != "active" || rec.room != req.room || rec.for_device.as_ref().is_some_and(|d| *d != from) {
                let why = if rec.for_device.as_ref().is_some_and(|d| *d != from) { "this invitation is for someone else" } else { state };
                self.answer(&id, Err(format!("this invitation is {why}")));
                continue;
            }
            if me.current_room() != Some(rec.room.as_str()) {
                me.open_room(&rec.room);
            }
            match me.admit_invited_via(&rec.room, &req.kp, Some(&home)) {
                Some(grant) => {
                    rec.used = true;
                    self.vault.kv_put("invites", "default", &rec.id, &serde_json::to_string(&rec).unwrap_or_default());
                    self.answer(&id, Ok(grant));
                    self.status.push(format!("Admitted a guest to \u{201c}{}\u{201d}.", rec.name));
                }
                None if tries < 200 => later.push((id, from, home, req, tries + 1)),
                None => self.answer(&id, Err("the room is not ready".into())),
            }
        }
        self.to_admit = later;
    }

    /// Make an invitation for the current room: (record, code).
    ///
    /// # Errors
    /// No room, no Beacon.
    pub fn make_invite(&self, me: &Engine, ttl: u64, for_friend: Option<(&str, &str)>) -> Result<(InviteRecord, Invitation), String> {
        let room = me.current_room().ok_or("no room")?.to_string();
        let name = me.rooms().iter().find(|r| r.room == room).map(|r| r.name.clone()).unwrap_or_default();
        let onion = self.home().ok_or(NO_BEACON)?;
        let rec = InviteRecord {
            id: rand_id(),
            room: room.clone(),
            name: name.clone(),
            created: now_secs(),
            ttl,
            for_device: for_friend.map(|f| f.0.to_string()),
            for_name: for_friend.map(|f| f.1.to_string()).unwrap_or_default(),
            used: false,
            revoked: false,
        };
        self.vault.kv_put("invites", "default", &rec.id, &serde_json::to_string(&rec).unwrap_or_default());
        let mut ids: Vec<String> = self.invite_ids();
        ids.push(rec.id.clone());
        self.vault.kv_put("invites", "default", "index", &serde_json::to_string(&ids).unwrap_or_default());
        let inv = Invitation { name, room, onion, device: me.device_id().to_string(), id: rec.id.clone(), expires: if ttl > 0 { rec.created + ttl } else { 0 }, for_device: rec.for_device.clone().unwrap_or_default() };
        Ok((rec, inv))
    }

    fn invite_ids(&self) -> Vec<String> {
        self.vault.kv_get("invites", "default", "index").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    /// Every invitation made here, newest first.
    #[must_use]
    pub fn invites(&self) -> Vec<InviteRecord> {
        let mut v: Vec<InviteRecord> = self.invite_ids().iter().filter_map(|id| self.vault.kv_get("invites", "default", id)).filter_map(|s| serde_json::from_str(&s).ok()).collect();
        v.sort_by(|a, b| b.created.cmp(&a.created));
        v
    }

    /// Withdraw an invitation.
    pub fn revoke_invite(&self, id: &str) {
        if let Some(mut r) = self.vault.kv_get("invites", "default", id).and_then(|s| serde_json::from_str::<InviteRecord>(&s).ok()) {
            r.revoked = true;
            self.vault.kv_put("invites", "default", id, &serde_json::to_string(&r).unwrap_or_default());
        }
    }
}

fn scratch(inv: &Invitation) -> String {
    format!("redeem-{}", inv.id)
}

impl Drop for RealBackend {
    fn drop(&mut self) {
        if let Some(c) = self.client.take() {
            c.stop();
        }
    }
}

impl Backend for RealBackend {
    fn tor_state(&self) -> TorState {
        if self.offline() {
            return TorState::Off;
        }
        if let Net::Test(_) | Net::Local(_) = self.net {
            return match &self.client {
                None => TorState::Off,
                Some(c) if c.is_connected() => TorState::Ready,
                Some(_) => TorState::Bootstrapping(50),
            };
        }
        match &*self.tor.lock().unwrap_or_else(std::sync::PoisonError::into_inner) {
            TorSlot::Off => TorState::Off,
            TorSlot::Starting => TorState::Bootstrapping(0),
            TorSlot::Ready(_) => TorState::Ready,
            TorSlot::Failed(e) => TorState::Error(e.clone()),
        }
    }
    fn transport(&self) -> Arc<dyn Transport + Send + Sync> {
        Arc::new(self.transport.clone())
    }
    fn mailbox(&self) -> Option<Arc<dyn Mailbox + Send + Sync>> {
        None
    }
    fn via_beacon(&self) -> bool {
        true
    }
    fn storage(&self) -> Option<(Box<dyn Kv + Send>, Arc<dyn Store + Send + Sync>, [u8; 32])> {
        Some((Box::new(self.vault.engine_kv()), Arc::new(self.vault.mls_store()), self.seed))
    }
    fn vault(&self) -> Option<&Vault> {
        Some(&self.vault)
    }
    fn take_rebuild(&mut self) -> bool {
        std::mem::take(&mut self.rebuild)
    }
    fn take_status(&mut self) -> Vec<String> {
        std::mem::take(&mut self.status)
    }
    fn my_beacon(&self) -> Option<MyBeacon> {
        RealBackend::my_beacon(self)
    }
    fn set_my_beacon(&mut self, code: Option<&str>) -> Result<Option<MyBeacon>, String> {
        RealBackend::set_my_beacon(self, code)
    }
    fn offline(&self) -> bool {
        RealBackend::offline(self)
    }
    fn set_offline(&mut self, on: bool) {
        RealBackend::set_offline(self, on);
    }
    fn connect_timeout(&self) -> u64 {
        RealBackend::connect_timeout(self)
    }
    fn set_connect_timeout(&mut self, secs: u64) {
        RealBackend::set_connect_timeout(self, secs);
    }
    fn discovery_key(&mut self) -> Option<String> {
        RealBackend::discovery_key(self)
    }
    fn make_invite(&mut self, me: &Engine, ttl: u64, friend: Option<(&str, &str)>) -> Result<Invitation, String> {
        RealBackend::make_invite(self, me, ttl, friend).map(|(_, i)| i)
    }
    fn invites(&self) -> Vec<InviteRecord> {
        RealBackend::invites(self)
    }
    fn revoke_invite(&mut self, id: &str) {
        RealBackend::revoke_invite(self, id);
    }
    fn poll(&mut self, me: &mut Engine) {
        let rest = self.client.as_ref().map(|c| c.pump(me)).unwrap_or_default();
        for i in rest {
            self.handle(me, i);
        }
        if !self.to_admit.is_empty() {
            self.admit(me);
        }
    }
    fn redeem(&mut self, me: &mut Engine, inv: &Invitation) -> Result<(), String> {
        let c = self.client.as_ref().ok_or(NO_BEACON)?;
        if inv.device.is_empty() || inv.id.is_empty() {
            return Err("this invitation is from an older app (no inviter device)".into());
        }
        if inv.expires > 0 && now_secs() >= inv.expires {
            return Err("this invitation has expired".into());
        }
        if !inv.for_device.is_empty() && inv.for_device != me.device_id() {
            return Err("this invitation is for someone else".into());
        }
        let kp = me.invite_key_package(&scratch(inv))?;
        let rid = rand_id();
        let req = RedeemReq { invite: inv.id.clone(), room: inv.room.clone(), kp };
        c.redeem(&inv.onion, &inv.device, &rid, &serde_json::to_string(&req).unwrap_or_default());
        self.waiting.insert(rid, inv.clone());
        self.status.push(format!("Asked to join \u{201c}{}\u{201d}: waiting for the inviter\u{2026}", inv.name));
        Ok(())
    }
}
