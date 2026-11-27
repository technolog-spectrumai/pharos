//! Snapshot-render the main screen with ratatui's TestBackend at 100x30.

use enigma_tui::app::{App, Dialog, Focus};
use enigma_tui::backend::DemoBackend;
use enigma_tui::screens::{render, to_html, to_text};

fn demo() -> App {
    App::new(Box::new(DemoBackend::new()), "Me")
}

#[test]
fn main_screen_shows_the_key_texts() {
    let mut app = demo();
    app.input = "draft message".into();
    let t = to_text(&render(&app, 100, 30));
    for s in [
        "Enigma27",
        "Tor: simulated",
        "Beacon: off",
        "Rooms",
        "Lighthouse",
        "Harbour",
        "Friends",
        "Ann",
        "Encrypted",
        "1 linked",
        "Direct",
        "Hi! Ann here",
        "Hello Ann, the console works.",
        "Message",
        "draft message",
        "\u{23fb} ENABLE BEACON",
        "[n] New room",
        "[j] Join",
        "[i] Invite",
        "[f] Friends",
        "[b] Beacon",
        "[q] Quit",
        "Tab move focus",
    ] {
        assert!(t.contains(s), "missing {s:?} in\n{t}");
    }
    assert_eq!(t.lines().count(), 30);
    // own message right-aligned: it ends near the right border of the chat
    let own = t.lines().find(|l| l.contains("Hello Ann, the console works.")).unwrap();
    assert!(own.trim_end().chars().count() > 90, "{own}");
    // the button sits at the bottom, framed
    let btn = app.beacon_button.get();
    assert_eq!((btn.y, btn.height), (26, 3));
}

#[test]
fn beacon_on_shows_disable_and_the_address() {
    let mut app = demo();
    app.toggle_beacon();
    let t = to_text(&render(&app, 100, 30));
    let onion = app.beacon.onion.clone().unwrap();
    for s in ["\u{23fb} DISABLE BEACON", "Beacon: on", "Via Beacon", onion.as_str()] {
        assert!(t.contains(s), "missing {s:?} in\n{t}");
    }
}

#[test]
fn dialogs_render() {
    let mut app = demo();
    app.focus = Focus::Rooms;
    app.dialog = Some(Dialog::Invite(app.invitation_code().unwrap()));
    let t = to_text(&render(&app, 100, 40));
    assert!(t.contains("Invite to this room") && t.contains("enigma27-invite:1:") && t.contains('\u{2580}'), "{t}");
    app.dialog = Some(Dialog::Friends(String::new()));
    let t = to_text(&render(&app, 100, 30));
    assert!(t.contains("enigma27-friend:1:") && t.contains("check code"), "{t}");
    assert!(to_html(&render(&app, 100, 30), "x").contains("<div class=\"r\">"));
}
