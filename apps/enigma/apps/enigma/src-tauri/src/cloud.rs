// "Enigma Cloud" — HTTP client for the user's self-hosted faros server: telegraph
// session auth (login / logout / me) and vault file storage (list, streaming
// upload/download, delete, directories, move). Registration is deliberately NOT
// offered here — accounts are created in a browser on the server's /sso/ page.
// The frontend drives the `cloud_*` commands; transfers return immediately and
// stream in background tasks, reporting via `cloud://progress` / `cloud://done` /
// `cloud://error` (mirroring file_xfer.rs's `file://…` events).
//
// Master switch: every byte to the server is additionally gated by the RUNTIME
// knob kv `cloud:settings/default/enabled` (Cloud tab; default off/absent ⇒ off,
// fail closed). It is checked per command (`ensure_cloud_ready`) AND at the top of
// `connect()` — the single choke point every cloud/beacon/aster request funnels
// through — so a forgotten call-site gate cannot leak traffic. Flipping it off
// aborts in-flight transfers via `shutdown`.
//
// Transport rules (see `connect`):
//   * `.onion` hosts ALWAYS go through the embedded Tor client (tor.rs) — that is
//     the only way to reach them.
//   * Loopback hosts (localhost, 127.0.0.0/8, ::1) ALWAYS use a direct TCP
//     connection: Tor cannot reach the client's own loopback, and a local
//     connection leaks nothing — allowed even in Tor-exclusive mode.
//   * Any other clearnet host connects directly, EXCEPT when the profile is in
//     Tor-exclusive mode (Settings → Tor) OR the Cloud-tab "route through Tor"
//     knob (kv `cloud:settings/default/force_tor`) is on — then it is routed
//     through arti (which can exit to clearnet) so the server never sees the
//     user's IP.
// Airplane mode blocks every networked cloud command with the same message as
// file_xfer. The connect deadline is the user's Settings-tab value
// (`p2p:settings/connect_timeout_secs`), never a hardcoded literal.
//
// HTTPS verification depends on the host class:
//   * Loopback / .onion reuse tor.rs's accept-any-cert config — acceptable for the
//     same reason it is in tor.rs: a self-signed cert on the user's own machine
//     (the address IS the machine) or on an .onion (the Tor circuit already
//     authenticates the address; onion TLS certs are self-signed — the address is
//     the identity). No CA could vouch for either endpoint.
//   * A real clearnet host (e.g. https://cloud.example.com) gets FULL WebPKI cert
//     verification against the Mozilla root bundle, whether reached directly or via
//     a Tor exit — otherwise an on-path attacker on hostile Wi-Fi could MITM the
//     login password and session token with any self-signed cert.
//
// The session token (a Django session key) and username persist in the encrypted
// kv store (protasius) under ns "cloud:auth", scoped by the normalized server URL.
// The frontend may read the username via `kv_get`, but the token is only ever read
// back here in Rust and sent as `Authorization: Bearer <token>`.

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::body::{Body, Frame, Incoming, SizeHint};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use crate::tor::{self, host_port};
use crate::vault;

/// Encrypted kv namespace holding the session per server (keys: token, username).
const NS_AUTH: &str = "cloud:auth";
/// Encrypted kv namespace of the Cloud-tab runtime knobs (keys: enabled,
/// force_tor) — same ns/scope the frontend's server_url setting lives in.
const NS_SETTINGS: &str = "cloud:settings";
const SETTINGS_SCOPE: &str = "default";
/// Streaming chunk size for both directions (same rationale as file_xfer::CHUNK).
const CHUNK: usize = crate::build_config::network::TRANSFER_CHUNK_BYTES;
/// Redirect-follow cap for the download 302 → media URL hop.
const MAX_REDIRECTS: usize = crate::build_config::network::MAX_REDIRECTS;

/// Returned by every cloud command in a build with cloud.allow_connections: false.
pub(crate) const CLOUD_DISABLED: &str = "Enigma Cloud is disabled in this build.";

/// Runtime switch off — distinct from CLOUD_DISABLED (wrong build) so the
/// frontend can offer "turn it on" instead of hiding the UI. Prefix-matched by
/// the store (`knobRefused` in stores/cloud.ts, beside the "unauthorized"
/// convention): on this prefix it syncs its `enabled` mirror off, so the tab
/// falls back to the knob-off state instead of showing the raw string.
pub(crate) const CLOUD_OFF: &str =
    "cloud_off: Enigma Cloud is switched off (enable it in the Cloud tab).";

/// Prefix on EVERY transport failure leaving `connect()` — Tor bootstrap/connect,
/// TCP connect, TLS handshake, or the deadline. Machine-classifiable beside
/// `cloud_off:` and `unauthorized:`, so the store can mirror "the server did not
/// answer" and the Cloud panels can say so instead of rendering a raw socket
/// error. Applied at the single exit, so any transport added inside `connect()`
/// later inherits it; the CLOUD_OFF early return sits ABOVE that exit and keeps
/// its own prefix (a doubled `unreachable: cloud_off: …` would break knobRefused).
///
/// NOT proof the server is down: a cold arti bootstrap can exceed the connect
/// timeout on a perfectly healthy server (see cloud.md, "First force-Tor
/// request"), which is why the UI always pairs this with a live retry.
pub(crate) const UNREACHABLE: &str = "unreachable";

/// Build-time gate: the whole faros client is off when the build config says so
/// (`ensure_cloud_ready` adds the runtime knob and airplane mode on top).
fn ensure_cloud_enabled() -> Result<(), String> {
    if !crate::build_config::cloud::ALLOW_CONNECTIONS {
        return Err(CLOUD_DISABLED.to_string());
    }
    Ok(())
}

// ── URL / host helpers (pure — unit-tested below) ─────────────────────────────

/// kv scope for a server: the URL trimmed, without any trailing slash.
fn normalize_scope(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

fn url_scheme(url: &str) -> &str {
    url.trim().split_once("://").map(|(s, _)| s).unwrap_or("http")
}

/// https/wss ⇒ TLS; anything else (http, ws, schemeless) ⇒ plain.
fn url_tls(url: &str) -> bool {
    matches!(url_scheme(url).to_ascii_lowercase().as_str(), "https" | "wss")
}

/// Optional path prefix of the server URL ("" or "/sub/path", no trailing slash),
/// prepended to every API path so a server mounted under a subpath still works.
fn url_path_prefix(url: &str) -> String {
    let trimmed = url.trim();
    let rest = trimmed.split_once("://").map(|(_, r)| r).unwrap_or(trimmed);
    match rest.find('/') {
        Some(i) => rest[i..].trim_end_matches('/').to_string(),
        None => String::new(),
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum HostClass {
    Onion,
    Loopback,
    Clearnet,
}

fn classify_host(host: &str) -> HostClass {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let lower = bare.to_ascii_lowercase();
    if lower.ends_with(".onion") {
        return HostClass::Onion;
    }
    if lower == "localhost" {
        return HostClass::Loopback;
    }
    if let Ok(ip) = lower.parse::<IpAddr>() {
        // Ipv4Addr::is_loopback covers all of 127.0.0.0/8; ::1 for IPv6.
        if ip.is_loopback() {
            return HostClass::Loopback;
        }
    }
    HostClass::Clearnet
}

/// A stored knob value is on only for the exact string "on" — anything else
/// (absent key, locked vault, "off", stray casing) fails closed. Mirrors the
/// `dht_discovery` convention in p2p_dht.rs.
fn flag_on(value: Option<&str>) -> bool {
    matches!(value, Some("on"))
}

/// Routing policy: `tor_route` = Tor-exclusive profile OR the force_tor knob.
/// Onion always rides arti; loopback never does (arti cannot reach it, and a
/// local connection leaks nothing); clearnet follows `tor_route`.
fn route_via_tor(class: HostClass, tor_route: bool) -> bool {
    match class {
        HostClass::Onion => true,
        HostClass::Loopback => false,
        HostClass::Clearnet => tor_route,
    }
}

/// Wire value for the Cloud tab's transport badge. "loopback" is deliberately
/// its own label — calling a local dev server "clearnet" would show the wrong
/// warning, calling it "tor" would be a lie.
fn transport_label(class: HostClass, tor_route: bool) -> &'static str {
    match class {
        HostClass::Onion => "onion",
        HostClass::Loopback => "loopback",
        HostClass::Clearnet if tor_route => "tor",
        HostClass::Clearnet => "clearnet",
    }
}

/// Resolve a redirect `Location` for the download loop. `cur_*` describe the hop
/// that returned the redirect; `api_*` identify the token's own endpoint. Returns
/// (host, port, tls, path, send_auth).
///
/// The Bearer token is sent to the next hop ONLY when it is the exact same endpoint
/// as the API — same host AND port AND scheme — so it never leaks to another port,
/// another host, or across an https→http downgrade. Relative Locations stay on the
/// current hop's transport and carry the current auth decision forward (a hop that
/// already dropped auth never re-adds it).
fn resolve_location(
    cur_host: &str,
    cur_port: u16,
    cur_tls: bool,
    cur_auth: bool,
    api_host: &str,
    api_port: u16,
    api_tls: bool,
    location: &str,
) -> Result<(String, u16, bool, String, bool), String> {
    let loc = location.trim();
    if loc.is_empty() {
        return Err("redirect without Location".to_string());
    }
    let is_api = |h: &str, p: u16, t: bool| h.eq_ignore_ascii_case(api_host) && p == api_port && t == api_tls;

    // Protocol-relative "//host/path": inherits the current scheme.
    if let Some(after) = loc.strip_prefix("//") {
        let scheme = if cur_tls { "https" } else { "http" };
        return resolve_location(
            cur_host, cur_port, cur_tls, cur_auth, api_host, api_port, api_tls,
            &format!("{scheme}://{after}"),
        );
    }
    // Absolute URL with a scheme.
    if loc.contains("://") {
        let (host, port) = host_port(loc)?;
        let tls = url_tls(loc);
        let rest = loc.split_once("://").map(|(_, r)| r).unwrap_or(loc);
        let path = match rest.find('/') {
            Some(i) => rest[i..].to_string(),
            None => "/".to_string(),
        };
        let send_auth = is_api(&host, port, tls);
        return Ok((host, port, tls, path, send_auth));
    }
    // Root-relative "/path": stay on the current hop, keep the current auth state.
    if let Some(_rest) = loc.strip_prefix('/') {
        return Ok((cur_host.to_string(), cur_port, cur_tls, loc.to_string(), cur_auth));
    }
    // Path-relative ("media/x"): the media redirects never use this form; resolve it
    // against the current host root so we never misparse it as a bare hostname.
    Ok((cur_host.to_string(), cur_port, cur_tls, format!("/{loc}"), cur_auth))
}

// ── multipart construction (pure — unit-tested below) ─────────────────────────

/// Multipart field values must not smuggle CRLF / quotes into part headers.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '"' => '\'',
            '\r' | '\n' | '\\' => '_',
            c => c,
        })
        .collect()
}

/// Build the multipart/form-data bytes that surround the streamed file: the
/// preamble (all text parts + the file part's headers) and the closing epilogue.
/// Content-Length = preamble.len() + file_size + epilogue.len() — no chunked
/// encoding (Django needs a length).
fn build_multipart(
    boundary: &str,
    text_parts: &[(&str, String)],
    file_name: &str,
    mime: &str,
) -> (Vec<u8>, Vec<u8>) {
    let mut preamble = Vec::new();
    for (name, value) in text_parts {
        preamble.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    let filename = sanitize_filename(file_name);
    preamble.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
        )
        .as_bytes(),
    );
    let epilogue = format!("\r\n--{boundary}--\r\n").into_bytes();
    (preamble, epilogue)
}

fn multipart_content_length(preamble: &[u8], file_size: u64, epilogue: &[u8]) -> u64 {
    preamble.len() as u64 + file_size + epilogue.len() as u64
}

// ── policy / settings / session helpers ───────────────────────────────────────

/// Airplane mode gate — every networked cloud command runs this first.
pub(crate) fn ensure_online(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AppConfigState>();
    let cfg = crate::active_config(&state)?;
    if crate::is_offline(&crate::load_profile_state(app, &cfg)) {
        return Err(crate::file_xfer::OFFLINE_BLOCKED.to_string());
    }
    Ok(())
}

/// True when this profile is in Tor-exclusive mode (clearnet must route via
/// arti). The Cloud-tab force_tor knob composes with this by OR in `connect`.
fn tor_exclusive(app: &AppHandle) -> bool {
    let state = app.state::<crate::AppConfigState>();
    match crate::active_config(&state) {
        Ok(cfg) => crate::is_use_tor(&crate::load_profile_state(app, &cfg)),
        Err(_) => false,
    }
}

/// The Cloud tab's runtime master switch (kv `cloud:settings/default/enabled`).
/// Missing key or locked vault reads as OFF — fail closed.
pub(crate) fn runtime_enabled(app: &AppHandle) -> bool {
    flag_on(vault::kv_get_raw(app, NS_SETTINGS, SETTINGS_SCOPE, "enabled").as_deref())
}

/// The Cloud tab's "route through Tor" knob (kv `cloud:settings/default/force_tor`).
fn force_tor(app: &AppHandle) -> bool {
    flag_on(vault::kv_get_raw(app, NS_SETTINGS, SETTINGS_SCOPE, "force_tor").as_deref())
}

/// Composite gate every networked cloud/beacon/aster command runs before any
/// I/O: build flag → runtime master switch → airplane mode.
pub(crate) fn ensure_cloud_ready(app: &AppHandle) -> Result<(), String> {
    ensure_cloud_enabled()?;
    if !runtime_enabled(app) {
        return Err(CLOUD_OFF.to_string());
    }
    ensure_online(app)
}

fn stored_token(app: &AppHandle, scope: &str) -> Option<String> {
    vault::kv_get_raw(app, NS_AUTH, scope, "token").filter(|t| !t.is_empty())
}

fn store_session(app: &AppHandle, scope: &str, token: &str, username: &str) -> Result<(), String> {
    vault::kv_put_raw(app, NS_AUTH, scope, "token", token)?;
    vault::kv_put_raw(app, NS_AUTH, scope, "username", username)
}

fn clear_session(app: &AppHandle, scope: &str) {
    let _ = vault::kv_delete_raw(app, NS_AUTH, scope, "token");
    let _ = vault::kv_delete_raw(app, NS_AUTH, scope, "username");
}

// ── in-flight transfer registry (so airplane / Tor toggles can abort them) ─────

/// Handles for running upload/download tasks, keyed by transfer id. A
/// network-policy change (airplane mode, entering Tor-exclusive mode) aborts them
/// via `shutdown` — otherwise a live direct clearnet transfer would keep streaming
/// (and keep exposing the user's IP) after the switch. Mirrors file_xfer's teardown.
#[derive(Default)]
pub struct CloudState {
    transfers: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

/// Insert a spawned transfer, then re-check the master switch: a knob flip can
/// land in the window between `spawn` and this insert, in which case its
/// `shutdown()` drained a map that did not yet contain this handle — abort it
/// now so "off means zero bytes" survives the race. A task that already
/// finished (its `finish_transfer` ran before this insert) is not registered
/// at all, so a later `shutdown()` can't emit a spurious cancel for it.
fn register_transfer(app: &AppHandle, id: &str, handle: tauri::async_runtime::JoinHandle<()>) {
    // Tauri's JoinHandle is a wrapper enum; only the tokio variant can answer.
    // The catch-all is unreachable on this target but keeps the match total on
    // targets where the enum carries a second (wasm) variant.
    #[allow(unreachable_patterns)]
    let finished = match &handle {
        tauri::async_runtime::JoinHandle::Tokio(h) => h.is_finished(),
        _ => false,
    };
    if finished {
        return;
    }
    if let Ok(mut map) = app.state::<CloudState>().transfers.lock() {
        map.insert(id.to_string(), handle);
    }
    if !runtime_enabled(app) {
        if let Ok(mut map) = app.state::<CloudState>().transfers.lock() {
            if let Some(handle) = map.remove(id) {
                handle.abort();
                emit_error(app, id, CANCELLED_BY_POLICY);
            }
        }
    }
}

/// Whether any transfer task is in flight — the lock watchdog (vault.rs) treats
/// this as presence so its fallback never cuts a transfer the user is waiting on.
pub fn transfers_active(app: &AppHandle) -> bool {
    app.state::<CloudState>()
        .transfers
        .lock()
        .map(|m| !m.is_empty())
        .unwrap_or(false)
}

/// A transfer task removes its own handle when it finishes (success or error).
fn finish_transfer(app: &AppHandle, id: &str) {
    if let Ok(mut map) = app.state::<CloudState>().transfers.lock() {
        map.remove(id);
    }
}

/// Accurate for every caller of `shutdown`: airplane mode, Tor-exclusive mode,
/// the Cloud master switch turning off, force_tor turning on, vault lock.
const CANCELLED_BY_POLICY: &str = "transfer cancelled (network policy changed)";

/// Abort every in-flight transfer and notify the UI. Called when airplane mode,
/// Tor-exclusive mode or force_tor turns on, or the Cloud master switch turns off.
pub async fn shutdown(app: &AppHandle) {
    let handles: Vec<(String, tauri::async_runtime::JoinHandle<()>)> = {
        match app.state::<CloudState>().transfers.lock() {
            Ok(mut map) => map.drain().collect(),
            Err(_) => return,
        }
    };
    for (id, handle) in handles {
        handle.abort();
        emit_error(app, &id, CANCELLED_BY_POLICY);
    }
}

// ── events (payload keys camelCase, like file://progress) ─────────────────────

fn emit_progress(app: &AppHandle, transfer_id: &str, dir: &str, transferred: u64, total: u64) {
    let _ = app.emit(
        "cloud://progress",
        json!({ "transferId": transfer_id, "dir": dir, "transferred": transferred, "total": total }),
    );
}

fn emit_done(app: &AppHandle, transfer_id: &str, dir: &str, file: Option<Value>) {
    let _ = app.emit(
        "cloud://done",
        json!({ "transferId": transfer_id, "dir": dir, "file": file }),
    );
}

fn emit_error(app: &AppHandle, transfer_id: &str, message: &str) {
    let _ = app.emit(
        "cloud://error",
        json!({ "transferId": transfer_id, "message": message }),
    );
}

// ── transport ─────────────────────────────────────────────────────────────────

/// Object-safe alias so one code path serves TCP, TLS-over-TCP, Tor, TLS-over-Tor.
trait IoStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> IoStream for T {}
type BoxedStream = Box<dyn IoStream>;

/// A process-wide rustls config that verifies certs against the Mozilla root
/// bundle (WebPKI). Used for real clearnet HTTPS; loopback/onion use tor.rs's
/// accept-any-cert config instead.
fn verifying_tls_config() -> Arc<ClientConfig> {
    static CONFIG: std::sync::OnceLock<Arc<ClientConfig>> = std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let provider =
                Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
            let config = ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .expect("rustls default protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

/// TLS-wrap a stream with full WebPKI verification (real clearnet CA-signed certs).
async fn tls_wrap_verified<S>(stream: S, host: &str) -> Result<TlsStream<S>, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let server_name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|e| format!("invalid TLS server name {host:?}: {e}"))?;
    TlsConnector::from(verifying_tls_config())
        .connect(server_name, stream)
        .await
        .map_err(|e| format!("TLS handshake to {host} failed: {e}"))
}

/// Open a stream to `host:port` per the module's transport rules, wrapping the
/// whole establishment (TCP/Tor connect + TLS handshake) in the user-configured
/// connect timeout. Clearnet HTTPS is cert-verified; loopback/onion accept any cert.
async fn connect(app: &AppHandle, host: &str, port: u16, tls: bool) -> Result<BoxedStream, String> {
    // Invariant enforcer: with the master switch off, no cloud byte leaves the
    // app even if a caller forgot its own gate — every cloud/beacon/aster
    // request (including download redirect hops) funnels through here.
    if !runtime_enabled(app) {
        return Err(CLOUD_OFF.to_string());
    }
    // Same Settings-tab value the P2P layer uses — one clamp/default governs it.
    let secs = crate::p2p_dht::connect_timeout_secs(app);
    let class = classify_host(host);
    let via_tor = route_via_tor(class, tor_exclusive(app) || force_tor(app));
    // Verify real CA certs for clearnet; loopback/onion are self-signed by design.
    let verify = matches!(class, HostClass::Clearnet);
    // rustls ServerName accepts DNS names and IP literals (no brackets).
    let tls_host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let established = tokio::time::timeout(Duration::from_secs(secs), async move {
        // Establish the raw byte stream (Tor circuit or direct TCP), then TLS-wrap.
        let raw: BoxedStream = if via_tor {
            let tor_state = app.state::<tor::TorState>();
            Box::new(tor_state.connect(host, port).await?)
        } else {
            let addr = format!("{host}:{port}");
            Box::new(
                tokio::net::TcpStream::connect(&addr)
                    .await
                    .map_err(|e| format!("connect to {addr} failed: {e}"))?,
            )
        };
        if !tls {
            return Ok::<BoxedStream, String>(raw);
        }
        if verify {
            Ok(Box::new(tls_wrap_verified(raw, &tls_host).await?))
        } else {
            Ok(Box::new(tor::tls_wrap(raw, &tls_host).await?))
        }
    })
    .await;
    // One exit for every transport failure: the INNER Result carries the Tor /
    // TCP / TLS errors, the OUTER Err is the deadline. Both leave here tagged
    // UNREACHABLE so the frontend can classify them. Note the `?`-and-append
    // shape does not work: `?` unwraps only the outer Elapsed, which would tag
    // timeouts alone and let a connection-refused through untagged.
    match established {
        Ok(inner) => inner,
        Err(_) => Err(format!("connect to {host}:{port} timed out after {secs}s")),
    }
    .map_err(|e| format!("{UNREACHABLE}: {e}"))
}

// ── HTTP mechanics ────────────────────────────────────────────────────────────

/// Map an HTTP error status to the command error convention: 401 ⇒ a message
/// starting with "unauthorized" (frontend flips to logged-out on that prefix);
/// otherwise prefer the server's JSON `error` field.
pub(crate) fn status_err(status: u16, body: &Value) -> String {
    let server_msg = body
        .get("error")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if status == 401 {
        format!(
            "unauthorized: {}",
            server_msg.unwrap_or_else(|| "session expired (HTTP 401)".to_string())
        )
    } else {
        server_msg.unwrap_or_else(|| format!("server error (HTTP {status})"))
    }
}

pub(crate) fn expect_2xx(status: u16, body: &Value) -> Result<(), String> {
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(status_err(status, body))
    }
}

/// One buffered JSON request/response against the API server (login, register,
/// logout, me, list, delete, mkdir, rmdir, move). Reuses tor::send_http over
/// whichever stream `connect` picked. Returns (status, parsed body — Null when
/// empty or not JSON).
pub(crate) async fn request_json(
    app: &AppHandle,
    server_url: &str,
    method: &str,
    path: &str,
    auth: bool,
    body: Option<Value>,
) -> Result<(u16, Value), String> {
    let (host, port) = host_port(server_url)?;
    let tls = url_tls(server_url);
    let prefix = url_path_prefix(server_url);

    let mut headers: Vec<(String, String)> = Vec::new();
    if auth {
        let scope = normalize_scope(server_url);
        let token = stored_token(app, &scope).ok_or_else(|| "unauthorized: not logged in".to_string())?;
        headers.push(("Authorization".to_string(), format!("Bearer {token}")));
    }
    let body_bytes = match &body {
        Some(v) => serde_json::to_vec(v).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    if body.is_some() {
        headers.push(("Content-Type".to_string(), "application/json".to_string()));
        headers.push(("Content-Length".to_string(), body_bytes.len().to_string()));
    }

    let stream = connect(app, &host, port, tls).await?;
    let (status, bytes) = tor::send_http(
        stream,
        &host,
        port,
        tls,
        method,
        &format!("{prefix}{path}"),
        &headers,
        body_bytes,
    )
    .await?;
    // Any authenticated call that comes back 401 means the stored session is dead;
    // clear it centrally so cloud_status can't later report a stale logged-in state.
    if auth && status == 401 {
        clear_session(app, &normalize_scope(server_url));
    }
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, value))
}

/// Streaming variant of tor::send_http: same handshake/Host handling, but generic
/// over the request body (a custom `Body` for uploads, `Empty` for downloads) and
/// returning the raw response so callers can stream `Incoming` frame by frame.
async fn send_request<S, B>(
    stream: S,
    host: &str,
    port: u16,
    tls: bool,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: B,
) -> Result<hyper::Response<Incoming>, String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    B: Body + Send + 'static,
    B::Data: Send,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let io = hyper_util::rt::TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| e.to_string())?;
    // Drive the connection in the background while we send/receive.
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let default_port = if tls { 443 } else { 80 };
    let authority = if port == default_port {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };
    let mut builder = hyper::Request::builder()
        .method(hyper::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?)
        .uri(if path.is_empty() { "/" } else { path })
        .header(hyper::header::HOST, authority);
    for (k, v) in headers {
        builder = builder.header(k.as_str(), v.as_str());
    }
    let req = builder.body(body).map_err(|e| e.to_string())?;
    sender.send_request(req).await.map_err(|e| e.to_string())
}

// ── streaming upload body ─────────────────────────────────────────────────────

enum Phase {
    Preamble,
    File,
    Epilogue,
    Done,
}

/// multipart/form-data request body with bounded memory: yields the preamble,
/// then 64 KiB file chunks read from tokio::fs::File, then the epilogue —
/// emitting `cloud://progress` (file bytes only) as chunks are produced.
struct MultipartBody {
    phase: Phase,
    preamble: Bytes,
    epilogue: Bytes,
    file: tokio::fs::File,
    buf: Vec<u8>,
    file_size: u64,
    file_sent: u64,
    remaining: u64,
    app: AppHandle,
    transfer_id: String,
}

impl MultipartBody {
    fn new(
        app: AppHandle,
        transfer_id: String,
        preamble: Vec<u8>,
        epilogue: Vec<u8>,
        file: tokio::fs::File,
        file_size: u64,
    ) -> Self {
        let remaining = multipart_content_length(&preamble, file_size, &epilogue);
        Self {
            phase: Phase::Preamble,
            preamble: Bytes::from(preamble),
            epilogue: Bytes::from(epilogue),
            file,
            buf: vec![0u8; CHUNK],
            file_size,
            file_sent: 0,
            remaining,
            app,
            transfer_id,
        }
    }
}

impl Body for MultipartBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, std::io::Error>>> {
        let this = self.get_mut();
        loop {
            match this.phase {
                Phase::Preamble => {
                    this.phase = Phase::File;
                    let chunk = std::mem::take(&mut this.preamble);
                    this.remaining = this.remaining.saturating_sub(chunk.len() as u64);
                    return Poll::Ready(Some(Ok(Frame::data(chunk))));
                }
                Phase::File => {
                    let mut rb = ReadBuf::new(&mut this.buf);
                    match Pin::new(&mut this.file).poll_read(cx, &mut rb) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Err(e)) => return Poll::Ready(Some(Err(e))),
                        Poll::Ready(Ok(())) => {
                            let filled = rb.filled();
                            if filled.is_empty() {
                                this.phase = Phase::Epilogue;
                                continue;
                            }
                            let chunk = Bytes::copy_from_slice(filled);
                            this.file_sent += chunk.len() as u64;
                            this.remaining = this.remaining.saturating_sub(chunk.len() as u64);
                            emit_progress(
                                &this.app,
                                &this.transfer_id,
                                "up",
                                this.file_sent,
                                this.file_size,
                            );
                            return Poll::Ready(Some(Ok(Frame::data(chunk))));
                        }
                    }
                }
                Phase::Epilogue => {
                    this.phase = Phase::Done;
                    let chunk = std::mem::take(&mut this.epilogue);
                    this.remaining = this.remaining.saturating_sub(chunk.len() as u64);
                    return Poll::Ready(Some(Ok(Frame::data(chunk))));
                }
                Phase::Done => return Poll::Ready(None),
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        matches!(self.phase, Phase::Done)
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact(self.remaining)
    }
}

// ── background transfer tasks ─────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn run_upload(
    app: AppHandle,
    server_url: String,
    file_path: PathBuf,
    name: String,
    size: u64,
    bucket_slug: Option<String>,
    directory_id: Option<i64>,
    transfer_id: String,
) -> Result<Value, String> {
    let scope = normalize_scope(&server_url);
    let token = stored_token(&app, &scope).ok_or_else(|| "unauthorized: not logged in".to_string())?;
    let (host, port) = host_port(&server_url)?;
    let tls = url_tls(&server_url);
    let prefix = url_path_prefix(&server_url);

    let title = file_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.clone());
    let mut text_parts: Vec<(&str, String)> = vec![("title", title)];
    if let Some(slug) = bucket_slug {
        text_parts.push(("bucket_slug", slug));
    }
    if let Some(dir) = directory_id {
        text_parts.push(("directory_id", dir.to_string()));
    }

    let boundary = format!("EnigmaCloud{}", uuid::Uuid::new_v4().simple());
    let mime = crate::file_xfer::mime_from_ext(&name);
    let (preamble, epilogue) = build_multipart(&boundary, &text_parts, &name, &mime);
    let content_length = multipart_content_length(&preamble, size, &epilogue);

    let file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| format!("open failed: {e}"))?;
    let body = MultipartBody::new(app.clone(), transfer_id, preamble, epilogue, file, size);

    let headers = vec![
        ("Authorization".to_string(), format!("Bearer {token}")),
        (
            "Content-Type".to_string(),
            format!("multipart/form-data; boundary={boundary}"),
        ),
        ("Content-Length".to_string(), content_length.to_string()),
    ];

    let stream = connect(&app, &host, port, tls).await?;
    let resp = send_request(
        stream,
        &host,
        port,
        tls,
        "POST",
        &format!("{prefix}/vault/api/files/upload/"),
        &headers,
        body,
    )
    .await?;

    let status = resp.status().as_u16();
    if status == 401 {
        clear_session(&app, &scope);
    }
    let bytes = resp
        .into_body()
        .collect()
        .await
        .map_err(|e| e.to_string())?
        .to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    expect_2xx(status, &value)?;
    Ok(value)
}

async fn run_download(
    app: AppHandle,
    server_url: String,
    key: String,
    dest: String,
    transfer_id: String,
) -> Result<(), String> {
    let scope = normalize_scope(&server_url);
    let token = stored_token(&app, &scope).ok_or_else(|| "unauthorized: not logged in".to_string())?;
    let (api_host, api_port) = host_port(&server_url)?;
    let api_tls = url_tls(&server_url);
    let prefix = url_path_prefix(&server_url);

    let mut host = api_host.clone();
    let mut port = api_port;
    let mut tls = api_tls;
    let mut path = format!("{prefix}/vault/api/files/{key}/download/");
    let mut send_auth = true;
    let mut redirects = 0usize;

    loop {
        let mut headers: Vec<(String, String)> = Vec::new();
        if send_auth {
            headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        let stream = connect(&app, &host, port, tls).await?;
        let resp = send_request(
            stream,
            &host,
            port,
            tls,
            "GET",
            &path,
            &headers,
            Empty::<Bytes>::new(),
        )
        .await?;
        let status = resp.status().as_u16();

        // The download endpoint answers 302 with the media URL; follow it (and
        // any further hop, capped) then stream whichever response is a 200.
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            redirects += 1;
            if redirects > MAX_REDIRECTS {
                return Err("too many redirects".to_string());
            }
            let location = resp
                .headers()
                .get(hyper::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "redirect without Location".to_string())?
                .to_string();
            let (h, p, t, pa, sa) = resolve_location(
                &host, port, tls, send_auth, &api_host, api_port, api_tls, &location,
            )?;
            host = h;
            port = p;
            tls = t;
            path = pa;
            send_auth = sa;
            continue;
        }

        if status != 200 {
            // A 401 here is only meaningful on the API endpoint (the media host is
            // unauthenticated); clear the session so the state stays consistent.
            if status == 401 && send_auth {
                clear_session(&app, &scope);
            }
            let bytes = resp
                .into_body()
                .collect()
                .await
                .map_err(|e| e.to_string())?
                .to_bytes();
            let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            return Err(status_err(status, &value));
        }

        // Direct 200 (or the followed media URL): stream the body to dest.
        let total = resp
            .headers()
            .get(hyper::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let mut body = resp.into_body();
        let mut file = tokio::fs::File::create(&dest)
            .await
            .map_err(|e| format!("create {dest} failed: {e}"))?;
        let mut got: u64 = 0;
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|e| e.to_string())?;
            if let Ok(data) = frame.into_data() {
                file.write_all(&data)
                    .await
                    .map_err(|e| format!("write failed: {e}"))?;
                got += data.len() as u64;
                emit_progress(&app, &transfer_id, "down", got, total);
            }
        }
        file.flush().await.map_err(|e| format!("flush failed: {e}"))?;
        return Ok(());
    }
}

// ── commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CloudStatus {
    logged_in: bool,
    username: Option<String>,
    /// Runtime master switch (Cloud tab knob).
    enabled: bool,
    /// "Route through Tor" knob.
    force_tor: bool,
    /// Predicted transport for `server_url`: "onion" | "tor" | "clearnet" | "loopback".
    transport: String,
}

#[derive(Serialize)]
pub struct CloudUser {
    username: String,
}

#[derive(Serialize)]
pub struct UploadStarted {
    transfer_id: String,
    name: String,
    size: u64,
}

#[derive(Serialize)]
pub struct DownloadStarted {
    transfer_id: String,
}

/// Local-only login/knob state (kv + profile flags): no network touched, and
/// deliberately NOT gated on the runtime knob — the Cloud tab renders from this
/// while the switch is off.
#[tauri::command]
pub fn cloud_status(app: AppHandle, server_url: String) -> Result<CloudStatus, String> {
    ensure_cloud_enabled()?;
    let scope = normalize_scope(&server_url);
    let logged_in = stored_token(&app, &scope).is_some();
    let username = vault::kv_get_raw(&app, NS_AUTH, &scope, "username");
    let force_tor = force_tor(&app);
    let tor_route = tor_exclusive(&app) || force_tor;
    // Unparseable URL ⇒ "clearnet": the worst-case warning is the safe default.
    let transport = match host_port(&server_url) {
        Ok((host, _)) => transport_label(classify_host(&host), tor_route),
        Err(_) => "clearnet",
    }
    .to_string();
    Ok(CloudStatus {
        logged_in,
        username,
        enabled: runtime_enabled(&app),
        force_tor,
        transport,
    })
}

/// Flip the runtime master switch. Turning it OFF aborts in-flight transfers —
/// "off" must mean zero bytes, not "finish what you started" (same rationale as
/// the airplane/Tor-mode teardown in lib.rs).
#[tauri::command]
pub async fn cloud_set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    ensure_cloud_enabled()?;
    vault::kv_put_raw(&app, NS_SETTINGS, SETTINGS_SCOPE, "enabled", if enabled { "on" } else { "off" })?;
    if !enabled {
        shutdown(&app).await;
    }
    Ok(())
}

/// Flip the "route through Tor" knob. Turning it ON aborts in-flight transfers —
/// a live direct clearnet transfer must not outlive the switch (it would keep
/// exposing the user's IP). Turning it OFF lets Tor-routed transfers finish.
#[tauri::command]
pub async fn cloud_set_force_tor(app: AppHandle, on: bool) -> Result<(), String> {
    ensure_cloud_enabled()?;
    vault::kv_put_raw(&app, NS_SETTINGS, SETTINGS_SCOPE, "force_tor", if on { "on" } else { "off" })?;
    if on {
        shutdown(&app).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn cloud_login(
    app: AppHandle,
    server_url: String,
    username: String,
    password: String,
) -> Result<CloudUser, String> {
    ensure_cloud_ready(&app)?;
    let body = json!({ "username": username, "password": password });
    let (status, value) =
        request_json(&app, &server_url, "POST", "/telegraph/api/login/", false, Some(body)).await?;
    expect_2xx(status, &value)?;
    let token = value
        .get("token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "malformed login response (no token)".to_string())?;
    store_session(&app, &normalize_scope(&server_url), token, &username)?;
    Ok(CloudUser { username })
}

/// Best-effort server logout; ALWAYS clears the local session (works with the
/// runtime knob off — disabling cloud must not trap a stale session).
#[tauri::command]
pub async fn cloud_logout(app: AppHandle, server_url: String) -> Result<(), String> {
    ensure_cloud_enabled()?;
    let scope = normalize_scope(&server_url);
    if stored_token(&app, &scope).is_some() && ensure_cloud_ready(&app).is_ok() {
        let _ = request_json(&app, &server_url, "POST", "/telegraph/api/logout/", true, None).await;
    }
    clear_session(&app, &scope);
    Ok(())
}

/// Network validation of the stored token. A 401 clears the session so the
/// frontend's "unauthorized" handling lands in a consistent logged-out state.
#[tauri::command]
pub async fn cloud_me(app: AppHandle, server_url: String) -> Result<CloudUser, String> {
    ensure_cloud_ready(&app)?;
    let (status, value) = request_json(&app, &server_url, "GET", "/telegraph/api/me/", true, None).await?;
    if status == 401 {
        clear_session(&app, &normalize_scope(&server_url));
        return Err(status_err(status, &value));
    }
    expect_2xx(status, &value)?;
    let username = value
        .get("username")
        .and_then(|u| u.as_str())
        .ok_or_else(|| "malformed me response (no username)".to_string())?
        .to_string();
    Ok(CloudUser { username })
}

/// Files + buckets in one call (two GETs, passthrough of the server JSON).
#[tauri::command]
pub async fn cloud_list(app: AppHandle, server_url: String) -> Result<Value, String> {
    ensure_cloud_ready(&app)?;
    let (status, files) = request_json(&app, &server_url, "GET", "/vault/api/files/", true, None).await?;
    expect_2xx(status, &files)?;
    let (status, buckets) =
        request_json(&app, &server_url, "GET", "/vault/api/buckets/", true, None).await?;
    expect_2xx(status, &buckets)?;
    Ok(json!({
        "files": files.get("files").cloned().unwrap_or_else(|| json!([])),
        "buckets": buckets.get("buckets").cloned().unwrap_or_else(|| json!([])),
    }))
}

/// Start a streaming upload; returns immediately, progress/done/error via events
/// (`cloud://done` carries the server's 201 fileDict).
#[tauri::command]
pub async fn cloud_upload(
    app: AppHandle,
    server_url: String,
    path: String,
    bucket_slug: Option<String>,
    directory_id: Option<i64>,
) -> Result<UploadStarted, String> {
    ensure_cloud_ready(&app)?;
    let scope = normalize_scope(&server_url);
    if stored_token(&app, &scope).is_none() {
        return Err("unauthorized: not logged in".to_string());
    }
    let file_path = PathBuf::from(&path);
    let meta = std::fs::metadata(&file_path).map_err(|e| format!("cannot read file: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    let size = meta.len();
    let name = file_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let transfer_id = uuid::Uuid::new_v4().to_string();

    let task_app = app.clone();
    let task_transfer_id = transfer_id.clone();
    let task_name = name.clone();
    let handle = tauri::async_runtime::spawn(async move {
        match run_upload(
            task_app.clone(),
            server_url,
            file_path,
            task_name,
            size,
            bucket_slug,
            directory_id,
            task_transfer_id.clone(),
        )
        .await
        {
            Ok(file) => emit_done(&task_app, &task_transfer_id, "up", Some(file)),
            Err(message) => emit_error(&task_app, &task_transfer_id, &message),
        }
        finish_transfer(&task_app, &task_transfer_id);
    });
    register_transfer(&app, &transfer_id, handle);

    Ok(UploadStarted { transfer_id, name, size })
}

/// Start a streaming download to `dest`; returns immediately, follows the 302
/// to the media URL, progress/done/error via events.
#[tauri::command]
pub async fn cloud_download(
    app: AppHandle,
    server_url: String,
    key: String,
    dest: String,
) -> Result<DownloadStarted, String> {
    ensure_cloud_ready(&app)?;
    let scope = normalize_scope(&server_url);
    if stored_token(&app, &scope).is_none() {
        return Err("unauthorized: not logged in".to_string());
    }
    let transfer_id = uuid::Uuid::new_v4().to_string();

    let task_app = app.clone();
    let task_transfer_id = transfer_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        match run_download(task_app.clone(), server_url, key, dest, task_transfer_id.clone()).await {
            Ok(()) => emit_done(&task_app, &task_transfer_id, "down", None),
            Err(message) => emit_error(&task_app, &task_transfer_id, &message),
        }
        finish_transfer(&task_app, &task_transfer_id);
    });
    register_transfer(&app, &transfer_id, handle);

    Ok(DownloadStarted { transfer_id })
}

#[tauri::command]
pub async fn cloud_delete(app: AppHandle, server_url: String, key: String) -> Result<(), String> {
    ensure_cloud_ready(&app)?;
    let (status, value) = request_json(
        &app,
        &server_url,
        "DELETE",
        &format!("/vault/api/files/{key}/"),
        true,
        None,
    )
    .await?;
    expect_2xx(status, &value)
}

/// Create a directory (passthrough of the server's 201 JSON:
/// {"id","name","parent_id","path","bucket_slug"}).
#[tauri::command]
pub async fn cloud_mkdir(
    app: AppHandle,
    server_url: String,
    bucket_slug: Option<String>,
    name: String,
    parent_id: Option<i64>,
) -> Result<Value, String> {
    ensure_cloud_ready(&app)?;
    let mut body = serde_json::Map::new();
    body.insert("name".to_string(), json!(name));
    if let Some(slug) = bucket_slug {
        body.insert("bucket_slug".to_string(), json!(slug));
    }
    if let Some(parent) = parent_id {
        body.insert("parent_id".to_string(), json!(parent));
    }
    let (status, value) = request_json(
        &app,
        &server_url,
        "POST",
        "/vault/api/directories/",
        true,
        Some(Value::Object(body)),
    )
    .await?;
    expect_2xx(status, &value)?;
    Ok(value)
}

#[tauri::command]
pub async fn cloud_rmdir(app: AppHandle, server_url: String, directory_id: i64) -> Result<(), String> {
    ensure_cloud_ready(&app)?;
    let (status, value) = request_json(
        &app,
        &server_url,
        "DELETE",
        &format!("/vault/api/directories/{directory_id}/"),
        true,
        None,
    )
    .await?;
    expect_2xx(status, &value)
}

/// Move a file into a directory (None ⇒ JSON null ⇒ bucket root). Returns the
/// updated fileDict passthrough.
#[tauri::command]
pub async fn cloud_move(
    app: AppHandle,
    server_url: String,
    key: String,
    directory_id: Option<i64>,
) -> Result<Value, String> {
    ensure_cloud_ready(&app)?;
    // Option<i64> serializes to null/number — exactly the contract's PATCH body.
    let body = json!({ "directory_id": directory_id });
    let (status, value) = request_json(
        &app,
        &server_url,
        "PATCH",
        &format!("/vault/api/files/{key}/"),
        true,
        Some(body),
    )
    .await?;
    expect_2xx(status, &value)?;
    Ok(value)
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_onion_loopback_clearnet() {
        assert_eq!(classify_host("abcdef.onion"), HostClass::Onion);
        assert_eq!(classify_host("SOME.ONION"), HostClass::Onion);
        assert_eq!(classify_host("localhost"), HostClass::Loopback);
        assert_eq!(classify_host("LocalHost"), HostClass::Loopback);
        assert_eq!(classify_host("127.0.0.1"), HostClass::Loopback);
        // Whole 127.0.0.0/8 is loopback.
        assert_eq!(classify_host("127.99.3.4"), HostClass::Loopback);
        assert_eq!(classify_host("::1"), HostClass::Loopback);
        assert_eq!(classify_host("[::1]"), HostClass::Loopback);
        assert_eq!(classify_host("example.com"), HostClass::Clearnet);
        assert_eq!(classify_host("128.0.0.1"), HostClass::Clearnet);
        // ".onion" must be the TLD, not a mere substring.
        assert_eq!(classify_host("onion.example.com"), HostClass::Clearnet);
    }

    #[test]
    fn normalizes_scope() {
        assert_eq!(normalize_scope(" https://localhost:8443/ "), "https://localhost:8443");
        assert_eq!(normalize_scope("https://x.onion///"), "https://x.onion");
        assert_eq!(normalize_scope("http://h:9000"), "http://h:9000");
    }

    #[test]
    fn route_via_tor_policy() {
        // Onion always rides arti, even with no tor_route request.
        assert!(route_via_tor(HostClass::Onion, false));
        assert!(route_via_tor(HostClass::Onion, true));
        // Loopback never does, even in Tor-exclusive/force_tor mode.
        assert!(!route_via_tor(HostClass::Loopback, true));
        assert!(!route_via_tor(HostClass::Loopback, false));
        // Clearnet follows the request.
        assert!(route_via_tor(HostClass::Clearnet, true));
        assert!(!route_via_tor(HostClass::Clearnet, false));
    }

    #[test]
    fn transport_labels() {
        assert_eq!(transport_label(HostClass::Onion, false), "onion");
        assert_eq!(transport_label(HostClass::Onion, true), "onion");
        // Loopback is never labeled "tor" — the traffic stays on the machine.
        assert_eq!(transport_label(HostClass::Loopback, true), "loopback");
        assert_eq!(transport_label(HostClass::Loopback, false), "loopback");
        assert_eq!(transport_label(HostClass::Clearnet, true), "tor");
        assert_eq!(transport_label(HostClass::Clearnet, false), "clearnet");
    }

    #[test]
    fn knob_flag_fails_closed() {
        assert!(flag_on(Some("on")));
        // Absent key, explicit off, and stray casing all read as OFF.
        assert!(!flag_on(None));
        assert!(!flag_on(Some("off")));
        assert!(!flag_on(Some("ON")));
        assert!(!flag_on(Some("true")));
        assert!(!flag_on(Some("")));
    }

    #[test]
    fn cloud_off_is_prefix_matchable() {
        // The frontend distinguishes the runtime switch from a session loss by
        // prefix, exactly like the "unauthorized" convention.
        assert!(CLOUD_OFF.starts_with("cloud_off"));
        assert!(!CLOUD_OFF.starts_with("unauthorized"));
    }

    #[test]
    fn unreachable_tags_transport_failures_without_colliding() {
        // What connect()'s single exit produces, for each of its four sources.
        let tagged = |cause: &str| format!("{UNREACHABLE}: {cause}");
        for cause in [
            "connect to h:443 failed: Connection refused (os error 111)",
            "connect to h:443 timed out after 60s",
            "TLS handshake to h failed: bad certificate",
            "tor: bootstrap failed",
        ] {
            let msg = tagged(cause);
            // Prefix-matchable by the store, and the human cause survives.
            assert!(msg.starts_with(UNREACHABLE));
            assert!(msg.ends_with(cause));
            // Exactly one tag — a doubled prefix would mean connect() tagged twice.
            assert_eq!(msg.matches(UNREACHABLE).count(), 1);
            // Must not be mistaken for either sibling convention.
            assert!(!msg.starts_with("unauthorized"));
            assert!(!msg.starts_with("cloud_off"));
        }
        // Neither sibling token is a prefix of this one, or vice versa, so
        // startsWith classification on the frontend stays unambiguous.
        assert!(!UNREACHABLE.starts_with("unauthorized"));
        assert!(!"unauthorized".starts_with(UNREACHABLE));
        assert!(!CLOUD_OFF.starts_with(UNREACHABLE));
    }

    #[test]
    fn cloud_off_is_never_tagged_unreachable() {
        // The knob refusal returns BEFORE the tagging exit; if it ever slipped
        // inside, the store's knobRefused prefix match would silently stop
        // working and the user would see a raw machine string.
        assert!(!CLOUD_OFF.starts_with(UNREACHABLE));
        assert!(!CLOUD_OFF.contains(UNREACHABLE));
    }

    #[test]
    fn url_helpers() {
        assert!(url_tls("https://h"));
        assert!(url_tls("wss://h"));
        assert!(!url_tls("http://h"));
        assert!(!url_tls("h")); // schemeless ⇒ http
        assert_eq!(url_path_prefix("https://h:1/base/"), "/base");
        assert_eq!(url_path_prefix("https://h:1/a/b"), "/a/b");
        assert_eq!(url_path_prefix("https://h:1"), "");
        assert_eq!(url_path_prefix("https://h:1/"), "");
    }

    #[test]
    fn multipart_bytes_and_length() {
        let (pre, epi) = build_multipart(
            "BOUND",
            &[("title", "report".to_string()), ("directory_id", "7".to_string())],
            "report.pdf",
            "application/pdf",
        );
        let pre_s = String::from_utf8(pre.clone()).unwrap();
        assert!(pre_s.starts_with(
            "--BOUND\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nreport\r\n"
        ));
        assert!(pre_s.contains("name=\"directory_id\"\r\n\r\n7\r\n"));
        assert!(pre_s.ends_with(
            "--BOUND\r\nContent-Disposition: form-data; name=\"file\"; filename=\"report.pdf\"\r\nContent-Type: application/pdf\r\n\r\n"
        ));
        assert_eq!(String::from_utf8(epi.clone()).unwrap(), "\r\n--BOUND--\r\n");

        let size = 1234u64;
        assert_eq!(
            multipart_content_length(&pre, size, &epi),
            pre.len() as u64 + size + epi.len() as u64
        );
    }

    #[test]
    fn multipart_sanitizes_filename() {
        let (pre, _) = build_multipart("B", &[], "we\"ird\r\nname.txt", "text/plain");
        let pre_s = String::from_utf8(pre).unwrap();
        assert!(pre_s.contains("filename=\"we'ird__name.txt\""));
    }

    // Helper: the common case where the current hop IS the API endpoint and still
    // carries auth (the first download request).
    fn resolve_from_api(
        api_host: &str,
        api_port: u16,
        api_tls: bool,
        location: &str,
    ) -> (String, u16, bool, String, bool) {
        resolve_location(
            api_host, api_port, api_tls, true, api_host, api_port, api_tls, location,
        )
        .unwrap()
    }

    #[test]
    fn resolves_relative_location() {
        let (h, p, t, path, auth) = resolve_from_api("localhost", 8443, true, "/media/a.bin");
        assert_eq!(
            (h.as_str(), p, t, path.as_str(), auth),
            ("localhost", 8443, true, "/media/a.bin", true)
        );
    }

    #[test]
    fn resolves_absolute_location_same_host_keeps_auth() {
        let (h, p, t, path, auth) =
            resolve_from_api("localhost", 8443, true, "https://localhost:8443/media/a.bin");
        assert_eq!(
            (h.as_str(), p, t, path.as_str(), auth),
            ("localhost", 8443, true, "/media/a.bin", true)
        );
    }

    #[test]
    fn resolves_absolute_location_cross_host_drops_auth() {
        let (h, p, t, path, auth) =
            resolve_from_api("localhost", 8443, true, "http://cdn.example.com/media/a.bin");
        assert_eq!(
            (h.as_str(), p, t, path.as_str(), auth),
            ("cdn.example.com", 80, false, "/media/a.bin", false)
        );
        // No path in the absolute URL ⇒ "/".
        let (_, _, _, path, _) = resolve_from_api("localhost", 8443, true, "https://cdn.example.com");
        assert_eq!(path, "/");
    }

    #[test]
    fn same_host_different_port_drops_auth() {
        // Token must NOT be sent to another port on the same host.
        let (_, p, _, _, auth) =
            resolve_from_api("api.example.com", 8443, true, "https://api.example.com:9000/x");
        assert_eq!((p, auth), (9000, false));
    }

    #[test]
    fn https_to_http_downgrade_drops_auth() {
        // Same host+port but scheme downgrade ⇒ never send the token in cleartext.
        let (_, _, t, _, auth) =
            resolve_from_api("api.example.com", 443, true, "http://api.example.com:443/x");
        assert_eq!((t, auth), (false, false));
    }

    #[test]
    fn relative_hop_after_cross_host_keeps_auth_off() {
        // API 302 → CDN (auth dropped); CDN 302 → root-relative /files/x must stay on
        // the CDN and must NOT re-enable auth.
        let (h, p, t, path, auth) = resolve_location(
            "cdn.example.com", 443, true, false, // current hop = CDN, auth already off
            "api.example.com", 8443, true, // API endpoint (token owner)
            "/files/x",
        )
        .unwrap();
        assert_eq!(
            (h.as_str(), p, t, path.as_str(), auth),
            ("cdn.example.com", 443, true, "/files/x", false)
        );
    }

    #[test]
    fn protocol_relative_inherits_scheme_and_matches_api() {
        // "//api-host/path" on an https current hop ⇒ https, and equals the API ⇒ auth.
        let (h, p, t, path, auth) = resolve_location(
            "api.example.com", 8443, true, true,
            "api.example.com", 8443, true,
            "//api.example.com:8443/vault/x",
        )
        .unwrap();
        assert_eq!(
            (h.as_str(), p, t, path.as_str(), auth),
            ("api.example.com", 8443, true, "/vault/x", true)
        );
    }

    #[test]
    fn path_relative_stays_on_current_host() {
        // "media/x" (no leading slash) must resolve on the current host, not become
        // a hostname — and keep the current auth state.
        let (h, _, _, path, auth) =
            resolve_from_api("localhost", 8443, true, "media/x.bin");
        assert_eq!((h.as_str(), path.as_str(), auth), ("localhost", "/media/x.bin", true));
    }

    #[test]
    fn rejects_empty_location() {
        assert!(resolve_location("h", 1, true, true, "h", 1, true, "  ").is_err());
    }
}
