// Two Enigma instances talking over the real Tor network: one process hosts an
// onion service, the other dials it, and both use the mesh's own wire
// protocol — the Hello/Ready handshake and length-prefixed frames, the same
// bytes a room carries. Run by ./test_tor2.sh, never by `cargo test` on its own:
// the tests are #[ignore]d and do nothing without TOR2_ROLE and TOR2_DIR.
//
// Each process has its own arti client and its own state directory, so there is
// no shared Tor state between the two instances; the only thing they share is
// the rendezvous directory (TOR2_DIR) where the host writes its `.onion`.
use super::*;
use std::path::{Path, PathBuf};
use std::time::Instant;

const ROUNDS: usize = 3;
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(300);
const DIAL_TIMEOUT: Duration = Duration::from_secs(240);
const WAIT_FOR_ONION: Duration = Duration::from_secs(600);

fn rendezvous() -> PathBuf {
    PathBuf::from(std::env::var("TOR2_DIR").expect("TOR2_DIR: the shared rendezvous directory"))
}

fn log(role: &str, msg: &str) {
    eprintln!("[tor2:{role}] {msg}");
}

async fn client(role: &str, dir: &Path) -> Arc<TorClient<PreferredRuntime>> {
    let state = dir.join(format!("{role}-state"));
    let cache = dir.join(format!("{role}-cache"));
    std::fs::create_dir_all(&state).unwrap();
    std::fs::create_dir_all(&cache).unwrap();
    let started = Instant::now();
    log(role, "bootstrapping Tor (full vanguards)…");
    let c = tokio::time::timeout(BOOTSTRAP_TIMEOUT, TorClient::create_bootstrapped(arti_config(&state, &cache).unwrap()))
        .await
        .expect("Tor bootstrap timed out")
        .expect("Tor bootstrap failed");
    log(role, &format!("bootstrapped in {:?}", started.elapsed()));
    c
}

/// The payload of message `i` from `who`: JSON like a room frame, with Polish
/// text and a large-ish body so it spans several Tor cells.
fn message(who: &str, i: usize) -> String {
    serde_json::json!({ "type": "mls_app", "from": who, "seq": i, "text": "Zażółć gęślą jaźń", "pad": "x".repeat(4000) })
        .to_string()
}

#[tokio::test]
#[ignore = "real Tor network: run ./test_tor2.sh"]
async fn tor2_host() {
    if std::env::var("TOR2_ROLE").as_deref() != Ok("host") {
        return;
    }
    let dir = rendezvous();
    let c = client("host", &dir).await;
    let nick = nickname_for(&format!("tor2-{}", std::process::id())).unwrap();
    let (service, rend) = c
        .launch_onion_service(OnionServiceConfigBuilder::default().nickname(nick).build().unwrap())
        .expect("launch onion service")
        .expect("onion services enabled");
    let onion = wait_onion_address(&service).await.expect("onion address");
    log("host", &format!("serving {onion}"));
    std::fs::write(dir.join("onion"), &onion).unwrap();

    let mut streams = Box::pin(handle_rend_requests(rend));
    let req = tokio::time::timeout(WAIT_FOR_ONION, streams.next())
        .await
        .expect("nobody dialled the onion in time")
        .expect("rendezvous stream ended");
    let ds = req.accept(Connected::new_empty()).await.expect("accept stream");
    let (mut rd, mut wr) = tokio::io::split(ds);

    let hello: Hello = serde_json::from_str(&read_frame(&mut rd).await.expect("read Hello")).expect("Hello");
    assert_eq!(hello.name, "tor2-room");
    log("host", &format!("Hello from peer {}", hello.peer_id));
    write_frame(&mut wr, &serde_json::to_string(&Ready { ok: true }).unwrap()).await.unwrap();

    for i in 0..ROUNDS {
        let got = read_frame(&mut rd).await.expect("read from dialler");
        assert_eq!(got, message("dialler", i), "frame {i} from the dialler arrived intact");
        write_frame(&mut wr, &message("host", i)).await.expect("reply");
        log("host", &format!("round {i}: received and answered"));
    }
    // Wait for the dialler's goodbye so the circuit is not torn down mid-reply.
    let bye = read_frame(&mut rd).await.expect("goodbye");
    assert_eq!(bye, r#"{"type":"bye"}"#);
    std::fs::write(dir.join("host-ok"), b"ok").unwrap();
    log("host", "PASS");
}

#[tokio::test]
#[ignore = "real Tor network: run ./test_tor2.sh"]
async fn tor2_dialler() {
    if std::env::var("TOR2_ROLE").as_deref() != Ok("dialler") {
        return;
    }
    let dir = rendezvous();
    let c = client("dialler", &dir).await;
    let started = Instant::now();
    let onion = loop {
        if let Ok(s) = std::fs::read_to_string(dir.join("onion")) {
            break s.trim().to_string();
        }
        assert!(started.elapsed() < WAIT_FOR_ONION, "the host never published its onion");
        tokio::time::sleep(Duration::from_secs(1)).await;
    };
    log("dialler", &format!("dialling {onion}"));

    // A fresh descriptor can take a while to be reachable: retry until DIAL_TIMEOUT.
    let dial_start = Instant::now();
    let (mut rd, mut wr) = loop {
        match tokio::time::timeout(Duration::from_secs(90), dial(&c, &onion, &Hello { name: "tor2-room".into(), peer_id: "tor2-dialler".into(), kind: None, onion: "tor2-dialler.onion".into(), device: String::new(), ts: 0, sig: String::new() })).await {
            Ok(Ok(s)) => break s,
            Ok(Err(e)) => log("dialler", &format!("not yet: {e}")),
            Err(_) => log("dialler", "not yet: dial timed out"),
        }
        assert!(dial_start.elapsed() < DIAL_TIMEOUT, "could not reach the host's onion");
        tokio::time::sleep(Duration::from_secs(5)).await;
    };
    log("dialler", &format!("connected and handshaken in {:?}", dial_start.elapsed()));

    for i in 0..ROUNDS {
        let t = Instant::now();
        write_frame(&mut wr, &message("dialler", i)).await.expect("send");
        let got = read_frame(&mut rd).await.expect("read reply");
        assert_eq!(got, message("host", i), "reply {i} from the host arrived intact");
        log("dialler", &format!("round {i}: round trip {:?}", t.elapsed()));
    }
    write_frame(&mut wr, r#"{"type":"bye"}"#).await.unwrap();
    // Give the goodbye time to cross before the client drops.
    tokio::time::sleep(Duration::from_secs(5)).await;
    std::fs::write(dir.join("dialler-ok"), b"ok").unwrap();
    log("dialler", "PASS");
}
