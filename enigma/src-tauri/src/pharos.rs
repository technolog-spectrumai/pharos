//! Friends: Pharos 1:1 messaging (Stage 4), on top of `pharos-node`.
//!
//! The engine's state lives sealed in the vault (`pharos/state`) and is saved
//! on every change. It starts after unlock (`pharos_start`, called by the
//! window) and stops on lock. Its own arti instance keeps its keys under the
//! profile's `pharos-tor/` folder; the rendezvous keys are derived, so that
//! folder holds no secret that is not also in the vault.

use pharos_node::net::TorNet;
use pharos_node::{parse_fp, Event, FriendView, Message, Node, State, Status};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

const NS: &str = "pharos";
const KEY: &str = "state";
/// Background round: listeners, pairings, mailbox, outbox.
const TICK: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct PharosState(pub Mutex<Option<Running>>);

pub struct Running {
    node: Node<TorNet>,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

fn base(app: &AppHandle) -> std::path::PathBuf {
    let profile = app
        .try_state::<crate::AppConfigState>()
        .and_then(|s| s.lock().ok().map(|c| c.profile.clone()))
        .unwrap_or_else(|| "default".into());
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| ".".into())
        .join("profiles")
        .join(crate::safe_filename_component(&profile))
        .join("pharos-tor")
}

async fn node(app: &AppHandle) -> Result<Node<TorNet>, String> {
    let st = app.state::<PharosState>();
    let g = st.0.lock().await;
    g.as_ref().map(|r| r.node.clone()).ok_or_else(|| "Friends has not started (unlock first)".into())
}

#[derive(Serialize, Clone)]
pub struct Me {
    name: String,
    fingerprint: String,
    id: String,
    proteus: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct MessageView {
    id: String,
    friend: String,
    text: String,
    sent_ms: u64,
    status: Status,
}

impl From<Message> for MessageView {
    fn from(m: Message) -> Self {
        MessageView {
            id: pharos_node::hex(&m.id),
            friend: pharos_node::hex(&m.friend),
            text: m.text,
            sent_ms: m.sent_ms,
            status: m.status,
        }
    }
}

fn me_of(n: &Node<TorNet>) -> Me {
    Me {
        name: n.name(),
        fingerprint: n.fingerprint_words(),
        id: pharos_node::hex(&n.fingerprint()),
        proteus: n.proteus(),
    }
}

/// Start (idempotent): load or create the state, bootstrap Tor, run the rounds.
#[tauri::command]
pub async fn pharos_start(app: AppHandle, name: Option<String>) -> Result<Me, String> {
    let st = app.state::<PharosState>();
    let mut g = st.0.lock().await;
    if let Some(r) = g.as_ref() {
        return Ok(me_of(&r.node));
    }
    let state = match crate::vault::get(&app, NS, KEY)? {
        Some(b) => State::from_bytes(&b).map_err(|e| e.to_string())?,
        None => State::new(name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Enigma")),
    };
    crate::vault::put(&app, NS, KEY, &state.to_bytes())?;
    let dir = base(&app);
    let tor = pharos_tor::Tor::start(dir.join("state"), dir.join("cache"), false).await.map_err(|e| e.to_string())?;
    let (node, mut events) = Node::new(state, TorNet(tor), pharos_node::system_clock());

    let (a, n) = (app.clone(), node.clone());
    let forward = tauri::async_runtime::spawn(async move {
        while let Some(e) = events.recv().await {
            match e {
                Event::Changed => {
                    let _ = crate::vault::put(&a, NS, KEY, &n.snapshot());
                }
                Event::Message(m) => {
                    let incoming = m.status == Status::Received;
                    let v = MessageView::from(m);
                    let _ = a.emit("pharos://message", v.clone());
                    if incoming {
                        notify(&a, &n, &v);
                    }
                }
                Event::Status { id, status } => {
                    let _ = a.emit("pharos://status", serde_json::json!({ "id": pharos_node::hex(&id), "status": status }));
                }
                Event::FriendAdded { .. } | Event::FriendMoved { .. } => {
                    let _ = a.emit("pharos://friends", ());
                }
            }
        }
    });
    let n = node.clone();
    let rounds = tauri::async_runtime::spawn(async move {
        loop {
            n.tick().await;
            tokio::time::sleep(TICK).await;
        }
    });
    let me = me_of(&node);
    *g = Some(Running { node, tasks: vec![forward, rounds] });
    Ok(me)
}

fn notify(app: &AppHandle, n: &Node<TorNet>, m: &MessageView) {
    use tauri_plugin_notification::NotificationExt;
    let from = n.friends().into_iter().find(|f| f.id == m.friend).map(|f| f.name).unwrap_or_default();
    // The text stays in the app: a notification can be read on a locked screen.
    let _ = app.notification().builder().title("Enigma").body(format!("{from}: new message")).show();
}

/// Stop on lock: hosting ends, the state is already saved.
pub async fn stop(app: &AppHandle) {
    if let Some(st) = app.try_state::<PharosState>() {
        if let Some(r) = st.0.lock().await.take() {
            r.node.stop_listeners();
            let _ = crate::vault::put(app, NS, KEY, &r.node.snapshot());
            for t in r.tasks {
                t.abort();
            }
        }
    }
}

#[tauri::command]
pub async fn pharos_me(app: AppHandle) -> Result<Me, String> {
    Ok(me_of(&node(&app).await?))
}

#[tauri::command]
pub async fn pharos_set_name(app: AppHandle, name: String) -> Result<Me, String> {
    let n = node(&app).await?;
    n.set_name(&name).map_err(|e| e.to_string())?;
    Ok(me_of(&n))
}

#[tauri::command]
/// Use a Proteus: `text` is its code (`pharos-proteus:…`, from its page in Tor
/// Browser or `proteus code`, scanned or pasted) or its bare .onion address;
/// empty means none. Enigma connects to it before saving.
pub async fn pharos_set_proteus(app: AppHandle, text: Option<String>) -> Result<Me, String> {
    let n = node(&app).await?;
    let target = pharos_node::parse_proteus(text.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
    n.set_proteus(target.map(|t| t.onion)).await.map_err(|e| e.to_string())?;
    Ok(me_of(&n))
}

#[tauri::command]
pub async fn pharos_card(app: AppHandle) -> Result<String, String> {
    node(&app).await?.my_card().map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ScanView {
    friend: String,
    name: String,
    reply: Option<String>,
}

#[tauri::command]
pub async fn pharos_scan(app: AppHandle, text: String) -> Result<ScanView, String> {
    let s = node(&app).await?.scan_card(&text).await.map_err(|e| e.to_string())?;
    Ok(ScanView { friend: pharos_node::hex(&s.friend), name: s.name, reply: s.reply })
}

#[tauri::command]
pub async fn pharos_accept(app: AppHandle, text: String) -> Result<String, String> {
    let fp = node(&app).await?.accept_reply(&text).map_err(|e| e.to_string())?;
    Ok(pharos_node::hex(&fp))
}

#[tauri::command]
pub async fn pharos_friends(app: AppHandle) -> Result<Vec<FriendView>, String> {
    Ok(node(&app).await?.friends())
}

#[tauri::command]
pub async fn pharos_messages(app: AppHandle, friend: String) -> Result<Vec<MessageView>, String> {
    let fp = parse_fp(&friend).map_err(|e| e.to_string())?;
    Ok(node(&app).await?.messages(&fp).into_iter().map(Into::into).collect())
}

/// Queue and return at once; delivery runs in the background (it can take a
/// minute over Tor) and reports through `pharos://status`.
#[tauri::command]
pub async fn pharos_send(app: AppHandle, friend: String, text: String) -> Result<String, String> {
    let fp = parse_fp(&friend).map_err(|e| e.to_string())?;
    let n = node(&app).await?;
    let id = n.queue(&fp, &text).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        let _ = n.deliver(&fp).await;
    });
    Ok(pharos_node::hex(&id))
}

#[tauri::command]
pub async fn pharos_remove(app: AppHandle, friend: String) -> Result<(), String> {
    let fp = parse_fp(&friend).map_err(|e| e.to_string())?;
    node(&app).await?.remove_friend(&fp);
    Ok(())
}

/// "Check now": one background round, on demand.
#[tauri::command]
pub async fn pharos_sync(app: AppHandle) -> Result<(), String> {
    let n = node(&app).await?;
    n.tick().await;
    for f in n.friends() {
        if let Ok(fp) = parse_fp(&f.id) {
            let _ = n.lookup(&fp).await;
        }
    }
    Ok(())
}
