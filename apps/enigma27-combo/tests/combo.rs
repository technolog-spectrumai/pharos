//! The combo end to end without Tor: its Lighthouse runs in-process (Listen::Memory), its
//! client attaches through the RelaySlot (in-process), a second client attaches the same
//! way, they talk; stopping the Lighthouse keeps the client's rooms, starting it again
//! re-attaches.

use std::sync::Arc;
use std::time::{Duration, Instant};

use beacon::runner::{Listen, Phase};
use beacon_node::link::NoDialer;
use enigma27_combo::{real_host, Combo, RelaySlot, OFF_NOTICE};
use enigma_app::backend::TorState;
use enigma_app::core::Core;
use enigma_app::real::{Net, RealBackend};
use enigma_app::vault::{test_kdf, Profiles, Vault};
use enigma_core::MlsStatus;
use pharos_lighthouse::model::{Mode, Model};

fn onion() -> String {
    pharos_lighthouse::model::demo_onion()
}

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("enigma27-combo-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Step the combo (and tick `other`) until `ok`.
fn until(combo: &Combo, other: &mut [&mut Core], what: &str, secs: u64, mut ok: impl FnMut(&Combo, &mut [&mut Core]) -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        combo.step();
        for c in other.iter_mut() {
            c.tick(true);
        }
        if ok(combo, other) {
            return;
        }
        assert!(Instant::now() < end, "timed out: {what} (status {:?})", combo.host.borrow().core().map(|c| c.status.clone()));
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The client link is up (Core::connected also counts "dialling").
fn linked(c: &Core) -> bool {
    matches!(c.backend.tor_state(), TorState::Ready)
}

fn with_core<T>(combo: &Combo, f: impl FnOnce(&mut Core) -> T) -> T {
    f(combo.host.borrow_mut().core_mut().expect("unlocked"))
}

fn lighthouse(dir: &std::path::Path) -> Model {
    let listen = Listen::Memory { onion: onion(), dialer: Arc::new(NoDialer) };
    Model::open(&dir.join("lighthouse").join("config.yaml"), Mode::Real(listen)).unwrap()
}

#[test]
fn the_combo_client_attaches_to_its_own_lighthouse_and_talks_to_a_second_client() {
    enigma27::headless::init();
    let dir = tmp("talk");
    let slot = RelaySlot::default();
    let mut m = lighthouse(&dir);
    m.start().unwrap();
    let host = real_host(&dir.join("client"), &slot, test_kdf()).unwrap();
    let combo = Combo::build(host, m, slot.clone()).unwrap();
    assert!(combo.ui.get_locked(), "the gate first");
    combo.ui.invoke_gate_create_vault("password1".into(), "password1".into());
    assert!(!combo.ui.get_locked());

    until(&combo, &mut [], "Lighthouse online", 10, |c, _| c.model.borrow_mut().snapshot().phase == Phase::Online);
    until(&combo, &mut [], "client attached in-process", 15, |c, _| with_core(c, |k| linked(k)));
    assert_eq!(with_core(&combo, |k| k.my_beacon().map(|b| b.onion)), Some(onion()), "its Lighthouse is Your Beacon");
    assert_eq!(combo.ui.get_notice(), "");
    assert_eq!(enigma27_combo::lighthouse::lh(&combo.ui).get_clients_online(), 1, "the Lighthouse sees its own client");

    // A second client (a friend's phone, here in-process too) on the same Lighthouse.
    let vb = Vault::open(&Profiles::new(dir.join("bob")), "default", test_kdf()).unwrap();
    vb.create("passphrase").unwrap();
    let mut bob = Core::new(Box::new(RealBackend::new(vb, Net::Test(Arc::new(slot.clone()))).unwrap()), "Bob");
    assert!(bob.set_my_beacon(Some(&onion())));
    until(&combo, &mut [&mut bob], "Bob attached", 15, |_, o| linked(o[0]));

    assert!(with_core(&combo, |k| k.create_room("Harbour")));
    let code = with_core(&combo, |k| k.invitation_code()).expect("an invitation");
    assert!(bob.join(&code), "{}", bob.status);
    until(&combo, &mut [&mut bob], "Bob admitted", 30, |_, o| o[0].engine.mls_status() == MlsStatus::Ready && o[0].room_name().as_deref() == Some("Harbour"));
    assert!(with_core(&combo, |k| k.send("hello bob")));
    until(&combo, &mut [&mut bob], "Bob hears the combo", 20, |_, o| o[0].texts().iter().any(|(_, t)| t == "hello bob"));
    assert!(bob.send("hi combo"));
    until(&combo, &mut [&mut bob], "the combo hears Bob", 20, |c, _| with_core(c, |k| k.texts().iter().any(|(_, t)| t == "hi combo")));
    assert!(enigma27_combo::lighthouse::lh(&combo.ui).get_rooms_total() >= 1);

    // Stop the Lighthouse: the client keeps its room and texts, and says so.
    combo.model.borrow_mut().stop();
    until(&combo, &mut [&mut bob], "Lighthouse off", 10, |c, _| !c.model.borrow().is_on());
    combo.step();
    assert_eq!(combo.ui.get_notice(), OFF_NOTICE);
    assert_eq!(with_core(&combo, |k| k.engine.rooms().len()), 1);
    assert!(with_core(&combo, |k| k.texts().iter().any(|(_, t)| t == "hi combo")), "still readable");
    until(&combo, &mut [&mut bob], "client sees the link down", 10, |c, _| !with_core(c, |k| linked(k)));

    // Start it again: same onion, the client re-attaches, the room carries on.
    combo.model.borrow_mut().start().unwrap();
    until(&combo, &mut [&mut bob], "client re-attached", 20, |c, o| with_core(c, |k| linked(k)) && linked(o[0]));
    assert_eq!(combo.ui.get_notice(), "");
    assert_eq!(with_core(&combo, |k| k.engine.rooms().len()), 1);
    assert!(with_core(&combo, |k| k.send("back again")));
    until(&combo, &mut [&mut bob], "Bob hears the combo after the restart", 30, |_, o| o[0].texts().iter().any(|(_, t)| t == "back again"));

    combo.model.borrow_mut().stop();
    drop(bob);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn demo_mode_and_sections() {
    enigma27::headless::init();
    let dir = tmp("demo");
    let mut m = Model::open(&dir.join("config.yaml"), Mode::Demo).unwrap();
    m.start().unwrap();
    let combo = Combo::build(enigma27::Host::demo("Me"), m, RelaySlot::default()).unwrap();
    assert!(combo.step(), "demo Lighthouse on");
    assert_eq!(combo.ui.get_notice(), "");
    assert_eq!(combo.ui.get_room_name(), "Lighthouse", "the demo client");
    let lh = enigma27_combo::lighthouse::lh(&combo.ui);
    assert!(lh.get_demo());
    assert!(lh.get_clients_online() > 0);
    lh.invoke_toggle();
    assert!(!combo.step(), "stopped from the Lighthouse view");
    assert_eq!(combo.ui.get_notice(), OFF_NOTICE);
    combo.ui.set_lighthouse_shown(true);
    let shot = enigma27::headless::render(&combo.ui, 1300, 760, 1.0);
    assert!(shot.rgb.len() == 1300 * 760 * 3);
    let _ = std::fs::remove_dir_all(dir);
}
