//! Two (or three) nodes on an in-process network, with and without a real
//! Proteus on loopback: pairing, direct delivery, the outbox, the mailbox,
//! the directory, restarts, and hostile input.

use pharos_node::net::{MemNet, Net};
use pharos_node::{Event, Node, State, Status};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::AsyncWriteExt;

/// One clock per test, shared by its nodes and its Proteus.
#[derive(Clone)]
struct T(Arc<AtomicU64>);
impl T {
    fn new() -> Self {
        T(Arc::new(AtomicU64::new(1_790_000_000)))
    }
    fn clock(&self) -> pharos_node::Clock {
        let t = self.0.clone();
        Arc::new(move || t.load(Ordering::SeqCst))
    }
    fn add(&self, s: u64) {
        self.0.fetch_add(s, Ordering::SeqCst);
    }
}

fn node(net: &MemNet, t: &T, name: &str) -> Node<MemNet> {
    let (n, mut rx) = Node::new(State::new(name), net.clone(), t.clock());
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    n
}

/// A real Proteus (the library behind the binary) on loopback, reachable as `onion`.
async fn proteus(net: &MemNet, onion: &str) {
    proteus_with_page(net, onion, None).await
}

/// …with its page (the code for Enigma), as `serve` adds it once Tor gave it an address.
async fn proteus_with_page(net: &MemNet, onion: &str, page: Option<&str>) {
    use proteus::{api, config::Limits, masterkey::MasterKey, page::Page, store::Store};
    let limits = Limits::default();
    let store = Store::in_memory(MasterKey::from_bytes(&[5; 32]), limits.clone()).unwrap();
    let mut app = api::router(Arc::new(api::AppState { store, limiter: api::Limiter::new(1000), clock: pharos_node::system_secs }));
    if let Some(name) = page {
        app = app.merge(proteus::page::router(Arc::new(Page::build(onion, name).unwrap())));
    }
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    net.route_tcp(onion, l.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (s, _) = l.accept().await.unwrap();
            tokio::spawn(proteus::serve_conn(s, app.clone()));
        }
    });
}

/// An acknowledgement sent with no message after it is handled by the other
/// side in its own time.
async fn eventually(f: impl Fn() -> bool) {
    for _ in 0..100 {
        if f() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("never happened");
}

async fn pair_by_text(a: &Node<MemNet>, b: &Node<MemNet>) {
    let card = a.my_card().unwrap();
    let scanned = b.scan_card(&card).await.unwrap();
    a.accept_reply(&scanned.reply.expect("no Proteus: the reply is shown")).unwrap();
}

fn status_of(n: &Node<MemNet>, friend: &[u8; 16], text: &str) -> Status {
    n.messages(friend).into_iter().find(|m| m.text == text).unwrap().status
}

#[tokio::test(flavor = "multi_thread")]
async fn without_proteus_direct_and_outbox() {
    let net = MemNet::default();
    let t = T::new();
    let (alice, bob) = (node(&net, &t, "Alice"), node(&net, &t, "Bob"));
    pair_by_text(&alice, &bob).await;
    let (fa, fb) = (alice.fingerprint(), bob.fingerprint());
    assert_eq!(alice.friends()[0].name, "Bob");
    assert_eq!(bob.friends()[0].name, "Alice");

    // Both online: delivered at once, acknowledged on the same connection.
    alice.refresh_listeners().await.unwrap();
    bob.refresh_listeners().await.unwrap();
    alice.send(&fb, "hello Bob").await.unwrap();
    assert_eq!(bob.messages(&fa)[0].text, "hello Bob");
    assert_eq!(bob.messages(&fa)[0].status, Status::Received);
    assert_eq!(status_of(&alice, &fb, "hello Bob"), Status::Delivered);

    // Bob offline: it waits in Alice's outbox …
    bob.stop_listeners();
    alice.send(&fb, "are you there?").await.unwrap();
    assert_eq!(status_of(&alice, &fb, "are you there?"), Status::Queued);
    // … and goes when he is back.
    bob.refresh_listeners().await.unwrap();
    alice.deliver_all().await;
    assert_eq!(status_of(&alice, &fb, "are you there?"), Status::Delivered);
    assert_eq!(bob.messages(&fa).len(), 2);

    // Bob answers.
    bob.send(&fa, "yes").await.unwrap();
    assert_eq!(alice.messages(&fb).last().unwrap().text, "yes");
}

#[tokio::test(flavor = "multi_thread")]
async fn rendezvous_onions_move_each_week() {
    let net = MemNet::default();
    let t = T::new();
    let (alice, bob) = (node(&net, &t, "Alice"), node(&net, &t, "Bob"));
    pair_by_text(&alice, &bob).await;
    bob.refresh_listeners().await.unwrap();
    alice.send(&bob.fingerprint(), "week one").await.unwrap();
    t.add(pharos_rendezvous::WEEK_SECS);
    // Bob has not refreshed yet: Alice still finds him on last week's onion.
    alice.send(&bob.fingerprint(), "week two, old onion").await.unwrap();
    assert_eq!(status_of(&alice, &bob.fingerprint(), "week two, old onion"), Status::Delivered);
    bob.refresh_listeners().await.unwrap();
    alice.send(&bob.fingerprint(), "week two, new onion").await.unwrap();
    assert_eq!(status_of(&alice, &bob.fingerprint(), "week two, new onion"), Status::Delivered);
}

#[tokio::test(flavor = "multi_thread")]
async fn with_proteus_pairing_mailbox_and_acks() {
    let net = MemNet::default();
    let t = T::new();
    proteus(&net, "bobsproteus.onion").await;
    let (alice, bob) = (node(&net, &t, "Alice"), node(&net, &t, "Bob"));
    bob.set_proteus(Some("bobsproteus.onion".into())).await.unwrap();

    // Alice scans Bob's card; her reply is left on Bob's Proteus, not shown.
    let card = bob.my_card().unwrap();
    let scanned = alice.scan_card(&card).await.unwrap();
    assert!(scanned.reply.is_none());
    assert_eq!(bob.poll_pairings().await.unwrap(), vec![alice.fingerprint()]);
    let (fa, fb) = (alice.fingerprint(), bob.fingerprint());

    // Bob offline: Alice leaves it in his mailbox.
    alice.refresh_listeners().await.unwrap();
    alice.send(&fb, "for later").await.unwrap();
    assert_eq!(status_of(&alice, &fb, "for later"), Status::OnProteus);

    // Bob starts: fetches, and his acknowledgement reaches Alice directly.
    assert_eq!(bob.fetch_mailboxes().await.unwrap(), 1);
    assert_eq!(bob.messages(&fa)[0].text, "for later");
    assert_eq!(bob.fetch_mailboxes().await.unwrap(), 0, "the mailbox was emptied");
    bob.deliver_all().await;
    eventually(|| status_of(&alice, &fb, "for later") == Status::Delivered).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_code_on_a_proteus_page_connects_enigma_to_it() {
    let net = MemNet::default();
    let t = T::new();
    let onion = pharos_rendezvous::onion_address(&[3u8; 32]);
    proteus_with_page(&net, &onion, Some("Bob's Pi")).await;
    // What Tor Browser shows on the page, and what its download gives.
    let (status, page) = pharos_node::proteus::call(&net, &onion, hyper::Method::GET, "/", None, vec![]).await.unwrap();
    assert_eq!(status, 200);
    let (_, txt) = pharos_node::proteus::call(&net, &onion, hyper::Method::GET, "/proteus.txt", None, vec![]).await.unwrap();
    let code = String::from_utf8(txt.to_vec()).unwrap().trim().to_string();
    assert!(String::from_utf8_lossy(&page).contains(&code));

    // Bob scans it; Enigma reads it and connects.
    let target = pharos_node::parse_proteus(&code).unwrap().unwrap();
    assert_eq!(target, pharos_node::ProteusTarget { onion: onion.clone(), name: Some("Bob's Pi".into()) });
    let (alice, bob) = (node(&net, &t, "Alice"), node(&net, &t, "Bob"));
    bob.set_proteus(Some(target.onion)).await.unwrap();
    assert_eq!(bob.proteus().as_deref(), Some(onion.as_str()));

    // And it works as his Proteus: pairing through it, then a message while he is offline.
    let s = alice.scan_card(&bob.my_card().unwrap()).await.unwrap();
    assert!(s.reply.is_none(), "the reply was left on Bob's Proteus");
    assert_eq!(bob.poll_pairings().await.unwrap(), vec![alice.fingerprint()]);
    alice.send(&bob.fingerprint(), "via your Pi").await.unwrap();
    assert_eq!(status_of(&alice, &bob.fingerprint(), "via your Pi"), Status::OnProteus);
    assert_eq!(bob.fetch_mailboxes().await.unwrap(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn directory_follows_a_move() {
    let net = MemNet::default();
    let t = T::new();
    proteus(&net, "old.onion").await;
    proteus(&net, "new.onion").await;
    let (alice, bob) = (node(&net, &t, "Alice"), node(&net, &t, "Bob"));
    bob.set_proteus(Some("old.onion".into())).await.unwrap();
    pair_by_text_or_drop(&bob, &alice).await;
    let fb = bob.fingerprint();
    assert_eq!(alice.friends()[0].proteus.as_deref(), Some("old.onion"));
    bob.set_proteus(Some("new.onion".into())).await.unwrap();
    assert_eq!(alice.lookup(&fb).await.unwrap().as_deref(), Some("new.onion"));
    assert_eq!(alice.friends()[0].proteus.as_deref(), Some("new.onion"));
    // Messages now go to the new mailbox.
    alice.send(&fb, "found you").await.unwrap();
    assert_eq!(bob.fetch_mailboxes().await.unwrap(), 1);
}

async fn pair_by_text_or_drop(owner: &Node<MemNet>, scanner: &Node<MemNet>) {
    let s = scanner.scan_card(&owner.my_card().unwrap()).await.unwrap();
    match s.reply {
        Some(r) => {
            owner.accept_reply(&r).unwrap();
        }
        None => {
            owner.poll_pairings().await.unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn state_survives_a_restart() {
    let net = MemNet::default();
    let t = T::new();
    let (alice, bob) = (node(&net, &t, "Alice"), node(&net, &t, "Bob"));
    pair_by_text(&alice, &bob).await;
    bob.refresh_listeners().await.unwrap();
    alice.send(&bob.fingerprint(), "before").await.unwrap();
    // Alice restarts from her saved state.
    let saved = alice.snapshot();
    drop(alice);
    let (alice, _rx) = Node::new(State::from_bytes(&saved).unwrap(), net.clone(), t.clock());
    alice.send(&bob.fingerprint(), "after").await.unwrap();
    assert_eq!(status_of(&alice, &bob.fingerprint(), "after"), Status::Delivered);
    assert_eq!(bob.messages(&alice.fingerprint()).len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn hostile_input_is_refused() {
    let net = MemNet::default();
    let t = T::new();
    let (alice, bob, eve) = (node(&net, &t, "Alice"), node(&net, &t, "Bob"), node(&net, &t, "Eve"));
    pair_by_text(&alice, &bob).await;
    bob.refresh_listeners().await.unwrap();
    // A reply meant for Alice does not work for Eve, and a reply to a card
    // Alice never showed does nothing.
    let s = eve.scan_card(&alice.my_card().unwrap()).await.unwrap();
    assert!(bob.accept_reply(s.reply.as_ref().unwrap()).is_err());
    assert!(alice.accept_reply("pharos-reply:AAAA").is_err());
    // Own card, duplicate friend, a stale card.
    assert!(alice.scan_card(&alice.my_card().unwrap()).await.is_err());
    assert!(bob.scan_card(&alice.my_card().unwrap()).await.is_err());
    let card = alice.my_card().unwrap();
    let late = T::new();
    late.add(pharos_id::CARD_TTL_SECS + 10);
    let carol = node(&net, &late, "Carol");
    assert!(carol.scan_card(&card).await.is_err());
    // Too long, empty.
    assert!(alice.send(&bob.fingerprint(), &"x".repeat(1001)).await.is_err());
    assert!(alice.send(&bob.fingerprint(), "   ").await.is_err());
    // Garbage and an oversized frame on Bob's rendezvous onion: the connection
    // is dropped, Bob keeps working.
    let candidates = {
        // Dial what Alice would dial, but speak nonsense.
        let mut io = None;
        for o in alice_candidates(&alice, &bob) {
            if let Ok(s) = net.dial(&o).await {
                io = Some(s);
                break;
            }
        }
        io.expect("bob is listening")
    };
    let mut io = candidates;
    io.write_all(&[0, 0, 0, 5, 1, 2, 3, 4, 5]).await.unwrap();
    drop(io);
    let mut io = net.dial(&alice_candidates(&alice, &bob)[0]).await.unwrap();
    io.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
    drop(io);
    alice.send(&bob.fingerprint(), "still fine").await.unwrap();
    assert_eq!(status_of(&alice, &bob.fingerprint(), "still fine"), Status::Delivered);
}

fn alice_candidates(_alice: &Node<MemNet>, bob: &Node<MemNet>) -> Vec<String> {
    bob.debug_rendezvous_onions()
}

#[tokio::test(flavor = "multi_thread")]
async fn events_report_messages_and_statuses() {
    let net = MemNet::default();
    let t = T::new();
    let (alice, mut arx) = Node::new(State::new("Alice"), net.clone(), t.clock());
    let bob = node(&net, &t, "Bob");
    let card = alice.my_card().unwrap();
    let r = bob.scan_card(&card).await.unwrap().reply.unwrap();
    alice.accept_reply(&r).unwrap();
    bob.refresh_listeners().await.unwrap();
    alice.send(&bob.fingerprint(), "evt").await.unwrap();
    let mut seen = vec![];
    while let Ok(e) = arx.try_recv() {
        seen.push(e);
    }
    assert!(seen.iter().any(|e| matches!(e, Event::FriendAdded { name, .. } if name == "Bob")));
    assert!(seen.iter().any(|e| matches!(e, Event::Message(m) if m.text == "evt")));
    assert!(seen.iter().any(|e| matches!(e, Event::Status { status: Status::Delivered, .. })));
}
