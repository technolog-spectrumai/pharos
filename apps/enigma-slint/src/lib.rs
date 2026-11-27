//! `enigma-slint`: Enigma's main app in Slint, for desktop and Android (stage 5 of b2.md).
//!
//! The UI is in `ui/*.slint`; this file is the glue: it owns a [`Host`] (the lock
//! [`Session`] around an [`enigma_app::core::Core`] on the real backend, or a demo `Core`),
//! turns its state into Slint models ([`refresh`]) and Slint callbacks into actions
//! ([`wire`]). Nothing here knows about rooms or crypto beyond what `Core` exposes, so the
//! console app (`enigma-tui`) and this app behave the same. The client never runs a
//! Beacon (b2.md: client and Beacon are separate apps); it attaches to Your Beacon.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

use enigma_app::actions::Theme as ThemeChoice;
use enigma_app::avatar::{colour_for, first_letter};
use enigma_app::backend::DemoBackend;
use enigma_app::codes;
use enigma_app::core::Core;
use enigma_app::files::FileState;
use enigma_app::i18n::{t, tf, Lang};
use enigma_app::real::Net;
use enigma_app::session::{Gate, Session};
use enigma_app::vault::{default_base, Idle, Profiles};
use enigma_core::MessageKind;
use slint::{Color, ComponentHandle, Image, ModelRc, Rgb8Pixel, Rgba8Pixel, SharedPixelBuffer, SharedString, VecModel};

pub mod audio;
pub mod headless;

slint::include_modules!();

/// What the window drives: the real app behind its lock gate, or the demo world.
pub struct Host {
    /// The real app (vault, client link to Your Beacon over Tor).
    pub session: Option<Session>,
    /// The demo app (no vault, no lock).
    pub demo: Option<Core>,
    /// A voice note being recorded.
    pub recording: Option<audio::Recording>,
    /// Decoded pictures by message id (decoding a data URL every refresh would be slow).
    pub images: HashMap<String, Image>,
    /// Last language seen (the gate has no core).
    pub lang: Lang,
}

impl Host {
    /// The demo world.
    #[must_use]
    pub fn demo(name: &str) -> Self {
        Self::with(None, Some(Core::new(Box::new(DemoBackend::new()), name)))
    }
    /// The real app on a session.
    #[must_use]
    pub fn real(s: Session) -> Self {
        Self::with(Some(s), None)
    }
    fn with(session: Option<Session>, demo: Option<Core>) -> Self {
        Self { session, demo, recording: None, images: HashMap::new(), lang: Lang::En }
    }
    /// The app, when unlocked.
    #[must_use]
    pub fn core(&self) -> Option<&Core> {
        self.demo.as_ref().or_else(|| self.session.as_ref().and_then(Session::core))
    }
    /// The app, when unlocked.
    pub fn core_mut(&mut self) -> Option<&mut Core> {
        match (&mut self.demo, &mut self.session) {
            (Some(c), _) => Some(c),
            (None, Some(s)) => s.core_mut(),
            _ => None,
        }
    }
    /// Locked (the gate shows).
    #[must_use]
    pub fn locked(&self) -> bool {
        self.core().is_none()
    }
    /// User activity (the idle lock restarts).
    pub fn touch(&mut self) {
        if let Some(s) = &mut self.session {
            s.touch(now_ms());
        }
    }
}

/// The shared host, as the callbacks hold it.
pub type Shared = Rc<RefCell<Host>>;

/// Milliseconds since the epoch.
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// 0xRRGGBB to a Slint colour.
#[must_use]
pub fn rgb(c: u32) -> Color {
    Color::from_rgb_u8((c >> 16) as u8, (c >> 8) as u8, c as u8)
}

/// A QR code as an image, `scale` pixels per module, dark on white.
#[must_use]
pub fn qr_image(text: &str, scale: u32) -> Image {
    let Some((side, m)) = codes::qr_modules(text) else { return Image::default() };
    let px = side as u32 * scale;
    let mut buf = SharedPixelBuffer::<Rgb8Pixel>::new(px, px);
    let data = buf.make_mut_slice();
    for y in 0..px {
        for x in 0..px {
            let dark = m[(y / scale) as usize * side + (x / scale) as usize];
            let v = if dark { 0x10 } else { 0xff };
            data[(y * px + x) as usize] = Rgb8Pixel { r: v, g: v, b: v };
        }
    }
    Image::from_rgb8(buf)
}

/// A data URL's picture as a Slint image.
#[must_use]
pub fn data_url_image(url: &str) -> Option<Image> {
    let (w, h, px) = enigma_app::media::data_url_rgba(url)?;
    let buf = SharedPixelBuffer::<Rgba8Pixel>::clone_from_slice(&px, w, h);
    Some(Image::from_rgba8(buf))
}

/// "HH:MM" (UTC) for a timestamp in ms.
#[must_use]
pub fn hhmm(ts_ms: u64) -> String {
    let m = ts_ms / 60_000;
    format!("{:02}:{:02}", (m / 60) % 24, m % 60)
}

fn s(x: &str) -> SharedString {
    x.into()
}

/// All UI texts for a language.
#[must_use]
pub fn texts(l: Lang) -> Texts {
    let g = |k: &str| s(t(l, k));
    Texts {
        app_name: g("app.name"),
        chats: g("nav.chats"),
        new_chat: g("nav.newChat"),
        join_chat: g("nav.joinChat"),
        friends: g("nav.friends"),
        settings: g("nav.settings"),
        connections: g("nav.connections"),
        back: g("nav.back"),
        cancel: g("common.cancel"),
        close: g("common.close"),
        copy: g("common.copy"),
        save: g("common.save"),
        placeholder: g("chat.placeholder"),
        send: g("chat.send"),
        no_room: g("chat.noRoom"),
        invite: g("menu.invite"),
        participants: g("menu.participants"),
        room_info: g("menu.roomInfo"),
        reset_encryption: g("menu.resetEncryption"),
        leave: g("menu.leave"),
        delete_room: g("menu.deleteRoom"),
        new_name: g("new.name"),
        create: g("new.create"),
        join_paste: g("join.paste"),
        join_scan: g("join.scan"),
        join_scan_file: g("join.scanFile"),
        picture_path: g("join.picturePath"),
        join_peek: g("join.peek"),
        join: g("join.join"),
        invite_hint: g("invite.hint"),
        friends_intro: g("friends.intro"),
        my_code: g("friends.myCode"),
        my_code_hint: g("friends.myCodeHint"),
        add_friend: g("friends.add"),
        paste_friend: g("friends.paste"),
        add: g("friends.addButton"),
        friends_none: g("friends.none"),
        friends_list: g("friends.list"),
        check_code: g("friends.checkCode"),
        friends_remove: g("friends.remove"),
        nickname: g("settings.nickname"),
        nickname_hint: g("settings.nicknameHint"),
        language: g("settings.language"),
        theme: g("settings.theme"),
        theme_system: g("theme.system"),
        theme_light: g("theme.light"),
        theme_dark: g("theme.dark"),
        tabs: g("settings.tabs"),
        tab_chat: g("tab.chat"),
        tab_files: g("tab.files"),
        tab_friends: g("tab.friends"),
        files_settings: g("settings.files"),
        max_file: g("settings.maxFile"),
        chunk: g("settings.chunk"),
        notifications: g("settings.notifications"),
        beacon_title: g("beacon.title"),
        beacon_intro: g("beacon.intro"),
        beacon_paste: g("beacon.paste"),
        beacon_set: g("beacon.set"),
        beacon_remove: g("beacon.remove"),
        beacon_none: g("beacon.none"),
        beacon_discovery: g("beacon.discovery"),
        beacon_discovery_hint: g("beacon.discoveryHint"),
        beacon_discovery_wait: g("beacon.discoveryWait"),
        offline: g("net.offline"),
        timeout: g("net.timeout"),
        not_connected: g("conn.notConnected"),
        offline_on: g("conn.offline"),
        sec_title: g("sec.title"),
        change_pass: g("sec.changePass"),
        current_pass: g("sec.current"),
        new_pass: g("sec.new"),
        new_again: g("sec.again"),
        pin_title: g("sec.pin"),
        pin_hint: g("sec.pinHint"),
        pin_set: g("sec.pinSet"),
        pin_clear: g("sec.pinClear"),
        idle: g("sec.idle"),
        lock_on_hide: g("sec.lockOnHide"),
        panic_title: g("sec.panic"),
        panic_hint: g("sec.panicHint"),
        panic_set: g("sec.panicSet"),
        panic_clear: g("sec.panicClear"),
        panic_on: g("sec.panicOn"),
        lock_now: g("sec.lockNow"),
        profiles: g("prof.title"),
        profile_name: g("prof.name"),
        profile_switch: g("prof.switch"),
        danger: g("danger.title"),
        erase: g("danger.erase"),
        erase_hint: g("danger.eraseHint"),
        erase_confirm: g("danger.confirm"),
        welcome: g("gate.welcome"),
        about: g("gate.about"),
        choose: g("gate.choose"),
        passphrase: g("gate.passphrase"),
        again: g("gate.again"),
        create_vault: g("gate.create"),
        locked: g("gate.locked"),
        unlock: g("gate.unlock"),
        pin: g("gate.pin"),
        use_pin: g("gate.usePin"),
        use_pass: g("gate.usePass"),
        tauri: g("gate.tauri"),
        stay: g("idle.stay"),
        ttl: g("invite.ttl"),
        ttl_1h: g("invite.ttl1h"),
        ttl_1d: g("invite.ttl1d"),
        ttl_7d: g("invite.ttl7d"),
        ttl_none: g("invite.ttlNone"),
        for_whom: g("invite.for"),
        anyone: g("invite.anyone"),
        make_invite: g("invite.make"),
        invite_list: g("invite.list"),
        revoke: g("invite.revoke"),
        invite_none: g("invite.none"),
        files: g("files.title"),
        file_offer: g("files.offer"),
        file_path: g("files.path"),
        file_accept: g("files.accept"),
        file_decline: g("files.decline"),
        files_none: g("files.none"),
        picture: g("chat.picture"),
        record: g("chat.record"),
        stop: g("chat.stop"),
        play: g("chat.play"),
        you: g("participants.you"),
        linked: g("participants.linked"),
        not_linked: g("participants.notLinked"),
        host: g("info.host"),
        member: g("info.member"),
    }
}

/// Invitation TTLs offered (seconds; 0 = none), as the Invite page's list.
pub const TTLS: [u64; 4] = [3_600, 86_400, 7 * 86_400, 0];

/// The timeline as bubbles: runs by the same author are grouped (name on the first,
/// avatar beside the last), like ChatBubble.vue. Pictures decode once (cached by id).
pub fn message_items(c: &Core, images: &mut HashMap<String, Image>) -> Vec<MessageItem> {
    let ms = c.messages();
    let key = |i: usize| {
        let m = &ms[i];
        (m.kind == MessageKind::System, m.is_self, m.user.clone())
    };
    (0..ms.len())
        .map(|i| {
            let m = &ms[i];
            let system = matches!(m.kind, MessageKind::System | MessageKind::Placeholder);
            let mut image = Image::default();
            let mut has_image = false;
            if m.kind == MessageKind::Image {
                if let Some(url) = &m.image_data {
                    let img = images.entry(m.id.clone()).or_insert_with(|| data_url_image(url).unwrap_or_default()).clone();
                    has_image = img.size().width > 0;
                    image = img;
                }
            }
            let text = match &m.kind {
                MessageKind::System => m.notice.as_ref().map_or_else(|| m.content.clone(), |n| n.text.clone()),
                MessageKind::Image if !has_image => "🖼 picture".into(),
                MessageKind::Voice => "🎤 voice message".into(),
                MessageKind::MapShare(_) => "📍 map (not shown in this build)".into(),
                _ => m.content.clone(),
            };
            MessageItem {
                mine: m.is_self,
                author: s(&m.user),
                text: s(&text),
                time: s(&hhmm(m.ts)),
                letter: s(&first_letter(&m.user)),
                colour: rgb(colour_for(&m.user)),
                first: i == 0 || key(i - 1) != key(i),
                last: i + 1 == ms.len() || key(i + 1) != key(i),
                system,
                has_image,
                image,
                voice: m.kind == MessageKind::Voice,
                index: i as i32,
            }
        })
        .collect()
}

fn model<T: Clone + 'static>(v: Vec<T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(v))
}

fn kb(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1} MB", n as f64 / 1_048_576.0)
    } else {
        format!("{} KB", n.div_ceil(1024))
    }
}

/// Push the host's state into the window.
pub fn refresh(ui: &AppWindow, h: &mut Host) {
    if let Some(c) = h.core() {
        h.lang = c.lang;
    }
    let l = h.lang;
    ui.set_t(texts(l));
    let locked = h.locked();
    ui.set_locked(locked);
    if let Some(sess) = &h.session {
        ui.set_profile(s(&tf(l, "prof.active", &[("name", sess.vault().profile())])));
        if locked {
            ui.set_gate_create(sess.gate() == Gate::Create);
            ui.set_gate_has_pin(sess.vault().pin_status().enrolled);
            ui.set_gate_tauri(sess.from_tauri());
            ui.set_gate_error(s(&sess.error));
            ui.set_idle_warn(0);
            return;
        }
    }
    let images = std::mem::take(&mut h.images);
    let mut images = images;
    let Some(c) = h.core_mut() else { return };
    refresh_core(ui, c, &mut images);
    h.images = images;
    if let Some(sess) = &h.session {
        ui.set_pin_on(sess.vault().pin_status().enrolled);
        ui.set_panic_on(sess.vault().has_panic_code());
        ui.set_idle_mins(s(&sess.idle_mins().to_string()));
        ui.set_lock_on_hide(sess.lock_on_hide());
    }
    ui.set_recording(h.recording.is_some());
}

fn refresh_core(ui: &AppWindow, c: &mut Core, images: &mut HashMap<String, Image>) {
    let l = c.lang;
    let cur = c.engine.current_room().map(str::to_string);
    ui.set_rooms(model(
        c.engine
            .rooms()
            .iter()
            .map(|r| RoomItem {
                name: s(&r.name),
                letter: s(&first_letter(&r.name)),
                colour: rgb(colour_for(&r.name)),
                unread: c.unread.get(&r.room).copied().unwrap_or(0) as i32,
                selected: cur.as_deref() == Some(r.room.as_str()),
            })
            .collect(),
    ));
    ui.set_messages(model(message_items(c, images)));
    let name = c.room_name();
    ui.set_has_room(name.is_some());
    let name = name.unwrap_or_default();
    ui.set_room_letter(s(&first_letter(&name)));
    ui.set_room_colour(rgb(colour_for(&name)));
    ui.set_room_name(s(&name));
    ui.set_state_line(s(&c.state_line()));
    ui.set_banner(s(&c.banner().unwrap_or_default()));
    ui.set_connected(c.connected());
    ui.set_offline(c.offline());
    let (tor, ok) = c.tor_label();
    ui.set_tor_text(s(&tor));
    ui.set_tor_ok(ok);
    ui.set_status(s(&c.status));

    ui.set_beacon_current(s(&c.my_beacon().map(|b| tf(l, "beacon.current", &[("name", if b.name.is_empty() { &b.onion } else { &b.name })])).unwrap_or_default()));
    ui.set_discovery_key(s(&c.discovery_key().unwrap_or_default()));

    ui.set_my_name(s(&c.user_name));
    ui.set_my_letter(s(&first_letter(&c.user_name)));
    ui.set_my_colour(rgb(colour_for(&c.user_name)));
    ui.set_lang_index(i32::from(l == Lang::Pl));
    ui.set_theme_index(match c.theme() {
        ThemeChoice::System => 0,
        ThemeChoice::Light => 1,
        ThemeChoice::Dark => 2,
    });
    ui.set_tab_files(c.tab_visible("files"));
    ui.set_tab_friends(c.tab_visible("friends"));
    ui.set_max_file_mb(s(&c.max_file_mb().to_string()));
    ui.set_chunk_kb(s(&c.chunk_kb().to_string()));
    ui.set_notifications(c.notifications_on());
    ui.set_connect_timeout(s(&c.connect_timeout().to_string()));
    let fc = c.my_friend_code();
    if ui.get_my_friend_code().as_str() != fc {
        ui.set_my_qr(qr_image(&fc, 6));
        ui.set_my_friend_code(s(&fc));
    }
    ui.set_friends(model(
        c.friends
            .iter()
            .map(|f| FriendItem { name: s(&f.name), letter: s(&first_letter(&f.name)), colour: rgb(colour_for(&f.name)), check: s(&c.check_code_with(&f.id)) })
            .collect(),
    ));
    let mut names = vec![s(t(l, "invite.anyone"))];
    names.extend(c.friends.iter().map(|f| s(&f.name)));
    ui.set_friend_names(model(names));
    let mut t2 = ui.get_t();
    t2.friends_list = s(&tf(l, "friends.list", &[("n", &c.friends.len().to_string())]));
    ui.set_t(t2);
    ui.set_people(model(
        c.participants()
            .iter()
            .map(|p| PersonItem { name: s(&p.name), letter: s(&first_letter(&p.name)), colour: rgb(colour_for(&p.name)), is_self: p.is_self, linked: p.linked })
            .collect(),
    ));
    ui.set_info(model(c.room_info().into_iter().map(|(a, b)| InfoItem { label: s(&a), value: s(&b) }).collect()));
    ui.set_invite_title(s(&tf(l, "invite.title", &[("room", &name)])));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    ui.set_invites(model(
        c.invites()
            .iter()
            .map(|r| InviteItem {
                id: s(&r.id),
                room: s(&r.name),
                who: s(if r.for_name.is_empty() { t(l, "invite.anyone") } else { &r.for_name }),
                state: s(r.state(now)),
                expires: s(&enigma_app::actions::expiry_text(if r.ttl > 0 { r.created + r.ttl } else { 0 }, now)),
                active: r.state(now) == "active",
            })
            .collect(),
    ));
    ui.set_files(model(
        c.files
            .rows()
            .iter()
            .map(|f| {
                let state = match &f.state {
                    FileState::Offered if f.mine => "waiting for someone to accept".to_string(),
                    FileState::Offered => format!("from {}", f.from),
                    FileState::Sending => format!("sending {}%", f.percent),
                    FileState::Receiving => format!("receiving {}%", f.percent),
                    FileState::Done(Some(p)) => format!("saved to {}", p.display()),
                    FileState::Done(None) => "sent".into(),
                    FileState::Declined => "declined".into(),
                    FileState::Cancelled => "cancelled".into(),
                    FileState::Failed(e) => format!("failed: {e}"),
                };
                FileItem {
                    id: s(&f.id),
                    name: s(&f.name),
                    detail: s(&format!("{} \u{b7} {state}", kb(f.size))),
                    percent: i32::from(f.percent),
                    can_accept: !f.mine && f.state == FileState::Offered,
                    can_cancel: f.mine && matches!(f.state, FileState::Offered | FileState::Sending),
                }
            })
            .collect(),
    ));
}

/// Make a new invitation for the current room and show it on the Invite page.
pub fn show_invite(ui: &AppWindow, c: &mut Core, ttl_index: usize, friend_index: usize) {
    let friend = friend_index.checked_sub(1).and_then(|i| c.friends.get(i)).map(|f| f.id.clone());
    if let Some(code) = c.invite(TTLS.get(ttl_index).copied().unwrap_or(0), friend.as_deref()) {
        ui.set_invite_qr(qr_image(&code, 8));
        ui.set_invite_code(s(&code));
    }
    ui.set_page(Page::Invite);
}

/// Apply the theme choice (system: Slint follows the platform's scheme).
pub fn apply_theme(ui: &AppWindow, c: &Core) {
    match c.theme() {
        ThemeChoice::Light => ui.invoke_set_dark(false),
        ThemeChoice::Dark => ui.invoke_set_dark(true),
        ThemeChoice::System => {}
    }
}

fn notify(title: &str, body: &str) {
    #[cfg(all(not(target_os = "android"), not(test)))]
    {
        let _ = notify_rust::Notification::new().appname("Enigma27").summary(title).body(body).show();
    }
    #[cfg(any(target_os = "android", test))]
    let _ = (title, body);
}

/// Connect the window's callbacks to the host.
#[allow(clippy::too_many_lines)]
pub fn wire(ui: &AppWindow, host: &Shared) {
    let w = ui.as_weak();
    // A callback on the unlocked app.
    macro_rules! on {
        ($set:ident, |$c:ident, $ui:ident $(, $a:ident: $ty:ty)*| $body:block) => {{
            let host = host.clone();
            let w = w.clone();
            ui.$set(move |$($a: $ty),*| {
                let Some($ui) = w.upgrade() else { return };
                {
                    let mut h = host.borrow_mut();
                    h.touch();
                    let Some($c) = h.core_mut() else { return };
                    $body
                }
                refresh(&$ui, &mut host.borrow_mut());
            });
        }};
    }
    // A callback on the host (gate, security).
    macro_rules! on_host {
        ($set:ident, |$h:ident, $ui:ident $(, $a:ident: $ty:ty)*| $body:block) => {{
            let host = host.clone();
            let w = w.clone();
            ui.$set(move |$($a: $ty),*| {
                let Some($ui) = w.upgrade() else { return };
                {
                    let mut g = host.borrow_mut();
                    g.touch();
                    let $h: &mut Host = &mut g;
                    $body
                }
                refresh(&$ui, &mut host.borrow_mut());
            });
        }};
    }
    on!(on_open_room, |c, ui, i: i32| {
        c.open_room(i as usize);
        let _ = &ui;
    });
    on!(on_send, |c, ui, text: SharedString| {
        if c.send(&text) {
            ui.set_draft(SharedString::new());
        }
    });
    on!(on_create_room, |c, ui, name: SharedString| {
        if c.create_room(&name) {
            ui.set_page(Page::Chat);
            ui.set_show_chat(true);
        }
    });
    on!(on_join, |c, ui, code: SharedString| {
        if c.join(&code) {
            ui.set_page(Page::Chat);
            ui.set_show_chat(true);
            ui.set_peek_text(SharedString::new());
            ui.set_scanned(SharedString::new());
        }
    });
    on!(on_peek, |c, ui, code: SharedString| {
        ui.set_peek_text(s(&c.peek(&code).map(|p| p.summary).unwrap_or_default()));
    });
    on!(on_scan_file, |c, ui, path: SharedString| {
        if let Some(text) = c.scan_file(Path::new(path.trim())) {
            ui.set_scanned(s(&text));
            if ui.get_page() == Page::Join {
                ui.set_peek_text(s(&c.peek(&text).map(|p| p.summary).unwrap_or_default()));
            }
            c.status = "Code read from the picture.".into();
        }
    });
    on!(on_add_friend, |c, ui, code: SharedString| {
        c.add_friend(&code);
        ui.set_scanned(SharedString::new());
    });
    on!(on_remove_friend, |c, ui, i: i32| {
        if let Some(id) = c.friends.get(i as usize).map(|f| f.id.clone()) {
            c.remove_friend(&id);
        }
        let _ = &ui;
    });
    on!(on_set_nickname, |c, ui, name: SharedString| {
        c.set_user_name(&name);
        let _ = &ui;
    });
    on!(on_set_lang, |c, ui, i: i32| {
        c.set_lang(if i == 1 { Lang::Pl } else { Lang::En });
        let _ = &ui;
    });
    on!(on_set_theme, |c, ui, i: i32| {
        c.set_theme(match i {
            1 => ThemeChoice::Light,
            2 => ThemeChoice::Dark,
            _ => ThemeChoice::System,
        });
        apply_theme(&ui, c);
    });
    on!(on_set_tab, |c, ui, tab: SharedString, on: bool| {
        c.set_tab_visible(&tab, on);
        let _ = &ui;
    });
    on!(on_set_max_file, |c, ui, v: SharedString| {
        if let Ok(n) = v.trim().parse() {
            c.set_max_file_mb(n);
        }
        let _ = &ui;
    });
    on!(on_set_chunk, |c, ui, v: SharedString| {
        if let Ok(n) = v.trim().parse() {
            c.set_chunk_kb(n);
        }
        let _ = &ui;
    });
    on!(on_set_notifications, |c, ui, on: bool| {
        c.set_notifications(on);
        let _ = &ui;
    });
    on!(on_open_invite, |c, ui| {
        ui.set_invite_code(SharedString::new());
        ui.set_page(Page::Invite);
        let _ = c;
    });
    on!(on_make_invite, |c, ui, ttl: i32, friend: i32| {
        show_invite(&ui, c, ttl.max(0) as usize, friend.max(0) as usize);
    });
    on!(on_revoke_invite, |c, ui, id: SharedString| {
        c.revoke_invite(&id);
        let _ = &ui;
    });
    on!(on_reset_encryption, |c, ui| {
        c.reset_encryption();
        let _ = &ui;
    });
    on!(on_leave_room, |c, ui| {
        c.leave();
        ui.set_show_chat(false);
    });
    on!(on_delete_room, |c, ui| {
        c.delete_current();
        ui.set_show_chat(false);
    });
    on!(on_set_my_beacon, |c, ui, code: SharedString| {
        if c.set_my_beacon(Some(&code)) {
            ui.set_scanned(SharedString::new());
        }
    });
    on!(on_remove_my_beacon, |c, ui| {
        c.set_my_beacon(None);
        let _ = &ui;
    });
    on!(on_set_offline, |c, ui, on: bool| {
        c.set_offline(on);
        let _ = &ui;
    });
    on!(on_set_timeout, |c, ui, v: SharedString| {
        if let Ok(n) = v.trim().parse() {
            c.set_connect_timeout(n);
        }
        let _ = &ui;
    });
    on!(on_send_picture, |c, ui, path: SharedString| {
        c.send_image_file(Path::new(path.trim()));
        ui.set_scroll_tick(ui.get_scroll_tick() + 1);
    });
    on!(on_play_voice, |c, ui, i: i32| {
        if let Some(wav) = c.voice_wav(i as usize) {
            if let Err(e) = audio::play(&wav) {
                c.status = e;
            }
        }
        let _ = &ui;
    });
    on!(on_offer_file, |c, ui, path: SharedString| {
        c.offer_file(Path::new(path.trim()));
        let _ = &ui;
    });
    on!(on_accept_file, |c, ui, id: SharedString| {
        c.accept_file(&id);
        let _ = &ui;
    });
    on!(on_decline_file, |c, ui, id: SharedString| {
        c.decline_file(&id);
        let _ = &ui;
    });
    on_host!(on_record_toggle, |h, ui| {
        match h.recording.take() {
            Some(r) => {
                let wav = r.stop();
                if let Some(c) = h.core_mut() {
                    c.send_voice_wav(&wav);
                }
                ui.set_scroll_tick(ui.get_scroll_tick() + 1);
            }
            None => match audio::record() {
                Ok(r) => h.recording = Some(r),
                Err(e) => {
                    if let Some(c) = h.core_mut() {
                        c.status = e;
                    }
                }
            },
        }
    });
    on_host!(on_activity, |h, ui| {
        let _ = (&h, &ui);
    });
    on_host!(on_stay_unlocked, |h, ui| {
        ui.set_idle_warn(0);
        let _ = h;
    });
    on_host!(on_lock_now, |h, ui| {
        if let Some(sess) = &mut h.session {
            sess.lock();
            h.recording = None;
            h.images.clear();
            ui.set_page(Page::Chat);
        }
    });
    on_host!(on_gate_create_vault, |h, ui, p: SharedString, again: SharedString| {
        if let Some(sess) = &mut h.session {
            if sess.create(&p, &again, now_ms()).is_ok() {
                ui.set_page(Page::Chat);
            }
        }
    });
    on_host!(on_gate_unlock, |h, ui, p: SharedString| {
        if let Some(sess) = &mut h.session {
            if sess.unlock(&p, now_ms()).is_ok() {
                ui.set_page(Page::Chat);
                if let Some(c) = sess.core() {
                    apply_theme(&ui, c);
                }
            }
        }
    });
    on_host!(on_gate_pin, |h, ui, pin: SharedString| {
        if let Some(sess) = &mut h.session {
            if sess.pin_unlock(&pin, now_ms()).is_ok() {
                ui.set_page(Page::Chat);
                ui.set_gate_pin_mode(false);
            }
        }
    });
    on_host!(on_switch_profile, |h, ui, name: SharedString| {
        if let Some(sess) = &mut h.session {
            if !name.trim().is_empty() {
                let _ = sess.switch_profile(&name);
                h.images.clear();
                ui.set_page(Page::Chat);
            }
        }
    });
    on_host!(on_change_pass, |h, ui, cur: SharedString, new: SharedString, again: SharedString| {
        if let Some(sess) = &mut h.session {
            let msg = match sess.change_passphrase(&cur, &new, &again) {
                Ok(()) => "Passphrase changed.".to_string(),
                Err(e) => e,
            };
            if let Some(c) = sess.core_mut() {
                c.status = msg;
            }
        }
        let _ = &ui;
    });
    on_host!(on_pin_set, |h, ui, pass: SharedString, pin: SharedString| {
        if let Some(sess) = &mut h.session {
            let msg = match sess.vault().pin_enroll(&pass, &pin, None) {
                Ok(()) => "PIN set: it unlocks until the app restarts.".to_string(),
                Err(e) => e,
            };
            if let Some(c) = sess.core_mut() {
                c.status = msg;
            }
        }
        let _ = &ui;
    });
    on_host!(on_pin_clear, |h, ui| {
        if let Some(sess) = &mut h.session {
            sess.vault().pin_clear();
        }
        let _ = &ui;
    });
    on_host!(on_set_idle, |h, ui, v: SharedString| {
        if let (Some(sess), Ok(m)) = (&mut h.session, v.trim().parse::<u64>()) {
            sess.set_idle_mins(m, now_ms());
        }
        let _ = &ui;
    });
    on_host!(on_set_lock_on_hide, |h, ui, on: bool| {
        if let Some(sess) = &mut h.session {
            sess.set_lock_on_hide(on);
        }
        let _ = &ui;
    });
    on_host!(on_panic_set, |h, ui, pass: SharedString, code: SharedString| {
        if let Some(sess) = &mut h.session {
            let msg = match sess.vault().set_panic_code(&pass, &code) {
                Ok(()) => "Panic code set.".to_string(),
                Err(e) => e,
            };
            if let Some(c) = sess.core_mut() {
                c.status = msg;
            }
        }
        let _ = &ui;
    });
    on_host!(on_panic_clear, |h, ui, pass: SharedString| {
        if let Some(sess) = &mut h.session {
            let msg = match sess.vault().clear_panic_code(&pass) {
                Ok(()) => "Panic code removed.".to_string(),
                Err(e) => e,
            };
            if let Some(c) = sess.core_mut() {
                c.status = msg;
            }
        }
        let _ = &ui;
    });
    on_host!(on_erase, |h, ui, confirm: SharedString| {
        if confirm.trim() == "ERASE" {
            if let Some(sess) = &mut h.session {
                let _ = sess.erase_profile();
                h.images.clear();
                ui.set_page(Page::Chat);
            }
        } else if let Some(c) = h.core_mut() {
            c.status = "Type ERASE to confirm.".into();
        }
    });
}

/// Build the window on a host: callbacks wired, state pushed.
///
/// # Errors
/// When Slint cannot create the window (no platform).
pub fn build(host: Host) -> Result<(AppWindow, Shared), slint::PlatformError> {
    let ui = AppWindow::new()?;
    ui.set_narrow(cfg!(target_os = "android"));
    let host = Rc::new(RefCell::new(host));
    wire(&ui, &host);
    refresh(&ui, &mut host.borrow_mut());
    if let Some(c) = host.borrow().core() {
        apply_theme(&ui, c);
    }
    ui.set_scroll_tick(ui.get_scroll_tick() + 1);
    Ok((ui, host))
}

/// The real app on the profiles under `base` (Tor), locked.
///
/// # Errors
/// The vault would not open.
pub fn real_host(base: &Path) -> Result<Host, String> {
    Ok(Host::real(Session::new(Profiles::new(base.to_path_buf()), Net::Tor, enigma_app::vault::KdfParams::default())?))
}

/// Narrow (phone) layout below this logical width.
pub const NARROW_BELOW: f32 = 700.0;

/// One timer tick (every 250 ms): time passes for the app, the idle lock and lock-on-hide;
/// notifications go out; the layout follows the window's width. Outside Slint's layout
/// (set from here, not bound in .slint), so there is no binding loop.
pub fn tick(ui: &AppWindow, host: &Shared) {
    let win = ui.window();
    let hidden = win.is_minimized() || !win.is_visible();
    let viewing = !hidden && ui.get_page() == Page::Chat;
    if !cfg!(target_os = "android") {
        let sz = win.size();
        let w = sz.width as f32 / win.scale_factor();
        if w > 0.0 {
            let narrow = w < NARROW_BELOW;
            if ui.get_narrow() != narrow {
                ui.set_narrow(narrow);
            }
        }
    }
    let mut h = host.borrow_mut();
    let before = h.core().map_or(0, |c| c.messages().len());
    let was_locked = h.locked();
    let hh = &mut *h;
    let idle = match (&mut hh.demo, &mut hh.session) {
        (Some(c), _) => {
            c.tick(viewing);
            Idle::Active
        }
        (None, Some(sess)) => sess.tick(now_ms(), viewing, hidden),
        _ => Idle::Active,
    };
    ui.set_idle_warn(match idle {
        Idle::Warn(s) => s as i32,
        _ => 0,
    });
    if !was_locked && h.locked() {
        h.recording = None;
        h.images.clear();
        ui.set_page(Page::Chat);
    }
    let notes = h.core_mut().map(Core::take_notifications).unwrap_or_default();
    for (title, body) in notes {
        notify(&title, &body);
    }
    let after = h.core().map_or(0, |c| c.messages().len());
    refresh(ui, &mut h);
    if after != before {
        ui.set_scroll_tick(ui.get_scroll_tick() + 1);
    }
}

/// Open an `enigma://` link (deep link) in the running app; the draft goes into the composer.
pub fn open_link(ui: &AppWindow, host: &Shared, url: &str) {
    let mut h = host.borrow_mut();
    if let Some(c) = h.core_mut() {
        if let Some(draft) = c.open_link(url) {
            if !draft.is_empty() {
                ui.set_draft(s(&draft));
            }
            if url.contains("://join/") {
                ui.set_page(Page::Join);
            } else {
                ui.set_page(Page::Chat);
                ui.set_show_chat(true);
            }
        }
    }
    refresh(ui, &mut h);
}

/// Run the app until the window closes: a 250 ms timer ticks it. `link`: an `enigma://`
/// link to open once unlocked (from the command line / the OS's URL handler).
///
/// # Errors
/// From Slint.
pub fn run(host: Host, link: Option<String>) -> Result<(), slint::PlatformError> {
    let (ui, host) = build(host)?;
    let timer = slint::Timer::default();
    let w = ui.as_weak();
    let h2 = host.clone();
    let mut link = link;
    timer.start(slint::TimerMode::Repeated, std::time::Duration::from_millis(250), move || {
        let Some(ui) = w.upgrade() else { return };
        tick(&ui, &h2);
        if link.is_some() && !h2.borrow().locked() {
            if let Some(l) = link.take() {
                open_link(&ui, &h2, &l);
            }
        }
    });
    ui.run()
}

/// The data dir on Android (the app's internal storage).
#[cfg(target_os = "android")]
fn android_base(app: &slint::android::AndroidApp) -> std::path::PathBuf {
    app.internal_data_path().unwrap_or_else(|| std::path::PathBuf::from("/data/local/tmp/enigma27"))
}

/// Android entry point (the cdylib): a client of Your Beacon, like the desktop.
#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(app: slint::android::AndroidApp) {
    let base = android_base(&app);
    slint::android::init(app).expect("slint android init");
    let host = real_host(&base).unwrap_or_else(|_| Host::demo("Me"));
    run(host, None).expect("run");
}

/// Where profiles live on this desktop (the Tauri app's data dir, so its profile opens).
#[must_use]
pub fn data_dir() -> std::path::PathBuf {
    default_base()
}
