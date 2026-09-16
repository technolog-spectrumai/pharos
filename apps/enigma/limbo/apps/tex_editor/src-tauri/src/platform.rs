//! The five commands that reach the server.
//!
//! SHIMS AND NOTHING ELSE. Every line of behaviour is in the `totoclient`
//! crate — the pinned-certificate verifier, the OS keyring, the path
//! allowlist. This file exists because the crate deliberately takes no `tauri`
//! dependency (the rule `substrate` states in its own manifest), so each app
//! names its own commands and the frontend's invoke strings stay the app's.
//!
//! **Nothing here returns the token.** `connect` takes one and stores it;
//! `request` attaches it; no command hands it back. That is the whole reason
//! these calls go through Rust rather than the webview — see the crate header
//! for the other reason, which is that the app's CSP blocks an outbound
//! `fetch` before it reaches the network.
use totoclient::{ApiReply, Probe, SessionInfo};

/// Look at a server without committing anything to it — is it there, and is
/// its certificate trusted? Runs before the token field is worth showing.
#[tauri::command]
pub async fn platform_probe(server_url: String) -> Result<Probe, String> {
    totoclient::probe(server_url).await
}

/// Verify a pasted capsule token and remember it in the OS secret store.
#[tauri::command]
pub async fn platform_connect(
    server_url: String,
    token: String,
    fingerprint: Option<String>,
) -> Result<SessionInfo, String> {
    totoclient::connect(server_url, token, fingerprint).await
}

/// Forget the stored token on THIS machine.
///
/// Not revocation, and the UI must not call it that: the token stays valid
/// until somebody revokes it on the server's Compute Capsules desk.
#[tauri::command]
pub fn platform_forget(server_url: String) -> Result<(), String> {
    totoclient::forget(server_url)
}

/// One authenticated call, against the crate's `/api/v1/` allowlist.
#[tauri::command]
pub async fn platform_request(
    server_url: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    fingerprint: Option<String>,
) -> Result<ApiReply, String> {
    totoclient::request(server_url, method, path, body, fingerprint).await
}

/// Who we are, without touching the network — local state only, because this
/// runs on every launch and must not depend on reachability.
#[tauri::command]
pub fn platform_status(server_url: String) -> Result<SessionInfo, String> {
    totoclient::status(server_url)
}
