//! Render the Slint app's screens off-screen (software renderer, 2x) to PNGs in
//! `docs/screens/slint/`: `cargo run -p enigma-slint --example screens`.

use std::path::{Path, PathBuf};

use enigma_slint::headless::{self, Shot};
use enigma_slint::{build, make_core, refresh, show_invite, AppWindow, Page, Theme};
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
    headless::init();
    let (w, h, scale) = (1100, 720, 2.0);

    let (ui, core) = build(make_core(true, "Me")).unwrap();
    {
        let mut c = core.borrow_mut();
        for t in ["Are you on the Pi already?", "The Slint app works on the desktop too."] {
            c.send(t);
        }
    }
    let redraw = |ui: &AppWindow| {
        refresh(ui, &core.borrow());
        ui.set_scroll_tick(ui.get_scroll_tick() + 1);
    };
    redraw(&ui);
    ui.set_draft("see you at the harbour".into());
    ui.global::<Theme>().set_dark(false);
    save(&out, "main-light", &headless::render(&ui, w, h, scale));
    ui.global::<Theme>().set_dark(true);
    save(&out, "main-dark", &headless::render(&ui, w, h, scale));

    core.borrow_mut().set_beacon(true);
    redraw(&ui);
    ui.global::<Theme>().set_dark(false);
    save(&out, "main-beacon-on", &headless::render(&ui, w, h, scale));

    ui.set_page(Page::Settings);
    save(&out, "settings-beacon", &headless::render(&ui, w, 980, scale));

    ui.set_page(Page::Friends);
    save(&out, "friends", &headless::render(&ui, w, 1000, scale));

    show_invite(&ui, &core.borrow());
    save(&out, "invite", &headless::render(&ui, w, 720, scale));

    ui.set_page(Page::Participants);
    save(&out, "participants", &headless::render(&ui, w, 480, scale));

    // phone layout (what Android shows): client only, list then chat
    ui.set_page(Page::Chat);
    ui.set_beacon_supported(false);
    ui.set_narrow(true);
    ui.set_show_chat(true);
    ui.global::<Theme>().set_dark(true);
    save(&out, "phone-chat-dark", &headless::render(&ui, 400, 820, scale));
    ui.hide().unwrap();
}
