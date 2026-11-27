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

/// The in-memory Directory spawns each Beacon's side of a link on the caller's runtime;
/// an app's runtime dies with the app, so dial on the test's runtime (where the Beacons
/// live), as a real Beacon in its own process would.
struct OnRt(Directory, tokio::runtime::Handle);

impl beacon_node::link::Dialer for OnRt {
    fn dial(&self, onion: &str) -> beacon_node::BoxFuture<anyhow::Result<(beacon_node::link::BoxRead, beacon_node::link::BoxWrite)>> {
        let f = beacon_node::link::Dialer::dial(&self.0, onion);
        let h = self.1.clone();
        Box::pin(async move { h.spawn(f).await.map_err(|e| anyhow::anyhow!("{e}"))? })
    }
}

fn net(rt: &tokio::runtime::Runtime, dir: &Directory) -> Net {
    Net::Test(Arc::new(OnRt(dir.clone(), rt.handle().clone())))
}

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

fn app(rt: &tokio::runtime::Runtime, dir: &Directory, tag: &str, name: &str, home: Option<&str>) -> (Core, std::path::PathBuf) {
    let base = tmp(tag);
    let v = Vault::open(&Profiles::new(base.clone()), "default", test_kdf()).unwrap();
    v.create("passphrase").unwrap();
    let mut b = RealBackend::new(v, net(rt, dir)).unwrap();
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
    let (mut ann, base_a) = app(&rt, &dir, "ann", "Ann", Some(a.onion()));
    let (mut bob, base_b) = app(&rt, &dir, "bob", "Bob", Some(b.onion()));
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
    let (mut cat, base_c) = app(&rt, &dir, "cat", "Cat", Some(b.onion()));
    assert!(cat.join(&code));
    until(&mut [&mut ann, &mut cat], "Cat refused", 20, |c| c[1].status.contains("used"));
    // Everything is in the vault: Bob's app restarts and finds the room and its texts.
    drop(bob);
    std::thread::sleep(Duration::from_millis(500));
    let v = Vault::open(&Profiles::new(base_b.clone()), "default", test_kdf()).unwrap();
    v.unlock("passphrase").unwrap();
    let mut bob = Core::new(Box::new(RealBackend::new(v, net(&rt, &dir)).unwrap()), "Bob");
    bob.tick(true);
    assert_eq!(bob.engine.rooms().len(), 1);
    bob.open_room(0);
    assert!(bob.texts().iter().any(|(_, t)| t == "hello bob"), "{:?}", bob.texts());
    until(&mut [&mut ann, &mut bob], "MLS restored", 20, |c| c[1].engine.mls_status() == MlsStatus::Ready);
    assert!(bob.send("back again"));
    until(&mut [&mut ann, &mut bob], "after restart", 20, |c| c[0].texts().iter().any(|(_, t)| t == "back again"));
    a.stop();
    b.stop();
    for d in [base_a, base_b, base_c] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[test]
fn without_a_beacon_nothing_opens_then_your_beacon_attaches() {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let dir = Directory::default();
    let b = beacon(&rt, &dir, 9);
    let (mut desk, base_d) = app(&rt, &dir, "desk", "Desk", None);
    assert!(!desk.connected());
    assert!(!desk.create_room("X"), "no Beacon yet");
    assert!(desk.status.contains("no Beacon"), "{}", desk.status);
    assert!(!desk.set_my_beacon(Some("not a code")));
    assert!(desk.set_my_beacon(Some(b.onion())), "{}", desk.status);
    desk.tick(true);
    until(&mut [&mut desk], "attached to Your Beacon", 10, |c| c[0].connected());
    assert!(desk.create_room("Attic"), "{}", desk.status);
    assert_eq!(desk.engine.my_onion(), b.onion());
    assert!(desk.set_my_beacon(None));
    desk.tick(true);
    assert!(desk.my_beacon().is_none());
    b.stop();
    let _ = std::fs::remove_dir_all(base_d);
}

/// A personal invitation for a friend (with a TTL) is refused to anyone else; leaving keeps
/// the membership on the Beacon (what came meanwhile arrives on reopen); delete forgets.
#[test]
fn personal_invitations_leave_and_delete_for_real() {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let dir = Directory::default();
    let a = beacon(&rt, &dir, 11);
    let b = beacon(&rt, &dir, 12);
    let (mut ann, base_a) = app(&rt, &dir, "pann", "Ann", Some(a.onion()));
    let (mut bob, base_b) = app(&rt, &dir, "pbob", "Bob", Some(b.onion()));
    let (mut eve, base_e) = app(&rt, &dir, "peve", "Eve", Some(b.onion()));
    assert!(ann.create_room("Den"));
    until(&mut [&mut ann], "Ann's link", 10, |c| c[0].connected());
    ann.add_friend(&bob.my_friend_code()).unwrap();
    let bob_id = bob.engine.device_id().to_string();
    let code = ann.invite(3600, Some(&bob_id)).unwrap();
    assert_eq!(ann.invites()[0].for_name, "Bob");
    // Eve holding Bob's code: refused locally, before anything is sent
    assert!(!eve.join(&code));
    assert!(eve.status.contains("for someone else"), "{}", eve.status);
    assert!(bob.join(&code), "{}", bob.status);
    until(&mut [&mut ann, &mut bob], "Bob admitted", 20, |c| c[1].engine.mls_status() == MlsStatus::Ready);
    // Ann withdraws a second invitation: it cannot be used
    let code2 = ann.invite(0, None).unwrap();
    let id2 = enigma_app::codes::decode_invitation(&code2).unwrap().id;
    ann.revoke_invite(&id2);
    assert!(eve.join(&code2));
    until(&mut [&mut ann, &mut eve], "Eve refused", 20, |c| c[1].status.contains("withdrawn"));
    // Bob leaves (the room stays in his list); Ann writes meanwhile; Bob reopens and reads it
    bob.leave();
    assert_eq!(bob.engine.rooms().len(), 1);
    assert!(bob.engine.current_room().is_none());
    assert!(ann.send("while you were out"));
    for _ in 0..20 {
        ann.tick(true);
        std::thread::sleep(Duration::from_millis(20));
    }
    bob.open_room(0);
    until(&mut [&mut ann, &mut bob], "Bob reads what came meanwhile", 20, |c| c[1].texts().iter().any(|(_, t)| t == "while you were out"));
    // Delete: gone from the list, and stays gone after a restart
    bob.delete_current();
    assert!(bob.engine.rooms().is_empty());
    drop(bob);
    let v = Vault::open(&Profiles::new(base_b.clone()), "default", test_kdf()).unwrap();
    v.unlock("passphrase").unwrap();
    let bob = Core::new(Box::new(RealBackend::new(v, net(&rt, &dir)).unwrap()), "Bob");
    assert!(bob.engine.rooms().is_empty());
    a.stop();
    b.stop();
    for d in [base_a, base_b, base_e] {
        let _ = std::fs::remove_dir_all(d);
    }
}
