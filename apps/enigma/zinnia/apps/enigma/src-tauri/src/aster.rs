// Aster — automatic Tor signalling for iroh.
//
// Instead of pasting a fresh ticket for every call/room, each iroh endpoint gets a
// *stable* NodeId (we persist its secret key) and publishes its current relay URL to
// the faros "aster" directory over Tor. To reach a peer we just resolve their NodeId
// → relay URL from the same directory. The address exchange rides Tor; only the relay
// URL is ever published (never a direct IP), so the server and peer never learn it.
//
//   - `TotoLookup`  : an iroh `AddressLookup` whose `resolve` does GET /aster/addr/<id>.
//   - `spawn_publisher` : a background task that registers the device and POSTs the
//                         endpoint's relay URL on a refresh interval.
//   - `load_or_create_secret` : a per-endpoint stable secret key (→ stable NodeId).
//
// All HTTP rides the same transport data.rs uses: the embedded Tor client for .onion
// servers (bearer-token auth), plain reqwest otherwise. Aster lives on faros only, so
// against a non-aster server the requests 404 and the caller falls back to tickets.

use std::time::Duration;

use iroh::address_lookup::{AddressLookup, EndpointInfo, Error as LookupError, Item};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey, TransportAddr};
use n0_future::boxed::BoxStream;
use serde::Deserialize;
use tauri::{AppHandle, Manager};

use crate::tor::{self, TorState};
use crate::{active_config, load_profile_state, AppConfigState};

pub const KIND_GOSSIP: &str = "gossip";
pub const KIND_VOX: &str = "vox";

const PROVENANCE: &str = "aster";
/// Republish cadence — roughly half the server TTL (default 300 s) so an address
/// never lapses between refreshes.
const REFRESH_SECS: u64 = 150;
/// While the home relay isn't known yet, retry quickly so the first publish is prompt.
const WARMUP_SECS: u64 = 3;

// ── stable identity ──────────────────────────────────────────────────────────

fn secret_path(app: &AppHandle, name: &str) -> std::path::PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    base.join(format!("iroh_{name}.key"))
}

/// Load this endpoint's persisted secret key, or generate + persist a new one. A
/// stable secret means a stable NodeId, which is what makes it a durable contact handle.
pub fn load_or_create_secret(app: &AppHandle, name: &str) -> SecretKey {
    let path = secret_path(app, name);
    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() == 32 {
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&bytes);
            return SecretKey::from_bytes(&arr);
        }
    }
    let sk = SecretKey::generate();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, sk.to_bytes());
    sk
}

// ── HTTP to the aster directory (over Tor for .onion, reqwest otherwise) ───────

async fn aster_request(
    app: &AppHandle,
    method: &str,
    path: &str,
    body: Option<Vec<u8>>,
) -> Result<(u16, Vec<u8>), String> {
    let config = app.state::<AppConfigState>();
    let cfg = active_config(&config)?;
    let profile = load_profile_state(app, &cfg);
    let base = profile.server_url.trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("no server configured".into());
    }

    let mut headers: Vec<(String, String)> = vec![(
        "X-Requested-With".to_string(),
        "XMLHttpRequest".to_string(),
    )];
    if body.is_some() {
        headers.push(("Content-Type".to_string(), "application/json".to_string()));
    }
    if let Some(token) = &profile.auth_token {
        headers.push(("Authorization".to_string(), format!("Bearer {token}")));
    }
    let body_bytes = body.unwrap_or_default();

    if profile.server_is_onion {
        let (host, port) = tor::host_port(&base)?;
        let tls = base.starts_with("https");
        let tor_state = app.state::<TorState>();
        tor_state
            .http_request(&host, port, tls, method, path, &headers, body_bytes)
            .await
    } else {
        let url = format!("{base}{path}");
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let client = reqwest::Client::new();
        let mut req = client.request(m, url);
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        if !body_bytes.is_empty() {
            req = req.body(body_bytes);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        Ok((status, bytes))
    }
}

fn ok_status(status: u16) -> bool {
    (200..300).contains(&status)
}

/// Register (or refresh) this device's NodeId for the logged-in user.
pub async fn register_device(app: &AppHandle, node_id: &str, kind: &str) -> Result<(), String> {
    let body = serde_json::json!({ "node_id": node_id, "kind": kind })
        .to_string()
        .into_bytes();
    let (status, _) = aster_request(app, "POST", "/aster/device", Some(body)).await?;
    if ok_status(status) {
        Ok(())
    } else {
        Err(format!("aster device register failed: {status}"))
    }
}

/// Publish this device's current relay URL (relay-only — never a direct address).
pub async fn publish_addr(app: &AppHandle, node_id: &str, relay_url: &str) -> Result<(), String> {
    let body = serde_json::json!({ "node_id": node_id, "relay_url": relay_url })
        .to_string()
        .into_bytes();
    let (status, _) = aster_request(app, "POST", "/aster/addr", Some(body)).await?;
    if ok_status(status) {
        Ok(())
    } else {
        Err(format!("aster addr publish failed: {status}"))
    }
}

/// Resolve a contact's NodeId(s) for a given iroh service ("vox" / "gossip").
pub async fn resolve_user_nodes(
    app: &AppHandle,
    username: &str,
    kind: &str,
) -> Result<Vec<String>, String> {
    let path = format!(
        "/aster/resolve?user={}&kind={}",
        encode_component(username),
        encode_component(kind),
    );
    let (status, body) = aster_request(app, "GET", &path, None).await?;
    if !ok_status(status) {
        return Err(format!("aster resolve failed: {status}"));
    }
    #[derive(Deserialize)]
    struct Resp {
        node_ids: Vec<String>,
    }
    let resp: Resp = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
    Ok(resp.node_ids)
}

/// Frontend command: resolve a contact's NodeId(s) for a service kind ("vox"/"gossip").
#[tauri::command]
pub async fn aster_resolve(
    app: AppHandle,
    username: String,
    kind: String,
) -> Result<Vec<String>, String> {
    resolve_user_nodes(&app, &username, &kind).await
}

/// Minimal percent-encoding for a query value (usernames/kinds are simple, but be safe).
fn encode_component(s: &str) -> String {
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

// ── background relay publisher ─────────────────────────────────────────────────

/// Register the endpoint's NodeId with the directory and keep its relay URL fresh.
/// Errors are swallowed (no server / not logged in / non-aster server) — the app
/// keeps working with the manual ticket path.
pub fn spawn_publisher(app: AppHandle, endpoint: Endpoint, node_id: String, kind: &'static str) {
    tauri::async_runtime::spawn(async move {
        let _ = register_device(&app, &node_id, kind).await;
        loop {
            match endpoint.addr().relay_urls().next().cloned() {
                Some(relay) => {
                    let _ = publish_addr(&app, &node_id, &relay.to_string()).await;
                    tokio::time::sleep(Duration::from_secs(REFRESH_SECS)).await;
                }
                // Home relay not established yet — retry soon so the first publish is prompt.
                None => tokio::time::sleep(Duration::from_secs(WARMUP_SECS)).await,
            }
        }
    });
}

// ── iroh AddressLookup: resolve NodeId → relay URL via the directory ───────────

#[derive(Clone)]
pub struct TotoLookup {
    app: AppHandle,
}

impl TotoLookup {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl std::fmt::Debug for TotoLookup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TotoLookup")
    }
}

fn lookup_err(msg: impl Into<String>) -> LookupError {
    LookupError::from_err_any(PROVENANCE, std::io::Error::other(msg.into()))
}

impl AddressLookup for TotoLookup {
    fn resolve(&self, endpoint_id: EndpointId) -> Option<BoxStream<Result<Item, LookupError>>> {
        let app = self.app.clone();
        let fut = async move {
            let path = format!("/aster/addr/{endpoint_id}");
            let (status, body) = aster_request(&app, "GET", &path, None)
                .await
                .map_err(lookup_err)?;
            if !ok_status(status) {
                return Err(lookup_err(format!("no fresh address (status {status})")));
            }
            #[derive(Deserialize)]
            struct Resp {
                relay_url: String,
            }
            let resp: Resp = serde_json::from_slice(&body).map_err(|e| lookup_err(e.to_string()))?;
            let relay: RelayUrl = resp
                .relay_url
                .parse()
                .map_err(|_| lookup_err("invalid relay url"))?;
            // Relay-only EndpointAddr — no direct socket addresses, ever.
            let addr = EndpointAddr::from_parts(endpoint_id, [TransportAddr::Relay(relay)]);
            Ok(Item::new(EndpointInfo::from(addr), PROVENANCE, None))
        };
        Some(Box::pin(n0_future::stream::once_future(fut)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_component_escapes_query_unsafe_bytes() {
        assert_eq!(encode_component("alice"), "alice");
        assert_eq!(encode_component("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(encode_component("user.name-1_2~"), "user.name-1_2~");
    }

    #[test]
    fn ok_status_range() {
        assert!(ok_status(200));
        assert!(ok_status(299));
        assert!(!ok_status(404));
        assert!(!ok_status(500));
    }
}
