//! Over real iroh endpoints on loopback (direct QUIC, no relays).

use std::time::Duration;

use ferrozine::endpoint::{EndpointConfig, Node, Relays};
use ferrozine::file::{self, FileHost, HostSettings, Limits};
use ferrozine::room::{self, RoomEvent};
use iroh::protocol::Router;
use rotor_core::RotorSession;

const ALPN: &[u8] = b"ferrozine/test-file/1";

#[tokio::test(flavor = "multi_thread")]
async fn a_file_crosses_two_endpoints_sealed() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("photo.jpg");
    let bytes: Vec<u8> = (0..300_000u32).map(|i| (i % 253) as u8).collect();
    std::fs::write(&src, &bytes).unwrap();

    let host_node = Node::bind(EndpointConfig::ephemeral(Relays::None))
        .await
        .unwrap();
    let host = FileHost::new(
        Limits::VESPER,
        || HostSettings {
            chunk_size: 64 * 1024,
            integrity: true,
        },
        file::ignore_events(),
    );
    let router = Router::builder(host_node.endpoint.clone())
        .accept(ALPN, host.clone())
        .spawn();
    let offer = host.offer(&src).unwrap();
    assert_eq!(offer.mime, "image/jpeg");

    // The address travels as text, as it would in a chat message.
    let addr = ferrozine::addr::decode(&host_node.addr_text()).unwrap();
    let dl_node = Node::bind(EndpointConfig::ephemeral(Relays::None))
        .await
        .unwrap();
    let prepared = file::prepare(&offer.offer_id).unwrap();
    host.authorize(&offer.offer_id, &prepared.commitment());
    let dest = dir.path().join("got.jpg");
    tokio::time::timeout(
        Duration::from_secs(30),
        file::download(
            &dl_node.endpoint,
            addr,
            ALPN,
            prepared,
            &dest,
            false,
            Limits::VESPER,
            file::ignore_events(),
        ),
    )
    .await
    .expect("transfer timed out")
    .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), bytes);
    router.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_room_carries_mls_sealed_messages_between_two_endpoints() {
    // The app's long-lived group: alice creates it, bob joins by Welcome.
    let mut alice_group = RotorSession::new("room-x".into(), "alice".into()).unwrap();
    alice_group.create_group().unwrap();
    let mut bob_group = RotorSession::new("room-x".into(), "bob".into()).unwrap();
    let (welcome, _) = alice_group
        .add_member(&bob_group.key_package().unwrap())
        .unwrap();
    bob_group.join_from_welcome(&welcome).unwrap();

    let a = Node::bind(EndpointConfig::ephemeral(Relays::None))
        .await
        .unwrap();
    let b = Node::bind(EndpointConfig::ephemeral(Relays::None))
        .await
        .unwrap();
    let ga = room::spawn_gossip(a.endpoint.clone(), 1 << 20);
    let gb = room::spawn_gossip(b.endpoint.clone(), 1 << 20);
    let ra = Router::builder(a.endpoint.clone())
        .accept(room::GOSSIP_ALPN, ga.clone())
        .spawn();
    let rb = Router::builder(b.endpoint.clone())
        .accept(room::GOSSIP_ALPN, gb.clone())
        .spawn();
    b.learn(a.endpoint.addr());

    let topic = room::topic_for("room-x");
    let (room_a, mut events_a) = room::join(&ga, topic, vec![]).await.unwrap();
    let (_room_b, mut events_b) = room::join(&gb, topic, vec![a.endpoint.id()]).await.unwrap();

    // Wait until they are neighbors.
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(RoomEvent::NeighborUp { .. }) = events_a.next().await {
                break;
            }
        }
    })
    .await
    .expect("neighbors");
    assert!(room_a.is_connected());

    room_a
        .broadcast_sealed(&mut alice_group, b"hello bob")
        .await
        .unwrap();
    let payload = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match events_b.next().await {
                Some(RoomEvent::Message { payload, .. }) => break payload,
                Some(_) => continue,
                None => panic!("room closed"),
            }
        }
    })
    .await
    .expect("message");
    assert!(
        !payload.windows(5).any(|w| w == b"hello"),
        "the gossip layer only ever saw ciphertext"
    );
    assert_eq!(
        room::open_sealed(&mut bob_group, &payload)
            .unwrap()
            .as_deref(),
        Some(&b"hello bob"[..])
    );

    // An outsider on the same topic cannot read it.
    let mut eve = RotorSession::new("room-x".into(), "eve".into()).unwrap();
    eve.create_group().unwrap();
    assert!(room::open_sealed(&mut eve, &payload).is_err());

    ra.shutdown().await.unwrap();
    rb.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_ticket_is_all_a_downloader_needs() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("notes.txt");
    std::fs::write(&src, b"sealed end to end").unwrap();

    let host_node = Node::bind(EndpointConfig::ephemeral(Relays::None))
        .await
        .unwrap();
    let host = FileHost::new(
        Limits::VESPER,
        || HostSettings {
            chunk_size: 64 * 1024,
            integrity: true,
        },
        file::ignore_events(),
    );
    let router = Router::builder(host_node.endpoint.clone())
        .accept(ALPN, host.clone())
        .spawn();
    let offer = host.offer(&src).unwrap();
    let ticket = file::Ticket::new(host_node.endpoint.addr(), &offer).unwrap();
    host.authorize_with_secret(&offer.offer_id, &ticket.secret);

    // Only the ticket's text crosses to the other side.
    let text = ticket.encode();
    let got = file::Ticket::decode(&text).unwrap();
    let dl = Node::bind(EndpointConfig::ephemeral(Relays::None))
        .await
        .unwrap();
    let dest = dir.path().join("got.txt");
    tokio::time::timeout(
        Duration::from_secs(30),
        file::download(
            &dl.endpoint,
            got.addr.clone(),
            ALPN,
            file::prepare_for_ticket(&got).unwrap(),
            &dest,
            true,
            Limits::VESPER,
            file::ignore_events(),
        ),
    )
    .await
    .expect("timed out")
    .unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), b"sealed end to end");
    router.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn one_peer_cannot_hold_more_than_its_share_of_serving_slots() {
    let host_node = Node::bind(EndpointConfig::ephemeral(Relays::None))
        .await
        .unwrap();
    let host = FileHost::new(
        Limits::VESPER,
        || HostSettings {
            chunk_size: 64 * 1024,
            integrity: false,
        },
        file::ignore_events(),
    );
    let router = Router::builder(host_node.endpoint.clone())
        .accept(ALPN, host.clone())
        .spawn();
    let peer = Node::bind(EndpointConfig::ephemeral(Relays::None))
        .await
        .unwrap();
    let addr = host_node.endpoint.addr();

    // MAX_SERVES_PER_PEER idle connections, each with a stream that sends
    // nothing, hold their slots…
    let mut idle = Vec::new();
    for _ in 0..file::MAX_SERVES_PER_PEER {
        let conn = peer.endpoint.connect(addr.clone(), ALPN).await.unwrap();
        let (mut send, recv) = conn.open_bi().await.unwrap();
        send.write_all(&[]).await.unwrap();
        idle.push((conn, send, recv));
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    // …so the next one from the same peer is dropped at once.
    let conn = peer.endpoint.connect(addr, ALPN).await.unwrap();
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let _ = send.write_all(&1u32.to_le_bytes()).await;
    let mut buf = [0u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(5), recv.read(&mut buf)).await;
    assert!(
        matches!(read, Ok(Err(_)) | Ok(Ok(None)) | Ok(Ok(Some(0)))),
        "the extra connection was served: {read:?}"
    );
    drop(idle);
    router.shutdown().await.unwrap();
}
