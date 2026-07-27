//! Aster — the user's OWN faros server as an optional NAME and MAILBOX
//! directory (rdv.md).
//!
//! Two things, both address-free: register this device's stable gossip NodeId
//! so peers can address it, and resolve a faros username to the NodeIds behind
//! it — then exchange HPKE-sealed room invites through a server mailbox
//! (`invite_seal.rs`; the server only ever holds ciphertext). **No address is
//! published and none is looked up**: the relay publisher and the stacked iroh
//! `AddressLookup` were withdrawn on 2026-07-27, so the server never learns
//! where this device can be reached, and nothing here runs on a timer.
//!
//! OPTIONAL by contract: no server URL, logged out, cloud switched off,
//! offline, or a non-aster server ⇒ every path degrades silently to the manual
//! ticket flow. All HTTP rides cloud.rs (`request_json`): bearer session from
//! `cloud:auth`, `.onion` servers via the embedded Tor client, 401 clears the
//! shared session.

use serde_json::{json, Value};
use tauri::AppHandle;

pub const KIND_GOSSIP: &str = "gossip";

/// faros caps a sealed blob at 8192 CHARS (413 past that). Checked before the
/// POST so an oversized ticket is explained instead of shown as an HTTP code.
const MAX_BLOB_CHARS: usize = 8192;
/// faros clamps an invite TTL to 24 h server-side, so that is what we send —
/// a longer envelope `exp` would outlive the row and misreport the expiry.
const DEFAULT_TTL_SECS: u64 = 24 * 3600;
const BLOB_TOO_BIG: &str =
    "this room's ticket is too large to leave on the server — share the QR instead";

/// Returned by every aster command in a build without the cloud client.
pub(crate) const ASTER_DISABLED: &str = "Cloud rendezvous is disabled in this build.";

// ── gates ─────────────────────────────────────────────────────────────────────

/// Build-time gate: the directory needs the cloud client (login, transport).
/// `p2p.allow_hosted_relays` is deliberately NOT part of it — that flag governs
/// THIRD-PARTY infrastructure, while everything left here talks to the user's
/// own server and never touches an address. (It was in the AND only because a
/// relay URL was what got published; withdrawn 2026-07-27 with the publisher.)
pub(crate) fn build_allowed() -> bool {
    crate::build_config::cloud::ALLOW_CONNECTIONS
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

/// Resolve a faros username to the gossip NodeIds registered behind it.
/// Shared by the `aster_resolve` command and the invite fan-out — an empty vec
/// means "no such user, or they never registered a device" (faros answers both
/// with 200 + an empty list, deliberately).
async fn resolve_user(
    app: &AppHandle,
    server_url: &str,
    username: &str,
) -> Result<Vec<String>, String> {
    let path = format!(
        "/aster/resolve?user={}&kind={}",
        encode_component(username),
        encode_component(KIND_GOSSIP),
    );
    let (status, body) =
        crate::cloud::request_json(app, server_url, "GET", &path, true, None).await?;
    crate::cloud::expect_2xx(status, &body)?;
    Ok(parse_node_ids(&body))
}

/// Resolve a username's registered NodeIds on the given server. Explicit user
/// action (the contacts flow), gated by the build flag and the cloud session.
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
    resolve_user(&app, &server_url, &username).await
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

/// Why one mailbox drop failed. `Quota` is separated because faros returns 429
/// for the per-SENDER cap (50 unacknowledged invites to anyone), which poisons
/// the rest of a fan-out — the caller stops instead of hammering the server.
enum PostErr {
    Quota(String),
    Other(String),
}

/// Seal `payload` to ONE device and leave it in that device's mailbox — the
/// single definition of what goes on the wire, shared by the one-shot command
/// and the fan-out.
async fn post_sealed(
    app: &AppHandle,
    server_url: &str,
    me: &iroh::SecretKey,
    to_node_id: &str,
    payload: &crate::invite_seal::InvitePayload,
    exp: u64,
    ttl: u64,
) -> Result<(), PostErr> {
    let recipient: iroh::PublicKey = to_node_id
        .parse()
        .map_err(|_| PostErr::Other("invalid recipient node id".to_string()))?;
    let blob = crate::invite_seal::seal_invite(me, &recipient, payload, exp)
        .map_err(|e| PostErr::Other(e.to_string()))?;
    // Explain an oversized ticket here rather than letting faros answer 413.
    if blob.chars().count() > MAX_BLOB_CHARS {
        return Err(PostErr::Other(BLOB_TOO_BIG.to_string()));
    }
    let body = json!({ "to_node_id": to_node_id, "blob": blob, "ttl_seconds": ttl });
    let (status, resp) =
        crate::cloud::request_json(app, server_url, "POST", "/aster/invite", true, Some(body))
            .await
            .map_err(PostErr::Other)?;
    if ok_status(status) {
        Ok(())
    } else if status == 429 {
        Err(PostErr::Quota(crate::cloud::status_err(status, &resp)))
    } else {
        Err(PostErr::Other(crate::cloud::status_err(status, &resp)))
    }
}

/// Seal a room ticket to `to_node_id` and leave it in the recipient's mailbox.
/// The server stores ciphertext: brokering an invite never grants it the room.
/// This is the NodeId-addressed path — the recipient's key was verified
/// out-of-band, so unlike the username fan-out it does not trust the directory.
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
    let ttl = ttl_seconds
        .unwrap_or(DEFAULT_TTL_SECS)
        .clamp(60, 7 * 24 * 3600);
    let payload = crate::invite_seal::InvitePayload {
        v: 1,
        room_name,
        ticket,
    };
    post_sealed(&app, &server_url, &me, &to_node_id, &payload, now_unix() + ttl, ttl)
        .await
        .map_err(|e| match e {
            PostErr::Quota(m) | PostErr::Other(m) => m,
        })
}

// ── invite fan-out: pick faros usernames, seal one copy per device ───────────

/// What happened for one picked username. The UI owns every word the user
/// sees; this is only the machine-readable outcome.
#[derive(serde::Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum InviteOutcome {
    /// Every device of that user got a sealed copy.
    Ok,
    /// At least one device got one and at least one did not.
    Partial,
    /// The directory returned nothing: no such user on this server, or they
    /// have never opened Enigma with Cloud on.
    Unknown,
    /// The only device behind that username is this one.
    SelfOnly,
    /// The server refused on quota (429) — its mailbox budget is full.
    Quota,
    /// Not attempted: an earlier 429 stopped the fan-out.
    Skipped,
    /// Anything else (unknown device, oversized blob, transport, 5xx).
    Error,
}

#[derive(serde::Serialize)]
pub struct InviteReport {
    pub username: String,
    pub outcome: InviteOutcome,
    /// Devices we tried, i.e. resolved NodeIds minus our own.
    pub devices: u32,
    pub delivered: u32,
    /// Server/transport detail, empty when there is none.
    pub error: String,
}

/// Trim, drop empties and fold case-insensitive duplicates, keeping the order
/// the user typed. Pure — unit-tested.
fn dedup_usernames(raw: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    for name in raw {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(trimmed.to_string());
    }
    out
}

/// Delivery counts → outcome. Pure, so the fan-out's decision table is testable
/// without a server.
fn classify(delivered: u32, targets: u32, stopped: bool) -> InviteOutcome {
    if delivered == 0 && stopped {
        InviteOutcome::Quota
    } else if delivered == targets {
        InviteOutcome::Ok
    } else if delivered > 0 {
        InviteOutcome::Partial
    } else {
        InviteOutcome::Error
    }
}

fn report(
    username: String,
    outcome: InviteOutcome,
    devices: u32,
    delivered: u32,
    error: String,
) -> InviteReport {
    InviteReport { username, outcome, devices, delivered, error }
}

/// Leave one sealed copy of `ticket` in the mailbox of every device of every
/// picked faros username. Always returns a per-username report — only
/// preconditions (build gate, cloud off/offline, empty list, empty ticket)
/// fail the whole call.
///
/// The payload is built ONCE and borrowed by every seal: HPKE mints a fresh
/// ephemeral per call, so resealing it N times is safe, and the AAD binds
/// recipient‖sender‖expiry so a blob cannot be replayed at another recipient.
///
/// Sends are SEQUENTIAL and stop at the first 429: faros counts 50 pending
/// invites per sender across every recipient, so continuing after the cap is
/// hit would be N pointless round trips (over Tor, serially), and concurrent
/// posts would race that cap into a nondeterministic partial state.
#[tauri::command]
pub async fn rdv_invite_broadcast(
    app: AppHandle,
    server_url: String,
    usernames: Vec<String>,
    room_name: String,
    ticket: String,
    ttl_seconds: Option<u64>,
) -> Result<Vec<InviteReport>, String> {
    if !build_allowed() {
        return Err(ASTER_DISABLED.to_string());
    }
    crate::cloud::ensure_cloud_ready(&app)?;
    let names = dedup_usernames(&usernames);
    if names.is_empty() {
        return Err("pick at least one person to invite".to_string());
    }
    if ticket.trim().is_empty() {
        return Err("this room has no shareable ticket yet".to_string());
    }

    let me = identity(&app)?;
    let my_id = me.public().to_string();
    let ttl = ttl_seconds
        .unwrap_or(DEFAULT_TTL_SECS)
        .clamp(60, 7 * 24 * 3600);
    let exp = now_unix() + ttl;
    let payload = crate::invite_seal::InvitePayload { v: 1, room_name, ticket };

    let mut out = Vec::with_capacity(names.len());
    let mut stopped = false;
    for username in names {
        if stopped {
            out.push(report(username, InviteOutcome::Skipped, 0, 0, String::new()));
            continue;
        }
        let ids = match resolve_user(&app, &server_url, &username).await {
            Ok(ids) => ids,
            Err(e) => {
                out.push(report(username, InviteOutcome::Error, 0, 0, e));
                continue;
            }
        };
        if ids.is_empty() {
            out.push(report(username, InviteOutcome::Unknown, 0, 0, String::new()));
            continue;
        }
        // Our own device is already in the room; sealing to it is pure noise.
        let targets: Vec<&String> = ids.iter().filter(|id| *id != &my_id).collect();
        if targets.is_empty() {
            out.push(report(username, InviteOutcome::SelfOnly, 0, 0, String::new()));
            continue;
        }

        let (mut delivered, mut last_err) = (0u32, String::new());
        for id in &targets {
            match post_sealed(&app, &server_url, &me, id, &payload, exp, ttl).await {
                Ok(()) => delivered += 1,
                Err(PostErr::Quota(m)) => {
                    stopped = true;
                    last_err = m;
                    break;
                }
                Err(PostErr::Other(m)) => last_err = m,
            }
        }
        let outcome = classify(delivered, targets.len() as u32, stopped);
        out.push(report(username, outcome, targets.len() as u32, delivered, last_err));
    }
    Ok(out)
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
    fn dedup_usernames_trims_drops_empties_and_folds_case() {
        let raw = ["Alice", " alice ", "", "   ", "bob", "BOB", "carol"]
            .map(str::to_string)
            .to_vec();
        // First spelling wins and the typed order survives.
        assert_eq!(dedup_usernames(&raw), vec!["Alice", "bob", "carol"]);
        assert!(dedup_usernames(&[]).is_empty());
        assert!(dedup_usernames(&["  ".to_string()]).is_empty());
    }

    #[test]
    fn classify_covers_every_delivery_shape() {
        assert_eq!(classify(2, 2, false), InviteOutcome::Ok);
        assert_eq!(classify(1, 2, false), InviteOutcome::Partial);
        assert_eq!(classify(0, 2, false), InviteOutcome::Error);
        // A 429 with nothing delivered is quota, not a generic error…
        assert_eq!(classify(0, 2, true), InviteOutcome::Quota);
        // …but a partial delivery that then hit the cap still reads as partial.
        assert_eq!(classify(1, 2, true), InviteOutcome::Partial);
        assert_eq!(classify(2, 2, true), InviteOutcome::Ok);
    }

    #[test]
    fn default_ttl_matches_the_servers_own_maximum() {
        // faros clamps to 24 h; sending more would make the UI misreport expiry.
        assert_eq!(DEFAULT_TTL_SECS, 24 * 3600);
        let clamp = |t: Option<u64>| t.unwrap_or(DEFAULT_TTL_SECS).clamp(60, 7 * 24 * 3600);
        assert_eq!(clamp(None), 86_400);
        assert_eq!(clamp(Some(1)), 60);
        assert_eq!(clamp(Some(u64::MAX)), 7 * 24 * 3600);
    }

    #[test]
    fn a_realistic_ticket_seals_well_under_the_server_blob_cap() {
        let me = iroh::SecretKey::generate();
        let them = iroh::SecretKey::generate();
        let payload = crate::invite_seal::InvitePayload {
            v: 1,
            room_name: "planning".to_string(),
            ticket: "t".repeat(300), // a Tor ticket is far shorter than this
        };
        let blob =
            crate::invite_seal::seal_invite(&me, &them.public(), &payload, now_unix() + 3600)
                .expect("seal");
        assert!(blob.chars().count() < MAX_BLOB_CHARS, "blob {}", blob.chars().count());
    }

    #[test]
    fn report_serializes_snake_case_for_the_frontend_union() {
        let value = serde_json::to_value(report(
            "alice".to_string(),
            InviteOutcome::SelfOnly,
            0,
            0,
            String::new(),
        ))
        .expect("serialize");
        assert_eq!(value["outcome"], json!("self_only"));
        assert_eq!(value["username"], json!("alice"));
        assert_eq!(value["devices"], json!(0));
    }
}
