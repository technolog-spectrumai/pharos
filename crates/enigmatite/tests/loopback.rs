//! The one integration test of the shared engine's Rust half: two gateways on loopback (no
//! relays, no discovery: each learns the other's address), rakotis' frames between them — a
//! key package with a device proof, the commit and Welcome, a sealed text — the way Enigma's
//! and Teutates' windows send them.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use enigmatite::events::Event;
use enigmatite::gateway::Gateway;
use enigmatite::mls::{At, Sessions, Store};
use enigmatite::admission;
use serde_json::{json, Value};

#[derive(Default)]
struct Mem(Mutex<std::collections::HashMap<String, Vec<u8>>>);
impl Store for Mem {
    fn get(&self, r: &str, i: &str) -> Option<Vec<u8>> {
        self.0.lock().unwrap().get(&format!("{r}\0{i}")).cloned()
    }
    fn put(&self, r: &str, i: &str, s: &[u8]) {
        self.0.lock().unwrap().insert(format!("{r}\0{i}"), s.to_vec());
    }
    fn delete(&self, r: &str, i: &str) {
        self.0.lock().unwrap().remove(&format!("{r}\0{i}"));
    }
}

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
fn unb64(v: &Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(v.as_str().unwrap()).unwrap()
}

type Inbox = Arc<Mutex<Vec<Value>>>;

async fn gateway() -> (Arc<Gateway>, Inbox) {
    let inbox: Inbox = Arc::default();
    let i2 = Arc::clone(&inbox);
    let g = Gateway::start(false, None, Arc::new(move |e| {
        if let Event::Message { payload, .. } = e {
            if let Ok(v) = serde_json::from_str(&payload) {
                i2.lock().unwrap().push(v);
            }
        }
    }))
    .await
    .unwrap();
    (g, inbox)
}

async fn wait_for(inbox: &Inbox, ty: &str, mut resend: impl AsyncFnMut()) -> Value {
    tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            if let Some(v) = inbox.lock().unwrap().iter().find(|v| v["type"] == ty).cloned() {
                return v;
            }
            resend().await;
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {ty} arrived"))
}

#[tokio::test(flavor = "multi_thread")]
async fn two_devices_exchange_a_sealed_message_over_ferrozine_on_loopback() {
    let name = "teutates-ab12";
    let ((ga, ia), (gb, ib)) = (gateway().await, gateway().await);
    gb.learn(&ga.addr_text()).unwrap();
    let slug = ga.join(name, &[]).await.unwrap();
    assert_eq!(gb.join(name, &[ga.node_id()]).await.unwrap(), slug);

    let pk = ed25519_dalek::SigningKey::from_bytes(&[2; 32]).verifying_key().to_bytes();
    let (alice, bob) = ("did:heliodor:alice#dev-aaaaaaaa".to_string(), admission::identity("did:heliodor:bob", &pk));
    let (sa, sb) = (Mem::default(), Mem::default());
    let (ma, mb) = (Sessions::default(), Sessions::default());
    let at_a = At { key: &alice, room: &slug, identity: &alice };
    let at_b = At { key: &bob, room: &slug, identity: &bob };
    ma.init(&sa, at_a).unwrap();
    mb.init(&sb, at_b).unwrap();

    // Bob asks to be let in until Alice hears him (the mesh takes a moment to form).
    let kp = mb.key_package(&sb, at_b).unwrap();
    let kp_frame = json!({ "type": "mls_key_package", "key_package": b64(&kp), "package": b64(&kp), "device_id": bob, "user": "Bob", "teutates": admission::kp_proof(&[2; 32], &kp) }).to_string();
    let got = wait_for(&ia, "mls_key_package", async || {
        let _ = gb.broadcast(&slug, kp_frame.clone()).await;
    })
    .await;
    assert!(admission::admits(&got, &[hex::encode(pk)]), "certified by the roster");

    let (welcome, commit) = ma.add_member(&sa, at_a, &unb64(&got["key_package"])).unwrap();
    let wf = json!({ "type": "mls_welcome", "welcome": b64(&welcome), "target": bob }).to_string();
    let cf = json!({ "type": "mls_commit", "commit": b64(&commit) }).to_string();
    let w = wait_for(&ib, "mls_welcome", async || {
        let _ = ga.broadcast(&slug, cf.clone()).await;
        let _ = ga.broadcast(&slug, wf.clone()).await;
    })
    .await;
    mb.join_from_welcome(&sb, at_b, &unb64(&w["welcome"])).unwrap();

    let ct = ma.encrypt(&sa, at_a, b"hello over iroh".to_vec()).unwrap();
    let app = json!({ "type": "mls_app", "ciphertext": b64(&ct), "device_id": alice, "sender_name": "Alice", "msg_id": "m1" }).to_string();
    let m = wait_for(&ib, "mls_app", async || {
        let _ = ga.broadcast(&slug, app.clone()).await;
    })
    .await;
    let plain = mb.process_message(&sb, at_b, &unb64(&m["ciphertext"])).unwrap().unwrap();
    assert_eq!(plain, b"hello over iroh");
    ga.leave(&slug).await;
}
