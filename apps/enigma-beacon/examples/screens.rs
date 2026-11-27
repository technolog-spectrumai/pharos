//! Render the Beacon app's screens off-screen (software renderer, 2x) to PNGs in
//! `docs/screens/beacon-app/`: `cargo run -p enigma-beacon --example beacon-screens`.

use std::path::{Path, PathBuf};

use enigma_beacon::headless::{self, Shot};
use enigma_beacon::model::{Mode, Model};
use enigma_beacon::{build, refresh, Screen};
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
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/screens/beacon-app");
    std::fs::create_dir_all(&out).unwrap();
    headless::init();
    let (w, h, scale) = (1100, 720, 2.0);
    let tmp = tempfile::tempdir().unwrap();
    let m = Model::open(&tmp.path().join("config.yaml"), Mode::Demo).unwrap();
    let (ui, m) = build(m).unwrap();
    m.borrow_mut().set_restricted(true).unwrap();
    refresh(&ui, &m.borrow_mut().snapshot());

    ui.invoke_set_dark(false);
    save(&out, "overview-light", &headless::render(&ui, w, h, scale));
    ui.invoke_set_dark(true);
    save(&out, "overview-dark", &headless::render(&ui, w, h, scale));
    ui.invoke_set_dark(false);
    for (screen, name) in [(Screen::Clients, "clients"), (Screen::Rooms, "rooms"), (Screen::Settings, "settings"), (Screen::Log, "log")] {
        ui.set_screen(screen);
        let hh = if name == "settings" { 900 } else { h };
        save(&out, name, &headless::render(&ui, w, hh, scale));
    }
    // A Pi's 800×480 touch screen.
    ui.set_screen(Screen::Overview);
    save(&out, "pi-800x480", &headless::render(&ui, 800, 480, 1.0));
    ui.hide().unwrap();
}
