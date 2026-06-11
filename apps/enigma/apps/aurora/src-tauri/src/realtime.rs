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
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;

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

/// Pump an established WebSocket connection until it ends. Generic over the
/// transport so it serves both a direct (`connect_async`) stream and a Tor
/// (`client_async` over an arti `DataStream`) stream. Returns `true` when the
/// caller should stop the task (intentional disconnect or a newer connection
/// superseded this one), `false` when it should reconnect with backoff.
async fn pump_ws<S>(
    app: &AppHandle,
    room: &str,
    realtime: &RealtimeState,
    my_gen: u64,
    ws_stream: WebSocketStream<S>,
    out_rx: &mut mpsc::UnboundedReceiver<String>,
) -> bool
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    let (mut write, mut read) = ws_stream.split();
    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(text) => {
                    if write.send(WsMessage::Text(text.into())).await.is_err() {
                        return false;
                    }
                }
                // Sender dropped → intentional disconnect.
                None => {
                    let _ = write.close().await;
                    emit_status(app, room, "disconnected");
                    return true;
                }
            },
            msg = read.next() => match msg {
                Some(Ok(WsMessage::Text(t))) => emit_message(app, room, t.as_str()),
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return false,
            },
        }

        if realtime.generation.load(Ordering::SeqCst) != my_gen {
            return true;
        }
    }
}

/// Run the WS handshake over an already-opened transport (a plain or TLS Tor
/// stream), then pump it. Returns `Some(stop)` when the handshake succeeded
/// (caller resets backoff), or `None` when it failed (caller reconnects).
async fn open_and_pump<S>(
    app: &AppHandle,
    room: &str,
    realtime: &RealtimeState,
    my_gen: u64,
    url: &str,
    raw: S,
    out_rx: &mut mpsc::UnboundedReceiver<String>,
) -> Option<bool>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    match tokio_tungstenite::client_async(url, raw).await {
        Ok((ws_stream, _)) => {
            emit_status(app, room, "connected");
            Some(pump_ws(app, room, realtime, my_gen, ws_stream, out_rx).await)
        }
        Err(_) => {
            emit_status(app, room, "error");
            None
        }
    }
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

    // When the server is a .onion, dial through the embedded Tor client instead
    // of connecting directly (nothing resolves .onion without Tor).
    let is_onion = state.server_is_onion;
    let onion_host_port = if is_onion {
        Some(crate::tor::host_port(&state.server_url)?)
    } else {
        None
    };
    // wss (TLS over the Tor stream) vs ws, decided by the (https→wss) scheme.
    let onion_tls = is_onion && url.starts_with("wss");

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

            let outcome = if is_onion {
                let (host, port) = onion_host_port.clone().expect("onion host:port");
                let tor = app2.state::<crate::tor::TorState>();
                if onion_tls {
                    // wss: TLS over the Tor stream, then the WS handshake.
                    match tor.connect_tls(&host, port).await {
                        Ok(s) => {
                            open_and_pump(&app2, &room, &realtime, my_gen, url.as_str(), s, &mut out_rx)
                                .await
                        }
                        Err(_) => {
                            emit_status(&app2, &room, "error");
                            None
                        }
                    }
                } else {
                    match tor.connect(&host, port).await {
                        Ok(s) => {
                            open_and_pump(&app2, &room, &realtime, my_gen, url.as_str(), s, &mut out_rx)
                                .await
                        }
                        Err(_) => {
                            emit_status(&app2, &room, "error");
                            None
                        }
                    }
                }
            } else {
                // Clearnet: connect_async handles plain ws and TLS wss itself.
                match tokio_tungstenite::connect_async(url.as_str()).await {
                    Ok((ws_stream, _)) => {
                        emit_status(&app2, &room, "connected");
                        Some(pump_ws(&app2, &room, &realtime, my_gen, ws_stream, &mut out_rx).await)
                    }
                    Err(_) => {
                        emit_status(&app2, &room, "error");
                        None
                    }
                }
            };

            let stop = match outcome {
                Some(stop) => {
                    attempt = 0; // connected → reset backoff
                    stop
                }
                None => false, // connect failed → reconnect with backoff
            };

            if stop || realtime.generation.load(Ordering::SeqCst) != my_gen {
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
    room: Option<String>,
    payload: String,
) -> Result<(), String> {
    if offline(&app, &config) {
        return Err(OFFLINE_BLOCKED.to_string());
    }
    // Aurora is relay-only (no P2P/iroh): send over the single WS server connection.
    let _ = room;
    let inner = realtime.inner.lock().await;
    match &inner.out_tx {
        Some(tx) => tx.send(payload).map_err(|e| e.to_string()),
        None => Err("realtime: not connected".to_string()),
    }
}
