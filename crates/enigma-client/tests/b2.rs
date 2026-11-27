//! Stage b2 end to end without Tor: Beacons (beacon-node's relay) and devices
//! (enigma-core engines on enigma-client links) over in-process duplex pipes.

use std::sync::Arc;
use std::time::{Duration, Instant};

use beacon_node::link::{BoxRead, BoxWrite, Dialer, LinkCfg};
use beacon_node::proto::{beacon_message, client_message, route_id, LinkHello};
use beacon_node::queue::{MemQueue, QueueLimits, QueueStore};
use beacon_node::relay::{now_secs, Directory, Relay, RelayConfig};
use beacon_node::{read_frame, room_for, write_frame};
use ed25519_dalek::{Signer as _, SigningKey};
use enigma_client::{Client, ClientConfig, Incoming};
use enigma_core::mem::{ManualClock, MemKv, MemStore};
use enigma_core::{Config, Deps, Ed25519Signer, Engine, Grant, MessageKind, MlsStatus, Transport};

const ROOM: &str = "Room One";

fn onion(name: &str) -> String {
    const A: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let h = blake3::hash(name.as_bytes());
    let s: String = h.as_bytes().iter().chain(blake3::hash(h.as_bytes()).as_bytes()).take(56).map(|b| A[(*b % 32) as usize] as char).collect();
    format!("{s}.onion")
}

fn fast(n: u32) -> Duration {
    Duration::from_millis((50 * u64::from(n)).min(400))
}

fn link_cfg() -> LinkCfg {
    LinkCfg { max_frame: 16 * 1024 * 1024, write_timeout: Duration::from_secs(5), cover_every: 0 }
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
}

fn beacon(rt: &tokio::runtime::Runtime, dir: &Directory, name: &str, seed: u8) -> Arc<Relay> {
    beacon_q(rt, dir, name, seed).0
}

fn beacon_q(rt: &tokio::runtime::Runtime, dir: &Directory, name: &str, seed: u8) -> (Arc<Relay>, Arc<MemQueue>) {
    let _g = rt.enter();
    let mut cfg = RelayConfig::new(&onion(name));
    cfg.link = link_cfg();
    cfg.handshake_timeout = Duration::from_secs(5);
    cfg.redial = fast;
    let q = Arc::new(MemQueue::new(QueueLimits::default()));
    let r = Relay::start(cfg, &[seed; 32], Arc::new(dir.clone()), q.clone());
    dir.add(&r);
    (r, q)
}

fn client(rt: &tokio::runtime::Runtime, dir: &Directory, home: &str, seed: u8) -> Client {
    let mut cfg = ClientConfig::new(home);
    cfg.link = link_cfg();
    cfg.handshake_timeout = Duration::from_secs(5);
    cfg.redial = fast;
    cfg.redeem_wait = Duration::from_secs(60);
    Client::start(cfg, &[seed; 32], Arc::new(dir.clone()), rt.handle())
}

struct Dev {
    seed: u8,
    home: String,
    kv: MemKv,
    store: MemStore,
    client: Client,
    eng: Engine,
    other: Vec<Incoming>,
}

struct Net {
    rt: tokio::runtime::Runtime,
    dir: Directory,
    clock: ManualClock,
    devs: Vec<Dev>,
}

impl Net {
    fn new() -> Self {
        Self { rt: rt(), dir: Directory::default(), clock: ManualClock::new(now_secs() * 1000), devs: vec![] }
    }
    fn engine(&self, name: &str, seed: u8, client: &Client, kv: &MemKv, store: &MemStore) -> Engine {
        let mut e = Engine::new(
            Deps {
                transport: Box::new(client.transport()),
                signer: Box::new(Ed25519Signer::from_seed(&[seed; 32])),
                kv: Box::new(kv.clone()),
                store: Arc::new(store.clone()),
                mailbox: None,
                clock: Box::new(self.clock.clone()),
            },
            Config::default(),
        );
        e.set_user_name(name);
        e
    }
    fn add(&mut self, name: &str, seed: u8, home: &Arc<Relay>) -> usize {
        let (kv, store) = (MemKv::default(), MemStore::default());
        let c = client(&self.rt, &self.dir, home.onion(), seed);
        let eng = self.engine(name, seed, &c, &kv, &store);
        self.devs.push(Dev { seed, home: home.onion().to_string(), kv, store, client: c, eng, other: vec![] });
        self.devs.len() - 1
    }
    /// The app closes (its link drops at once).
    fn close(&mut self, i: usize) {
        self.devs[i].client.stop();
    }
    /// The app opens again: same disk, fresh memory and a fresh link.
    fn reopen(&mut self, i: usize) {
        let d = &self.devs[i];
        let c = client(&self.rt, &self.dir, &d.home.clone(), d.seed);
        let eng = self.engine("again", d.seed, &c, &d.kv.clone(), &d.store.clone());
        self.devs[i].client = c;
        self.devs[i].eng = eng;
    }
    fn step(&mut self) {
        std::thread::sleep(Duration::from_millis(20));
        self.clock.advance(20);
        for d in &mut self.devs {
            let rest = d.client.pump(&mut d.eng);
            d.other.extend(rest);
            d.eng.tick();
        }
    }
    fn settle(&mut self, ms: u64) {
        for _ in 0..ms / 20 {
            self.step();
        }
    }
    fn until(&mut self, what: &str, secs: u64, mut ok: impl FnMut(&mut Self) -> bool) {
        let end = Instant::now() + Duration::from_secs(secs);
        while !ok(self) {
            assert!(Instant::now() < end, "timed out waiting for {what}: {:?}", (0..self.devs.len()).map(|i| (self.texts(i), self.devs[i].eng.mls_status(), self.devs[i].eng.messages().iter().filter_map(|m| m.notice.as_ref().map(|n| n.key.clone())).collect::<Vec<_>>())).collect::<Vec<_>>());
            self.step();
        }
    }
    fn e(&mut self, i: usize) -> &mut Engine {
        &mut self.devs[i].eng
    }
    fn texts(&self, i: usize) -> Vec<String> {
        self.devs[i].eng.messages().iter().filter(|m| m.kind == MessageKind::Text).map(|m| m.content.clone()).collect()
    }
    fn has_text(&self, i: usize, t: &str) -> bool {
        self.texts(i).iter().any(|x| x == t)
    }
    /// `host` admits `guest`, the grant handed over in the test.
    fn invite(&mut self, host: usize, guest: usize) {
        let room = self.devs[host].eng.current_room().unwrap().to_string();
        let kp = self.e(guest).invite_key_package("scratch").unwrap();
        let via = self.devs[guest].home.clone();
        let grant = self.e(host).admit_invited_via(&room, &kp, Some(&via)).expect("admitted");
        assert!(self.e(guest).join_by_invite(&grant, "scratch"));
        assert_eq!(self.e(guest).mls_status(), MlsStatus::Ready);
        self.settle(1500);
    }
}

fn hello_text(h: &LinkHello) -> String {
    serde_json::to_string(h).unwrap()
}

/// Dials `onion` raw, sends `hello`, returns whether it was let in.
fn raw_hello(net: &Net, onion: &str, hello: &LinkHello) -> bool {
    let dir = net.dir.clone();
    let (o, h) = (onion.to_string(), hello_text(hello));
    net.rt.block_on(async move {
        let (mut rd, mut wr): (BoxRead, BoxWrite) = dir.dial(&o).await.unwrap();
        write_frame(&mut wr, &h).await.unwrap();
        let r = tokio::time::timeout(Duration::from_secs(5), read_frame(&mut rd, 1 << 20)).await.unwrap().unwrap();
        serde_json::from_str::<serde_json::Value>(&r).unwrap()["ok"] == true
    })
}

#[test]
fn three_devices_on_two_beacons_talk_over_mls() {
    let mut n = Net::new();
    let a = beacon(&n.rt, &n.dir, "beacon-a", 101);
    let b = beacon(&n.rt, &n.dir, "beacon-b", 102);
    let alice = n.add("Alice", 1, &a);
    let bob = n.add("Bob", 2, &a);
    let carol = n.add("Carol", 3, &b);
    let slug = n.e(alice).create_room(ROOM).unwrap();
    // A member's onion is now its home Beacon's.
    assert_eq!(n.e(alice).my_onion(), a.onion());
    n.invite(alice, bob);
    n.invite(alice, carol);
    assert_eq!(n.e(carol).my_onion(), b.onion());
    let route = route_id(&slug);
    n.until("the Beacons to link", 20, |_| a.linked(&route) == vec![b.onion().to_string()] && b.linked(&route) == vec![a.onion().to_string()]);
    n.e(alice).send_text("hello from alice");
    n.e(bob).send_text("hello from bob");
    n.e(carol).send_text("hello from carol");
    n.until("every text everywhere", 20, |n| {
        [alice, bob, carol].iter().all(|i| ["hello from alice", "hello from bob", "hello from carol"].iter().all(|t| n.has_text(*i, t)))
    });
    for i in [alice, bob, carol] {
        assert_eq!(n.texts(i).len(), 3, "each text once: {:?}", n.texts(i));
    }
    // The roster shows the others linked (through either Beacon).
    n.until("the roster to settle", 10, |n| n.devs[carol].eng.roster().iter().filter(|p| !p.is_self).all(|p| p.linked));
    a.stop();
    b.stop();
}

#[test]
fn an_offline_device_gets_its_queued_frames_once_on_reconnect() {
    let mut n = Net::new();
    let a = beacon(&n.rt, &n.dir, "beacon-a", 101);
    let (b, bq) = beacon_q(&n.rt, &n.dir, "beacon-b", 102);
    let alice = n.add("Alice", 1, &a);
    let bob = n.add("Bob", 2, &b);
    let slug = n.e(alice).create_room(ROOM).unwrap();
    n.invite(alice, bob);
    n.until("the Beacons to link", 20, |_| !a.linked(&route_id(&slug)).is_empty());
    n.e(alice).send_text("first");
    n.until("bob to read it", 10, |n| n.has_text(bob, "first"));
    n.close(bob);
    n.until("bob to be offline", 5, |_| b.online().is_empty());
    n.e(alice).send_text("while you were away");
    n.e(alice).send_text("and again");
    n.settle(500);
    // Bob comes back: his Beacon kept both frames for him.
    n.reopen(bob);
    n.e(bob).open_room(&slug);
    n.until("bob to catch up", 10, |n| n.has_text(bob, "while you were away") && n.has_text(bob, "and again"));
    assert_eq!(n.texts(bob).iter().filter(|t| *t == "while you were away").count(), 1);
    // Once acked, a frame is gone from bob's queue on his Beacon.
    let bob_id = n.devs[bob].client.device_id().to_string();
    n.until("bob's acks to land", 5, |_| bq.pending(&bob_id, &route_id(&slug), now_secs()).is_empty());
    a.stop();
    b.stop();
}

#[test]
fn acked_frames_are_not_delivered_again() {
    // At the link level: a raw client in a room, frames, ack, reconnect.
    let n = Net::new();
    let a = beacon(&n.rt, &n.dir, "beacon-a", 101);
    let route_slug = room_for(ROOM);
    let sender = client(&n.rt, &n.dir, a.onion(), 1);
    let reader = client(&n.rt, &n.dir, a.onion(), 2);
    let ts = sender.transport();
    let tr = reader.transport();
    ts.join_room(ROOM, &[]).unwrap();
    tr.join_room(ROOM, &[]).unwrap();
    let wait_frames = |c: &Client, want: usize| {
        let end = Instant::now() + Duration::from_secs(10);
        let mut got = vec![];
        while got.len() < want && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
            got.extend(c.drain().into_iter().filter_map(|i| match i {
                Incoming::Frame { payload, .. } => Some(payload),
                _ => None,
            }));
        }
        got
    };
    let wait_up = |c: &Client| {
        let end = Instant::now() + Duration::from_secs(5);
        while !c.is_connected() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    wait_up(&sender);
    wait_up(&reader);
    std::thread::sleep(Duration::from_millis(200));
    ts.send(&route_slug, r#"{"type":"mls_app","ciphertext":"one"}"#);
    assert_eq!(wait_frames(&reader, 1), vec![r#"{"type":"mls_app","ciphertext":"one"}"#.to_string()]);
    std::thread::sleep(Duration::from_millis(200)); // the ack lands
    reader.stop();
    ts.send(&route_slug, r#"{"type":"mls_app","ciphertext":"two"}"#);
    ts.send(&route_slug, r#"{"type":"mls_app","ciphertext":"two"}"#); // a resend: deduplicated
    std::thread::sleep(Duration::from_millis(300));
    let again = client(&n.rt, &n.dir, a.onion(), 2);
    again.transport().join_room(ROOM, &[]).unwrap();
    assert_eq!(wait_frames(&again, 2), vec![r#"{"type":"mls_app","ciphertext":"two"}"#.to_string()], "only the unacked frame, once");
    assert_eq!(sender.unconfirmed(), 0, "every send confirmed");
    a.stop();
}

#[test]
fn a_beacon_no_local_client_listed_is_refused() {
    let mut n = Net::new();
    let a = beacon(&n.rt, &n.dir, "beacon-a", 101);
    let b = beacon(&n.rt, &n.dir, "beacon-b", 102);
    let alice = n.add("Alice", 1, &a);
    let slug = n.e(alice).create_room(ROOM).unwrap();
    let route = route_id(&slug);
    n.devs[alice].client.transport().set_peers(&slug, &[b.onion().to_string()]);
    n.settle(200);
    let hello = |key: &SigningKey, from: &str, room: &str| {
        let ts = now_secs();
        LinkHello::Beacon {
            onion: from.to_string(),
            node: hex::encode(key.verifying_key().to_bytes()),
            room: room.to_string(),
            ts,
            sig: hex::encode(key.sign(&beacon_message(a.onion(), from, room, ts)).to_bytes()),
        }
    };
    let stranger = SigningKey::from_bytes(&[77; 32]);
    assert!(!raw_hello(&n, a.onion(), &hello(&stranger, &onion("stranger"), &route)), "not listed");
    assert!(!raw_hello(&n, a.onion(), &hello(&stranger, b.onion(), &route_id("other room"))), "listed for another room only");
    let mut bad = hello(&stranger, b.onion(), &route);
    if let LinkHello::Beacon { ts, .. } = &mut bad {
        *ts += 1; // the signature no longer matches
    }
    assert!(!raw_hello(&n, a.onion(), &bad), "bad signature");
    assert!(raw_hello(&n, a.onion(), &hello(&stranger, b.onion(), &route)), "listed: let in");
    // Pinned: another node key for the same onion is refused afterwards.
    let other = SigningKey::from_bytes(&[78; 32]);
    assert!(!raw_hello(&n, a.onion(), &hello(&other, b.onion(), &route)), "pinned to the first key");
    a.stop();
    b.stop();
}

#[test]
fn a_client_with_a_bad_signature_is_refused() {
    let n = Net::new();
    let a = beacon(&n.rt, &n.dir, "beacon-a", 101);
    let k = SigningKey::from_bytes(&[5; 32]);
    let device = hex::encode(k.verifying_key().to_bytes());
    let ts = now_secs();
    let good = LinkHello::Client { device: device.clone(), ts, sig: hex::encode(k.sign(&client_message(a.onion(), ts)).to_bytes()) };
    assert!(raw_hello(&n, a.onion(), &good));
    let other_beacon = LinkHello::Client { device: device.clone(), ts, sig: hex::encode(k.sign(&client_message("x.onion", ts)).to_bytes()) };
    assert!(!raw_hello(&n, a.onion(), &other_beacon), "signed for another Beacon");
    let old = ts - 16 * 60;
    let stale = LinkHello::Client { device: device.clone(), ts: old, sig: hex::encode(k.sign(&client_message(a.onion(), old)).to_bytes()) };
    assert!(!raw_hello(&n, a.onion(), &stale), "too old");
    let k2 = SigningKey::from_bytes(&[6; 32]);
    let wrong_key = LinkHello::Client { device, ts, sig: hex::encode(k2.sign(&client_message(a.onion(), ts)).to_bytes()) };
    assert!(!raw_hello(&n, a.onion(), &wrong_key), "someone else's key");
    a.stop();
}

#[test]
fn three_beacons_deliver_each_frame_once_with_no_loops() {
    let n = Net::new();
    let bs: Vec<Arc<Relay>> = ["a", "b", "c"].iter().enumerate().map(|(i, x)| beacon(&n.rt, &n.dir, x, 100 + i as u8)).collect();
    let cs: Vec<Client> = bs.iter().enumerate().map(|(i, b)| client(&n.rt, &n.dir, b.onion(), 1 + i as u8)).collect();
    let slug = room_for(ROOM);
    let route = route_id(&slug);
    for (i, c) in cs.iter().enumerate() {
        let others: Vec<String> = bs.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, b)| b.onion().to_string()).collect();
        c.transport().join_room(ROOM, &others).unwrap();
    }
    let end = Instant::now() + Duration::from_secs(20);
    while !bs.iter().all(|b| b.linked(&route).len() == 2) {
        assert!(Instant::now() < end, "full mesh of three");
        std::thread::sleep(Duration::from_millis(20));
    }
    for c in &cs {
        let _ = c.drain();
    }
    for k in 0..5 {
        cs[0].transport().send(&slug, &format!(r#"{{"type":"mls_app","ciphertext":"a{k}"}}"#));
        cs[1].transport().send(&slug, &format!(r#"{{"type":"mls_app","ciphertext":"b{k}"}}"#));
    }
    std::thread::sleep(Duration::from_millis(1500));
    let frames = |c: &Client| -> Vec<String> {
        c.drain()
            .into_iter()
            .filter_map(|i| match i {
                Incoming::Frame { payload, .. } => Some(payload),
                _ => None,
            })
            .collect()
    };
    let (f0, f1, f2) = (frames(&cs[0]), frames(&cs[1]), frames(&cs[2]));
    assert_eq!(f2.len(), 10, "carol gets each of the ten once: {f2:?}");
    assert_eq!(f0.len(), 5, "alice gets bob's five, never her own back");
    assert_eq!(f1.len(), 5);
    assert!(f0.iter().all(|f| f.contains("\"b")));
    for b in &bs {
        b.stop();
    }
}

#[test]
fn a_redemption_waits_at_the_inviters_beacon_until_the_inviter_is_back() {
    let mut n = Net::new();
    let a = beacon(&n.rt, &n.dir, "beacon-a", 101);
    let b = beacon(&n.rt, &n.dir, "beacon-b", 102);
    let alice = n.add("Alice", 1, &a);
    let dave = n.add("Dave", 4, &b);
    let slug = n.e(alice).create_room(ROOM).unwrap();
    let alice_id = n.e(alice).device_id().to_string();
    n.settle(200);
    n.close(alice);
    n.until("alice offline", 5, |_| a.online().is_empty());
    // Dave redeems through alice's Beacon (from the invitation): only the payload
    // travels, and the Beacon cannot read it.
    let kp = n.e(dave).invite_key_package("scratch").unwrap();
    let id = "00112233445566778899aabbccddeeff";
    n.devs[dave].client.redeem(a.onion(), &alice_id, id, &kp);
    n.settle(500);
    // Alice comes back and finds it waiting.
    n.reopen(alice);
    n.e(alice).open_room(&slug);
    n.until("alice to get the redemption", 10, |n| n.devs[alice].other.iter().any(|i| matches!(i, Incoming::Redeem { .. })));
    let (rid, from, home, payload) = n.devs[alice]
        .other
        .iter()
        .find_map(|i| match i {
            Incoming::Redeem { id, from, home, payload } => Some((id.clone(), from.clone(), home.clone(), payload.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(rid, id);
    assert_eq!(from, n.devs[dave].client.device_id(), "the Beacon names the redeemer by its signed hello");
    n.until("alice ready", 10, |n| n.devs[alice].eng.mls_status() == MlsStatus::Ready);
    assert_eq!(home, b.onion());
    let grant = n.e(alice).admit_invited_via(&slug, &payload, Some(&home)).expect("admitted");
    n.devs[alice].client.answer_redeem(&rid, &serde_json::to_string(&grant).unwrap());
    n.until("dave to get the answer", 10, |n| n.devs[dave].other.iter().any(|i| matches!(i, Incoming::RedeemAnswer { .. })));
    let answer = n.devs[dave]
        .other
        .iter()
        .find_map(|i| match i {
            Incoming::RedeemAnswer { payload, .. } => Some(payload.clone()),
            _ => None,
        })
        .unwrap();
    let grant: Grant = serde_json::from_str(&answer).unwrap();
    assert_eq!(grant.peers[0], a.onion(), "the grant names alice's Beacon");
    assert!(n.e(dave).join_by_invite(&grant, "scratch"));
    n.until("the Beacons to link", 20, |_| !b.linked(&route_id(&slug)).is_empty());
    n.e(dave).send_text("thanks for having me");
    n.until("alice reads dave", 10, |n| n.has_text(alice, "thanks for having me"));
    n.e(alice).send_text("welcome");
    n.until("dave reads alice", 10, |n| n.has_text(dave, "welcome"));
    a.stop();
    b.stop();
}

#[test]
fn cover_and_padding_run_on_client_links() {
    // With cover on, a quiet link still carries padded dummies, and nothing breaks.
    let n = Net::new();
    let _g = n.rt.enter();
    let mut cfg = RelayConfig::new(&onion("cover"));
    cfg.link = LinkCfg { cover_every: 1, ..link_cfg() };
    let a = Relay::start(cfg, &[9; 32], Arc::new(n.dir.clone()), Arc::new(MemQueue::default()));
    n.dir.add(&a);
    let mut ccfg = ClientConfig::new(a.onion());
    ccfg.link = LinkCfg { cover_every: 1, ..link_cfg() };
    let c1 = Client::start(ccfg.clone(), &[1; 32], Arc::new(n.dir.clone()), n.rt.handle());
    let c2 = Client::start(ccfg, &[2; 32], Arc::new(n.dir.clone()), n.rt.handle());
    c1.transport().join_room(ROOM, &[]).unwrap();
    c2.transport().join_room(ROOM, &[]).unwrap();
    std::thread::sleep(Duration::from_millis(2500));
    assert!(c1.is_connected() && c2.is_connected());
    c1.transport().send(&room_for(ROOM), r#"{"type":"mls_app","ciphertext":"x"}"#);
    std::thread::sleep(Duration::from_millis(300));
    let got: Vec<Incoming> = c2.drain().into_iter().filter(|i| matches!(i, Incoming::Frame { .. })).collect();
    assert_eq!(got.len(), 1, "covers are never delivered: {got:?}");
    a.stop();
}
