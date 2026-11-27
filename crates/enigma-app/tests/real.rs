//! The real backend end to end without Tor: Beacons (beacon-node relays) in an in-memory
//! `Directory`, apps (`Core` on `RealBackend` with a vault) attached to them.

use std::sync::Arc;
use std::time::{Duration, Instant};

use beacon_node::queue::{MemQueue, QueueLimits};
use beacon_node::relay::{Directory, Relay, RelayConfig};
use enigma_app::core::Core;
use enigma_app::real::{Net, RealBackend};
use enigma_app::vault::{test_kdf, Profiles, Vault};
use enigma_core::MlsStatus;

fn onion(seed: u8) -> String {
    format!("{}.onion", enigma_app::codes::base32_lower(&[seed; 35]))
}

fn beacon(rt: &tokio::runtime::Runtime, dir: &Directory, seed: u8) -> Arc<Relay> {
    let _g = rt.enter();
    let mut cfg = RelayConfig::new(&onion(seed));
    cfg.handshake_timeout = Duration::from_secs(5);
    cfg.link.cover_every = 0;
    cfg.redial = |n| Duration::from_millis((50 * u64::from(n)).min(400));
    let r = Relay::start(cfg, &[seed; 32], Arc::new(dir.clone()), Arc::new(MemQueue::new(QueueLimits::default())));
    dir.add(&r);
    r
}

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("enigma-real-{tag}-{}-{}", std::process::id(), Instant::now().elapsed().as_nanos()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn app(dir: &Directory, tag: &str, name: &str, home: Option<&str>) -> (Core, std::path::PathBuf) {
    let base = tmp(tag);
    let v = Vault::open(&Profiles::new(base.clone()), "default", test_kdf()).unwrap();
    v.create("passphrase").unwrap();
    let mut b = RealBackend::new(v, Net::Test(dir.clone())).unwrap();
    if let Some(h) = home {
        b.set_my_beacon(Some(h)).unwrap();
    }
    let mut c = Core::new(Box::new(b), name);
    c.tick(true);
    (c, base)
}

fn until(cs: &mut [&mut Core], what: &str, secs: u64, ok: impl Fn(&[&mut Core]) -> bool) {
    let end = Instant::now() + Duration::from_secs(secs);
    while !ok(cs) {
        assert!(Instant::now() < end, "timed out: {what}: {:?}", cs.iter().map(|c| (c.status.clone(), c.engine.messages().iter().map(|m| m.content.clone()).collect::<Vec<_>>(), c.engine.mls_status(), c.engine.roster().to_vec())).collect::<Vec<_>>());
        std::thread::sleep(Duration::from_millis(20));
        for c in cs.iter_mut() {
            c.tick(true);
        }
    }
}

#[test]
fn two_apps_on_two_beacons_invite_and_talk() {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let dir = Directory::default();
    let a = beacon(&rt, &dir, 1);
    let b = beacon(&rt, &dir, 2);
    let (mut ann, base_a) = app(&dir, "ann", "Ann", Some(a.onion()));
    let (mut bob, base_b) = app(&dir, "bob", "Bob", Some(b.onion()));
    assert!(ann.create_room("Harbour"), "{}", ann.status);
    assert_eq!(ann.engine.my_onion(), a.onion(), "a member's onion is its Beacon");
    until(&mut [&mut ann], "Ann's link", 10, |c| c[0].connected());
    let code = ann.invitation_code().expect("an invitation");
    let inv = enigma_app::codes::decode_invitation(&code).unwrap();
    assert_eq!(inv.onion, a.onion());
    assert_eq!(inv.device, ann.engine.device_id());
    assert!(bob.join(&code), "{}", bob.status);
    until(&mut [&mut ann, &mut bob], "Bob admitted", 20, |c| c[1].engine.mls_status() == MlsStatus::Ready && c[1].room_name().as_deref() == Some("Harbour"));
    assert_eq!(ann.invites()[0].state(0), "used", "single use");
    assert!(ann.send("hello bob"));
    until(&mut [&mut ann, &mut bob], "Bob hears Ann", 20, |c| c[1].texts().iter().any(|(_, t)| t == "hello bob"));
    assert!(bob.send("hi ann"));
    until(&mut [&mut ann, &mut bob], "Ann hears Bob", 20, |c| c[0].texts().iter().any(|(_, t)| t == "hi ann"));
    // A used invitation is refused.
//    let (mut cat, base_c) = app(&dir, "cat", "Cat", Some(b.onion()));
//    assert!(cat.join(&code));
//    until(&mut [&mut ann, &mut cat], "Cat refused", 20, |c| c[1].status.contains("used"));
    // Everything is in the vault: Bob's app restarts and finds the room and its texts.
    drop(bob);
    std::thread::sleep(Duration::from_millis(500));
    let v = Vault::open(&Profiles::new(base_b.clone()), "default", test_kdf()).unwrap();
    v.unlock("passphrase").unwrap();
    let mut bob = Core::new(Box::new(RealBackend::new(v, Net::Test(dir.clone())).unwrap()), "Bob");
    bob.tick(true);
    assert_eq!(bob.engine.rooms().len(), 1);
    bob.open_room(0);
    assert!(bob.texts().iter().any(|(_, t)| t == "hello bob"), "{:?}", bob.texts());
    until(&mut [&mut ann, &mut bob], "MLS restored", 20, |c| c[1].engine.mls_status() == MlsStatus::Ready);
    assert!(bob.send("back again"));
    { let route = beacon_node::proto::route_id(bob.engine.current_room().unwrap()); ann.send("ping2"); std::thread::sleep(Duration::from_secs(2)); for _ in 0..20 { ann.tick(true); bob.tick(true); std::thread::sleep(Duration::from_millis(50)); } eprintln!("DBG bob={:?} err={:?} rooms={:?} ann={:?}", bob.texts(), bob.engine.error(), bob.engine.rooms(), ann.texts()); }
    until(&mut [&mut ann, &mut bob], "after restart", 20, |c| c[0].texts().iter().any(|(_, t)| t == "back again"));
    a.stop();
    b.stop();
    for d in [base_a, base_b] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn enable_beacon_runs_one_in_process_and_others_reach_it() {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let dir = Directory::default();
    let b = beacon(&rt, &dir, 9);
    let (mut desk, base_d) = app(&dir, "desk", "Desk", None);
    assert!(!desk.create_room("X"), "no Beacon yet");
    assert!(desk.status.contains("no Beacon"), "{}", desk.status);
    desk.set_beacon(true);
    assert!(desk.beacon.enabled);
    let own = desk.beacon.onion.clone().unwrap();
    assert!(own.ends_with(".onion"));
    desk.tick(true);
    until(&mut [&mut desk], "attached to its own Beacon", 10, |c| c[0].connected());
    assert!(desk.create_room("Attic"), "{}", desk.status);
    assert_eq!(desk.engine.my_onion(), own);
    let (mut phone, base_p) = app(&dir, "phone", "Phone", Some(b.onion()));
    let code = desk.invitation_code().unwrap();
    assert!(phone.join(&code), "{}", phone.status);
    until(&mut [&mut desk, &mut phone], "the phone joins via the desktop's Beacon", 20, |c| c[1].engine.mls_status() == MlsStatus::Ready);
    assert!(phone.send("via your beacon"));
    until(&mut [&mut desk, &mut phone], "text", 20, |c| c[0].texts().iter().any(|(_, t)| t == "via your beacon"));
    // Off: the app falls back to Your Beacon (none here); on again: the same onion.
    desk.set_beacon(false);
    assert!(!desk.beacon.enabled);
    desk.tick(true);
    assert!(!desk.connected());
    desk.set_beacon(true);
    assert_eq!(desk.beacon.onion.as_deref(), Some(own.as_str()), "the node key is kept");
    assert!(base_d.join("profiles/default/relay.sqlite").exists(), "sealed queue on disk");
    b.stop();
    for d in [base_d, base_p] {
        let _ = std::fs::remove_dir_all(d);
    }
}
