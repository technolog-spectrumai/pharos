//! Drive the Slint UI headless (software renderer, no window system): callbacks in,
//! properties out, and a real render.

use enigma_app::codes;
use enigma_slint::{build, headless, make_core, qr_image, texts, Page};
use enigma_app::i18n::Lang;
use slint::Model;

#[test]
fn the_window_drives_the_core_end_to_end() {
    headless::init();
    let (ui, core) = build(make_core(true, "Me")).unwrap();
    assert_eq!(ui.get_room_name(), "Lighthouse");
    assert_eq!(ui.get_state_line(), "\u{1f512} Encrypted \u{b7} Linked to 1 \u{b7} Direct");
    assert_eq!(ui.get_rooms().row_count(), 2);
    assert!(ui.get_connected());

    // send through the composer callback; Ann answers on the next tick
    ui.set_draft("hello from slint".into());
    ui.invoke_send("hello from slint".into());
    assert_eq!(ui.get_draft(), "");
    core.borrow_mut().tick(true);
    enigma_slint::refresh(&ui, &core.borrow());
    let msgs = ui.get_messages();
    assert!(msgs.iter().any(|m| m.mine && m.text == "hello from slint"));
    assert!(msgs.iter().any(|m| !m.mine && m.author == "Ann" && m.text.contains("hello from slint")));

    // the big Beacon toggle
    ui.invoke_toggle_beacon();
    assert!(ui.get_beacon_on() && ui.get_beacon_onion().ends_with(".onion"));
    assert!(ui.get_state_line().ends_with("Via Beacon"));
    assert!(ui.get_beacon_supported());

    // new room, invite, join, friends, language
    ui.invoke_create_room("Attic".into());
    assert_eq!(ui.get_room_name(), "Attic");
    ui.invoke_open_invite();
    assert_eq!(ui.get_page(), Page::Invite);
    assert_eq!(codes::decode_invitation(&ui.get_invite_code()).unwrap().name, "Attic");
    assert!(ui.get_invite_qr().size().width > 100);
    let code = core.borrow().backend.sample_invitation().unwrap();
    ui.invoke_join(code.into());
    assert_eq!(ui.get_room_name(), "Ann's Garden");
    assert_eq!(ui.get_page(), Page::Chat);
    ui.invoke_add_friend(codes::encode_pairing(&"b".repeat(64), "Bob").into());
    assert_eq!(ui.get_friends().row_count(), 2);
    assert_eq!(ui.get_friends().row_data(1).unwrap().check.len(), 14);
    ui.invoke_set_lang(1);
    assert_eq!(ui.get_t().friends, "Znajomi");
    assert_eq!(ui.get_t().friends_list, "Twoi znajomi (2)");

    // it renders: the header is the dark header colour
    let shot = headless::render(&ui, 800, 600, 1.0);
    assert_eq!((shot.width, shot.height), (800, 600));
    assert_eq!(&shot.rgb[(10 * 800 + 400) * 3..][..3], &[0x1d, 0x23, 0x33]);
}

#[test]
fn glue_helpers() {
    assert_eq!(texts(Lang::Pl).new_chat, "Nowy czat");
    assert_eq!(enigma_slint::hhmm(3_600_000 * 25 + 60_000 * 7), "01:07");
    assert_eq!(qr_image("x", 2).size().width % 2, 0);
}

#[test]
fn the_real_backend_shows_not_connected() {
    headless::init();
    let (ui, _core) = build(make_core(false, "Me")).unwrap();
    assert!(!ui.get_connected());
    assert!(!ui.get_has_room());
    assert!(ui.get_t().not_connected.contains("Not connected yet"));
    ui.invoke_toggle_beacon();
    assert!(ui.get_status().contains("stage 2"));
}

/// The composer's LineEdit follows dark mode (std widgets read Palette.color-scheme).
#[test]
fn text_fields_follow_dark_mode() {
    headless::init();
    let (ui, _core) = build(make_core(true, "Me")).unwrap();
    // the composer field sits in the bottom bar; sample its middle, left of the send button
    let px = |ui: &enigma_slint::AppWindow| {
        let s = headless::render(ui, 800, 600, 1.0);
        let i = ((600 - 30) * 800 + 600) * 3;
        let p = &s.rgb[i..i + 3];
        (u32::from(p[0]) + u32::from(p[1]) + u32::from(p[2])) / 3
    };
    ui.invoke_set_dark(true);
    let dark = px(&ui);
    ui.invoke_set_dark(false);
    let light = px(&ui);
    assert!(dark < 80, "dark field luminance {dark}");
    assert!(light > 180, "light field luminance {light}");
}
