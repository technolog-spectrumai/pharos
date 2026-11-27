//! The window renders headless (software renderer) in demo mode, every screen, and
//! the QR is dark on light with a light border.

use pharos_lighthouse::model::{Mode, Model};
use pharos_lighthouse::{build, headless, lh, LhScreen as Screen};

#[test]
fn renders_every_screen() {
    headless::init();
    let d = tempfile::tempdir().unwrap();
    let (ui, m) = build(Model::open(&d.path().join("config.yaml"), Mode::Demo).unwrap()).unwrap();
    assert!(lh(&ui).get_code().starts_with("pharos-beacon:"));
    assert_eq!(lh(&ui).get_clients_online(), 2);
    for (dark, screen) in [(false, Screen::Overview), (true, Screen::Overview), (false, Screen::Clients), (false, Screen::Rooms), (false, Screen::Settings), (false, Screen::Log)] {
        ui.invoke_set_dark(dark);
        lh(&ui).set_screen(screen);
        let s = headless::render(&ui, 900, 600, 1.0);
        assert_eq!((s.width, s.height), (900, 600));
        let distinct: std::collections::HashSet<&[u8]> = s.rgb.chunks(3).collect();
        assert!(distinct.len() > 20, "something is drawn");
    }
    // The switch stops the demo Beacon.
    lh(&ui).invoke_toggle();
    assert!(!lh(&ui).get_on());
    assert!(!m.borrow().is_on());
}

#[test]
fn qr_has_a_light_border() {
    let img = pharos_lighthouse::qr_image("pharos-beacon:TEST", 4).unwrap();
    let b = img.to_rgb8().unwrap();
    let px = b.as_slice();
    assert!(px[..b.width() as usize * 4 * 4].iter().all(|p| p.r == 255), "4-module white border");
    assert!(px.iter().any(|p| p.r < 64), "dark modules");
}
