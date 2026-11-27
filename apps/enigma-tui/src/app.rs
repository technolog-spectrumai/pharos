//! App state and event handling, independent of terminal I/O (unit-testable).

use std::cell::Cell;
use std::ops::{Deref, DerefMut};

use enigma_app::core::Core;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::layout::{Position, Rect};

use crate::backend::Backend;

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

pub use enigma_app::core::Friend;

/// The console app: the shared [`Core`] plus what only a keyboard UI needs
/// (`app.engine`, `app.friends`, ... reach the core through `Deref`).
pub struct App {
    /// The shared state and actions.
    pub core: Core,
    /// Keyboard focus.
    pub focus: Focus,
    /// The open dialog.
    pub dialog: Option<Dialog>,
    /// The message being typed.
    pub input: String,
    /// Selected row in the friends list.
    pub friend_sel: usize,
    /// Asked to quit.
    pub quit: bool,
    /// Where the Beacon button was drawn (set by the UI, for the mouse).
    pub beacon_button: Cell<Rect>,
}

impl Deref for App {
    type Target = Core;
    fn deref(&self) -> &Core {
        &self.core
    }
}

impl DerefMut for App {
    fn deref_mut(&mut self) -> &mut Core {
        &mut self.core
    }
}

impl App {
    /// An app on a backend; the backend seeds or connects.
    #[must_use]
    pub fn new(backend: Box<dyn Backend>, name: &str) -> Self {
        Self {
            core: Core::new(backend, name),
            focus: Focus::Input,
            dialog: None,
            input: String::new(),
            friend_sel: 0,
            quit: false,
            beacon_button: Cell::new(Rect::default()),
        }
    }

    /// Time passes (~250 ms).
    pub fn tick(&mut self) {
        let viewing = self.focus == Focus::Input;
        self.core.tick(viewing);
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

    /// Send what is typed.
    pub fn send(&mut self) {
        let t = self.input.clone();
        if self.core.send(&t) {
            self.input.clear();
        }
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
                let core = &mut self.core;
                if let Some(r) = core.engine.current_room() {
                    core.unread.remove(r);
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
                let i = self.room_sel;
                self.core.open_room(i);
                self.focus = Focus::Input;
            }
            _ => {}
        }
    }

    fn move_sel(&mut self, d: isize) {
        let (rooms, friends) = (self.core.engine.rooms().len(), self.core.friends.len());
        let (sel, len) = match self.focus {
            Focus::Rooms => (&mut self.core.room_sel, rooms),
            Focus::Friends => (&mut self.friend_sel, friends),
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
                if self.core.create_room(&name) {
                    self.focus = Focus::Input;
                }
            }
            (KeyCode::Enter, Dialog::Join(t)) => {
                let code = t.clone();
                if enigma_app::codes::decode_invitation(&code).is_none() {
                    self.core.status = self.core.tr("join.notACode");
                    return;
                }
                self.dialog = None;
                if self.core.join(&code) {
                    self.focus = Focus::Input;
                }
            }
            (KeyCode::Enter, Dialog::Friends(t)) => {
                let code = t.clone();
                if self.core.add_friend(&code).is_some() {
                    self.dialog = Some(Dialog::Friends(String::new()));
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{DemoBackend, RealBackend, NOT_CONNECTED};
    use crate::codes;
    use enigma_core::MlsStatus;

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
