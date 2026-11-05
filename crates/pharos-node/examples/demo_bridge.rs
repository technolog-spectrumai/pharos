//! A demo bridge: the real Pharos engine behind Nautes' window in a plain
//! browser, for screenshots and UI work without Tauri or Tor.
//!
//!   cargo run -p pharos-node --example demo_bridge      # http://127.0.0.1:8977
//!
//! Three nodes (alice, bob, carol) and a real Proteus run on the in-process
//! network. `POST /call/{profile}/{command}` with the command's JSON arguments
//! answers as `src-tauri/src/pharos.rs` would; `GET /events/{profile}?since=n`
//! returns the events since `n`. A browser shim (nautes/tests/e2e/bridge.ts)
//! routes the window's `pharos_*` invokes here.

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use pharos_node::net::MemNet;
use pharos_node::{hex, parse_fp, Event, Message, Node, State as NodeState, Status};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const PROTEUS: &str = "proteusdemo4k2q7m3xv5nb6wz8yc9h2dj4lf7rt3ga5ek6pq2sum3wd.onion";

struct Peer {
    node: Node<MemNet>,
    /// Offline: no background rounds, no listeners (a closed laptop).
    offline: Arc<std::sync::atomic::AtomicBool>,
    events: Arc<Mutex<Vec<Value>>>,
}

type Peers = Arc<HashMap<String, Peer>>;

fn msg(m: &Message) -> Value {
    json!({ "id": hex(&m.id), "friend": hex(&m.friend), "text": m.text, "sent_ms": m.sent_ms, "status": m.status })
}

fn me(n: &Node<MemNet>) -> Value {
    json!({ "name": n.name(), "fingerprint": n.fingerprint_words(), "id": hex(&n.fingerprint()), "proteus": n.proteus() })
}

async fn call(State(p): State<Peers>, Path((who, cmd)): Path<(String, String)>, Json(a): Json<Value>) -> Json<Value> {
    let Some(peer) = p.get(&who) else { return Json(json!({ "error": "no such profile" })) };
    let n = &peer.node;
    let s = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let r: anyhow::Result<Value> = async {
        Ok(match cmd.as_str() {
            "pharos_start" | "pharos_me" => me(n),
            "pharos_set_name" => {
                n.set_name(&s("name"))?;
                me(n)
            }
            "pharos_set_proteus" => {
                n.set_proteus(a.get("onion").and_then(|v| v.as_str()).map(String::from)).await?;
                me(n)
            }
            "pharos_card" => json!(n.my_card()?),
            "pharos_scan" => {
                let r = n.scan_card(&s("text")).await?;
                json!({ "friend": hex(&r.friend), "name": r.name, "reply": r.reply })
            }
            "pharos_accept" => json!(hex(&n.accept_reply(&s("text"))?)),
            "pharos_friends" => serde_json::to_value(n.friends())?,
            "pharos_messages" => json!(n.messages(&parse_fp(&s("friend"))?).iter().map(msg).collect::<Vec<_>>()),
            "pharos_send" => {
                let fp = parse_fp(&s("friend"))?;
                let id = n.queue(&fp, &s("text"))?;
                let n = n.clone();
                tokio::spawn(async move {
                    // Tor takes a moment; so does the demo.
                    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
                    let _ = n.deliver(&fp).await;
                });
                json!(hex(&id))
            }
            "pharos_remove" => {
                n.remove_friend(&parse_fp(&s("friend"))?);
                Value::Null
            }
            "pharos_sync" => {
                n.tick().await;
                Value::Null
            }
            // Demo controls.
            "demo_offline" => {
                peer.offline.store(true, std::sync::atomic::Ordering::SeqCst);
                n.stop_listeners();
                Value::Null
            }
            "demo_online" => {
                peer.offline.store(false, std::sync::atomic::Ordering::SeqCst);
                n.refresh_listeners().await?;
                Value::Null
            }
            "demo_fetch" => json!(n.fetch_mailboxes().await?),
            other => anyhow::bail!("unknown command {other}"),
        })
    }
    .await;
    Json(match r {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "error": e.to_string() }),
    })
}

#[derive(serde::Deserialize)]
struct Since {
    since: usize,
}

async fn events(State(p): State<Peers>, Path(who): Path<String>, Query(q): Query<Since>) -> Json<Value> {
    let Some(peer) = p.get(&who) else { return Json(json!([])) };
    let ev = peer.events.lock().unwrap();
    Json(json!({ "next": ev.len(), "events": ev.iter().skip(q.since).cloned().collect::<Vec<_>>() }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let net = MemNet::default();
    {
        use proteus::{api, config::Limits, masterkey::MasterKey, store::Store};
        let store = Store::in_memory(MasterKey::from_bytes(&[5; 32]), Limits::default())?;
        let app = api::router(Arc::new(api::AppState { store, limiter: api::Limiter::new(1000), clock: pharos_node::system_secs }));
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        net.route_tcp(PROTEUS, l.local_addr()?);
        tokio::spawn(async move {
            while let Ok((s, _)) = l.accept().await {
                tokio::spawn(proteus::serve_conn(s, app.clone()));
            }
        });
    }
    let mut peers = HashMap::new();
    for (who, name) in [("alice", "Alice"), ("bob", "Bob"), ("carol", "Carol")] {
        let (node, mut rx) = Node::new(NodeState::new(name), net.clone(), pharos_node::system_clock());
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        tokio::spawn(async move {
            while let Some(e) = rx.recv().await {
                let v = match e {
                    Event::Message(m) => json!({ "event": "pharos://message", "payload": msg(&m) }),
                    Event::Status { id, status } => json!({ "event": "pharos://status", "payload": { "id": hex(&id), "status": status } }),
                    Event::FriendAdded { .. } | Event::FriendMoved { .. } => json!({ "event": "pharos://friends", "payload": null }),
                    Event::Changed => continue,
                };
                ev.lock().unwrap().push(v);
            }
        });
        let n = node.clone();
        let offline = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let off = offline.clone();
        tokio::spawn(async move {
            loop {
                if !off.load(std::sync::atomic::Ordering::SeqCst) {
                    n.tick().await;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        });
        peers.insert(who.to_string(), Peer { node, offline, events });
    }
    let _ = Status::Queued;
    let app = Router::new()
        .route("/call/{who}/{cmd}", post(call))
        .route("/events/{who}", get(events))
        .layer(axum::middleware::from_fn(cors))
        .with_state(Arc::new(peers));
    let l = tokio::net::TcpListener::bind("127.0.0.1:8977").await?;
    eprintln!("demo bridge on http://127.0.0.1:8977 (Proteus: {PROTEUS})");
    axum::serve(l, app).await?;
    Ok(())
}

async fn cors(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    use axum::response::IntoResponse;
    if req.method() == axum::http::Method::OPTIONS {
        let mut r = ().into_response();
        allow(&mut r);
        return r;
    }
    let mut r = next.run(req).await;
    allow(&mut r);
    r
}

fn allow(r: &mut axum::response::Response) {
    let h = r.headers_mut();
    h.insert("access-control-allow-origin", "*".parse().unwrap());
    h.insert("access-control-allow-headers", "content-type".parse().unwrap());
}
