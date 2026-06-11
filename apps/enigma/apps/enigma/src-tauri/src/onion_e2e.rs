// End-to-end harness for the onion transport, gated behind env so it never runs in
// a normal `cargo test`. Run via:
//
//   ENIGMA_E2E=1 ENIGMA_E2E_BASE=https://<onion> ENIGMA_E2E_IS_ONION=1 \
//   ENIGMA_E2E_USER=admin ENIGMA_E2E_PASS=test1234 ENIGMA_E2E_CHANNEL=e2e \
//   cargo test --lib -- --ignored --nocapture onion_full_flow
//
// It exercises the SAME transport the app uses: tor.rs (Arti) for onion rows and a
// plain/TLS TcpStream for clearnet rows, then shares send_http / client_async. The
// matrix is driven by env (one row per invocation):
//   - TLS onion : https://<onion>  + wss   (Arti + tls_wrap)
//   - clearnet  : https://localhost:8443    (TcpStream + tls_wrap)
//   - plain onion: http://<onion>  + ws     (Arti, no TLS)
//
// Progressive layers (hard-fail on any): bootstrap+login → me → join channel →
// two WSS clients chat (A→B) → send an image inline (A→B). "Two instances talking"
// = two independent WebSocket clients in one room.

#![cfg(test)]

use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use arti_client::DataStream;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;

use crate::tor::{host_port, send_http, tls_wrap, TorState};

// ── config from env ──────────────────────────────────────────────────────────

struct Cfg {
    base: String,
    is_onion: bool,
    tls: bool,
    host: String,
    port: u16,
    user: String,
    pass: String,
    channel: String,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

impl Cfg {
    fn from_env() -> Option<Self> {
        if env("ENIGMA_E2E").as_deref() != Some("1") {
            return None;
        }
        let base = env("ENIGMA_E2E_BASE").expect("ENIGMA_E2E_BASE");
        let (host, port) = host_port(&base).expect("parse base");
        Some(Cfg {
            tls: base.starts_with("https"),
            is_onion: env("ENIGMA_E2E_IS_ONION").as_deref() == Some("1"),
            host,
            port,
            user: env("ENIGMA_E2E_USER").unwrap_or_else(|| "admin".into()),
            pass: env("ENIGMA_E2E_PASS").expect("ENIGMA_E2E_PASS"),
            channel: env("ENIGMA_E2E_CHANNEL").unwrap_or_else(|| "e2e".into()),
            base,
        })
    }

    fn ws_url(&self, token: &str) -> String {
        let scheme = if self.tls { "wss" } else { "ws" };
        format!(
            "{scheme}://{}/ws/telegraph/{}/?token={}",
            self.host, self.channel, token
        )
    }
}

// ── a single stream type covering all 4 transport combos ─────────────────────

enum AnyStream {
    Plain(DataStream),
    TorTls(Box<TlsStream<DataStream>>),
    Tcp(TcpStream),
    TcpTls(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for AnyStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            AnyStream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            AnyStream::TorTls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
            AnyStream::Tcp(s) => Pin::new(s).poll_read(cx, buf),
            AnyStream::TcpTls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for AnyStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            AnyStream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            AnyStream::TorTls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
            AnyStream::Tcp(s) => Pin::new(s).poll_write(cx, buf),
            AnyStream::TcpTls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            AnyStream::Plain(s) => Pin::new(s).poll_flush(cx),
            AnyStream::TorTls(s) => Pin::new(s.as_mut()).poll_flush(cx),
            AnyStream::Tcp(s) => Pin::new(s).poll_flush(cx),
            AnyStream::TcpTls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            AnyStream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            AnyStream::TorTls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
            AnyStream::Tcp(s) => Pin::new(s).poll_shutdown(cx),
            AnyStream::TcpTls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

async fn connect_stream(cfg: &Cfg, tor: &TorState) -> Result<AnyStream, String> {
    if cfg.is_onion {
        let s = tor.connect(&cfg.host, cfg.port).await?;
        if cfg.tls {
            Ok(AnyStream::TorTls(Box::new(tls_wrap(s, &cfg.host).await?)))
        } else {
            Ok(AnyStream::Plain(s))
        }
    } else {
        let s = TcpStream::connect((cfg.host.as_str(), cfg.port))
            .await
            .map_err(|e| format!("tcp connect: {e}"))?;
        if cfg.tls {
            Ok(AnyStream::TcpTls(Box::new(tls_wrap(s, &cfg.host).await?)))
        } else {
            Ok(AnyStream::Tcp(s))
        }
    }
}

fn json_headers(token: Option<&str>) -> Vec<(String, String)> {
    let mut h = vec![
        ("Content-Type".into(), "application/json".into()),
        ("X-Requested-With".into(), "XMLHttpRequest".into()),
    ];
    if let Some(t) = token {
        h.push(("Authorization".into(), format!("Bearer {t}")));
    }
    h
}

async fn http(
    cfg: &Cfg,
    tor: &TorState,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Vec<u8>,
) -> Result<(u16, Vec<u8>), String> {
    let stream = connect_stream(cfg, tor).await?;
    send_http(
        stream,
        &cfg.host,
        cfg.port,
        cfg.tls,
        method,
        path,
        &json_headers(token),
        body,
    )
    .await
}

async fn ws_connect(
    cfg: &Cfg,
    tor: &TorState,
    token: &str,
) -> Result<WebSocketStream<AnyStream>, String> {
    let stream = connect_stream(cfg, tor).await?;
    let url = cfg.ws_url(token);
    let (ws, _resp) = tokio_tungstenite::client_async(url.as_str(), stream)
        .await
        .map_err(|e| format!("ws handshake: {e}"))?;
    Ok(ws)
}

async fn recv_matching(
    ws: &mut WebSocketStream<AnyStream>,
    needle: &str,
    secs: u64,
) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!("timeout waiting for ws frame containing {needle:?}"));
        }
        match tokio::time::timeout(remaining, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(t)))) => {
                let s = t.to_string();
                if s.contains(needle) {
                    return Ok(s);
                }
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => return Err(format!("ws error: {e}")),
            Ok(None) => return Err("ws closed before match".into()),
            Err(_) => return Err(format!("timeout waiting for ws frame containing {needle:?}")),
        }
    }
}

// A tiny 1x1 PNG (valid image header so the consumer's `data:image/` check passes).
fn tiny_png_data_url() -> String {
    let png: [u8; 67] = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    format!("data:image/png;base64,{}", data_encoding::BASE64.encode(&png))
}

async fn run(cfg: Cfg) -> Result<(), String> {
    let label = if cfg.is_onion {
        if cfg.tls { "TLS onion (https+wss over Tor)" } else { "plain onion (http+ws over Tor)" }
    } else if cfg.tls {
        "clearnet TLS (https+wss)"
    } else {
        "clearnet (http+ws)"
    };
    eprintln!("\n=== E2E row: {label} → {} ===", cfg.base);
    let tor = TorState::default();

    // Layer 1 — bootstrap (onion) + login over HTTP(S).
    if cfg.is_onion {
        eprintln!("[1] bootstrapping embedded Tor + connecting to the .onion …");
    }
    let login_body = serde_json::json!({ "username": cfg.user, "password": cfg.pass });
    let (status, bytes) = http(
        &cfg,
        &tor,
        "POST",
        "/telegraph/api/login/",
        None,
        serde_json::to_vec(&login_body).unwrap(),
    )
    .await?;
    if status != 200 {
        return Err(format!("login HTTP {status}: {}", String::from_utf8_lossy(&bytes)));
    }
    let token = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v.get("token").and_then(|t| t.as_str().map(String::from)))
        .ok_or_else(|| format!("no token in login response: {}", String::from_utf8_lossy(&bytes)))?;
    eprintln!("[1] OK — logged in, token acquired");

    // Layer 2 — authenticated REST.
    let (status, bytes) = http(&cfg, &tor, "GET", "/telegraph/api/me/", Some(&token), Vec::new()).await?;
    if status != 200 {
        return Err(format!("me HTTP {status}: {}", String::from_utf8_lossy(&bytes)));
    }
    let me: Value = serde_json::from_slice(&bytes).map_err(|e| format!("me json: {e}"))?;
    eprintln!("[2] OK — /me as {:?}", me.get("username"));

    // Layer 3 — join the channel (idempotent; channel pre-seeded by the harness script).
    let (status, bytes) = http(
        &cfg,
        &tor,
        "POST",
        &format!("/telegraph/api/channels/{}/join/", cfg.channel),
        Some(&token),
        b"{}".to_vec(),
    )
    .await?;
    if status != 200 {
        return Err(format!("join HTTP {status}: {}", String::from_utf8_lossy(&bytes)));
    }
    eprintln!("[3] OK — joined channel {:?}", cfg.channel);

    // Layer 4 — two WS clients in the room; A → B chat.
    let mut client_b = ws_connect(&cfg, &tor, &token).await?;
    let mut client_a = ws_connect(&cfg, &tor, &token).await?;
    eprintln!("[4] OK — two WebSocket clients connected to {:?}", cfg.channel);

    let nonce = format!("e2e-{}", uuid::Uuid::new_v4().simple());
    let chat = serde_json::json!({ "type": "chat_message", "message": nonce });
    client_a
        .send(WsMessage::Text(chat.to_string().into()))
        .await
        .map_err(|e| format!("send chat: {e}"))?;
    recv_matching(&mut client_b, &nonce, 20).await?;
    eprintln!("[4] OK — client B received client A's chat message");

    // Layer 5 — send an image inline (base64) A → B.
    let img = tiny_png_data_url();
    let image_msg = serde_json::json!({ "type": "image_message", "image_data": img });
    client_a
        .send(WsMessage::Text(image_msg.to_string().into()))
        .await
        .map_err(|e| format!("send image: {e}"))?;
    recv_matching(&mut client_b, "data:image/png", 20).await?;
    eprintln!("[5] OK — client B received the image from client A");

    eprintln!("=== E2E row PASSED: {label} ===\n");
    let _ = tor; // keep alive
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn onion_full_flow() {
    let Some(cfg) = Cfg::from_env() else {
        eprintln!("ENIGMA_E2E != 1 — skipping onion e2e harness");
        return;
    };
    run(cfg).await.expect("onion e2e flow failed");
}
