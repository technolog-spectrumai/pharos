//! The combo's screens at 2x (software renderer, demo client + demo Lighthouse) into
//! `docs/screens/combo/`: `cargo run -p enigma27-combo --example combo-screens`.

use std::path::{Path, PathBuf};

use enigma27::headless::{self, Shot};
use enigma27_combo::{lighthouse, Combo, RelaySlot};
use pharos_lighthouse::model::{Mode, Model};
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
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/screens/combo");
    std::fs::create_dir_all(&out).unwrap();
    headless::init();
    let (w, h, scale) = (1300, 760, 2.0);
    let cfg = std::env::temp_dir().join(format!("enigma27-combo-screens-{}", std::process::id())).join("config.yaml");
    let mut m = Model::open(&cfg, Mode::Demo).unwrap();
    m.start().unwrap();
    let combo = Combo::build(enigma27::Host::demo("Me"), m, RelaySlot::default()).unwrap();
    {
        let mut hh = combo.host.borrow_mut();
        let c = hh.core_mut().unwrap();
        c.send("My Lighthouse runs on this PC now.");
    }
    combo.step();
    combo.ui.set_scroll_tick(combo.ui.get_scroll_tick() + 1);
    let ui = &combo.ui;
    for (dark, tag) in [(false, "light"), (true, "dark")] {
        ui.invoke_set_dark(dark);
        ui.set_lighthouse_shown(false);
        save(&out, &format!("chat-{tag}"), &headless::render(ui, w, h, scale));
        ui.set_lighthouse_shown(true);
        lighthouse::lh(ui).set_screen(enigma27_combo::LhScreen::Overview);
        save(&out, &format!("lighthouse-overview-{tag}"), &headless::render(ui, w, h, scale));
    }
    ui.invoke_set_dark(false);
    lighthouse::lh(ui).set_screen(enigma27_combo::LhScreen::Clients);
    save(&out, "lighthouse-clients", &headless::render(ui, w, h, scale));
    // The Lighthouse stopped: the client says so and stays readable.
    lighthouse::lh(ui).invoke_toggle();
    combo.step();
    ui.set_lighthouse_shown(false);
    save(&out, "chat-lighthouse-off", &headless::render(ui, w, h, scale));
    ui.hide().unwrap();
    combo.model.borrow_mut().stop();
    let _ = std::fs::remove_dir_all(cfg.parent().unwrap());
}
