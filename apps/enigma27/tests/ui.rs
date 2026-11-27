//! Drive the Slint UI headless (software renderer, no window system): callbacks in,
//! properties out, and a real render.

use std::sync::Arc;

use beacon_node::relay::Directory;
use enigma_app::codes;
use enigma_app::i18n::Lang;
use enigma_app::real::Net;
use enigma_app::session::Session;
use enigma_app::vault::{test_kdf, Profiles};
use enigma27::{build, headless, qr_image, texts, Host, Page};
use slint::Model;

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("enigma27-ui-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn the_window_drives_the_core_end_to_end() {
    headless::init();
    let (ui, host) = build(Host::demo("Me")).unwrap();
    assert!(!ui.get_locked());
    assert_eq!(ui.get_room_name(), "Lighthouse");
    assert_eq!(ui.get_state_line(), "\u{1f512} Encrypted \u{b7} Linked to 1 \u{b7} Direct");
    assert_eq!(ui.get_rooms().row_count(), 2);
    assert!(ui.get_connected());

    // send through the composer callback; Ann answers on the next tick
    ui.set_draft("hello from slint".into());
    ui.invoke_send("hello from slint".into());
    assert_eq!(ui.get_draft(), "");
    enigma27::tick(&ui, &host);
    let msgs = ui.get_messages();
    assert!(msgs.iter().any(|m| m.mine && m.text == "hello from slint"));
    assert!(msgs.iter().any(|m| !m.mine && m.author == "Ann" && m.text.contains("hello from slint")));

    // Your Beacon: a pharos-beacon code / onion makes rooms go via the Beacon
    let onion = format!("{}.onion", codes::base32_lower(&[3u8; 35]));
    ui.invoke_set_my_beacon(onion.clone().into());
    assert!(ui.get_state_line().ends_with("Via Beacon"));
    assert!(ui.get_beacon_current().contains(&onion));
    ui.invoke_remove_my_beacon();
    assert_eq!(ui.get_beacon_current(), "");

    // new room, invite (TTL + for whom), join, friends, language
    ui.invoke_create_room("Attic".into());
    assert_eq!(ui.get_room_name(), "Attic");
    assert!(ui.get_banner().contains("alone"));
    ui.invoke_open_invite();
    assert_eq!(ui.get_page(), Page::Invite);
    ui.invoke_make_invite(0, 1);
    let inv = codes::decode_invitation(&ui.get_invite_code()).unwrap();
    assert_eq!(inv.name, "Attic");
    assert!(inv.expires > 0, "1 hour");
    assert_eq!(inv.for_device, host.borrow().core().unwrap().friends[0].id, "personal, for Ann");
    assert!(ui.get_invite_qr().size().width > 100);
    let code = host.borrow().core().unwrap().backend.sample_invitation().unwrap();
    ui.invoke_peek(code.clone().into());
    assert!(ui.get_peek_text().contains("Ann's Garden"), "{}", ui.get_peek_text());
    ui.invoke_join(code.into());
    assert_eq!(ui.get_room_name(), "Ann's Garden");
    assert_eq!(ui.get_page(), Page::Chat);
    ui.invoke_add_friend(codes::encode_pairing(&"b".repeat(64), "Bob").into());
    assert_eq!(ui.get_friends().row_count(), 2);
    assert_eq!(ui.get_friends().row_data(1).unwrap().check.len(), 14);
    assert_eq!(ui.get_friend_names().row_count(), 3);
    ui.invoke_remove_friend(1);
    assert_eq!(ui.get_friends().row_count(), 1);
    ui.invoke_set_tab("files".into(), false);
    assert!(!ui.get_tab_files());
    ui.invoke_set_theme(2);
    assert_eq!(ui.get_theme_index(), 2);
    ui.invoke_set_lang(1);
    assert_eq!(ui.get_t().friends, "Znajomi");
    assert_eq!(ui.get_t().friends_list, "Twoi znajomi (1)");

    // it renders: the header is the dark header colour
    ui.invoke_set_dark(false);
    let shot = headless::render(&ui, 800, 600, 1.0);
    assert_eq!((shot.width, shot.height), (800, 600));
    assert_eq!(&shot.rgb[(10 * 800 + 400) * 3..][..3], &[0x1d, 0x23, 0x33]);
}

#[test]
fn pictures_show_in_bubbles_and_a_qr_picture_fills_the_join_field() {
    headless::init();
    let dir = tmp("pic");
    let (ui, host) = build(Host::demo("Me")).unwrap();
    let png = dir.join("p.png");
    image_png(&png, 80, 60);
    ui.invoke_send_picture(png.to_string_lossy().to_string().into());
    let m = ui.get_messages();
    let pic = m.iter().find(|m| m.has_image).expect("a picture bubble");
    assert!(pic.mine && pic.image.size().width == 80);
    // a QR code in a picture → the Join field, peeked
    let code = host.borrow().core().unwrap().backend.sample_invitation().unwrap();
    let qr = dir.join("qr.png");
    qr_png(&code, &qr);
    ui.set_page(Page::Join);
    ui.invoke_scan_file(qr.to_string_lossy().to_string().into());
    assert_eq!(ui.get_scanned(), code.as_str());
    assert!(ui.get_peek_text().contains("Ann's Garden"));
    // files: an offer shows in the Files list
    ui.invoke_offer_file(png.to_string_lossy().to_string().into());
    assert_eq!(ui.get_files().row_count(), 1);
    assert!(ui.get_files().row_data(0).unwrap().can_cancel);
    let _ = std::fs::remove_dir_all(dir);
}

fn image_png(p: &std::path::Path, w: u32, h: u32) {
    let f = std::fs::File::create(p).unwrap();
    let mut e = png::Encoder::new(std::io::BufWriter::new(f), w, h);
    e.set_color(png::ColorType::Rgb);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().unwrap().write_image_data(&vec![120u8; (w * h * 3) as usize]).unwrap();
}

fn qr_png(text: &str, p: &std::path::Path) {
    let (side, m) = codes::qr_modules(text).unwrap();
    let (scale, quiet) = (4usize, 4usize);
    let px = (side + 2 * quiet) * scale;
    let mut buf = vec![255u8; px * px];
    for y in 0..px {
        for x in 0..px {
            let (mx, my) = ((x / scale) as isize - quiet as isize, (y / scale) as isize - quiet as isize);
            if mx >= 0 && my >= 0 && (mx as usize) < side && (my as usize) < side && m[my as usize * side + mx as usize] {
                buf[y * px + x] = 0;
            }
        }
    }
    let f = std::fs::File::create(p).unwrap();
    let mut e = png::Encoder::new(std::io::BufWriter::new(f), px as u32, px as u32);
    e.set_color(png::ColorType::Grayscale);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().unwrap().write_image_data(&buf).unwrap();
}

#[test]
fn glue_helpers() {
    assert_eq!(texts(Lang::Pl).new_chat, "Nowy czat");
    assert_eq!(enigma27::hhmm(3_600_000 * 25 + 60_000 * 7), "01:07");
    assert_eq!(qr_image("x", 2).size().width % 2, 0);
}

/// The real app behind its lock gate: create, lock, wrong passphrase, unlock, PIN, panic
/// code, change passphrase, profiles, erase. No Tor (an empty in-memory Beacon directory).
#[test]
fn the_lock_gate_create_unlock_pin_panic_and_erase() {
    headless::init();
    let base = tmp("gate");
    let net = Net::Test(Arc::new(Directory::default()));
    let sess = Session::new(Profiles::new(base.clone()), net, test_kdf()).unwrap();
    let (ui, host) = build(Host::real(sess)).unwrap();
    assert!(ui.get_locked() && ui.get_gate_create());
    ui.invoke_gate_create_vault("password1".into(), "password2".into());
    assert!(ui.get_locked());
    assert_eq!(ui.get_gate_error(), "the two passphrases differ");
    ui.invoke_gate_create_vault("password1".into(), "password1".into());
    assert!(!ui.get_locked());
    // not attached to a Beacon yet
    assert!(!ui.get_connected());
    assert!(ui.get_t().not_connected.contains("Your Beacon"));
    assert_eq!(ui.get_beacon_current(), "");
    ui.invoke_set_nickname("Zed".into());
    ui.invoke_lock_now();
    assert!(ui.get_locked() && !ui.get_gate_create());
    ui.invoke_gate_unlock("nope".into());
    assert_eq!(ui.get_gate_error(), "wrong passphrase");
    ui.invoke_gate_unlock("password1".into());
    assert!(!ui.get_locked());
    assert_eq!(ui.get_my_name(), "Zed", "kept in the vault");
    // PIN
    ui.invoke_pin_set("password1".into(), "2468".into());
    assert!(ui.get_pin_on());
    ui.invoke_lock_now();
    assert!(ui.get_gate_has_pin());
    ui.invoke_gate_pin("2468".into());
    assert!(!ui.get_locked());
    ui.invoke_pin_clear();
    assert!(!ui.get_pin_on());
    // change passphrase
    ui.invoke_change_pass("password1".into(), "password3".into(), "password3".into());
    assert_eq!(ui.get_status(), "Passphrase changed.");
    // settings that live in the vault
    ui.invoke_set_idle("5".into());
    assert_eq!(ui.get_idle_mins(), "5");
    ui.invoke_set_lock_on_hide(true);
    assert!(ui.get_lock_on_hide());
    ui.invoke_set_timeout("45".into());
    assert_eq!(ui.get_connect_timeout(), "45");
    ui.invoke_set_offline(true);
    assert!(ui.get_offline() && !ui.get_connected());
    ui.invoke_set_offline(false);
    // panic code: typing it at the lock screen wipes, silently
    ui.invoke_panic_set("password3".into(), "redcode99".into());
    assert!(ui.get_panic_on());
    ui.invoke_lock_now();
    ui.invoke_gate_unlock("redcode99".into());
    assert!(!ui.get_locked(), "looks like a normal unlock");
    assert_eq!(ui.get_rooms().row_count(), 0);
    assert_ne!(ui.get_my_name(), "Zed", "everything was erased");
    // profiles: another one starts at Create
    ui.invoke_switch_profile("work".into());
    assert!(ui.get_locked() && ui.get_gate_create());
    assert!(ui.get_profile().contains("work"));
    ui.invoke_gate_create_vault("password9".into(), "password9".into());
    ui.invoke_erase("nope".into());
    assert!(!ui.get_locked());
    ui.invoke_erase("ERASE".into());
    assert!(ui.get_locked() && ui.get_gate_create());
    drop((ui, host));
    let _ = std::fs::remove_dir_all(base);
}

/// The phone layout follows the window's width (set from Rust on each tick: no binding loop).
#[test]
fn narrow_windows_get_the_phone_layout() {
    headless::init();
    let (ui, host) = build(Host::demo("Me")).unwrap();
    let _ = headless::render(&ui, 420, 800, 1.0);
    enigma27::tick(&ui, &host);
    assert!(ui.get_narrow());
    let _ = headless::render(&ui, 1100, 700, 1.0);
    enigma27::tick(&ui, &host);
    assert!(!ui.get_narrow());
}

/// The composer's LineEdit follows dark mode (std widgets read Palette.color-scheme).
#[test]
fn text_fields_follow_dark_mode() {
    headless::init();
    let (ui, _host) = build(Host::demo("Me")).unwrap();
    // the composer field sits in the bottom bar; sample its middle, left of the send button
    let px = |ui: &enigma27::AppWindow| {
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

#[test]
fn deep_links_open_the_room_with_a_draft() {
    headless::init();
    let (ui, host) = build(Host::demo("Me")).unwrap();
    enigma27::open_link(&ui, &host, "enigma://room/Harbour/news?to=Ann&quote=hi");
    assert_eq!(ui.get_room_name(), "Harbour");
    assert_eq!(ui.get_draft(), "#news @Ann hi");
}
