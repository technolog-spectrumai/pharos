//! App state and event handling, independent of terminal I/O (unit-testable).

use std::ops::{Deref, DerefMut};

use enigma_app::core::Core;
use enigma_app::session::Session;
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseEvent};

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
    /// Your Beacon: a pasted `pharos-beacon:` code (empty Enter removes it).
    Beacon(String),
    /// A command line (`:`), see [`App::command`].
    Command(String),
    /// Lines to read (the answer of a command).
    Info(String, Vec<String>),
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
    /// The lock gate around this app (real backend): passphrase, PIN, panic code,
    /// profiles. `None` in the demo.
    pub session: Option<Session>,
    /// Asked to lock: the front end drops the app and shows the gate.
    pub lock: bool,
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
            session: None,
            lock: false,
        }
    }

    /// The real app out of its unlocked session (the session keeps the vault).
    #[must_use]
    pub fn from_session(mut s: Session) -> Option<Self> {
        let core = s.take_core()?;
        Some(Self { core, focus: Focus::Input, dialog: None, input: String::new(), friend_sel: 0, quit: false, session: Some(s), lock: false })
    }

    /// Time passes (~250 ms).
    pub fn tick(&mut self) {
        let viewing = self.focus == Focus::Input;
        self.core.tick(viewing);
    }

    /// Send what is typed.
    pub fn send(&mut self) {
        let t = self.input.clone();
        if self.core.send(&t) {
            self.input.clear();
        }
    }

    /// A mouse event (nothing is clickable yet).
    pub fn on_mouse(&mut self, _m: MouseEvent) {}

    /// Pasted text goes where typing goes.
    pub fn on_paste(&mut self, s: &str) {
        let s = s.trim_end_matches(['\n', '\r']);
        match &mut self.dialog {
            Some(Dialog::NewRoom(t) | Dialog::Join(t) | Dialog::Friends(t) | Dialog::Beacon(t) | Dialog::Command(t)) => t.push_str(s.trim()),
            Some(Dialog::Invite(_) | Dialog::Info(..)) => {}
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
        if ctrl && k.code == KeyCode::Char('l') {
            self.lock = true;
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
            KeyCode::Char('b') => self.dialog = Some(Dialog::Beacon(String::new())),
            KeyCode::Char(':') => self.dialog = Some(Dialog::Command(String::new())),
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
            (KeyCode::Enter, Dialog::Invite(_) | Dialog::Info(..)) => self.dialog = None,
            (_, Dialog::Invite(_) | Dialog::Info(..)) => {}
            (KeyCode::Backspace, Dialog::NewRoom(t) | Dialog::Join(t) | Dialog::Friends(t) | Dialog::Beacon(t) | Dialog::Command(t)) => {
                t.pop();
            }
            (KeyCode::Char(c), Dialog::NewRoom(t) | Dialog::Join(t) | Dialog::Friends(t) | Dialog::Beacon(t) | Dialog::Command(t)) => t.push(c),
            (KeyCode::Enter, Dialog::Beacon(t)) => {
                let code = t.trim().to_string();
                let ok = self.core.set_my_beacon(if code.is_empty() { None } else { Some(&code) });
                if ok {
                    self.dialog = None;
                }
            }
            (KeyCode::Enter, Dialog::Command(t)) => {
                let line = t.clone();
                self.dialog = None;
                self.command(&line);
            }
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

const HELP: &[&str] = &[
    ":beacon CODE | :beacon none     Your Beacon (the pharos-beacon: code from its screen)",
    ":key                            this device's discovery key for Your Beacon (only my phones)",
    ":invite [1h|1d|7d|none] [FRIEND]  a new invitation (personal when a friend is named)",
    ":invites | :revoke ID           invitations made here, withdraw one",
    ":peek CODE                      what an invitation is, before joining",
    ":info | :leave | :delete | :reset   the current room",
    ":unfriend NAME                  remove a friend",
    ":offline on|off | :timeout SECS   network",
    ":passwd OLD NEW                 change the passphrase",
    ":panic PASS CODE | :panic-clear PASS   the panic code (typing it at unlock erases everything)",
    ":profile NAME                   switch to (or create) a profile; locks first",
    ":erase ERASE                    erase this profile",
    ":lock (or Ctrl+L)               lock now",
    ":open enigma://room/NAME        open a deep link",
];

impl App {
    fn info(&mut self, title: &str, lines: Vec<String>) {
        self.dialog = Some(Dialog::Info(title.into(), lines));
    }

    fn vault_op(&mut self, f: impl FnOnce(&mut Session) -> Result<String, String>) {
        let r = match self.session.as_mut() {
            Some(s) => f(s),
            None => Err("not in the demo".into()),
        };
        self.core.status = r.unwrap_or_else(|e| e);
    }

    /// Run a `:` command (see `:help`).
    pub fn command(&mut self, line: &str) {
        let mut it = line.trim().trim_start_matches(':').split_whitespace();
        let cmd = it.next().unwrap_or("");
        let args: Vec<&str> = it.collect();
        let a = |i: usize| args.get(i).copied().unwrap_or("");
        match cmd {
            "" => {}
            "help" | "h" | "?" => self.info("Commands", HELP.iter().map(|s| (*s).to_string()).collect()),
            "beacon" => {
                let code = a(0);
                self.core.set_my_beacon(if code.is_empty() || code == "none" { None } else { Some(code) });
            }
            "key" => {
                let k = self.core.discovery_key().unwrap_or_else(|| "(not yet: set Your Beacon and wait for Tor)".into());
                self.info("Discovery key (add it on the Beacon: Phones \u{2192} Allow)", vec![k]);
            }
            "invite" => {
                let ttl = match a(0) {
                    "1h" => 3_600,
                    "7d" => 7 * 86_400,
                    "none" | "0" => 0,
                    _ => 86_400,
                };
                let who = a(1).to_lowercase();
                let friend = if who.is_empty() { None } else { self.core.friends.iter().find(|f| f.name.to_lowercase() == who).map(|f| f.id.clone()) };
                if !who.is_empty() && friend.is_none() {
                    self.core.status = format!("No friend called {}.", a(1));
                    return;
                }
                if let Some(c) = self.core.invite(ttl, friend.as_deref()) {
                    self.dialog = Some(Dialog::Invite(c));
                }
            }
            "invites" => {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                let v: Vec<String> = self
                    .core
                    .invites()
                    .iter()
                    .map(|r| format!("{}  {}  {}  {}  {}", &r.id[..8.min(r.id.len())], r.name, if r.for_name.is_empty() { "anyone" } else { &r.for_name }, r.state(now), enigma_app::actions::expiry_text(if r.ttl > 0 { r.created + r.ttl } else { 0 }, now)))
                    .collect();
                self.info("Invitations (id, room, for, state, expiry)", if v.is_empty() { vec!["none yet".into()] } else { v });
            }
            "revoke" => {
                let id = self.core.invites().into_iter().find(|r| !a(0).is_empty() && r.id.starts_with(a(0))).map(|r| r.id);
                match id {
                    Some(id) => {
                        self.core.revoke_invite(&id);
                        self.core.status = "Invitation withdrawn.".into();
                    }
                    None => self.core.status = "No such invitation.".into(),
                }
            }
            "peek" => {
                if let Some(p) = self.core.peek(a(0)) {
                    self.core.status = p.summary;
                }
            }
            "info" => {
                let v = self.core.room_info().into_iter().map(|(k, v)| format!("{k}: {v}")).collect();
                self.info("Room info", v);
            }
            "leave" => self.core.leave(),
            "delete" => self.core.delete_current(),
            "reset" => self.core.reset_encryption(),
            "unfriend" => {
                let n = a(0).to_lowercase();
                match self.core.friends.iter().find(|f| f.name.to_lowercase() == n).map(|f| f.id.clone()) {
                    Some(id) => self.core.remove_friend(&id),
                    None => self.core.status = format!("No friend called {}.", a(0)),
                }
            }
            "offline" => self.core.set_offline(a(0) != "off"),
            "timeout" => match a(0).parse() {
                Ok(n) => self.core.set_connect_timeout(n),
                Err(_) => self.core.status = "timeout SECS".into(),
            },
            "passwd" => {
                let (o, n) = (a(0).to_string(), a(1).to_string());
                self.vault_op(|s| s.change_passphrase(&o, &n, &n).map(|()| "Passphrase changed.".into()));
            }
            "panic" => {
                let (p, c) = (a(0).to_string(), a(1).to_string());
                self.vault_op(|s| s.vault().set_panic_code(&p, &c).map(|()| "Panic code set.".into()));
            }
            "panic-clear" => {
                let p = a(0).to_string();
                self.vault_op(|s| s.vault().clear_panic_code(&p).map(|()| "Panic code removed.".into()));
            }
            "profile" => {
                if self.session.is_some() && !a(0).is_empty() {
                    self.lock = true;
                    let n = a(0).to_string();
                    self.vault_op(|s| s.switch_profile(&n).map(|()| String::new()));
                }
            }
            "erase" => {
                if a(0) == "ERASE" && self.session.is_some() {
                    self.vault_op(|s| s.erase_profile().map(|()| String::new()));
                    self.lock = true;
                } else {
                    self.core.status = "Type :erase ERASE to confirm.".into();
                }
            }
            "lock" => self.lock = true,
            "open" => {
                if let Some(d) = self.core.open_link(a(0)) {
                    self.input = d;
                    self.focus = Focus::Input;
                }
            }
            _ => self.core.status = format!("Unknown command :{cmd} (try :help)."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::DemoBackend;
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
        assert!(!app.quit && app.dialog.is_none());
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
    fn your_beacon_by_key_b_and_commands() {
        let mut app = demo();
        app.focus = Focus::Rooms;
        app.on_key(key(KeyCode::Char('b')));
        assert!(matches!(app.dialog, Some(Dialog::Beacon(_))));
        let onion = format!("{}.onion", codes::base32_lower(&[5u8; 35]));
        app.on_paste(&onion);
        app.on_key(key(KeyCode::Enter));
        assert!(app.dialog.is_none(), "{}", app.status);
        assert_eq!(app.my_beacon().unwrap().onion, onion);
        assert_eq!(app.route_label(), "Via Beacon");
        app.command(":beacon none");
        assert!(app.my_beacon().is_none());
        app.on_key(key(KeyCode::Char(':')));
        typ(&mut app, "help");
        app.on_key(key(KeyCode::Enter));
        assert!(matches!(&app.dialog, Some(Dialog::Info(t, l)) if t == "Commands" && l.len() > 5));
        app.on_key(key(KeyCode::Esc));
        app.command(":invite 1h ann");
        let Some(Dialog::Invite(c)) = &app.dialog else { panic!("{}", app.status) };
        let inv = codes::decode_invitation(c).unwrap();
        assert!(inv.expires > 0 && inv.for_device == app.friends[0].id);
        app.command(":invite 1d nobody");
        assert!(app.status.contains("No friend"));
        app.command(":info");
        assert!(matches!(&app.dialog, Some(Dialog::Info(t, _)) if t == "Room info"));
        app.command(":peek nope");
        assert_eq!(app.status, "That is not an invitation code.");
        app.command(":passwd a b");
        assert_eq!(app.status, "not in the demo");
        app.command(":unfriend ann");
        assert!(app.friends.is_empty());
        app.command(":wat");
        assert!(app.status.contains("Unknown command"));
        app.on_key(KeyEvent::new(KeyCode::Char('l'), KeyModifiers::CONTROL));
        assert!(app.lock);
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
    fn the_real_app_from_its_session_without_a_beacon() {
        use enigma_app::real::Net;
        use enigma_app::vault::{test_kdf, Profiles};
        let base = std::env::temp_dir().join(format!("enigma-tui-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let mut s = Session::new(Profiles::new(base.clone()), Net::Test(std::sync::Arc::new(beacon_node::relay::Directory::default())), test_kdf()).unwrap();
        s.create("password1", "password1", 0).unwrap();
        let mut app = App::from_session(s).unwrap();
        assert!(!app.connected());
        app.focus = Focus::Rooms;
        app.on_key(key(KeyCode::Char('n')));
        typ(&mut app, "X");
        app.on_key(key(KeyCode::Enter));
        assert!(app.status.contains("no Beacon"), "{}", app.status);
        app.command(":passwd password1 password2");
        assert_eq!(app.status, "Passphrase changed.");
        app.command(":panic password2 redcode99");
        assert_eq!(app.status, "Panic code set.");
        app.command(":offline on");
        assert!(app.offline());
        app.command(":lock");
        assert!(app.lock);
        let _ = std::fs::remove_dir_all(base);
    }
}
