// Rust-owned realtime gateway.
//
// The frontend calls `realtime_connect/disconnect/send` and listens to the
// `realtime://message` / `realtime://status` events — it never learns which
// transport is used. This phase ships a single backend: a WebSocket client to
// the toto `telegraph` server (mirroring the old JS ws.ts, incl. backoff
// reconnect). A P2P backend can later be added behind the same commands without
// any frontend change.

use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::p2p_iroh::{self, P2pState};
use crate::{active_config, load_profile_state, AppConfigState};

const BACKOFF_MS: [u64; 6] = [1000, 2000, 4000, 8000, 16000, 30000];

#[derive(Default)]
pub struct RealtimeState {
    inner: Mutex<Inner>,
    generation: AtomicU64,
}

#[derive(Default)]
struct Inner {
    room: Option<String>,
    out_tx: Option<mpsc::UnboundedSender<String>>,
}

fn ws_base(server_url: &str) -> Option<String> {
    let http = server_url.trim_end_matches('/');
    if http.is_empty() {
        return None;
    }
    if let Some(rest) = http.strip_prefix("https") {
        Some(format!("wss{rest}"))
    } else if let Some(rest) = http.strip_prefix("http") {
        Some(format!("ws{rest}"))
    } else {
        None
    }
}

/// Minimal percent-encoding for the token query parameter.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn emit_status(app: &AppHandle, room: &str, state: &str) {
    let _ = app.emit("realtime://status", json!({ "room": room, "state": state }));
}

fn emit_message(app: &AppHandle, room: &str, payload: &str) {
    let _ = app.emit("realtime://message", json!({ "room": room, "payload": payload }));
}

#[tauri::command]
pub async fn realtime_connect(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    realtime: State<'_, RealtimeState>,
    room: String,
) -> Result<(), String> {
    // Cancel any previous connection task by bumping the generation.
    let my_gen = realtime.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let cfg = active_config(&config)?;
    let state = load_profile_state(&app, &cfg);
    if crate::is_offline(&state) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let Some(ws_base) = ws_base(&state.server_url) else {
        return Err("No server configured.".to_string());
    };
    let token = state.auth_token.clone().unwrap_or_default();
    let query = if token.is_empty() {
        String::new()
    } else {
        format!("?token={}", url_encode(&token))
    };
    let url = format!("{ws_base}/ws/telegraph/{room}/{query}");

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    {
        let mut inner = realtime.inner.lock().await;
        inner.room = Some(room.clone());
        inner.out_tx = Some(out_tx);
    }

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let realtime = app2.state::<RealtimeState>();
        let mut attempt = 0usize;

        loop {
            if realtime.generation.load(Ordering::SeqCst) != my_gen {
                return;
            }
            emit_status(&app2, &room, "connecting");

            match tokio_tungstenite::connect_async(url.as_str()).await {
                Ok((ws_stream, _)) => {
                    attempt = 0;
                    emit_status(&app2, &room, "connected");
                    let (mut write, mut read) = ws_stream.split();

                    loop {
                        tokio::select! {
                            out = out_rx.recv() => match out {
                                Some(text) => {
                                    if write.send(WsMessage::Text(text.into())).await.is_err() {
                                        break;
                                    }
                                }
                                // Sender dropped → intentional disconnect.
                                None => {
                                    let _ = write.close().await;
                                    emit_status(&app2, &room, "disconnected");
                                    return;
                                }
                            },
                            msg = read.next() => match msg {
                                Some(Ok(WsMessage::Text(t))) => emit_message(&app2, &room, t.as_str()),
                                Some(Ok(_)) => {}
                                Some(Err(_)) | None => break,
                            },
                        }

                        if realtime.generation.load(Ordering::SeqCst) != my_gen {
                            return;
                        }
                    }
                }
                Err(_) => emit_status(&app2, &room, "error"),
            }

            if realtime.generation.load(Ordering::SeqCst) != my_gen {
                return;
            }
            let delay = BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)];
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn realtime_disconnect(realtime: State<'_, RealtimeState>) -> Result<(), String> {
    realtime.generation.fetch_add(1, Ordering::SeqCst);
    let mut inner = realtime.inner.lock().await;
    inner.room = None;
    inner.out_tx = None; // drop the sender → the task's out_rx yields None and it exits
    Ok(())
}

const OFFLINE_BLOCKED: &str = "Offline — all network connections are blocked.";

/// Airplane mode: true when the offline switch is on (blocks server AND P2P).
fn offline(app: &AppHandle, config: &State<'_, AppConfigState>) -> bool {
    matches!(active_config(config), Ok(cfg) if crate::is_offline(&load_profile_state(app, &cfg)))
}

#[tauri::command]
pub async fn realtime_send(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    realtime: State<'_, RealtimeState>,
    p2p: State<'_, P2pState>,
    room: Option<String>,
    payload: String,
) -> Result<(), String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    // Route to the P2P backend if this room is a P2P (iroh) room…
    if let Some(room) = &room {
        if p2p_iroh::has_room(&p2p, room).await {
            return p2p_iroh::broadcast(&p2p, room, payload)
                .await
                .map_err(|e| e.to_string());
        }
    }
    // …otherwise it's the WS server room (single active connection).
    let inner = realtime.inner.lock().await;
    match &inner.out_tx {
        Some(tx) => tx.send(payload).map_err(|e| e.to_string()),
        None => Err("realtime: not connected".to_string()),
    }
}

// ── P2P (iroh) room commands — same realtime://* events as the WS backend ──────

#[derive(Serialize)]
pub struct CreatedRoom {
    room: String,
    name: String,
    ticket: String,
}

#[derive(Serialize)]
pub struct JoinedRoom {
    room: String,
    name: String,
}

#[tauri::command]
pub async fn realtime_create_room(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    name: String,
) -> Result<CreatedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let (room, ticket) = p2p_iroh::create_room(&app, &p2p, name.clone())
        .await
        .map_err(|e| e.to_string())?;
    Ok(CreatedRoom { room, name, ticket })
}

#[tauri::command]
pub async fn realtime_join_room(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    ticket: String,
) -> Result<JoinedRoom, String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    let (room, name) = p2p_iroh::join_room(&app, &p2p, ticket)
        .await
        .map_err(|e| e.to_string())?;
    Ok(JoinedRoom { room, name })
}

#[tauri::command]
pub async fn realtime_leave_room(p2p: State<'_, P2pState>, room: String) -> Result<(), String> {
    p2p_iroh::leave_room(&p2p, &room).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn realtime_node_info(p2p: State<'_, P2pState>) -> Result<serde_json::Value, String> {
    let node_id = p2p_iroh::node_info(&p2p).await.map_err(|e| e.to_string())?;
    Ok(json!({ "node_id": node_id }))
}
