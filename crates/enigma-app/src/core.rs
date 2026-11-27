//! The app state and its actions, independent of any UI toolkit (unit-testable).
//!
//! A front end owns one [`Core`], calls [`Core::tick`] every ~250 ms, maps clicks / keys to
//! the actions below, and redraws from the getters.

use std::collections::HashMap;

use enigma_core::{Engine, Event, LinkStatus, Message, MessageKind, MlsStatus, Participant};

use crate::backend::{build_engine, Backend, InviteRecord, MyBeacon, TorState};
use crate::vault::Vault;

fn load_friends(v: &Vault) -> Vec<Friend> {
    let raw = v.kv_get("friends", "default", "list").unwrap_or_default();
    let list: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap_or_default();
    let mut out: Vec<Friend> = list
        .iter()
        .filter_map(|f| Some(Friend { id: f["id"].as_str()?.to_string(), name: f["name"].as_str().unwrap_or("").to_string() }))
        .filter(|f| codes::is_device_id(&f.id))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}
use crate::codes;
use crate::i18n::{t, tf, Lang};

/// A paired device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Friend {
    /// Device id (64 hex).
    pub id: String,
    /// Name.
    pub name: String,
}

/// The app.
pub struct Core {
    /// The room engine.
    pub engine: Engine,
    /// The outside.
    pub backend: Box<dyn Backend>,
    /// Selected row in the rooms list (follows the engine's current room).
    pub room_sel: usize,
    /// Friends (memory only).
    pub friends: Vec<Friend>,
    /// One status line (last error or info).
    pub status: String,
    /// Unread counts per room slug.
    pub unread: HashMap<String, usize>,
    /// My display name.
    pub user_name: String,
    /// UI language.
    pub lang: Lang,
    /// File transfers in the current room.
    pub files: crate::files::Files,
    /// Notifications to show (new messages while the window is away): (title, body).
    pub notes: Vec<(String, String)>,
    /// Settings when there is no vault (demo).
    pub mem_settings: HashMap<String, String>,
    /// Whether the timeline is on screen (as last told by `tick`).
    pub viewing: bool,
}

impl Core {
    /// An app on a backend; the backend seeds or connects.
    #[must_use]
    pub fn new(mut backend: Box<dyn Backend>, name: &str) -> Self {
        let mut engine = build_engine(backend.as_ref(), name);
        backend.start(&mut engine);
        let mut friends: Vec<Friend> = backend.seed_friends().into_iter().map(|(id, name)| Friend { id, name }).collect();
        let mut lang = Lang::En;
        if let Some(v) = backend.vault() {
            friends = load_friends(v);
            if let Some(l) = v.setting("lang") {
                lang = Lang::from_code(&l);
            }
        }
        let mut c = Self {
            engine,
            backend,
            room_sel: 0,
            friends,
            status: String::new(),
            unread: HashMap::new(),
            user_name: name.into(),
            lang,
            files: crate::files::Files::new(crate::actions::downloads_dir()),
            notes: vec![],
            mem_settings: HashMap::new(),
            viewing: true,
        };
        let _ = c.engine.drain_events();
        c.sync_selection();
        c
    }

    /// A text in the current language.
    #[must_use]
    pub fn tr(&self, key: &str) -> String {
        t(self.lang, key).to_string()
    }

    fn sync_selection(&mut self) {
        if let Some(cur) = self.engine.current_room() {
            if let Some(i) = self.engine.rooms().iter().position(|r| r.room == cur) {
                self.room_sel = i;
            }
        }
    }

    /// Time passes (~250 ms): engine timers, incoming frames, events. `viewing`: the current
    /// room's timeline is on screen (else new messages count as unread).
    pub fn tick(&mut self, viewing: bool) {
        self.viewing = viewing;
        if self.backend.take_rebuild() {
            self.rebuild();
        }
        self.engine.tick();
        for (k, p) in self.files.pump() {
            if let Err(e) = self.engine.send_sync(k, p) {
                self.status = format!("Files: {e}");
            }
        }
        self.backend.poll(&mut self.engine);
        for s in self.backend.take_status() {
            self.status = s;
        }
        self.drain(viewing);
    }

    /// A fresh engine on the backend's (new) transport, back in the room we were in.
    fn rebuild(&mut self) {
        let cur = self.engine.current_room().map(str::to_string);
        self.engine = build_engine(self.backend.as_ref(), &self.user_name);
        if let Some(slug) = cur {
            self.engine.open_room(&slug);
        }
        let _ = self.engine.drain_events();
        self.sync_selection();
    }

    /// Change the UI language (kept in the vault).
    pub fn set_lang(&mut self, l: Lang) {
        self.lang = l;
        if let Some(v) = self.backend.vault() {
            v.set_setting("lang", l.code());
        }
    }

    fn save_friends(&self) {
        if let Some(v) = self.backend.vault() {
            let list: Vec<serde_json::Value> = self.friends.iter().map(|f| serde_json::json!({ "id": f.id, "name": f.name, "addedAt": 0 })).collect();
            v.kv_put("friends", "default", "list", &serde_json::Value::Array(list).to_string());
        }
    }

    /// Remove a friend.
    pub fn remove_friend(&mut self, id: &str) {
        self.friends.retain(|f| f.id != id);
        self.save_friends();
    }

    /// Your Beacon (the code's onion and name), when set.
    #[must_use]
    pub fn my_beacon(&self) -> Option<MyBeacon> {
        self.backend.my_beacon()
    }

    /// Set Your Beacon from a `pharos-beacon:` code (`None` removes it).
    pub fn set_my_beacon(&mut self, code: Option<&str>) -> bool {
        match self.backend.set_my_beacon(code) {
            Ok(Some(b)) => {
                self.status = format!("Your Beacon: {}", if b.name.is_empty() { &b.onion } else { &b.name });
                true
            }
            Ok(None) => {
                self.status = "Your Beacon removed.".into();
                true
            }
            Err(e) => {
                self.status = e;
                false
            }
        }
    }

    /// Handle the engine's queued events.
    pub fn drain(&mut self, viewing: bool) {
        for ev in self.engine.drain_events() {
            match ev {
                Event::MessageAdded(m) if !m.is_self && !viewing => {
                    if let Some(r) = self.engine.current_room() {
                        *self.unread.entry(r.to_string()).or_default() += 1;
                    }
                    if m.kind != MessageKind::System && m.kind != MessageKind::Placeholder && self.notifications_on() {
                        let body = match m.kind {
                            MessageKind::Image => "\u{1f5bc} picture".to_string(),
                            MessageKind::Voice => "\u{1f3a4} voice message".to_string(),
                            _ => m.content.chars().take(120).collect(),
                        };
                        let room = self.room_name().unwrap_or_default();
                        self.notes.push((format!("{} \u{b7} {room}", m.user), body));
                    }
                }
                Event::Sync { kind, payload, sender } if kind.starts_with("file_") => {
                    if let Some(s) = self.files.on_sync(&kind, &payload, &sender) {
                        self.status = s;
                    }
                }
                Event::Error(e) => self.status = e,
                Event::RoomsChanged | Event::RoomChanged(_) => self.sync_selection(),
                _ => {}
            }
        }
        if let Some(e) = self.engine.error() {
            if self.status.is_empty() {
                self.status = e.to_string();
            }
        }
    }

    /// The timeline of the current room.
    #[must_use]
    pub fn messages(&self) -> &[Message] {
        self.engine.messages()
    }

    /// The current room's name.
    #[must_use]
    pub fn room_name(&self) -> Option<String> {
        let cur = self.engine.current_room()?;
        self.engine.rooms().iter().find(|r| r.room == cur).map(|r| r.name.clone())
    }

    /// Whether I host the current room.
    #[must_use]
    pub fn is_host(&self) -> bool {
        let Some(cur) = self.engine.current_room() else { return false };
        self.engine.rooms().iter().any(|r| r.room == cur && r.host)
    }

    /// Members linked to us right now.
    #[must_use]
    pub fn linked_count(&self) -> usize {
        self.engine.roster().iter().filter(|p| p.linked && !p.is_self).count()
    }

    /// The roster of the current room, me first.
    #[must_use]
    pub fn participants(&self) -> Vec<Participant> {
        let mut v = self.engine.roster().to_vec();
        v.sort_by_key(|p| (!p.is_self, p.name.to_lowercase()));
        v
    }

    /// "🔒 Encrypted" / "Key exchange…" / ...
    #[must_use]
    pub fn crypto_label(&self) -> String {
        match self.engine.mls_status() {
            MlsStatus::Ready => self.tr("chat.encrypted"),
            MlsStatus::KeyExchange | MlsStatus::Initializing => self.tr("chat.keyExchange"),
            MlsStatus::Error => self.tr("chat.cryptoError"),
            MlsStatus::Idle => self.tr("chat.noRoom"),
        }
    }

    /// "Direct" / "Via Beacon".
    #[must_use]
    pub fn route_label(&self) -> String {
        self.tr(if self.backend.via_beacon() { "chat.viaBeacon" } else { "chat.direct" })
    }

    /// The room header's one line: "🔒 Encrypted · Linked to 1 · Via Beacon".
    #[must_use]
    pub fn state_line(&self) -> String {
        let n = self.linked_count().to_string();
        format!("{} \u{b7} {} \u{b7} {}", self.crypto_label(), tf(self.lang, "chat.linkedTo", &[("n", &n)]), self.route_label())
    }

    /// Link state, short (English, for the console).
    #[must_use]
    pub fn link_label(&self) -> &'static str {
        match self.engine.link_status() {
            LinkStatus::Connected => "connected",
            LinkStatus::Connecting => "connecting",
            LinkStatus::Waiting => "waiting",
            LinkStatus::Disconnected => "disconnected",
            LinkStatus::Error => "link error",
        }
    }

    /// Tor, for the indicator: (text, ok).
    #[must_use]
    pub fn tor_label(&self) -> (String, bool) {
        match self.backend.tor_state() {
            TorState::Ready => (self.tr("tor.on"), true),
            TorState::Simulated => (self.tr("tor.demo"), true),
            TorState::Bootstrapping(p) => (format!("{} {p}%", self.tr("tor.starting")), false),
            TorState::Off => (self.tr("tor.off"), false),
            TorState::Error(_) => (self.tr("tor.error"), false),
        }
    }

    /// Whether the backend is connected to anything (the real one is not, until stage 2).
    #[must_use]
    pub fn connected(&self) -> bool {
        !matches!(self.backend.tor_state(), TorState::Off | TorState::Error(_))
    }

    /// My Friends code.
    #[must_use]
    pub fn my_friend_code(&self) -> String {
        codes::encode_pairing(self.engine.device_id(), &self.user_name)
    }

    /// A new invitation code for the current room (general, no expiry).
    pub fn invitation_code(&mut self) -> Option<String> {
        self.invite(0, None)
    }

    /// A new invitation for the current room: `ttl` seconds (0 = none), for a friend
    /// (device id) or anyone holding the code.
    pub fn invite(&mut self, ttl: u64, friend: Option<&str>) -> Option<String> {
        let f = friend.and_then(|id| self.friends.iter().find(|f| f.id == id)).map(|f| (f.id.clone(), f.name.clone()));
        match self.backend.make_invite(&self.engine, ttl, f.as_ref().map(|(a, b)| (a.as_str(), b.as_str()))) {
            Ok(inv) => Some(codes::encode_invitation(&inv)),
            Err(e) => {
                self.status = format!("Invite: {e}");
                None
            }
        }
    }

    /// The invitations made here, newest first.
    #[must_use]
    pub fn invites(&self) -> Vec<InviteRecord> {
        self.backend.invites()
    }

    /// Withdraw an invitation.
    pub fn revoke_invite(&mut self, id: &str) {
        self.backend.revoke_invite(id);
    }

    /// Send a text; false (and a status) when it could not go.
    pub fn send(&mut self, text: &str) -> bool {
        let t = text.trim();
        if t.is_empty() {
            return false;
        }
        if self.engine.mls_status() != MlsStatus::Ready {
            self.status = self.tr("chat.notReady");
            return false;
        }
        self.engine.send_text(t);
        self.backend.poll(&mut self.engine);
        self.drain(self.viewing);
        true
    }

    /// Open the room at row `i` of the rooms list.
    pub fn open_room(&mut self, i: usize) {
        let Some(slug) = self.engine.rooms().get(i).map(|r| r.room.clone()) else { return };
        self.room_sel = i;
        if self.engine.current_room() != Some(slug.as_str()) {
            self.engine.open_room(&slug);
            self.backend.poll(&mut self.engine);
        }
        self.unread.remove(&slug);
        self.drain(true);
    }

    /// Create a room and enter it.
    pub fn create_room(&mut self, name: &str) -> bool {
        let name = name.trim();
        if name.is_empty() {
            return false;
        }
        let ok = match self.engine.create_room(name) {
            Some(_) => {
                self.status = format!("Room \u{201c}{name}\u{201d} created.");
                true
            }
            None => {
                self.status = self.engine.error().unwrap_or("could not create the room").to_string();
                false
            }
        };
        self.drain(self.viewing);
        ok
    }

    /// Join by a pasted invitation code.
    pub fn join(&mut self, code: &str) -> bool {
        let Some(inv) = codes::decode_invitation(code) else {
            self.status = self.tr("join.notACode");
            return false;
        };
        let ok = match self.backend.redeem(&mut self.engine, &inv) {
            Ok(()) => {
                self.status = format!("Joined \u{201c}{}\u{201d}.", inv.name);
                for s in self.backend.take_status() {
                    self.status = s;
                }
                true
            }
            Err(e) => {
                self.status = format!("Join: {e}");
                false
            }
        };
        self.drain(self.viewing);
        ok
    }

    /// Add a friend from a pasted code; returns the check code.
    pub fn add_friend(&mut self, code: &str) -> Option<String> {
        let Some((id, name)) = codes::decode_pairing(code) else {
            self.status = self.tr("friends.notACode");
            return None;
        };
        if id == self.engine.device_id() {
            self.status = self.tr("friends.thatIsYou");
            return None;
        }
        let name = if name.trim().is_empty() { id[..8].to_string() } else { name };
        if let Some(f) = self.friends.iter_mut().find(|f| f.id == id) {
            f.name = name.clone();
        } else {
            self.friends.push(Friend { id: id.clone(), name: name.clone() });
            self.friends.sort_by(|a, b| a.name.cmp(&b.name));
        }
        self.save_friends();
        let check = codes::check_code(self.engine.device_id(), &id);
        self.status = tf(self.lang, "friends.added", &[("name", &name), ("code", &check)]);
        Some(check)
    }

    /// The check code with a friend.
    #[must_use]
    pub fn check_code_with(&self, friend_id: &str) -> String {
        codes::check_code(self.engine.device_id(), friend_id)
    }

    /// Change my nickname.
    pub fn set_user_name(&mut self, name: &str) {
        let n = name.trim();
        if n.is_empty() {
            return;
        }
        self.user_name = n.into();
        if let Some(v) = self.backend.vault() {
            v.set_setting("nickname", n);
        }
        self.engine.set_user_name(n);
        self.backend.poll(&mut self.engine);
        self.drain(self.viewing);
    }

    /// Leave the current room (it stays in the list).
    pub fn leave(&mut self) {
        self.engine.leave();
        self.backend.poll(&mut self.engine);
        self.drain(self.viewing);
    }

    /// Delete the current room.
    pub fn delete_current(&mut self) {
        if let Some(slug) = self.engine.current_room().map(str::to_string) {
            self.engine.delete_room(&slug);
            self.backend.poll(&mut self.engine);
            self.unread.remove(&slug);
            self.room_sel = 0;
            self.drain(self.viewing);
        }
    }

    /// Reset the current room's encryption (fresh MLS group, history cleared).
    pub fn reset_encryption(&mut self) {
        self.engine.force_reset(true);
        self.backend.poll(&mut self.engine);
        self.drain(self.viewing);
    }

    /// Human rows only: (mine, text).
    #[must_use]
    pub fn texts(&self) -> Vec<(bool, String)> {
        self.messages().iter().filter(|m| m.kind == MessageKind::Text).map(|m| (m.is_self, m.content.clone())).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::DemoBackend;

    fn demo() -> Core {
        Core::new(Box::new(DemoBackend::new()), "Me")
    }

    #[test]
    fn demo_starts_in_an_encrypted_room_with_ann_linked() {
        let c = demo();
        assert_eq!(c.room_name().as_deref(), Some("Lighthouse"));
        assert_eq!(c.engine.mls_status(), MlsStatus::Ready);
        assert_eq!(c.linked_count(), 1);
        assert_eq!(c.engine.rooms().len(), 2);
        assert!(c.texts().iter().any(|(s, t)| !s && t.contains("Ann here")));
        assert_eq!(c.friends.len(), 1);
        assert_eq!(c.state_line(), "\u{1f512} Encrypted \u{b7} Linked to 1 \u{b7} Direct");
        assert!(c.connected());
    }

    #[test]
    fn send_reaches_ann_and_she_answers() {
        let mut c = demo();
        assert!(c.send("ping over MLS"));
        c.tick(true);
        let t = c.texts();
        assert!(t.contains(&(true, "ping over MLS".into())));
        assert!(t.iter().any(|(s, x)| !s && x.starts_with("Got it") && x.contains("ping over MLS")));
        assert!(c.backend.peer_texts().contains(&"ping over MLS".to_string()));
        assert!(!c.send("   "));
    }

    #[test]
    fn your_beacon_routes_rooms_via_beacon_and_polish_texts() {
        let mut c = demo();
        let onion = format!("{}.onion", codes::base32_lower(&[7u8; 35]));
        assert!(c.set_my_beacon(Some(&onion)));
        assert_eq!(c.my_beacon().unwrap().onion, onion);
        assert!(!c.set_my_beacon(Some("nope")));
        c.lang = Lang::Pl;
        assert_eq!(c.state_line(), "\u{1f512} Szyfrowany \u{b7} Połączono z 1 \u{b7} Przez Beacon");
        assert!(c.set_my_beacon(None));
        assert!(c.my_beacon().is_none());
    }

    #[test]
    fn create_join_and_invite() {
        let mut c = demo();
        assert!(c.create_room("Attic"));
        assert_eq!(c.room_name().as_deref(), Some("Attic"));
        assert!(c.is_host());
        assert_eq!(codes::decode_invitation(&c.invitation_code().unwrap()).unwrap().name, "Attic");
        assert!(!c.join("nope"));
        assert_eq!(c.status, "That is not an invitation code.");
        let code = c.backend.sample_invitation().unwrap();
        assert!(c.join(&code), "{}", c.status);
        assert_eq!(c.room_name().as_deref(), Some("Ann's Garden"));
        assert_eq!(c.engine.rooms()[c.room_sel].name, "Ann's Garden");
        assert_eq!(c.participants().len(), 2);
        assert!(c.participants()[0].is_self);
    }

    #[test]
    fn friends_by_code_with_check_code() {
        let mut c = demo();
        let bob = "b".repeat(64);
        let check = c.add_friend(&codes::encode_pairing(&bob, "Bob")).unwrap();
        assert_eq!(check, c.check_code_with(&bob));
        assert!(c.friends.iter().any(|f| f.name == "Bob"));
        assert_eq!(c.add_friend(&c.my_friend_code()), None);
        assert_eq!(c.status, "That is your own code.");
    }

    #[test]
    fn open_rooms_delete_and_rename() {
        let mut c = demo();
        let i = c.engine.rooms().iter().position(|r| r.name == "Harbour").unwrap();
        c.open_room(i);
        assert_eq!(c.room_name().as_deref(), Some("Harbour"));
        c.delete_current();
        assert_eq!(c.engine.rooms().len(), 1);
        c.set_user_name("Zed");
        assert!(c.my_friend_code().ends_with(":WmVk"));
    }
}
