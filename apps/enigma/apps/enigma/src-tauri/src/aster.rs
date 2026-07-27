//! Aster — cloud rendezvous (RDV v1): the user's OWN faros server as an
//! optional peer directory.
//!
//! Each profile's stable gossip NodeId can be published (opt-in, default off)
//! to the faros "aster" directory together with its current iroh relay URL —
//! **relay-only, never a direct IP**, the same datum the DHT toggle already
//! publishes to a public DHT, sent to the user's own server instead. Peers on
//! the same server resolve each other by NodeId (a stacked iroh
//! `AddressLookup`, racing the ticket/DHT paths) or by faros username (the
//! `aster_resolve` command feeding the existing contacts/invite flow).
//!
//! OPTIONAL by contract: no server URL, logged out, toggle off, offline, or a
//! non-aster server ⇒ every path degrades silently to the manual ticket flow.
//! All HTTP rides cloud.rs (`request_json`): bearer session from `cloud:auth`,
//! `.onion` servers via the embedded Tor client, 401 clears the shared session.

use std::time::Duration;

use iroh::address_lookup::{AddressLookup, EndpointInfo, Error as LookupError, Item};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, TransportAddr};
use n0_future::boxed::BoxStream;
use serde_json::{json, Value};
use tauri::AppHandle;

pub const KIND_GOSSIP: &str = "gossip";

const PROVENANCE: &str = "aster";
/// Republish cadence — roughly half the server TTL (default 300 s) so an
/// address never lapses between refreshes.
const REFRESH_SECS: u64 = 150;
/// While the home relay isn't known yet, retry quickly so the first publish is
/// prompt; also the poll cadence while the toggle is off (no network then).
const WARMUP_SECS: u64 = 3;
/// Cadence for re-checking an off toggle / missing server — cheap local reads.
const IDLE_SECS: u64 = 30;

/// Returned by `aster_resolve` in a build without cloud or without relays.
pub(crate) const ASTER_DISABLED: &str = "Cloud rendezvous is disabled in this build.";

// ── gates ─────────────────────────────────────────────────────────────────────

/// Build-time half of the gate: rendezvous needs the cloud client (login,
/// transport) AND hosted relays (without them there is no relay URL to
/// publish). Mirrors beacon's two-flag AND.
pub(crate) fn build_allowed() -> bool {
    crate::build_config::cloud::ALLOW_CONNECTIONS
        && crate::build_config::p2p::ALLOW_HOSTED_RELAYS
}

/// The user's opt-in toggle (kv `p2p:settings`, beside the DHT toggles).
/// Default OFF — publishing to the server is a deliberate choice. Also requires
/// the Cloud tab's runtime master switch: with cloud off, both the publisher
/// loop and the aster address lookup must generate zero server traffic.
pub(crate) fn rdv_enabled(app: &AppHandle) -> bool {
    if !build_allowed() || !crate::cloud::runtime_enabled(app) {
        return false;
    }
    matches!(
        crate::vault::kv_get_raw(app, "p2p:settings", "default", "rdv_publish").as_deref(),
        Some("on")
    )
}

/// The configured Enigma Cloud server URL (frontend-managed kv). `None` when
/// no server was ever configured — rendezvous then never touches the network.
fn server_url(app: &AppHandle) -> Option<String> {
    crate::vault::kv_get_raw(app, "cloud:settings", "default", "server_url")
        .map(|u| u.trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
}

fn ok_status(status: u16) -> bool {
    (200..300).contains(&status)
}

/// Minimal percent-encoding for a query value.
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

// ── directory calls (cloud.rs transport + session) ────────────────────────────

/// Register (or refresh) this device's NodeId for the logged-in user.
async fn register_device(
    app: &AppHandle,
    server: &str,
    node_id: &str,
) -> Result<(), String> {
    let body = json!({ "node_id": node_id, "kind": KIND_GOSSIP });
    let (status, _) =
        crate::cloud::request_json(app, server, "POST", "/aster/device", true, Some(body)).await?;
    if ok_status(status) {
        Ok(())
    } else {
        Err(format!("aster device register failed: {status}"))
    }
}

/// Publish this device's current relay URL (relay-only — never a direct address).
async fn publish_addr(
    app: &AppHandle,
    server: &str,
    node_id: &str,
    relay_url: &str,
) -> Result<(), String> {
    let body = json!({ "node_id": node_id, "relay_url": relay_url });
    let (status, _) =
        crate::cloud::request_json(app, server, "POST", "/aster/addr", true, Some(body)).await?;
    if ok_status(status) {
        Ok(())
    } else {
        Err(format!("aster addr publish failed: {status}"))
    }
}

fn parse_node_ids(body: &Value) -> Vec<String> {
    body.get("node_ids")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Resolve a username's registered NodeIds on the given server. Explicit user
/// action (the contacts flow), so it is gated only by the build flags and the
/// cloud session — not the publish toggle.
#[tauri::command]
pub async fn aster_resolve(
    app: AppHandle,
    server_url: String,
    username: String,
) -> Result<Vec<String>, String> {
    if !build_allowed() {
        return Err(ASTER_DISABLED.to_string());
    }
    crate::cloud::ensure_cloud_ready(&app)?;
    let path = format!(
        "/aster/resolve?user={}&kind={}",
        encode_component(&username),
        encode_component(KIND_GOSSIP),
    );
    let (status, body) =
        crate::cloud::request_json(&app, &server_url, "GET", &path, true, None).await?;
    crate::cloud::expect_2xx(status, &body)?;
    Ok(parse_node_ids(&body))
}

// ── sealed room invites (the QR replacement for Tor rooms) ───────────────────

/// Our stable gossip identity — the key invites are sealed to/from. Derived
/// from the vault, so it exists even in Tor-exclusive mode where iroh is down.
fn identity(app: &AppHandle) -> Result<iroh::SecretKey, String> {
    crate::p2p_iroh::load_or_create_secret(app, KIND_GOSSIP).map_err(|e| e.to_string())
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Make sure this device is addressable in the directory. Registration needs
/// only the NodeId, so unlike relay publishing it works with iroh torn down
/// (Tor-exclusive mode) — which is exactly when server invites matter most.
#[tauri::command]
pub async fn rdv_register(app: AppHandle, server_url: String) -> Result<String, String> {
    if !build_allowed() {
        return Err(ASTER_DISABLED.to_string());
    }
    crate::cloud::ensure_cloud_ready(&app)?;
    let node_id = identity(&app)?.public().to_string();
    register_device(&app, &server_url, &node_id).await?;
    Ok(node_id)
}

/// Seal a room ticket to `to_node_id` and leave it in the recipient's mailbox.
/// The server stores ciphertext: brokering an invite never grants it the room.
#[tauri::command]
pub async fn rdv_invite_send(
    app: AppHandle,
    server_url: String,
    to_node_id: String,
    room_name: String,
    ticket: String,
    ttl_seconds: Option<u64>,
) -> Result<(), String> {
    if !build_allowed() {
        return Err(ASTER_DISABLED.to_string());
    }
    crate::cloud::ensure_cloud_ready(&app)?;
    let me = identity(&app)?;
    let recipient: iroh::PublicKey = to_node_id
        .parse()
        .map_err(|_| "invalid recipient node id".to_string())?;
    let ttl = ttl_seconds.unwrap_or(24 * 3600).clamp(60, 7 * 24 * 3600);
    let payload = crate::invite_seal::InvitePayload {
        v: 1,
        room_name,
        ticket,
    };
    let blob = crate::invite_seal::seal_invite(&me, &recipient, &payload, now_unix() + ttl)
        .map_err(|e| e.to_string())?;

    let body = json!({ "to_node_id": to_node_id, "blob": blob, "ttl_seconds": ttl });
    let (status, resp) =
        crate::cloud::request_json(&app, &server_url, "POST", "/aster/invite", true, Some(body))
            .await?;
    crate::cloud::expect_2xx(status, &resp)
}

/// One collected invite, already verified and decrypted locally.
#[derive(serde::Serialize)]
pub struct OpenInvite {
    pub id: i64,
    pub from_node_id: String,
    pub room_name: String,
    pub ticket: String,
    pub expires_at: u64,
}

/// Collect invites for this device. Anything that fails to verify or decrypt
/// is dropped silently — a mailbox entry is untrusted input.
#[tauri::command]
pub async fn rdv_invite_fetch(
    app: AppHandle,
    server_url: String,
) -> Result<Vec<OpenInvite>, String> {
    if !build_allowed() {
        return Err(ASTER_DISABLED.to_string());
    }
    crate::cloud::ensure_cloud_ready(&app)?;
    let me = identity(&app)?;
    let (status, body) =
        crate::cloud::request_json(&app, &server_url, "GET", "/aster/invites", true, None).await?;
    crate::cloud::expect_2xx(status, &body)?;

    let now = now_unix();
    let mut out = Vec::new();
    for item in body.get("invites").and_then(Value::as_array).cloned().unwrap_or_default() {
        let (Some(id), Some(blob)) = (
            item.get("id").and_then(Value::as_i64),
            item.get("blob").and_then(Value::as_str),
        ) else {
            continue;
        };
        match crate::invite_seal::open_invite(&me, blob, now) {
            Ok(opened) => out.push(OpenInvite {
                id,
                from_node_id: opened.from.to_string(),
                room_name: opened.payload.room_name,
                ticket: opened.payload.ticket,
                expires_at: opened.exp,
            }),
            Err(_) => continue,
        }
    }
    Ok(out)
}

/// Acknowledge a collected invite (one-shot: the server drops the row).
#[tauri::command]
pub async fn rdv_invite_ack(app: AppHandle, server_url: String, id: i64) -> Result<(), String> {
    if !build_allowed() {
        return Err(ASTER_DISABLED.to_string());
    }
    crate::cloud::ensure_cloud_ready(&app)?;
    let path = format!("/aster/invite/{id}/delete");
    let (status, resp) =
        crate::cloud::request_json(&app, &server_url, "POST", &path, true, None).await?;
    crate::cloud::expect_2xx(status, &resp)
}

// ── background relay publisher ────────────────────────────────────────────────

/// Keep the directory fresh while (and only while) the opt-in toggle is on.
/// The loop self-gates every round, so the Settings switch takes effect live
/// in both directions and an off toggle produces zero network traffic. Every
/// error is swallowed — the manual ticket path is always the fallback.
pub fn spawn_publisher(
    app: AppHandle,
    endpoint: Endpoint,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let node_id = endpoint.id().to_string();
        let mut registered = false;
        loop {
            if !rdv_enabled(&app) || crate::cloud::ensure_online(&app).is_err() {
                registered = false;
                tokio::time::sleep(Duration::from_secs(IDLE_SECS)).await;
                continue;
            }
            let Some(server) = server_url(&app) else {
                tokio::time::sleep(Duration::from_secs(IDLE_SECS)).await;
                continue;
            };
            if !registered {
                registered = register_device(&app, &server, &node_id).await.is_ok();
                if !registered {
                    // No login yet / not an aster server — back off quietly.
                    tokio::time::sleep(Duration::from_secs(REFRESH_SECS)).await;
                    continue;
                }
            }
            match endpoint.addr().relay_urls().next().cloned() {
                Some(relay) => {
                    let _ = publish_addr(&app, &server, &node_id, relay.as_str()).await;
                    tokio::time::sleep(Duration::from_secs(REFRESH_SECS)).await;
                }
                // Home relay not established yet — retry soon so the first
                // publish is prompt. Never publish direct addresses instead.
                None => tokio::time::sleep(Duration::from_secs(WARMUP_SECS)).await,
            }
        }
    })
}

// ── iroh AddressLookup: NodeId → relay URL via the directory ──────────────────

/// Stacked on the main endpoint beside MemoryLookup/DhtAddressLookup; races
/// them in parallel. Self-gates on the toggle, so it is inert (returns no
/// stream) unless the user opted in — a dial then simply relies on the other
/// lookup paths, exactly as today.
#[derive(Clone)]
pub struct AsterLookup {
    app: AppHandle,
}

impl AsterLookup {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl std::fmt::Debug for AsterLookup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AsterLookup")
    }
}

fn lookup_err(msg: impl Into<String>) -> LookupError {
    LookupError::from_err_any(PROVENANCE, std::io::Error::other(msg.into()))
}

fn relay_only_addr(endpoint_id: EndpointId, relay_url: &str) -> Result<EndpointAddr, String> {
    let relay: RelayUrl = relay_url.parse().map_err(|_| "invalid relay url".to_string())?;
    // Relay-only EndpointAddr — no direct socket addresses, ever.
    Ok(EndpointAddr::from_parts(endpoint_id, [TransportAddr::Relay(relay)]))
}

impl AddressLookup for AsterLookup {
    fn resolve(&self, endpoint_id: EndpointId) -> Option<BoxStream<Result<Item, LookupError>>> {
        if !rdv_enabled(&self.app) || crate::cloud::ensure_online(&self.app).is_err() {
            return None;
        }
        let server = server_url(&self.app)?;
        let app = self.app.clone();
        let fut = async move {
            let path = format!("/aster/addr/{endpoint_id}");
            let (status, body) = crate::cloud::request_json(&app, &server, "GET", &path, true, None)
                .await
                .map_err(lookup_err)?;
            if !ok_status(status) {
                return Err(lookup_err(format!("no fresh address (status {status})")));
            }
            let relay_url = body
                .get("relay_url")
                .and_then(Value::as_str)
                .ok_or_else(|| lookup_err("malformed aster response"))?;
            let addr = relay_only_addr(endpoint_id, relay_url).map_err(lookup_err)?;
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

    #[test]
    fn parses_node_ids_defensively() {
        assert_eq!(
            parse_node_ids(&json!({ "node_ids": ["a", "b", 3] })),
            vec!["a".to_string(), "b".to_string()],
        );
        assert!(parse_node_ids(&json!({})).is_empty());
        assert!(parse_node_ids(&json!({ "node_ids": "x" })).is_empty());
    }

    #[test]
    fn relay_only_addr_never_carries_ips() {
        let id = iroh::SecretKey::generate().public();
        let addr = relay_only_addr(id, "https://relay.example/").unwrap();
        assert!(addr
            .addrs
            .iter()
            .all(|a| matches!(a, TransportAddr::Relay(_))));
        assert!(relay_only_addr(id, "not a url").is_err());
    }
}
