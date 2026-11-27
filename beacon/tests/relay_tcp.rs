//! Stage b2 on a real Beacon over loopback TCP: the HTTP API and client links share
//! one port (told apart by their first bytes); two devices exchange a frame, and the
//! queue is the sealed SQLite one.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use beacon::api::{self, AppState, Limiter};
use beacon::config::Limits;
use beacon::masterkey::MasterKey;
use beacon::relay_store::SqliteQueue;
use beacon::store::Store;
use beacon_node::link::{BoxRead, BoxWrite, Dialer, LinkCfg, NoDialer};
use beacon_node::queue::QueueLimits;
use beacon_node::relay::{Relay, RelayConfig};
use enigma_client::{Client, ClientConfig, Incoming};
use enigma_core::Transport;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Tcp(std::net::SocketAddr);

impl Dialer for Tcp {
    fn dial(&self, _onion: &str) -> beacon_node::BoxFuture<Result<(BoxRead, BoxWrite)>> {
        let a = self.0;
        Box::pin(async move { Ok(beacon_node::link::boxed(tokio::net::TcpStream::connect(a).await?)) })
    }
}

#[test]
fn http_and_client_links_share_the_port() {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let onion = "loopbackbeaconloopbackbeaconloopbackbeaconloopbackbeacon.onion";
    let addr = rt.block_on(async {
        let store = Store::in_memory(MasterKey::from_bytes(&[3; 32]), Limits::default()).unwrap();
        let state = Arc::new(AppState { limiter: Limiter::new(60), store, clock: api::now_secs });
        let app = api::router(state);
        let q = SqliteQueue::in_memory(MasterKey::from_bytes(&[3; 32]), QueueLimits::default()).unwrap();
        let mut cfg = RelayConfig::new(onion);
        cfg.link = LinkCfg { max_frame: 1 << 24, write_timeout: Duration::from_secs(5), cover_every: 0 };
        let relay = Relay::start(cfg, &[4; 32], Arc::new(NoDialer), Arc::new(q));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                tokio::spawn(beacon::route_conn(s, app.clone(), Some(relay.clone())));
            }
        });
        addr
    });
    // HTTP still answers.
    let health = rt.block_on(async {
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET /v1/health HTTP/1.1\r\nHost: b\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).await.unwrap();
        out
    });
    assert!(health.starts_with("HTTP/1.1 200") && health.contains("\"ok\":true"), "{health}");
    // Two devices on the same port.
    let mut cc = ClientConfig::new(onion);
    cc.link = LinkCfg { max_frame: 1 << 24, write_timeout: Duration::from_secs(5), cover_every: 0 };
    cc.redial = |_| Duration::from_millis(100);
    let a = Client::start(cc.clone(), &[1; 32], Arc::new(Tcp(addr)), rt.handle());
    let b = Client::start(cc, &[2; 32], Arc::new(Tcp(addr)), rt.handle());
    let room = a.transport().join_room("Room", &[]).unwrap().room;
    b.transport().join_room("Room", &[]).unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    while !(a.is_connected() && b.is_connected()) {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(200));
    a.transport().send(&room, r#"{"type":"mls_app","ciphertext":"c"}"#);
    let mut got = vec![];
    while got.is_empty() {
        assert!(Instant::now() < end, "frame over TCP");
        std::thread::sleep(Duration::from_millis(20));
        got.extend(b.drain().into_iter().filter(|i| matches!(i, Incoming::Frame { .. })));
    }
    assert_eq!(got, vec![Incoming::Frame { room, payload: r#"{"type":"mls_app","ciphertext":"c"}"#.into() }]);
}
