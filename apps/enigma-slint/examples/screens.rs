//! Render the Slint app's screens off-screen (software renderer, 2x) to PNGs in
//! `docs/screens/slint/`: `cargo run -p enigma-slint --example slint-screens`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use beacon_node::relay::Directory;
use enigma_app::real::Net;
use enigma_app::session::Session;
use enigma_app::vault::{test_kdf, Profiles};
use enigma_slint::headless::{self, Shot};
use enigma_slint::{build, refresh, show_invite, AppWindow, Host, Page};
use slint::ComponentHandle;

fn save(dir: &Path, name: &str, s: &Shot) {
    let p = dir.join(format!("{name}.png"));
    let f = std::fs::File::create(&p).unwrap();
    let mut e = png::Encoder::new(std::io::BufWriter::new(f), s.width, s.height);
    e.set_color(png::ColorType::Rgb);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().unwrap().write_image_data(&s.rgb).unwrap();
    println!("{}", p.display());
}

fn main() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/screens/slint");
    std::fs::create_dir_all(&out).unwrap();
    for old in ["main-beacon-on", "settings-beacon"] {
        let _ = std::fs::remove_file(out.join(format!("{old}.png")));
    }
    headless::init();
    let (w, h, scale) = (1100, 720, 2.0);

    let (ui, host) = build(Host::demo("Me")).unwrap();
    {
        let mut hh = host.borrow_mut();
        let c = hh.core_mut().unwrap();
        for t in ["Are you on the Pi already?", "The Slint app works on the desktop too."] {
            c.send(t);
        }
        let pic = std::env::temp_dir().join("enigma-screens-pic.png");
        let img = image_like(&pic);
        if img {
            c.send_image_file(&pic);
        }
        c.send_voice_wav(&enigma_slint::audio::wav_bytes(&[0; 8000], 8000));
    }
    let redraw = |ui: &AppWindow| {
        refresh(ui, &mut host.borrow_mut());
        ui.set_scroll_tick(ui.get_scroll_tick() + 1);
    };
    redraw(&ui);
    ui.set_draft("see you at the harbour".into());
    ui.invoke_set_dark(false);
    save(&out, "main-light", &headless::render(&ui, w, h, scale));
    ui.invoke_set_dark(true);
    save(&out, "main-dark", &headless::render(&ui, w, h, scale));
    ui.invoke_set_dark(false);

    let onion = format!("{}.onion", enigma_app::codes::base32_lower(&[3u8; 35]));
    ui.invoke_set_my_beacon(onion.into());
    ui.set_page(Page::Settings);
    redraw(&ui);
    save(&out, "settings", &headless::render(&ui, w, 2600, scale));

    ui.set_page(Page::Friends);
    save(&out, "friends", &headless::render(&ui, w, 1000, scale));

    {
        let mut hh = host.borrow_mut();
        show_invite(&ui, hh.core_mut().unwrap(), 1, 1);
    }
    redraw(&ui);
    save(&out, "invite", &headless::render(&ui, w, 1100, scale));

    ui.set_page(Page::Participants);
    save(&out, "participants", &headless::render(&ui, w, 480, scale));

    ui.set_page(Page::RoomInfo);
    save(&out, "room-info", &headless::render(&ui, w, 720, scale));

    ui.invoke_offer_file(std::env::temp_dir().join("enigma-screens-pic.png").to_string_lossy().to_string().into());
    ui.set_page(Page::Files);
    redraw(&ui);
    save(&out, "files", &headless::render(&ui, w, 600, scale));

    ui.set_page(Page::Join);
    let code = host.borrow().core().unwrap().backend.sample_invitation().unwrap();
    ui.invoke_peek(code.into());
    save(&out, "join-peek", &headless::render(&ui, w, 600, scale));

    // phone layout (what Android shows): list then chat
    ui.set_page(Page::Chat);
    ui.set_narrow(true);
    ui.set_show_chat(true);
    ui.invoke_set_dark(true);
    save(&out, "phone-chat-dark", &headless::render(&ui, 400, 820, scale));
    ui.set_show_chat(false);
    save(&out, "phone-rooms-dark", &headless::render(&ui, 400, 820, scale));
    ui.hide().unwrap();
    drop((ui, host));

    // the lock gate on a real (empty) profile: welcome, then locked
    let base = std::env::temp_dir().join(format!("enigma-screens-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let sess = Session::new(Profiles::new(base.clone()), Net::Test(Arc::new(Directory::default())), test_kdf()).unwrap();
    let (ui, host) = build(Host::real(sess)).unwrap();
    ui.invoke_set_dark(false);
    save(&out, "welcome", &headless::render(&ui, w, h, scale));
    ui.invoke_gate_create_vault("password1".into(), "password1".into());
    ui.invoke_lock_now();
    ui.invoke_gate_unlock("wrong one".into());
    save(&out, "unlock", &headless::render(&ui, w, h, scale));
    ui.invoke_gate_unlock("password1".into());
    save(&out, "real-not-connected", &headless::render(&ui, w, h, scale));
    ui.set_idle_warn(19);
    save(&out, "idle-warning", &headless::render(&ui, w, h, scale));
    ui.hide().unwrap();
    drop((ui, host));
    let _ = std::fs::remove_dir_all(base);
}

/// A small picture to send (a gradient), as PNG.
fn image_like(p: &Path) -> bool {
    let (w, h) = (320u32, 200u32);
    let mut buf = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            buf.extend_from_slice(&[(x * 255 / w) as u8, (y * 255 / h) as u8, 160]);
        }
    }
    let Ok(f) = std::fs::File::create(p) else { return false };
    let mut e = png::Encoder::new(std::io::BufWriter::new(f), w, h);
    e.set_color(png::ColorType::Rgb);
    e.set_depth(png::BitDepth::Eight);
    e.write_header().and_then(|mut wr| wr.write_image_data(&buf)).is_ok()
}
