//! App state and event handling, independent of terminal I/O (unit-testable).

use std::cell::Cell;
use std::collections::HashMap;

use enigma_core::{Engine, Event, LinkStatus, Message, MessageKind, MlsStatus};
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::{Position, Rect};

use crate::backend::{build_engine, Backend, BeaconInfo};
use crate::codes;

/// Which pane has the keyboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Focus {
    /// The rooms list.
    Rooms,
    /// The friends list.
    Friends,
    /// The message input.
    Input,
}

/// An open dialog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Dialog {
    /// New room: its name.
    NewRoom(String),
    /// Join: the pasted code.
    Join(String),
    /// Invite: the code shown (text + QR).
    Invite(String),
    /// Friends: my code, and a pasted friend code.
    Friends(String),
}

/// A paired device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Friend {
    /// Device id (64 hex).
    pub id: String,
    /// Name.
    pub name: String,
}

/// The app.
pub struct App {
    /// The room engine.
    pub engine: Engine,
    /// The outside.
    pub backend: Box<dyn Backend>,
    /// Keyboard focus.
    pub focus: Focus,
    /// The open dialog.
    pub dialog: Option<Dialog>,
    /// The message being typed.
    pub input: String,
    /// Selected row in the rooms list.
    pub room_sel: usize,
    /// Selected row in the friends list.
    pub friend_sel: usize,
    /// Friends (memory only).
    pub friends: Vec<Friend>,
    /// The Beacon, as last set.
    pub beacon: BeaconInfo,
    /// One status line (last error or info).
    pub status: String,
    /// Unread counts per room slug.
    pub unread: HashMap<String, usize>,
    /// Asked to quit.
    pub quit: bool,
    /// My display name.
    pub user_name: String,
    /// Where the Beacon button was drawn (set by the UI, for the mouse).
    pub beacon_button: Cell<Rect>,
}

impl App {
    /// An app on a backend; the backend seeds or connects.
    #[must_use]
    pub fn new(mut backend: Box<dyn Backend>, name: &str) -> Self {
        let mut engine = build_engine(backend.as_ref(), name);
        backend.start(&mut engine);
        let friends = backend.seed_friends().into_iter().map(|(id, name)| Friend { id, name }).collect();
        let beacon = BeaconInfo { enabled: backend.beacon_enabled(), onion: None, status: "off".into() };
        let mut app = Self {
            engine,
            backend,
            focus: Focus::Input,
            dialog: None,
            input: String::new(),
            room_sel: 0,
            friend_sel: 0,
            friends,
            beacon,
            status: String::new(),
            unread: HashMap::new(),
            quit: false,
            user_name: name.into(),
            beacon_button: Cell::new(Rect::default()),
        };
        let _ = app.engine.drain_events();
        app.sync_selection();
        app
    }

    fn sync_selection(&mut self) {
        if let Some(cur) = self.engine.current_room() {
            if let Some(i) = self.engine.rooms().iter().position(|r| r.room == cur) {
                self.room_sel = i;
            }
        }
    }

    /// Time passes (~250 ms): engine timers, incoming frames, events.
    pub fn tick(&mut self) {
        self.engine.tick();
        self.backend.poll(&mut self.engine);
        self.drain();
    }

    fn drain(&mut self) {
        for ev in self.engine.drain_events() {
            match ev {
                Event::MessageAdded(m) if !m.is_self && self.focus != Focus::Input => {
                    if let Some(r) = self.engine.current_room() {
                        *self.unread.entry(r.to_string()).or_default() += 1;
                    }
                    let _ = m;
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

    /// Members linked to us right now.
    #[must_use]
    pub fn linked_count(&self) -> usize {
        self.engine.roster().iter().filter(|p| p.linked && !p.is_self).count()
    }

    /// "🔒 Encrypted" / "Key exchange" / ...
    #[must_use]
    pub fn crypto_label(&self) -> &'static str {
        match self.engine.mls_status() {
            MlsStatus::Ready => "\u{1f512} Encrypted",
            MlsStatus::KeyExchange | MlsStatus::Initializing => "Key exchange",
            MlsStatus::Error => "Encryption error",
            MlsStatus::Idle => "No room",
        }
    }

    /// "Direct" / "Via Beacon".
    #[must_use]
    pub fn route_label(&self) -> &'static str {
        if self.backend.via_beacon() {
            "Via Beacon"
        } else {
            "Direct"
        }
    }

    /// Link state, short.
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

    /// The Beacon button's label.
    #[must_use]
    pub fn beacon_label(&self) -> &'static str {
        if self.beacon.enabled {
            "\u{23fb} DISABLE BEACON"
        } else {
            "\u{23fb} ENABLE BEACON"
        }
    }

    /// Flip the Beacon.
    pub fn toggle_beacon(&mut self) {
        let on = !self.beacon.enabled;
        match self.backend.set_beacon(on) {
            Ok(info) => {
                self.status = match &info.onion {
                    Some(_) => "Beacon on: share its address with friends.".into(),
                    None => "Beacon off.".into(),
                };
                self.beacon = info;
            }
            Err(e) => self.status = format!("Beacon: {e}"),
        }
    }

    /// My Friends code.
    #[must_use]
    pub fn my_friend_code(&self) -> String {
        codes::encode_pairing(self.engine.device_id(), &self.user_name)
    }

    /// The invitation code for the current room.
    #[must_use]
    pub fn invitation_code(&self) -> Option<String> {
        let room = self.engine.current_room()?.to_string();
        Some(codes::encode_invitation(&codes::Invitation {
            name: self.room_name().unwrap_or_default(),
            room,
            onion: self.engine.my_onion().to_string(),
        }))
    }

    /// Send what is typed.
    pub fn send(&mut self) {
        let t = self.input.trim().to_string();
        if t.is_empty() {
            return;
        }
        if self.engine.mls_status() != MlsStatus::Ready {
            self.status = "Not encrypted yet: wait for the key exchange.".into();
            return;
        }
        self.engine.send_text(&t);
        self.input.clear();
        self.backend.poll(&mut self.engine);
        self.drain();
    }

    fn select_room(&mut self, i: usize) {
        let Some(slug) = self.engine.rooms().get(i).map(|r| r.room.clone()) else { return };
        self.room_sel = i;
        if self.engine.current_room() != Some(slug.as_str()) {
            self.engine.open_room(&slug);
            self.backend.poll(&mut self.engine);
        }
        self.unread.remove(&slug);
        self.drain();
    }

    /// Add a friend from a pasted code; returns the check code.
    pub fn add_friend(&mut self, code: &str) -> Option<String> {
        let Some((id, name)) = codes::decode_pairing(code) else {
            self.status = "That is not a friend code.".into();
            return None;
        };
        if id == self.engine.device_id() {
            self.status = "That is your own code.".into();
            return None;
        }
        let name = if name.trim().is_empty() { id[..8].to_string() } else { name };
        if let Some(f) = self.friends.iter_mut().find(|f| f.id == id) {
            f.name = name.clone();
        } else {
            self.friends.push(Friend { id: id.clone(), name: name.clone() });
            self.friends.sort_by(|a, b| a.name.cmp(&b.name));
        }
        let check = codes::check_code(self.engine.device_id(), &id);
        self.status = format!("Added {name}. Check code: {check}");
        Some(check)
    }

    /// A mouse event (the Beacon button).
    pub fn on_mouse(&mut self, m: MouseEvent) {
        if let MouseEventKind::Down(MouseButton::Left) = m.kind {
            if self.dialog.is_none() && self.beacon_button.get().contains(Position::new(m.column, m.row)) {
                self.toggle_beacon();
            }
        }
    }

    /// Pasted text goes where typing goes.
    pub fn on_paste(&mut self, s: &str) {
        let s = s.trim_end_matches(['\n', '\r']);
        match &mut self.dialog {
            Some(Dialog::NewRoom(t) | Dialog::Join(t) | Dialog::Friends(t)) => t.push_str(s.trim()),
            Some(Dialog::Invite(_)) => {}
            None => {
                self.focus = Focus::Input;
                self.input.push_str(s);
            }
        }
    }

    /// A key.
    pub fn on_key(&mut self, k: KeyEvent) {
        if k.kind == KeyEventKind::Release {
            return;
        }
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && k.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        if ctrl && k.code == KeyCode::Char('b') {
            self.toggle_beacon();
            return;
        }
        if self.dialog.is_some() {
            self.on_dialog_key(k);
            return;
        }
        if k.code == KeyCode::Tab || k.code == KeyCode::BackTab {
            self.focus = match (self.focus, k.code == KeyCode::BackTab) {
                (Focus::Rooms, false) | (Focus::Input, true) => Focus::Friends,
                (Focus::Friends, false) | (Focus::Rooms, true) => Focus::Input,
                (Focus::Input, false) | (Focus::Friends, true) => Focus::Rooms,
            };
            if self.focus == Focus::Input {
                if let Some(r) = self.engine.current_room() {
                    self.unread.remove(r);
                }
            }
            return;
        }
        if self.focus == Focus::Input {
            match k.code {
                KeyCode::Enter => self.send(),
                KeyCode::Backspace => {
                    self.input.pop();
                }
                KeyCode::Esc => self.focus = Focus::Rooms,
                KeyCode::Char(c) => self.input.push(c),
                _ => {}
            }
            return;
        }
        match k.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('b') => self.toggle_beacon(),
            KeyCode::Char('n') => self.dialog = Some(Dialog::NewRoom(String::new())),
            KeyCode::Char('j') => self.dialog = Some(Dialog::Join(String::new())),
            KeyCode::Char('f') => self.dialog = Some(Dialog::Friends(String::new())),
            KeyCode::Char('i') => match self.invitation_code() {
                Some(c) => self.dialog = Some(Dialog::Invite(c)),
                None => self.status = "Open a room first.".into(),
            },
            KeyCode::Up | KeyCode::Char('k') => self.move_sel(-1),
            KeyCode::Down => self.move_sel(1),
            KeyCode::Enter if self.focus == Focus::Rooms => {
                self.select_room(self.room_sel);
                self.focus = Focus::Input;
            }
            _ => {}
        }
    }

    fn move_sel(&mut self, d: isize) {
        let (sel, len) = match self.focus {
            Focus::Rooms => (&mut self.room_sel, self.engine.rooms().len()),
            Focus::Friends => (&mut self.friend_sel, self.friends.len()),
            Focus::Input => return,
        };
        if len > 0 {
            *sel = (*sel as isize + d).clamp(0, len as isize - 1) as usize;
        }
    }

    fn on_dialog_key(&mut self, k: KeyEvent) {
        let Some(dialog) = self.dialog.as_mut() else { return };
        match (k.code, dialog) {
            (KeyCode::Esc, _) => self.dialog = None,
            (KeyCode::Enter, Dialog::Invite(_)) => self.dialog = None,
            (_, Dialog::Invite(_)) => {}
            (KeyCode::Backspace, Dialog::NewRoom(t) | Dialog::Join(t) | Dialog::Friends(t)) => {
                t.pop();
            }
            (KeyCode::Char(c), Dialog::NewRoom(t) | Dialog::Join(t) | Dialog::Friends(t)) => t.push(c),
            (KeyCode::Enter, Dialog::NewRoom(t)) => {
                let name = t.trim().to_string();
                if name.is_empty() {
                    return;
                }
                self.dialog = None;
                match self.engine.create_room(&name) {
                    Some(_) => {
                        self.status = format!("Room \u{201c}{name}\u{201d} created.");
                        self.focus = Focus::Input;
                    }
                    None => self.status = self.engine.error().unwrap_or("could not create the room").to_string(),
                }
                self.drain();
            }
            (KeyCode::Enter, Dialog::Join(t)) => {
                let code = t.clone();
                let Some(inv) = codes::decode_invitation(&code) else {
                    self.status = "That is not an invitation code.".into();
                    return;
                };
                self.dialog = None;
                match self.backend.redeem(&mut self.engine, &inv) {
                    Ok(()) => {
                        self.status = format!("Joined \u{201c}{}\u{201d}.", inv.name);
                        self.focus = Focus::Input;
                    }
                    Err(e) => self.status = format!("Join: {e}"),
                }
                self.drain();
            }
            (KeyCode::Enter, Dialog::Friends(t)) => {
                let code = t.clone();
                if self.add_friend(&code).is_some() {
                    self.dialog = Some(Dialog::Friends(String::new()));
                }
            }
            _ => {}
        }
    }

    /// Human rows only (for tests and the chat pane).
    #[must_use]
    pub fn texts(&self) -> Vec<(bool, String)> {
        self.messages().iter().filter(|m| m.kind == MessageKind::Text).map(|m| (m.is_self, m.content.clone())).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{DemoBackend, RealBackend, NOT_CONNECTED};

    fn key(c: KeyCode) -> KeyEvent {
        KeyEvent::new(c, KeyModifiers::NONE)
    }
    fn typ(app: &mut App, s: &str) {
        for c in s.chars() {
            app.on_key(key(KeyCode::Char(c)));
        }
    }
    fn demo() -> App {
        App::new(Box::new(DemoBackend::new()), "Me")
    }

    #[test]
    fn demo_starts_in_an_encrypted_room_with_ann_linked() {
        let app = demo();
        assert_eq!(app.room_name().as_deref(), Some("Lighthouse"));
        assert_eq!(app.engine.mls_status(), MlsStatus::Ready);
        assert_eq!(app.linked_count(), 1);
        assert_eq!(app.engine.rooms().len(), 2);
        assert!(app.texts().iter().any(|(s, t)| !s && t.contains("Ann here")));
        assert_eq!(app.friends.len(), 1);
    }

    #[test]
    fn a_message_reaches_ann_and_her_answer_comes_back_through_the_engine() {
        let mut app = demo();
        assert_eq!(app.focus, Focus::Input);
        typ(&mut app, "ping over MLS");
        app.on_key(key(KeyCode::Enter));
        app.tick();
        assert!(app.input.is_empty());
        let t = app.texts();
        assert!(t.contains(&(true, "ping over MLS".into())));
        assert!(t.iter().any(|(s, x)| !s && x.contains("ping over MLS") && x.starts_with("Got it")), "{t:?}");
        // and it really went sealed over the hub into Ann's engine
        assert!(app.backend.peer_texts().contains(&"ping over MLS".to_string()));
    }

    #[test]
    fn tab_cycles_focus_and_letters_type_only_in_the_input() {
        let mut app = demo();
        typ(&mut app, "bq");
        assert_eq!(app.input, "bq");
        assert!(!app.quit && !app.beacon.enabled);
        app.on_key(key(KeyCode::Tab));
        assert_eq!(app.focus, Focus::Rooms);
        app.on_key(key(KeyCode::Tab));
        assert_eq!(app.focus, Focus::Friends);
        app.on_key(key(KeyCode::Tab));
        assert_eq!(app.focus, Focus::Input);
        app.on_key(key(KeyCode::BackTab));
        assert_eq!(app.focus, Focus::Friends);
        app.on_key(key(KeyCode::Char('q')));
        assert!(app.quit);
    }

    #[test]
    fn beacon_toggles_by_key_ctrl_b_and_mouse() {
        let mut app = demo();
        app.focus = Focus::Rooms;
        app.on_key(key(KeyCode::Char('b')));
        assert!(app.beacon.enabled && app.backend.beacon_enabled());
        assert!(app.beacon.onion.as_deref().is_some_and(|o| o.ends_with(".onion") && o.len() == 62));
        assert_eq!(app.beacon_label(), "\u{23fb} DISABLE BEACON");
        assert_eq!(app.route_label(), "Via Beacon");
        app.on_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
        assert!(!app.beacon.enabled);
        app.beacon_button.set(Rect::new(10, 20, 30, 3));
        let click = |c, r| MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: c, row: r, modifiers: KeyModifiers::NONE };
        app.on_mouse(click(5, 21));
        assert!(!app.beacon.enabled);
        app.on_mouse(click(15, 21));
        assert!(app.beacon.enabled);
    }

    #[test]
    fn new_room_dialog_creates_and_enters_it() {
        let mut app = demo();
        app.focus = Focus::Rooms;
        app.on_key(key(KeyCode::Char('n')));
        assert!(matches!(app.dialog, Some(Dialog::NewRoom(_))));
        typ(&mut app, "Attic");
        app.on_key(key(KeyCode::Enter));
        assert!(app.dialog.is_none());
        assert_eq!(app.room_name().as_deref(), Some("Attic"));
        assert_eq!(app.engine.mls_status(), MlsStatus::Ready);
        assert_eq!(app.engine.rooms().len(), 3);
    }

    #[test]
    fn join_by_code_lets_ann_admit_us_and_esc_closes_dialogs() {
        let mut app = demo();
        app.focus = Focus::Rooms;
        app.on_key(key(KeyCode::Char('j')));
        app.on_key(key(KeyCode::Esc));
        assert!(app.dialog.is_none());
        app.on_key(key(KeyCode::Char('j')));
        let code = app.backend.sample_invitation().unwrap();
        app.on_paste(&code);
        app.on_key(key(KeyCode::Enter));
        assert!(app.dialog.is_none(), "{}", app.status);
        assert_eq!(app.room_name().as_deref(), Some("Ann's Garden"));
        assert_eq!(app.engine.mls_status(), MlsStatus::Ready);
        typ(&mut app, "x");
        app.focus = Focus::Input;
        app.on_key(key(KeyCode::Enter));
        assert!(app.texts().iter().any(|(s, _)| !s));
    }

    #[test]
    fn invite_shows_a_code_that_decodes_to_this_room() {
        let mut app = demo();
        app.focus = Focus::Rooms;
        app.on_key(key(KeyCode::Char('i')));
        let Some(Dialog::Invite(c)) = &app.dialog else { panic!() };
        assert_eq!(codes::decode_invitation(c).unwrap().name, "Lighthouse");
    }

    #[test]
    fn friends_dialog_adds_by_code_with_a_check_code() {
        let mut app = demo();
        app.focus = Focus::Friends;
        app.on_key(key(KeyCode::Char('f')));
        let bob = "b".repeat(64);
        app.on_paste(&codes::encode_pairing(&bob, "Bob"));
        app.on_key(key(KeyCode::Enter));
        assert!(app.friends.iter().any(|f| f.name == "Bob"));
        assert!(app.status.contains(&codes::check_code(&bob, app.engine.device_id())));
        app.on_paste(&app.my_friend_code());
        app.on_key(key(KeyCode::Enter));
        assert_eq!(app.status, "That is your own code.");
    }

    #[test]
    fn switching_rooms_and_unread() {
        let mut app = demo();
        app.focus = Focus::Rooms;
        let i = app.engine.rooms().iter().position(|r| r.name == "Harbour").unwrap();
        app.room_sel = i;
        app.on_key(key(KeyCode::Enter));
        assert_eq!(app.room_name().as_deref(), Some("Harbour"));
        assert_eq!(app.focus, Focus::Input);
    }

    #[test]
    fn the_real_backend_says_not_connected() {
        assert_eq!(RealBackend::connect().err().as_deref(), Some(NOT_CONNECTED));
        let mut app = App::new(Box::new(RealBackend), "Me");
        app.toggle_beacon();
        assert!(app.status.contains("stage 2"));
        app.focus = Focus::Rooms;
        app.on_key(key(KeyCode::Char('n')));
        typ(&mut app, "X");
        app.on_key(key(KeyCode::Enter));
        assert!(app.status.contains("stage 2"), "{}", app.status);
    }
}
