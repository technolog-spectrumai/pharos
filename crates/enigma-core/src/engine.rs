//! The room engine (port of `useChatChannel.ts`). One current room at a time, like the TS
//! channel; saved rooms are kept in the kv.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use base64::Engine as _;
use enigmatite::mls::{At, Sessions, Store};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Map, Value};

use crate::mailbox::{self, Place};
use crate::traits::{reset_message, Clock, Kv, Mailbox, Signer, Transport};
use crate::types::{Event, Grant, LinkStatus, Message, MessageKind, MlsStatus, Notice, Participant, RoomEntry};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const PEERS_DEBOUNCE_MS: u64 = 1000;
const CREATOR_WAIT_MS: u64 = 5000;
const RESET_DEDUPE_MS: u64 = 30_000;
const RESET_MAX_AGE_MS: u64 = 5 * 60_000;
const FRESH_PRESENCE_MS: u64 = 120_000;
const MAP_SHARE_TYPES: [&str; 3] = ["map_pin", "map_loc", "map_region"];
const SYNC_PREFIXES: [&str; 6] = ["sync_", "file_", "meeting_", "vox_", "dlink_", "plink_"];

/// What the engine runs on.
pub struct Deps {
    /// The mesh / Beacon link.
    pub transport: Box<dyn Transport + Send>,
    /// The device key (MLS identity, reset signatures).
    pub signer: Box<dyn Signer + Send>,
    /// Saved rooms, admitted flags, mailbox place, the timeline log.
    pub kv: Box<dyn Kv + Send>,
    /// Where MLS sessions are saved (enigmatite's store).
    pub store: Arc<dyn Store + Send + Sync>,
    /// The room's Beacon mailbox, if any.
    pub mailbox: Option<Box<dyn Mailbox + Send>>,
    /// Time.
    pub clock: Box<dyn Clock + Send>,
}

/// Settings.
#[derive(Clone, Debug)]
pub struct Config {
    /// Messages kept in a room's log.
    pub history_cap: usize,
    /// How long a joiner waits to be admitted before being told nobody did (s).
    pub connect_timeout_secs: u64,
    /// The Beacon a room created here uses.
    pub beacon_for_new_room: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self { history_cap: 500, connect_timeout_secs: 60, beacon_for_new_room: None }
    }
}

#[derive(Clone)]
struct Presence {
    name: String,
    avatar: String,
    onion: String,
}

#[derive(Clone)]
struct Current {
    slug: String,
    name: String,
}

/// The room engine.
pub struct Engine {
    cfg: Config,
    d: Deps,
    sessions: Sessions,
    identity: String,
    user_name: String,
    avatar: String,
    room: Option<Current>,
    messages: Vec<Message>,
    roster: Vec<Participant>,
    link: LinkStatus,
    mls: MlsStatus,
    mls_error: Option<String>,
    error: Option<String>,
    unread: usize,
    my_onion: String,
    linked: Vec<String>,
    presence: BTreeMap<String, Presence>,
    rooms: Vec<RoomEntry>,
    saw_foreign: bool,
    processed_resets: HashMap<String, u64>,
    recovering: bool,
    gen: u64,
    creator_at: Option<(u64, u64)>,
    admission_at: Option<u64>,
    reset_ready_at: Option<u64>,
    peers_at: Option<u64>,
    mailbox_at: Option<u64>,
    place: Place,
    place_room: String,
    unsent: Vec<Value>,
    events: Vec<Event>,
}

fn rand_id() -> String {
    let mut b = [0u8; 12];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

fn rand_unit() -> f64 {
    (OsRng.next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

fn err_mismatch(e: &str) -> bool {
    e.to_lowercase().contains("group id differs")
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn is_onion(s: &str) -> bool {
    s.len() == 62 && s.ends_with(".onion") && s[..56].bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

impl Engine {
    /// A new engine; loads the saved rooms. The MLS identity is the signer's device id.
    pub fn new(d: Deps, cfg: Config) -> Self {
        let identity = d.signer.device_id();
        let mut e = Self {
            cfg,
            d,
            sessions: Sessions::default(),
            identity,
            user_name: String::new(),
            avatar: String::new(),
            room: None,
            messages: Vec::new(),
            roster: Vec::new(),
            link: LinkStatus::Disconnected,
            mls: MlsStatus::Idle,
            mls_error: None,
            error: None,
            unread: 0,
            my_onion: String::new(),
            linked: Vec::new(),
            presence: BTreeMap::new(),
            rooms: Vec::new(),
            saw_foreign: false,
            processed_resets: HashMap::new(),
            recovering: false,
            gen: 0,
            creator_at: None,
            admission_at: None,
            reset_ready_at: None,
            peers_at: None,
            mailbox_at: None,
            place: Place::default(),
            place_room: String::new(),
            unsent: Vec::new(),
            events: Vec::new(),
        };
        e.load_rooms();
        e
    }

    // ── state the UI reads ───────────────────────────────────────────────────

    /// The events since the last drain.
    pub fn drain_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }
    /// The timeline of the current room.
    #[must_use]
    pub fn messages(&self) -> &[Message] {
        &self.messages
    }
    /// The roster of the current room.
    #[must_use]
    pub fn roster(&self) -> &[Participant] {
        &self.roster
    }
    /// The encryption state.
    #[must_use]
    pub fn mls_status(&self) -> MlsStatus {
        self.mls
    }
    /// Why encryption failed.
    #[must_use]
    pub fn mls_error(&self) -> Option<&str> {
        self.mls_error.as_deref()
    }
    /// The last action's error.
    #[must_use]
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
    /// The link state.
    #[must_use]
    pub fn link_status(&self) -> LinkStatus {
        self.link
    }
    /// The current room's slug.
    #[must_use]
    pub fn current_room(&self) -> Option<&str> {
        self.room.as_ref().map(|r| r.slug.as_str())
    }
    /// The saved rooms.
    #[must_use]
    pub fn rooms(&self) -> &[RoomEntry] {
        &self.rooms
    }
    /// This device's id (MLS identity).
    #[must_use]
    pub fn device_id(&self) -> &str {
        &self.identity
    }
    /// Our onion for the current room.
    #[must_use]
    pub fn my_onion(&self) -> &str {
        &self.my_onion
    }
    /// Messages received since [`Engine::clear_unread`].
    #[must_use]
    pub fn unread(&self) -> usize {
        self.unread
    }
    /// Resets the unread count.
    pub fn clear_unread(&mut self) {
        self.unread = 0;
    }
    /// The current group's members (device ids), from MLS.
    #[must_use]
    pub fn members(&self) -> Vec<String> {
        self.room.as_ref().map_or_else(Vec::new, |r| self.mls_members(&r.slug))
    }

    /// Our display name (rides presence and the sealed `from`).
    pub fn set_user_name(&mut self, name: &str) {
        self.user_name = name.trim().to_string();
    }
    /// Our avatar (data URL, "" = none); re-announced at once.
    pub fn set_avatar(&mut self, avatar: &str) {
        if self.avatar == avatar {
            return;
        }
        self.avatar = avatar.to_string();
        self.refresh_roster();
        self.announce_presence(true);
    }

    fn display_name(&self) -> String {
        if self.user_name.is_empty() { self.identity.clone() } else { self.user_name.clone() }
    }
    fn now(&self) -> u64 {
        self.d.clock.now_ms()
    }

    // ── MLS (enigmatite) ─────────────────────────────────────────────────────

    fn key(room: &str, identity: &str) -> String {
        format!("{room}\0{identity}")
    }
    fn with_at<T>(&self, room: &str, f: impl FnOnce(&Sessions, &dyn Store, At<'_>) -> T) -> T {
        let k = Self::key(room, &self.identity);
        f(&self.sessions, &*self.d.store, At { key: &k, room, identity: &self.identity })
    }
    fn mls_members(&self, room: &str) -> Vec<String> {
        self.with_at(room, |s, st, at| s.members(st, at)).unwrap_or_default()
    }
    fn mls_clear(&self, room: &str) {
        self.with_at(room, |s, st, at| s.clear(st, at));
    }

    // ── events, notices, timeline ────────────────────────────────────────────

    fn emit(&mut self, e: Event) {
        self.events.push(e);
    }
    fn set_mls(&mut self, st: MlsStatus) {
        if self.mls == st {
            return;
        }
        self.mls = st;
        self.emit(Event::MlsStatusChanged(st));
        if st == MlsStatus::Ready {
            if let Some(r) = self.room.clone() {
                self.d.kv.put("chat:admitted", &r.slug, "1");
            }
            self.announce_presence(false);
            self.refresh_roster();
        }
    }
    fn system_row(&self, n: Notice) -> Message {
        Message {
            id: rand_id(),
            kind: MessageKind::System,
            user: "System".into(),
            device_id: None,
            content: n.text.clone(),
            image_data: None,
            audio_data: None,
            is_self: false,
            encrypted: false,
            ts: self.now(),
            via_mailbox: false,
            notice: Some(n),
        }
    }
    fn notice(&mut self, key: &str, fallback: &str, params: &[(&str, &str)], error: bool) {
        let n = Notice::new(key, fallback, params, error);
        let row = self.system_row(n.clone());
        self.messages.push(row);
        self.emit(Event::Notice(n));
    }
    fn info(&mut self, key: &str, fallback: &str) {
        self.notice(key, fallback, &[], false);
    }
    fn fail(&mut self, key: &str, fallback: &str) {
        self.notice(key, fallback, &[], true);
    }
    fn reset_timeline(&mut self, notice: Option<Notice>) {
        self.messages.clear();
        if let Some(n) = notice {
            let row = self.system_row(n);
            self.messages.push(row);
        }
        self.emit(Event::TimelineReset);
    }

    fn push_message(&mut self, msg: Message) {
        if msg.is_human() && self.messages.iter().any(|m| m.id == msg.id) {
            return;
        }
        if !msg.is_self {
            self.unread += 1;
        }
        if let (Some(r), true) = (self.room.clone(), msg.is_human()) {
            let mut log = self.load_log(&r.slug);
            log.push(msg.clone());
            let cap = self.cfg.history_cap;
            if log.len() > cap {
                log.drain(..log.len() - cap);
            }
            self.d.kv.put("chat:log", &r.slug, &serde_json::to_string(&log).unwrap_or_default());
        }
        self.messages.push(msg.clone());
        self.emit(Event::MessageAdded(msg));
    }
    fn load_log(&self, slug: &str) -> Vec<Message> {
        self.d.kv.get("chat:log", slug).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }
    /// The stored timeline comes back first, so a reopened room isn't blank.
    fn restore_timeline(&mut self, slug: &str) {
        let me = self.identity.clone();
        let stored: Vec<Message> = self
            .load_log(slug)
            .into_iter()
            .filter(|m| !self.messages.iter().any(|x| x.id == m.id))
            .map(|mut m| {
                m.is_self = m.device_id.as_deref() == Some(me.as_str());
                m
            })
            .collect();
        if !stored.is_empty() {
            let live = std::mem::take(&mut self.messages);
            self.messages = stored;
            self.messages.extend(live);
            self.emit(Event::TimelineReset);
        }
    }

    // ── sending ──────────────────────────────────────────────────────────────

    fn send(&mut self, mut payload: Value) {
        let Some(slug) = self.room.as_ref().map(|r| r.slug.clone()) else { return };
        if self.d.mailbox.is_some() && payload.get("ts").and_then(Value::as_u64).is_none() {
            payload["ts"] = json!(self.now());
        }
        let text = payload.to_string();
        self.d.transport.send(&slug, &text);
        if self.d.mailbox.is_some() {
            self.mailbox_out(&slug, &text);
        }
    }

    /// Seals an inner message and sends it as `{type:"mls_app", ciphertext}` (sealed sender).
    fn send_inner(&mut self, ty: &str, payload: Value, msg_id: Option<&str>) -> Result<(), String> {
        let slug = self.room.as_ref().map(|r| r.slug.clone()).ok_or("no room")?;
        let mut inner = Map::new();
        inner.insert("type".into(), json!(ty));
        if let Some(id) = msg_id {
            inner.insert("msg_id".into(), json!(id));
        }
        inner.insert("from".into(), json!({ "id": self.identity, "name": self.display_name() }));
        if let Value::Object(p) = payload {
            inner.extend(p);
        }
        let plain = Value::Object(inner).to_string().into_bytes();
        let ct = self.with_at(&slug, |s, st, at| s.encrypt(st, at, plain))?;
        self.send(json!({ "type": "mls_app", "ciphertext": B64.encode(ct) }));
        Ok(())
    }

    fn own_row(&self, id: String, kind: MessageKind, content: &str) -> Message {
        Message {
            id,
            kind,
            user: self.display_name(),
            device_id: Some(self.identity.clone()),
            content: content.to_string(),
            image_data: None,
            audio_data: None,
            is_self: true,
            encrypted: true,
            ts: self.now(),
            via_mailbox: false,
            notice: None,
        }
    }

    fn not_ready(&mut self) -> bool {
        if self.mls == MlsStatus::Ready {
            return false;
        }
        self.fail("chat.sys.notReady", "Encryption not ready yet — try again in a moment.");
        true
    }

    /// Sends a text (`sendMessage`). Never in the clear: refused before the room is encrypted.
    pub fn send_text(&mut self, text: &str) {
        let text = text.trim();
        if text.is_empty() || self.room.is_none() || self.not_ready() {
            return;
        }
        let id = rand_id();
        if self.send_inner("text", json!({ "text": text }), Some(&id)).is_ok() {
            let row = self.own_row(id, MessageKind::Text, text);
            self.push_message(row);
        } else {
            self.fail("chat.sys.encryptFailed", "Encryption failed — message not sent.");
        }
    }

    /// Sends an image (data URL; the app downscales it) (`sendImage`).
    pub fn send_image(&mut self, data_url: &str) {
        if self.room.is_none() || self.not_ready() {
            return;
        }
        let id = rand_id();
        match self.send_inner("image_message", json!({ "image_data": data_url }), Some(&id)) {
            Ok(()) => {
                let mut row = self.own_row(id, MessageKind::Image, "");
                row.image_data = Some(data_url.into());
                self.push_message(row);
            }
            Err(e) => self.set_error(e),
        }
    }

    /// Sends a voice message (data URL) (`sendAudio`).
    pub fn send_voice(&mut self, data_url: &str) {
        if self.room.is_none() || self.not_ready() {
            return;
        }
        let id = rand_id();
        match self.send_inner("voice_message", json!({ "audio_data": data_url }), Some(&id)) {
            Ok(()) => {
                let mut row = self.own_row(id, MessageKind::Voice, "");
                row.audio_data = Some(data_url.into());
                self.push_message(row);
            }
            Err(e) => self.set_error(e),
        }
    }

    /// Sends a control message over the group (`sendSync`: `file_offer`, `file_accept`, …).
    ///
    /// # Errors
    /// No room, or encryption failed.
    pub fn send_sync(&mut self, kind: &str, payload: Value) -> Result<(), String> {
        if self.mls != MlsStatus::Ready {
            return Err("encryption not ready".into());
        }
        self.send_inner(kind, payload, None)
    }

    /// A local notice (`postSystemNotice`); nothing is sent.
    pub fn post_system_notice(&mut self, text: &str) {
        self.notice("", text, &[], false);
    }

    fn set_error(&mut self, e: String) {
        self.error = Some(e.clone());
        self.emit(Event::Error(e));
    }

    fn announce_presence(&mut self, reply: bool) {
        if self.mls != MlsStatus::Ready || self.room.is_none() {
            return;
        }
        let mut p = json!({
            "device_id": self.identity, "name": self.display_name(), "avatar": self.avatar,
            "onion": self.my_onion, "reply": reply,
        });
        if let Some(b) = self.room_beacon() {
            p["beacon"] = json!(b);
        }
        let _ = self.send_inner("presence", p, None);
    }

    // ── roster, peers, Beacon ───────────────────────────────────────────────

    fn refresh_roster(&mut self) {
        let Some(r) = self.room.clone() else { return };
        let mut ids = self.mls_members(&r.slug);
        if ids.is_empty() {
            ids.push(self.identity.clone());
        }
        ids.sort();
        let list: Vec<Participant> = ids
            .into_iter()
            .map(|id| {
                if id == self.identity {
                    return Participant { id, name: self.display_name(), avatar: self.avatar.clone(), linked: false, is_self: true };
                }
                let info = self.presence.get(&id);
                let linked = info.is_some_and(|i| !i.onion.is_empty() && self.linked.contains(&i.onion));
                let name = match info.map(|i| i.name.as_str()).filter(|n| !n.is_empty()) {
                    Some(n) => n.to_string(),
                    None if id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => format!("Member {}", &id[..6]),
                    None => id.clone(),
                };
                Participant { avatar: info.map(|i| i.avatar.clone()).unwrap_or_default(), id, name, linked, is_self: false }
            })
            .collect();
        self.schedule_peers();
        if list != self.roster {
            self.roster = list.clone();
            self.emit(Event::RosterChanged(list));
        }
    }

    fn schedule_peers(&mut self) {
        if self.room.is_some() {
            self.peers_at = Some(self.now() + PEERS_DEBOUNCE_MS);
        }
    }

    fn flush_peers(&mut self) {
        let Some(r) = self.room.clone() else { return };
        let mut peers: Vec<String> = self.entry(&r.slug).map(|e| e.peers.clone()).unwrap_or_default();
        for p in self.presence.values() {
            if !p.onion.is_empty() && !peers.contains(&p.onion) {
                peers.push(p.onion.clone());
            }
        }
        peers.retain(|o| *o != self.my_onion);
        self.d.transport.set_peers(&r.slug, &peers);
        self.update_entry(&r.slug, |e| e.peers = peers.clone());
    }

    fn room_beacon(&self) -> Option<String> {
        self.room.as_ref().and_then(|r| self.entry(&r.slug)).and_then(|e| e.beacon.clone())
    }

    /// A member told us the room's Beacon: the first one heard is kept.
    fn learn_beacon(&mut self, onion: Option<&str>) {
        let (Some(r), Some(o)) = (self.room.clone(), onion) else { return };
        if !is_onion(o) || self.room_beacon().is_some() {
            return;
        }
        self.update_entry(&r.slug, |e| e.beacon = Some(o.to_string()));
    }

    // ── saved rooms ──────────────────────────────────────────────────────────

    fn load_rooms(&mut self) {
        self.rooms = self.d.kv.get("p2p:rooms", "default").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    }
    fn persist_rooms(&mut self) {
        self.d.kv.put("p2p:rooms", "default", &serde_json::to_string(&self.rooms).unwrap_or_default());
        self.emit(Event::RoomsChanged);
    }
    fn entry(&self, slug: &str) -> Option<&RoomEntry> {
        self.rooms.iter().find(|r| r.room == slug)
    }
    fn update_entry(&mut self, slug: &str, f: impl FnOnce(&mut RoomEntry)) {
        if let Some(e) = self.rooms.iter_mut().find(|r| r.room == slug) {
            let before = e.clone();
            f(e);
            if *e != before {
                self.persist_rooms();
            }
        }
    }
    fn remember_room(&mut self, entry: RoomEntry) {
        match self.rooms.iter_mut().find(|r| r.room == entry.room) {
            Some(e) => {
                e.name = entry.name;
                e.host |= entry.host;
                if entry.onion.is_some() {
                    e.onion = entry.onion;
                }
                if entry.beacon.is_some() {
                    e.beacon = entry.beacon;
                }
                if !entry.peers.is_empty() {
                    e.peers = entry.peers;
                }
            }
            None => self.rooms.insert(0, entry),
        }
        self.persist_rooms();
    }
    fn forget_room(&mut self, slug: &str) {
        let n = self.rooms.len();
        self.rooms.retain(|r| r.room != slug);
        if self.rooms.len() != n {
            self.persist_rooms();
        }
    }

    // ── lifecycle ────────────────────────────────────────────────────────────

    fn teardown(&mut self) {
        self.gen += 1;
        self.creator_at = None;
        self.admission_at = None;
        self.reset_ready_at = None;
        self.peers_at = None;
        self.mailbox_at = None;
        if let Some(r) = self.room.clone() {
            self.d.transport.leave_room(&r.slug);
        }
    }

    fn enter_view(&mut self, slug: &str, name: &str, onion: &str) {
        self.gen += 1;
        self.presence.clear();
        self.peers_at = None;
        self.my_onion = onion.to_string();
        self.linked.clear();
        self.saw_foreign = false;
        self.room = Some(Current { slug: slug.into(), name: name.into() });
        self.emit(Event::RoomChanged(Some(slug.into())));
        self.roster = vec![Participant { id: self.identity.clone(), name: self.display_name(), avatar: self.avatar.clone(), linked: false, is_self: true }];
        self.emit(Event::RosterChanged(self.roster.clone()));
        self.mls = MlsStatus::Idle;
        self.emit(Event::MlsStatusChanged(MlsStatus::Idle));
        self.mls_error = None;
        let st = self.d.transport.last_status(slug).unwrap_or(LinkStatus::Waiting);
        self.link = st;
        self.emit(Event::LinkStatusChanged(st));
        self.restore_timeline(slug);
        if self.d.mailbox.is_some() {
            self.load_place(slug);
            self.schedule_mailbox();
        }
    }

    fn clear_messages(&mut self) {
        self.reset_timeline(None);
    }

    /// Creates a room and enters it: a group of one at once (`createRoom`).
    pub fn create_room(&mut self, name: &str) -> Option<String> {
        self.error = None;
        self.teardown();
        self.clear_messages();
        match self.d.transport.create_room(name.trim()) {
            Ok(res) => {
                let beacon = self.cfg.beacon_for_new_room.clone();
                self.remember_room(RoomEntry { room: res.room.clone(), name: res.name.clone(), host: true, onion: Some(res.onion.clone()), beacon, peers: vec![] });
                self.enter_view(&res.room, &res.name, &res.onion);
                self.start_mls(true);
                self.refresh_roster();
                self.notice("chat.sys.created", "Created “{name}”. Invite someone to let them in.", &[("name", &res.name)], false);
                Some(res.room)
            }
            Err(e) => {
                self.set_error(e);
                None
            }
        }
    }

    /// Reopens a saved room: same onion, links to its saved peers, kept MLS session
    /// (`openP2pRoom`).
    pub fn open_room(&mut self, slug: &str) {
        if self.current_room() == Some(slug) {
            return;
        }
        let Some(entry) = self.entry(slug).cloned() else {
            self.set_error(format!("unknown room {slug}"));
            return;
        };
        self.error = None;
        self.teardown();
        self.clear_messages();
        match self.d.transport.join_room(&entry.name, &entry.peers) {
            Ok(res) => {
                if entry.onion.as_deref() != Some(res.onion.as_str()) {
                    let o = res.onion.clone();
                    self.update_entry(slug, |e| e.onion = Some(o));
                }
                self.enter_view(slug, &entry.name, &res.onion);
                self.start_mls(false);
            }
            Err(e) => self.set_error(e),
        }
    }

    /// Aborts an in-flight join.
    pub fn cancel_join(&mut self) {
        self.d.transport.cancel_join();
        self.error = None;
    }

    /// The redeemer's first half: a key package built under a scratch room (the room is not
    /// known until the grant names it). Base64.
    ///
    /// # Errors
    /// When rotor refuses.
    pub fn invite_key_package(&mut self, scratch_room: &str) -> Result<String, String> {
        self.with_at(scratch_room, |s, st, at| {
            s.init(st, at)?;
            s.key_package(st, at)
        })
        .map(|kp| B64.encode(kp))
    }

    /// Admits someone who redeemed an invitation: adds their key package, broadcasts the
    /// commit, returns the Welcome, the room's name and the onions to link to
    /// (`admitInvited`). `None`: the room is not open or not ready, or MLS refused.
    pub fn admit_invited(&mut self, room: &str, key_package_b64: &str) -> Option<Grant> {
        let r = self.room.clone().filter(|r| r.slug == room)?;
        if self.mls != MlsStatus::Ready {
            return None;
        }
        let kp = B64.decode(key_package_b64).ok()?;
        let (welcome, commit) = self.with_at(room, |s, st, at| s.add_member(st, at, &kp)).ok()?;
        self.send(json!({ "type": "mls_commit", "commit": B64.encode(commit) }));
        self.refresh_roster();
        let mut peers = vec![self.my_onion.clone()];
        for p in self.presence.values() {
            if !p.onion.is_empty() && !peers.contains(&p.onion) {
                peers.push(p.onion.clone());
            }
        }
        peers.retain(|p| !p.is_empty());
        Some(Grant { welcome: B64.encode(welcome), room_name: r.name, peers })
    }

    /// The redeemer's second half: moves the scratch session onto the room, joins from the
    /// Welcome, opens the room and links to the granted members (`joinByInvite`).
    pub fn join_by_invite(&mut self, grant: &Grant, scratch_room: &str) -> bool {
        self.error = None;
        self.teardown();
        self.clear_messages();
        let res = match self.d.transport.join_room(grant.room_name.trim(), &grant.peers) {
            Ok(r) => r,
            Err(e) => {
                self.set_error(e);
                return false;
            }
        };
        let slug = res.room.clone();
        let peers: Vec<String> = grant.peers.iter().filter(|o| **o != res.onion).cloned().collect();
        self.remember_room(RoomEntry { room: slug.clone(), name: res.name.clone(), peers, onion: Some(res.onion.clone()), ..Default::default() });
        self.enter_view(&slug, &res.name, &res.onion);
        self.set_mls(MlsStatus::Initializing);
        self.notice("chat.sys.joined", "Joined “{name}”. Connecting to the others…", &[("name", &res.name)], false);
        let (from_k, to_k) = (Self::key(scratch_room, &self.identity), Self::key(&slug, &self.identity));
        let adopted = self.sessions.adopt(
            &*self.d.store,
            At { key: &from_k, room: scratch_room, identity: &self.identity },
            At { key: &to_k, room: &slug, identity: &self.identity },
        );
        if adopted.is_err() {
            self.set_mls(MlsStatus::Error);
            self.mls_error = Some("Could not take up the invitation's encrypted session.".into());
            return false;
        }
        let joined = B64.decode(&grant.welcome).map_err(|e| e.to_string()).and_then(|w| self.with_at(&slug, |s, st, at| s.join_from_welcome(st, at, &w)));
        if joined.is_err() {
            self.set_mls(MlsStatus::Error);
            self.mls_error = Some("Failed to join encrypted group.".into());
            return false;
        }
        self.set_mls(MlsStatus::Ready);
        self.info("chat.sys.encrypted", "🔒 End-to-end encryption active.");
        self.schedule_peers();
        true
    }

    /// Leaves the current room: tells the group (a remaining member removes us), resets the view
    /// (`leaveParticipant`).
    pub fn leave(&mut self) {
        if self.room.is_none() {
            return;
        }
        if self.mls == MlsStatus::Ready {
            let id = self.identity.clone();
            let _ = self.send_inner("leave", json!({ "device_id": id }), None);
        }
        self.presence.clear();
        self.teardown();
        self.room = None;
        self.emit(Event::RoomChanged(None));
        self.clear_messages();
        self.roster.clear();
        self.set_mls(MlsStatus::Idle);
    }

    /// Deletes a saved room: `room_closed` if we host it (and it is open), `leave` if we only
    /// joined; then wipes the MLS state, the entry, the log and our onion (`deleteRoom`).
    pub fn delete_room(&mut self, slug: &str) {
        let Some(entry) = self.entry(slug).cloned() else { return };
        let current = self.current_room() == Some(slug);
        if current && self.mls == MlsStatus::Ready {
            let id = self.identity.clone();
            let _ = self.send_inner(if entry.host { "room_closed" } else { "leave" }, json!({ "device_id": id }), None);
        }
        self.mls_clear(slug);
        self.d.kv.delete("chat:admitted", slug);
        self.d.transport.forget_onion(&entry.name);
        self.d.kv.delete("chat:log", slug);
        self.forget_room(slug);
        if current {
            self.clear_local(Notice::new("chat.sys.roomDeleted", "Room deleted.", &[], false));
        } else {
            self.d.transport.leave_room(slug);
        }
    }

    fn handle_room_closed(&mut self) {
        let Some(r) = self.room.clone() else { return };
        self.mls_clear(&r.slug);
        self.d.kv.delete("chat:admitted", &r.slug);
        self.d.transport.forget_onion(&r.name);
        self.d.kv.delete("chat:log", &r.slug);
        self.forget_room(&r.slug);
        self.clear_local(Notice::new("chat.sys.roomDeletedByHost", "This room was deleted by the host.", &[], false));
        self.emit(Event::RoomClosed(r.slug));
    }

    /// Leaves every chat; the notice is the only row left (`clearLocalChatState`).
    pub fn clear_local(&mut self, notice: Notice) {
        self.teardown();
        if self.room.take().is_some() {
            self.emit(Event::RoomChanged(None));
        }
        self.reset_timeline(Some(notice));
        self.roster.clear();
        self.set_mls(MlsStatus::Idle);
        self.mls_error = None;
        self.recovering = false;
    }

    // ── MLS start, reset, recovery ───────────────────────────────────────────

    fn start_mls(&mut self, alone: bool) {
        let Some(r) = self.room.clone() else { return };
        if !matches!(self.mls, MlsStatus::Idle | MlsStatus::Error) {
            return;
        }
        let gen = self.gen;
        self.set_mls(MlsStatus::Initializing);
        self.mls_error = None;
        let restored = match self.with_at(&r.slug, |s, st, at| s.init(st, at)) {
            Ok(b) => b,
            Err(e) => {
                self.set_mls(MlsStatus::Error);
                self.mls_error = Some(e.clone());
                self.notice("chat.sys.initFailed", "Encryption init failed: {why}", &[("why", &e)], true);
                return;
            }
        };
        if restored && self.d.kv.get("chat:admitted", &r.slug).as_deref() == Some("1") {
            self.set_mls(MlsStatus::Ready);
            self.info("chat.sys.encrypted", "🔒 End-to-end encryption active.");
            self.catch_up_mailbox();
            return;
        }
        let kp = match self.with_at(&r.slug, |s, st, at| s.key_package(st, at)) {
            Ok(kp) => kp,
            Err(e) => {
                self.set_mls(MlsStatus::Error);
                self.mls_error = Some(e.clone());
                self.notice("chat.sys.initFailed", "Encryption init failed: {why}", &[("why", &e)], true);
                return;
            }
        };
        let b64 = B64.encode(kp);
        let (id, name) = (self.identity.clone(), self.display_name());
        self.send(json!({ "type": "mls_key_package", "key_package": b64, "package": b64, "device_id": id, "user": name }));
        if !alone {
            self.info("chat.sys.settingUp", "🔑 Setting up encryption…");
        }
        self.set_mls(MlsStatus::KeyExchange);
        self.catch_up_mailbox();
        if alone {
            self.creator_fire(gen);
        } else {
            self.creator_at = Some((self.now() + CREATOR_WAIT_MS, gen));
        }
    }

    fn creator_fire(&mut self, gen: u64) {
        if gen != self.gen || self.mls != MlsStatus::KeyExchange {
            return;
        }
        if self.saw_foreign {
            // Others are here and none admitted us: no green lock over a group nobody reads.
            self.admission_at = Some(self.now() + self.cfg.connect_timeout_secs * 1000);
            return;
        }
        self.set_mls(MlsStatus::Ready);
        self.info("chat.sys.encrypted", "🔒 End-to-end encryption active.");
    }

    /// Starts the room's group over (`forceResetMls`): broadcasts a signed reset request when
    /// `broadcast`, clears the history, makes a fresh group (ready after 5 s).
    pub fn force_reset(&mut self, broadcast: bool) {
        let Some(r) = self.room.clone() else { return };
        if broadcast {
            let reset_id = rand_id();
            let ts = self.now();
            let sig = self.d.signer.sign(&reset_message(&r.slug, &reset_id, ts));
            let id = self.identity.clone();
            self.send(json!({ "type": "mls_reset_request", "device_id": id, "reset_id": reset_id, "ts": ts, "sig": sig }));
            self.processed_resets.insert(reset_id, ts + RESET_DEDUPE_MS);
        }
        self.set_mls(MlsStatus::Initializing);
        self.mls_error = None;
        self.recovering = false;
        self.reset_timeline(Some(Notice::new("chat.sys.sessionReset", "🔄 Session reset — history cleared.", &[], false)));
        self.mls_clear(&r.slug);
        let kp = self.with_at(&r.slug, |s, st, at| {
            s.init(st, at)?;
            s.key_package(st, at)
        });
        match kp {
            Ok(kp) => {
                let b64 = B64.encode(kp);
                let (id, name) = (self.identity.clone(), self.display_name());
                self.send(json!({ "type": "mls_key_package", "key_package": b64, "package": b64, "device_id": id, "user": name }));
                self.set_mls(MlsStatus::KeyExchange);
                self.info("chat.sys.freshKp", "🔑 Fresh key package sent.");
                self.reset_ready_at = Some(self.now() + CREATOR_WAIT_MS);
            }
            Err(e) => {
                self.set_mls(MlsStatus::Error);
                self.mls_error = Some(e.clone());
                self.notice("chat.sys.resetFailed", "Reset failed: {err}", &[("err", &e)], true);
            }
        }
    }

    fn request_fresh_invite(&mut self, reason: &str) {
        let Some(r) = self.room.clone() else { return };
        if self.recovering {
            return;
        }
        self.recovering = true;
        self.set_mls(MlsStatus::KeyExchange);
        self.mls_error = Some(reason.to_string());
        self.mls_clear(&r.slug);
        let kp = self.with_at(&r.slug, |s, st, at| {
            s.init(st, at)?;
            s.key_package(st, at)
        });
        match kp {
            Ok(kp) => {
                let b64 = B64.encode(kp);
                let id = self.identity.clone();
                self.send(json!({ "type": "mls_key_package", "key_package": b64, "device_id": id }));
                self.info("chat.sys.groupChanged", "🔑 MLS group changed — sent a fresh key package.");
            }
            Err(e) => {
                self.set_mls(MlsStatus::Error);
                self.mls_error = Some(e.clone());
                self.notice("chat.sys.recoverFailedWhy", "Could not recover MLS session: {why}", &[("why", &e)], true);
            }
        }
        self.recovering = false;
    }

    fn reset_is_genuine(&self, data: &Value) -> bool {
        let Some(r) = &self.room else { return false };
        let (Some(id), Some(rid), Some(ts), Some(sig)) = (str_of(data, "device_id"), str_of(data, "reset_id"), data.get("ts").and_then(Value::as_u64), str_of(data, "sig")) else {
            return false;
        };
        if self.now().abs_diff(ts) > RESET_MAX_AGE_MS {
            return false;
        }
        if !self.mls_members(&r.slug).iter().any(|m| m == id) {
            return false;
        }
        self.d.signer.verify(id, &reset_message(&r.slug, rid, ts), sig)
    }

    // ── time ─────────────────────────────────────────────────────────────────

    /// Runs what is due: the lone-room wait, the admission deadline, the reset's new group, the
    /// debounced peers, the Poisson-timed mailbox catch-up. Call it often (every ~250 ms).
    pub fn tick(&mut self) {
        let now = self.now();
        self.processed_resets.retain(|_, until| *until > now);
        if let Some((at, gen)) = self.creator_at {
            if now >= at {
                self.creator_at = None;
                self.creator_fire(gen);
            }
        }
        if self.admission_at.is_some_and(|at| now >= at) {
            self.admission_at = None;
            if self.mls == MlsStatus::KeyExchange {
                self.notice(
                    "chat.sys.notAdmitted",
                    "No one admitted you to this room. It may require an invitation — ask whoever shared it for one.",
                    &[],
                    true,
                );
            }
        }
        if self.reset_ready_at.is_some_and(|at| now >= at) {
            self.reset_ready_at = None;
            if self.mls == MlsStatus::KeyExchange {
                self.set_mls(MlsStatus::Ready);
                self.info("chat.sys.newGroup", "🔒 New encryption group created.");
            }
        }
        if self.peers_at.is_some_and(|at| now >= at) {
            self.peers_at = None;
            self.flush_peers();
        }
        if self.mailbox_at.is_some_and(|at| now >= at) {
            self.catch_up_mailbox();
            self.schedule_mailbox();
        }
    }

    // ── mailbox ──────────────────────────────────────────────────────────────

    fn load_place(&mut self, slug: &str) {
        if self.place_room == slug {
            return;
        }
        self.place_room = slug.to_string();
        self.place = self.d.kv.get("chat:mailbox", &format!("{slug}:place")).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        self.unsent = self.d.kv.get("chat:mailbox", &format!("{slug}:unsent")).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    }
    fn save_place(&self, slug: &str) {
        if self.place_room != slug {
            return;
        }
        self.d.kv.put("chat:mailbox", &format!("{slug}:place"), &serde_json::to_string(&self.place).unwrap_or_default());
        self.d.kv.put("chat:mailbox", &format!("{slug}:unsent"), &serde_json::to_string(&self.unsent).unwrap_or_default());
    }
    fn flush_unsent(&mut self, slug: &str) {
        let Some(mb) = &self.d.mailbox else { return };
        while let Some(first) = self.unsent.first() {
            if mb.post(first).is_err() {
                break; // the server does not answer: later
            }
            self.unsent.remove(0);
        }
        self.save_place(slug);
    }
    fn mailbox_out(&mut self, slug: &str, frame: &str) {
        let Some(env) = mailbox::envelope(slug, frame) else { return };
        if self.place_room != slug {
            return;
        }
        mailbox::note(&mut self.place, frame);
        self.unsent.push(env);
        self.flush_unsent(slug);
    }
    /// Exponential (Poisson) gaps around `every_ms`, clamped to [every/6, 4·every].
    fn schedule_mailbox(&mut self) {
        let Some(mb) = &self.d.mailbox else { return };
        let every = mb.every_ms() as f64;
        let gap = (-(1.0 - rand_unit()).ln() * every).clamp(every / 6.0, 4.0 * every);
        self.mailbox_at = Some(self.now() + gap as u64);
    }

    /// Feeds in what the Beacon mailbox holds that this device has not seen, then posts what
    /// waits to go (`catchUpMailbox`). No-op without a mailbox.
    pub fn catch_up_mailbox(&mut self) {
        let Some(r) = self.room.clone() else { return };
        if self.d.mailbox.is_none() {
            return;
        }
        self.load_place(&r.slug);
        let got = {
            let mb = self.d.mailbox.as_deref().expect("checked");
            mailbox::catch_up(&mut self.place, mb, &r.slug)
        };
        let Ok(frames) = got else { return };
        self.save_place(&r.slug);
        for f in frames {
            if self.current_room() != Some(r.slug.as_str()) {
                break;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&f) {
                self.handle_message(&v, true);
            }
        }
        self.flush_unsent(&r.slug);
    }

    // ── incoming ─────────────────────────────────────────────────────────────

    /// A link status from the transport (`chatTransport.onStatus`).
    pub fn handle_status(&mut self, room: &str, status: LinkStatus, peer: Option<&str>, linked: &[String]) {
        if let (Some(p), LinkStatus::Connected) = (peer, status) {
            let p = p.to_string();
            self.update_entry(room, |e| {
                if !e.peers.contains(&p) {
                    e.peers.push(p);
                }
            });
        }
        let Some(r) = self.room.clone().filter(|r| r.slug == room) else { return };
        let before = self.link;
        self.link = status;
        self.linked = linked.to_vec();
        self.refresh_roster();
        if status == before {
            return;
        }
        self.emit(Event::LinkStatusChanged(status));
        match status {
            LinkStatus::Connected => {
                self.notice("chat.sys.connected", "Connected to {room}.", &[("room", &r.name)], false);
                self.catch_up_mailbox();
            }
            LinkStatus::Disconnected if before == LinkStatus::Connected => self.info("chat.sys.disconnected", "Disconnected."),
            LinkStatus::Error => self.fail("chat.sys.connectionError", "Connection error."),
            _ => {}
        }
    }

    /// A frame (JSON text) from the transport for `room` (`chatTransport.onMessage`).
    pub fn handle_frame(&mut self, room: &str, payload: &str) {
        if self.current_room() != Some(room) {
            return;
        }
        let Ok(data) = serde_json::from_str::<Value>(payload) else { return };
        if self.d.mailbox.is_some() && self.place_room == room && mailbox::frame_id(payload).is_some() && !mailbox::note(&mut self.place, payload) {
            return; // fed in from the mailbox already, or ours
        }
        self.handle_message(&data, false);
    }

    fn handle_message(&mut self, data: &Value, via_mailbox: bool) {
        let Some(r) = self.room.clone() else { return };
        let ty = data.get("type").and_then(Value::as_str).unwrap_or("");
        match ty {
            "mls_reset_request" => {
                if str_of(data, "device_id") == Some(self.identity.as_str()) || !self.reset_is_genuine(data) {
                    return;
                }
                if let Some(rid) = str_of(data, "reset_id") {
                    if self.processed_resets.contains_key(rid) {
                        return;
                    }
                    self.processed_resets.insert(rid.to_string(), self.now() + RESET_DEDUPE_MS);
                }
                self.force_reset(false);
            }
            // Nobody gets in off the mesh: a redeemed invitation is the only way in.
            "mls_key_package" => {}
            "mls_welcome" => {
                let Some(w) = str_of(data, "welcome") else { return };
                if self.mls != MlsStatus::KeyExchange {
                    return;
                }
                self.creator_at = None;
                self.admission_at = None;
                self.info("chat.sys.gotWelcome", "🔑 Received group invitation — joining encrypted group…");
                let ok = B64.decode(w).map_err(|e| e.to_string()).and_then(|w| self.with_at(&r.slug, |s, st, at| s.join_from_welcome(st, at, &w)));
                if ok.is_ok() {
                    self.set_mls(MlsStatus::Ready);
                    self.info("chat.sys.encrypted", "🔒 End-to-end encryption active.");
                } else {
                    self.set_mls(MlsStatus::Error);
                    self.mls_error = Some("Failed to join encrypted group.".into());
                    self.fail("chat.sys.joinGroupFailed", "Failed to join encrypted group.");
                }
            }
            "mls_commit" => {
                let Some(c) = str_of(data, "commit") else { return };
                if self.mls != MlsStatus::Ready {
                    return;
                }
                let res = B64.decode(c).map_err(|e| e.to_string()).and_then(|c| self.with_at(&r.slug, |s, st, at| s.process_message(st, at, &c)));
                match res {
                    Ok(_) => self.refresh_roster(),
                    Err(_) if via_mailbox => {}
                    Err(e) if err_mismatch(&e) => self.request_fresh_invite(&e),
                    Err(e) => {
                        self.set_mls(MlsStatus::Error);
                        self.mls_error = Some(e.clone());
                        self.notice("chat.sys.commitFailed", "Could not process MLS commit: {why}", &[("why", &e)], true);
                    }
                }
            }
            "mls_app" => {
                let Some(ct) = str_of(data, "ciphertext") else { return };
                if !via_mailbox {
                    self.saw_foreign = true;
                }
                if self.mls != MlsStatus::Ready {
                    if !via_mailbox {
                        // A transient placeholder, never persisted.
                        let row = Message {
                            id: rand_id(),
                            kind: MessageKind::Placeholder,
                            user: "…".into(),
                            device_id: None,
                            content: "🔒 [encrypted — session not ready]".into(),
                            image_data: None,
                            audio_data: None,
                            is_self: false,
                            encrypted: true,
                            ts: self.now(),
                            via_mailbox: false,
                            notice: None,
                        };
                        self.messages.push(row.clone());
                        self.emit(Event::MessageAdded(row));
                    }
                    return;
                }
                let res = B64.decode(ct).map_err(|e| e.to_string()).and_then(|c| self.with_at(&r.slug, |s, st, at| s.process_message(st, at, &c)));
                match res {
                    Ok(Some(plain)) => self.handle_inner(data, &plain, via_mailbox),
                    Ok(None) => self.fail("chat.sys.decryptFailed", "⚠ Could not decrypt an incoming message."),
                    Err(_) if via_mailbox => {}
                    Err(e) if err_mismatch(&e) => self.request_fresh_invite(&e),
                    Err(e) => {
                        self.set_mls(MlsStatus::Error);
                        self.mls_error = Some(e.clone());
                        self.notice("chat.sys.decryptFailedWhy", "Could not decrypt incoming message: {why}", &[("why", &e)], true);
                    }
                }
            }
            // `cover` frames and anything else in the clear: ignored.
            _ => {}
        }
    }

    fn handle_inner(&mut self, data: &Value, plain: &[u8], via_mailbox: bool) {
        let raw = String::from_utf8_lossy(plain).to_string();
        let inner: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let sender = inner.get("from").and_then(|f| str_of(f, "id")).map(str::to_string);
        if sender.as_deref() == Some(self.identity.as_str()) {
            return; // our own, come back
        }
        let sender_name = inner.get("from").and_then(|f| str_of(f, "name")).map(str::to_string).or_else(|| sender.clone()).unwrap_or_else(|| "Unknown".into());
        let ity = inner.get("type").and_then(Value::as_str).unwrap_or("");
        let rx_id = str_of(&inner, "msg_id").map_or_else(rand_id, str::to_string);
        let now = self.now();
        let frame_ts = data.get("ts").and_then(Value::as_u64);

        match ity {
            "presence" => {
                let Some(id) = str_of(&inner, "device_id").map(str::to_string) else { return };
                if via_mailbox && !frame_ts.is_some_and(|ts| now.saturating_sub(ts) < FRESH_PRESENCE_MS) {
                    return;
                }
                if id == self.identity {
                    return;
                }
                self.presence.insert(
                    id.clone(),
                    Presence {
                        name: str_of(&inner, "name").unwrap_or(&id).to_string(),
                        avatar: str_of(&inner, "avatar").unwrap_or("").to_string(),
                        onion: str_of(&inner, "onion").unwrap_or("").to_string(),
                    },
                );
                self.learn_beacon(str_of(&inner, "beacon"));
                self.refresh_roster();
                if !inner.get("reply").and_then(Value::as_bool).unwrap_or(false) {
                    self.announce_presence(true);
                }
                return;
            }
            "leave" => {
                if let (Some(id), false) = (str_of(&inner, "device_id"), via_mailbox) {
                    let id = id.to_string();
                    self.handle_peer_leave(&id);
                }
                return;
            }
            "room_closed" => {
                self.handle_room_closed();
                return;
            }
            "room_meta" => return,
            t if t.starts_with("mod_") => return,
            t if SYNC_PREFIXES.iter().any(|p| t.starts_with(p)) => {
                self.emit(Event::Sync { kind: t.to_string(), payload: inner.clone(), sender: sender_name });
                return;
            }
            _ => {}
        }
        let sent_at = frame_ts.filter(|ts| *ts > 0 && *ts <= now + 60_000).unwrap_or(now);
        let mut row = Message {
            id: rx_id,
            kind: MessageKind::Text,
            user: sender_name,
            device_id: sender,
            content: String::new(),
            image_data: None,
            audio_data: None,
            is_self: false,
            encrypted: true,
            ts: now,
            via_mailbox,
            notice: None,
        };
        match ity {
            "image_message" => {
                let Some(d) = str_of(&inner, "image_data") else { return };
                row.kind = MessageKind::Image;
                row.image_data = Some(d.into());
            }
            "voice_message" => {
                let Some(d) = str_of(&inner, "audio_data") else { return };
                row.kind = MessageKind::Voice;
                row.audio_data = Some(d.into());
            }
            t if t.starts_with("map_") => {
                if !MAP_SHARE_TYPES.contains(&t) {
                    return;
                }
                row.kind = MessageKind::MapShare(t.into());
            }
            _ => {
                row.content = if ity == "text" { str_of(&inner, "text").unwrap_or("").to_string() } else { raw };
                if self.d.mailbox.is_some() {
                    row.ts = sent_at;
                }
            }
        }
        self.push_message(row);
    }

    fn handle_peer_leave(&mut self, device: &str) {
        let onion = self.presence.remove(device).map(|p| p.onion);
        let Some(r) = self.room.clone() else { return };
        if let Some(o) = onion.filter(|o| !o.is_empty()) {
            self.update_entry(&r.slug, |e| e.peers.retain(|p| *p != o));
        }
        let ids = self.mls_members(&r.slug);
        if ids.iter().any(|i| i == device) {
            // The smallest remaining identity removes the leaver.
            let admin = ids.iter().filter(|i| *i != device).min().cloned();
            if admin.as_deref() == Some(self.identity.as_str()) {
                if let Ok(commit) = self.with_at(&r.slug, |s, st, at| s.remove_member(st, at, device)) {
                    self.send(json!({ "type": "mls_commit", "commit": B64.encode(commit) }));
                }
            }
        }
        self.refresh_roster();
    }
}

#[allow(dead_code)]
fn assert_send() {
    fn is_send<T: Send>() {}
    is_send::<Engine>();
}
