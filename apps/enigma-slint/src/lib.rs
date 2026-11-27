//! `enigma-slint`: Enigma's main app in Slint, for desktop and Android (stage 5 of b2.md).
//!
//! The UI is in `ui/*.slint`; this file is the glue: it owns an [`enigma_app::core::Core`],
//! turns its state into Slint models ([`refresh`]) and Slint callbacks into core actions
//! ([`wire`]). Nothing here knows about rooms or crypto beyond what `Core` exposes, so the
//! console app (`enigma-tui`) and this app behave the same.

use std::cell::RefCell;
use std::rc::Rc;

use enigma_app::avatar::{colour_for, first_letter};
use enigma_app::backend::{Backend, DemoBackend, RealBackend};
use enigma_app::codes;
use enigma_app::core::{Core, BEACON_SUPPORTED};
use enigma_app::i18n::{t, tf, Lang};
use enigma_core::MessageKind;
use slint::{Color, ComponentHandle, Image, ModelRc, Rgb8Pixel, SharedPixelBuffer, SharedString, VecModel};

pub mod headless;

slint::include_modules!();

/// The shared core, as the callbacks hold it.
pub type Shared = Rc<RefCell<Core>>;

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
        nickname: g("settings.nickname"),
        nickname_hint: g("settings.nicknameHint"),
        language: g("settings.language"),
        theme: g("settings.theme"),
        beacon_title: g("beacon.title"),
        beacon_intro: g("beacon.intro"),
        beacon_enable: g("beacon.enable"),
        beacon_disable: g("beacon.disable"),
        beacon_on: g("beacon.on"),
        beacon_off: g("beacon.off"),
        beacon_on_hint: g("beacon.onHint"),
        beacon_client_only: g("beacon.clientOnly"),
        beacon_address: g("beacon.address"),
        not_connected: g("conn.notConnected"),
        you: g("participants.you"),
        linked: g("participants.linked"),
        not_linked: g("participants.notLinked"),
        host: g("info.host"),
        member: g("info.member"),
    }
}

/// The timeline as bubbles: runs by the same author are grouped (name on the first,
/// avatar beside the last), like ChatBubble.vue.
#[must_use]
pub fn message_items(c: &Core) -> Vec<MessageItem> {
    let ms = c.messages();
    let key = |i: usize| {
        let m = &ms[i];
        (m.kind == MessageKind::System, m.is_self, m.user.clone())
    };
    (0..ms.len())
        .map(|i| {
            let m = &ms[i];
            let system = matches!(m.kind, MessageKind::System | MessageKind::Placeholder);
            let text = match &m.kind {
                MessageKind::System => m.notice.as_ref().map_or_else(|| m.content.clone(), |n| n.text.clone()),
                MessageKind::Image => "🖼 image".into(),
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
            }
        })
        .collect()
}

fn model<T: Clone + 'static>(v: Vec<T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(v))
}

/// Push the core's state into the window.
pub fn refresh(ui: &AppWindow, c: &Core) {
    let l = c.lang;
    ui.set_t(texts(l));
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
    ui.set_messages(model(message_items(c)));
    let name = c.room_name();
    ui.set_has_room(name.is_some());
    let name = name.unwrap_or_default();
    ui.set_room_letter(s(&first_letter(&name)));
    ui.set_room_colour(rgb(colour_for(&name)));
    ui.set_room_name(s(&name));
    ui.set_state_line(s(&c.state_line()));
    ui.set_connected(c.connected());
    let (tor, ok) = c.tor_label();
    ui.set_tor_text(s(&tor));
    ui.set_tor_ok(ok);
    ui.set_status(s(&c.status));

    ui.set_beacon_supported(BEACON_SUPPORTED);
    ui.set_beacon_on(c.beacon.enabled);
    ui.set_beacon_onion(s(c.beacon.onion.as_deref().unwrap_or("")));
    ui.set_beacon_status(s(&if c.beacon.enabled { format!("{} \u{b7} {}", t(l, "beacon.on"), c.beacon.status) } else { t(l, "beacon.off").into() }));

    ui.set_my_name(s(&c.user_name));
    ui.set_my_letter(s(&first_letter(&c.user_name)));
    ui.set_my_colour(rgb(colour_for(&c.user_name)));
    ui.set_lang_index(i32::from(l == Lang::Pl));
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
    let mut t2 = ui.get_t();
    t2.friends_list = s(&tf(l, "friends.list", &[("n", &c.friends.len().to_string())]));
    ui.set_t(t2);
    ui.set_people(model(
        c.participants()
            .iter()
            .map(|p| PersonItem { name: s(&p.name), letter: s(&first_letter(&p.name)), colour: rgb(colour_for(&p.name)), is_self: p.is_self, linked: p.linked })
            .collect(),
    ));
    ui.set_info_slug(s(cur.as_deref().unwrap_or("")));
    ui.set_info_role(s(t(l, if c.is_host() { "info.host" } else { "info.member" })));
    ui.set_invite_title(s(&tf(l, "invite.title", &[("room", &name)])));
}

/// Fill the Invite page for the current room.
pub fn show_invite(ui: &AppWindow, c: &Core) {
    if let Some(code) = c.invitation_code() {
        ui.set_invite_qr(qr_image(&code, 8));
        ui.set_invite_code(s(&code));
        ui.set_page(Page::Invite);
    }
}

/// Connect the window's callbacks to the core.
pub fn wire(ui: &AppWindow, core: &Shared) {
    let w = ui.as_weak();
    macro_rules! on {
        ($set:ident, |$c:ident, $ui:ident $(, $a:ident: $ty:ty)*| $body:block) => {{
            let core = core.clone();
            let w = w.clone();
            ui.$set(move |$($a: $ty),*| {
                let Some($ui) = w.upgrade() else { return };
                {
                    let mut guard = core.borrow_mut();
                    let $c: &mut Core = &mut guard;
                    $body
                }
                refresh(&$ui, &core.borrow());
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
    on!(on_toggle_beacon, |c, ui| {
        c.toggle_beacon();
        let _ = &ui;
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
        }
    });
    on!(on_add_friend, |c, ui, code: SharedString| {
        c.add_friend(&code);
        let _ = &ui;
    });
    on!(on_set_nickname, |c, ui, name: SharedString| {
        c.set_user_name(&name);
        let _ = &ui;
    });
    on!(on_set_lang, |c, ui, i: i32| {
        c.lang = if i == 1 { Lang::Pl } else { Lang::En };
        let _ = &ui;
    });
    on!(on_open_invite, |c, ui| {
        show_invite(&ui, c);
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
}

/// Build the window on a core: callbacks wired, state pushed.
///
/// # Errors
/// When Slint cannot create the window (no platform).
pub fn build(core: Core) -> Result<(AppWindow, Shared), slint::PlatformError> {
    let ui = AppWindow::new()?;
    ui.set_narrow(cfg!(target_os = "android"));
    let core = Rc::new(RefCell::new(core));
    wire(&ui, &core);
    refresh(&ui, &core.borrow());
    ui.set_scroll_tick(ui.get_scroll_tick() + 1);
    Ok((ui, core))
}

/// A core on the demo backend (simulated Ann) or the real one.
#[must_use]
pub fn make_core(demo: bool, name: &str) -> Core {
    let backend: Box<dyn Backend> = if demo { Box::new(DemoBackend::new()) } else { Box::new(RealBackend) };
    Core::new(backend, name)
}

/// Run the app until the window closes: a 250 ms timer ticks the core.
///
/// # Errors
/// From Slint.
pub fn run(demo: bool, name: &str, lang: Lang) -> Result<(), slint::PlatformError> {
    let mut c = make_core(demo, name);
    c.lang = lang;
    let (ui, core) = build(c)?;
    let timer = slint::Timer::default();
    let w = ui.as_weak();
    let core2 = core.clone();
    timer.start(slint::TimerMode::Repeated, std::time::Duration::from_millis(250), move || {
        let Some(ui) = w.upgrade() else { return };
        let before = core2.borrow().messages().len();
        core2.borrow_mut().tick(true);
        let after = core2.borrow().messages().len();
        refresh(&ui, &core2.borrow());
        if after != before {
            ui.set_scroll_tick(ui.get_scroll_tick() + 1);
        }
    });
    ui.run()
}

/// Android entry point (the cdylib): client only, so no Beacon toggle.
#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(app: slint::android::AndroidApp) {
    slint::android::init(app).expect("slint android init");
    // Stage 2 wires the real client; until then the phone runs the demo world.
    run(true, "Me", Lang::En).expect("run");
}
