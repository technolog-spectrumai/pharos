//! Over the real Tor network (slow; needs outbound connections to Tor relays):
//!   cargo test -p pharos-node --test real_tor -- --ignored --nocapture
//! Two nodes pair, host their rendezvous onions, and exchange a message.

use pharos_node::net::TorNet;
use pharos_node::{Node, State, Status};

async fn tor(dir: &std::path::Path, name: &str) -> TorNet {
    TorNet(pharos_tor::Tor::start(dir.join(name).join("state"), dir.join(name).join("cache"), false).await.expect("bootstrap"))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn two_nodes_over_real_tor() {
    let dir = std::env::temp_dir().join(format!("pharos-real-tor-{}", std::process::id()));
    let t0 = std::time::Instant::now();
    let (ta, tb) = tokio::join!(tor(&dir, "a"), tor(&dir, "b"));
    eprintln!("bootstrapped in {:?}", t0.elapsed());
    let (alice, _ra) = Node::new(State::new("Alice"), ta, pharos_node::system_clock());
    let (bob, _rb) = Node::new(State::new("Bob"), tb, pharos_node::system_clock());
    let s = bob.scan_card(&alice.my_card().unwrap()).await.unwrap();
    alice.accept_reply(&s.reply.unwrap()).unwrap();
    bob.refresh_listeners().await.unwrap();
    eprintln!("bob's onion is up after {:?}; publishing takes a while", t0.elapsed());
    let fb = bob.fingerprint();
    for attempt in 1..=10 {
        let _ = alice.send(&fb, "over real Tor").await;
        if alice.messages(&fb).iter().any(|m| m.status == Status::Delivered) {
            eprintln!("delivered on attempt {attempt} after {:?}", t0.elapsed());
            assert_eq!(bob.messages(&alice.fingerprint())[0].text, "over real Tor");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    }
    panic!("not delivered within the attempts");
}
