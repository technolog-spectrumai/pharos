//! Writes the demo screens (beacon off / on, plus the invite and friends dialogs) to
//! `docs/screens/tui/*.txt` and `*.html`; `scripts/screenshot.js` turns the HTML into PNGs.
//!
//! cargo run -p enigma-tui --example screens && node apps/enigma-tui/scripts/screenshot.js

use std::path::PathBuf;

use enigma_tui::app::{App, Dialog, Focus};
use enigma_tui::backend::DemoBackend;
use enigma_tui::screens::{render, to_html, to_text};

fn main() {
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/screens/tui");
    std::fs::create_dir_all(&out).unwrap();
    let mut app = App::new(Box::new(DemoBackend::new()), "Me");
    for t in ["Are you on the Pi already?", "The console works over SSH too."] {
        app.input = t.into();
        app.send();
    }
    app.input = "see you at the harbour".into();
    let save = |name: &str, app: &App, h: u16| {
        let b = render(app, 100, h);
        std::fs::write(out.join(format!("{name}.txt")), to_text(&b)).unwrap();
        std::fs::write(out.join(format!("{name}.html")), to_html(&b, &format!("enigma-tui --demo \u{2014} {name}"))).unwrap();
        println!("{}", out.join(name).display());
    };
    save("main-beacon-off", &app, 30);
    app.toggle_beacon();
    save("main-beacon-on", &app, 30);
    app.focus = Focus::Rooms;
    app.dialog = Some(Dialog::Invite(app.invitation_code().unwrap()));
    save("invite", &app, 36);
    app.dialog = Some(Dialog::Friends(String::new()));
    save("friends", &app, 30);
}
