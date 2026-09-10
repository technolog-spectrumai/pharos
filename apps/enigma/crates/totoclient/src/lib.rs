//! Talking to a toto platform server.
//!
//! Lifted out of `limbo/cloud/src-tauri/src/cloud.rs` on 2026-09-10 and made a
//! crate, because `py_editor` and `tex_editor` both need it and `LIMBO.md` is
//! explicit that `normalize()` here and `normalizeServerUrl` in the TypeScript
//! client must keep agreeing — two copies is how that stops being true.
//!
//! **No `tauri` dependency**, the rule `substrate` states: this exports plain
//! functions and each app expands its own `#[tauri::command]` shims over them.
//!
//! This exists for three reasons a frontend cannot cover.
//!
//! * **The token must not be reachable from page JavaScript.** An editor opens
//!   files whose contents the user did not write. A token in `localStorage`
//!   could be read and sent away by a document somebody merely opened. Here it
//!   goes into the OS secret store and is only ever read back in this file, to
//!   be attached as `Authorization: Bearer …`. No function returns it.
//!
//! * **The webview cannot make the call at all.** The apps ship
//!   `connect-src 'self' ipc: http://ipc.localhost`, so a `fetch()` at a remote
//!   host is blocked before it reaches the network — silently, as CSP
//!   violations are. Widening that for a user-supplied origin means widening it
//!   to `https:`, which is the protection gone. Going out through `ipc:` into
//!   Rust is already allowed.
//!
//! * **A webview `fetch` cannot reach a server with an untrusted certificate,
//!   and cannot be told to.** WebKitGTK fails the request opaquely with no
//!   per-request override. Since the platform's own deployment ships a
//!   self-signed certificate by default, that path has to work — deliberately,
//!   visibly, and without disabling verification for everything else.
//!
//! The trust model is trust-on-first-use with pinning, not an "insecure" flag:
//! verification is normal, and a chain that fails is accepted **only** when the
//! leaf certificate matches a fingerprint the user was shown and accepted. If
//! the certificate later changes, the pin stops matching and the user is asked
//! again. That is the difference between trusting one server and trusting
//! whoever happens to be on the network.
//!
//! The pin itself is not a secret and is not stored here — the frontend keeps
//! it and passes it in. This module holds no persistent state of its own except
//! the token, which keeps the "what is stored where" question answerable.
//!
//! # What changed in the lift
//!
//! * **A pasted token replaced a username and password.** `connect()` verifies
//!   it against `/api/v1/me` and stores it; there is no password anywhere on
//!   this path, so a compromised editor has none to replay. Revoking on the
//!   server is immediate — the next call is a 401 and the session is cleared.
//! * **The keyring service is set by the app**, not a constant, so two editors
//!   pointed at two servers keep separate credentials.
//! * **`ALLOWED_PREFIXES` names `/api/v1/`**, the surface these apps actually
//!   use. It named the vault's routes before.

use std::sync::{Arc, Mutex, OnceLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::{DigitallySignedStruct, RootCertStore, SignatureScheme};
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Keyring service name, set once by the app at startup.
///
/// A CONSTANT PER APP, never anything the user typed — the service and account
/// of a keyring entry are stored in the clear, so only the server address (not
/// a secret) ends up visible there.
///
/// Set rather than hardcoded because two apps share this crate and must not
/// share a credential: `py_editor` and `tex_editor` are separate bundles a
/// person may point at different servers, and one shared service name would
/// make connecting one silently move the other.
///
/// **Changing an app's service name orphans anything a previous build stored** —
/// the entry stays on disk with nothing able to enumerate it. Pick it once,
/// from the bundle identifier, and leave it alone.
static KEYRING_SERVICE: OnceLock<String> = OnceLock::new();

/// Name this app's keyring service. Call once, before anything else.
///
/// Idempotent and last-write-loses: a second call with a different name is
/// ignored rather than swapping the store underneath a live session, which
/// would strand the first name's credential.
pub fn init(service: &str) {
    let _ = KEYRING_SERVICE.set(service.to_string());
}

fn service() -> &'static str {
    // A default rather than a panic: a library that aborts the app because a
    // startup line is missing turns a wiring mistake into a crash on launch.
    // The name is deliberately obvious in a keyring browser, so the mistake is
    // visible rather than silent.
    KEYRING_SERVICE.get().map(String::as_str).unwrap_or("totoclient.unconfigured")
}

/// Every request carries this, so a hung server cannot wedge the sign-in form.
const TIMEOUT_SECS: u64 = 20;

// ── the session ─────────────────────────────────────────────────────────────

/// What is kept for a connected server. Serialised as one JSON secret so the
/// username travels with the token it belongs to — two separate stores would be
/// two things to keep in step, and a username without its token is a lie.
///
/// `username` and `label` are what the SERVER said when the token was verified
/// (`GET /api/v1/me`), not anything the user typed. They exist so a connection
/// screen can say "janek, via the token you called Laptop" rather than showing
/// a bare URL — two machines signed into one account are otherwise
/// indistinguishable, and "revoke the one that says laptop" needs the label to
/// have travelled.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    token: String,
    username: String,
    #[serde(default)]
    label: String,
}

/// Where the token ended up. The distinction is shown to the user: a session
/// that will not survive a restart should say so rather than appear permanent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    /// The OS secret store.
    Keychain,
    /// This process only — no secret service was available.
    Memory,
}

/// The in-process fallback, used when the OS secret store is unreachable (a
/// bare window manager with no gnome-keyring or KWallet running is ordinary).
///
/// Deliberately NOT a file: falling back to disk would quietly deliver
/// something weaker than the storage the user was promised. Losing the session
/// on exit is honest, and the UI says so.
fn memory_store() -> &'static Mutex<Vec<(String, Session)>> {
    static STORE: OnceLock<Mutex<Vec<(String, Session)>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Vec::new()))
}

fn save_session(scope: &str, session: &Session) -> Storage {
    let encoded = match serde_json::to_string(session) {
        Ok(s) => s,
        Err(_) => return Storage::Memory,
    };
    if let Ok(entry) = keyring::Entry::new(service(), scope) {
        if entry.set_password(&encoded).is_ok() {
            // Drop any memory copy so the two cannot disagree.
            memory_store().lock().ok().map(|mut m| m.retain(|(s, _)| s != scope));
            return Storage::Keychain;
        }
    }
    if let Ok(mut mem) = memory_store().lock() {
        mem.retain(|(s, _)| s != scope);
        mem.push((scope.to_string(), session.clone()));
    }
    Storage::Memory
}

fn load_session(scope: &str) -> Option<(Session, Storage)> {
    if let Ok(entry) = keyring::Entry::new(service(), scope) {
        if let Ok(raw) = entry.get_password() {
            if let Ok(session) = serde_json::from_str::<Session>(&raw) {
                return Some((session, Storage::Keychain));
            }
        }
    }
    let mem = memory_store().lock().ok()?;
    mem.iter()
        .find(|(s, _)| s == scope)
        .map(|(_, session)| (session.clone(), Storage::Memory))
}

/// Clears both stores unconditionally. Called on sign-out AND on any 401: a
/// session the server has already discarded must never be reported as live.
fn clear_session(scope: &str) {
    if let Ok(entry) = keyring::Entry::new(service(), scope) {
        let _ = entry.delete_credential();
    }
    if let Ok(mut mem) = memory_store().lock() {
        mem.retain(|(s, _)| s != scope);
    }
}

// ── the server address ──────────────────────────────────────────────────────

/// The canonical form of a server URL — and the key the token is stored under.
///
/// FROZEN, and for a specific reason: this string is the keyring account name.
/// Change the rule and every stored token becomes unreadable — a silent logout
/// with the credential still sitting on disk, and nothing able to enumerate
/// what was orphaned. The frontend does not compute this; it stores whatever
/// this function returned, so the two can never drift apart.
///
/// Matches `normalizeServerUrl` in `packages/totoapi/src/api/client.ts` on the
/// SHAPE of the output — host, port only when non-default, no trailing slash —
/// so the string this returns is the one that keys the credential.
///
/// It is STRICTER in one way, and that asymmetry is deliberate rather than a
/// drift: this refuses anything but `https`, and the TypeScript does not. The
/// gate belongs here because this is the side that makes the connection; a
/// check that lived only in the frontend would be bypassed by anything else
/// that called in. The TypeScript one runs in tests against `http://` fixtures
/// and never opens a socket.
pub fn normalize(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("no_server: enter the server address".into());
    }
    let url = reqwest::Url::parse(trimmed).map_err(|_| "bad_url: that is not a web address".to_string())?;

    // https only, and refused HERE rather than in the form. A check that lives
    // only in the UI is bypassed by anything else that calls this command.
    if url.scheme() != "https" {
        return Err("insecure_scheme: the address must start with https://".into());
    }
    let host = url.host_str().ok_or("bad_url: that address has no host")?;
    // `Url::port()` is None when the port is the scheme's default, which is
    // exactly what the JS `URL.host` getter does.
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let path = url.path().trim_end_matches('/');
    Ok(format!("https://{authority}{path}"))
}

// ── certificate verification ────────────────────────────────────────────────

fn fingerprint_of(cert: &CertificateDer<'_>) -> String {
    let digest = Sha256::digest(cert.as_ref());
    digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn webpki_verifier() -> Arc<WebPkiServerVerifier> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .build()
    .expect("webpki verifier with the bundled roots")
}

/// Verifies normally; falls back to an exact fingerprint match.
///
/// The order matters. A pinned server whose certificate becomes properly
/// trusted keeps working, and a properly trusted server is never weakened by a
/// stale pin — the pin is only ever consulted for a chain that already failed.
#[derive(Debug)]
struct PinnedVerifier {
    inner: Arc<WebPkiServerVerifier>,
    pinned: Option<String>,
    /// Filled in with whatever the server presented, so a probe can report the
    /// fingerprint to show the user.
    seen: Mutex<Option<String>>,
}

impl PinnedVerifier {
    fn new(pinned: Option<String>) -> Arc<Self> {
        Arc::new(Self { inner: webpki_verifier(), pinned, seen: Mutex::new(None) })
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let presented = fingerprint_of(end_entity);
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(presented.clone());
        }
        match self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp, now) {
            Ok(ok) => Ok(ok),
            Err(err) => match &self.pinned {
                // Constant-time comparison is not needed — the fingerprint is
                // public information, presented by the server on every
                // handshake. What matters is that it is an EXACT match.
                Some(pin) if pin.eq_ignore_ascii_case(&presented) => Ok(ServerCertVerified::assertion()),
                _ => Err(err),
            },
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Records the certificate and accepts anything.
///
/// Used by ONE caller — the probe — whose entire job is to find out what a
/// server presents so the user can be asked about it. It never carries a
/// credential, which is what makes accepting-anything safe here: the worst an
/// impostor gets is an unauthenticated GET of a health endpoint.
#[derive(Debug)]
struct InspectingVerifier {
    inner: Arc<WebPkiServerVerifier>,
    seen: Mutex<Option<String>>,
    trusted: Mutex<bool>,
}

impl InspectingVerifier {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: webpki_verifier(),
            seen: Mutex::new(None),
            trusted: Mutex::new(false),
        })
    }
}

impl ServerCertVerifier for InspectingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(fingerprint_of(end_entity));
        }
        let ok = self
            .inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
            .is_ok();
        if let Ok(mut trusted) = self.trusted.lock() {
            *trusted = ok;
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

fn client_with(verifier: Arc<dyn ServerCertVerifier>) -> Result<reqwest::Client, String> {
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("tls_setup: {e}"))?
    .dangerous()
    .with_custom_certificate_verifier(verifier)
    .with_no_client_auth();

    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        // Redirects are refused rather than followed: a redirect would carry
        // the Authorization header to wherever it pointed. Nothing in the API
        // redirects, so this costs nothing and closes the hole.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("tls_setup: {e}"))
}

// ── what the frontend sees ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct Probe {
    reachable: bool,
    /// "trusted" | "untrusted" | "unknown" (never got far enough to see one)
    tls: String,
    fingerprint: Option<String>,
    /// A machine-readable reason, prefixed like the errors below.
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SessionInfo {
    signed_in: bool,
    username: Option<String>,
    /// Which token this is, as the person labelled it when they minted it.
    label: Option<String>,
    server: String,
    storage: Option<Storage>,
}

// ── commands ────────────────────────────────────────────────────────────────

/// Look at a server without committing anything to it.
///
/// This is what runs before the password field is worth showing: it says
/// whether the address answers at all and whether its certificate is trusted,
/// and — when it is not — hands back the fingerprint for the user to check.
pub async fn probe(server_url: String) -> Result<Probe, String> {
    let scope = normalize(&server_url)?;
    let verifier = InspectingVerifier::new();
    let client = client_with(verifier.clone())?;

    // `/api/health/` is the framework's own unauthenticated endpoint and is
    // NOT under `/api/v1/`. Deliberate: a probe runs before there is a token,
    // so it must reach something that does not need one. It also does not go
    // through `request()`, so the allowlist does not apply to it — which is
    // why the URL is built here from a normalised scope and a literal.
    let result = client.get(format!("{scope}/api/health/")).send().await;
    let fingerprint = verifier.seen.lock().ok().and_then(|s| s.clone());
    let trusted = verifier.trusted.lock().map(|t| *t).unwrap_or(false);

    match result {
        Ok(res) => Ok(Probe {
            reachable: res.status().is_success(),
            tls: if trusted { "trusted".into() } else { "untrusted".into() },
            fingerprint,
            reason: if res.status().is_success() {
                None
            } else {
                Some(format!("http_{}", res.status().as_u16()))
            },
        }),
        Err(err) => Ok(Probe {
            reachable: false,
            // A fingerprint means the handshake got far enough to show us one,
            // so the failure was not TLS.
            tls: if fingerprint.is_some() {
                if trusted { "trusted".into() } else { "untrusted".into() }
            } else {
                "unknown".into()
            },
            fingerprint,
            reason: Some(format!("unreachable: {err}")),
        }),
    }
}

/// Verify a pasted capsule API token and remember it.
///
/// THE TOKEN IS A PARAMETER AND NOTHING ELSE on the way in: it is written
/// straight to the OS secret store and never returned by any function here.
/// The caller clears its own field as soon as this returns.
///
/// **Verified before it is stored**, by the call that also identifies it. A
/// connect screen that accepted a token without asking the server would show a
/// signed-in state it loses on the very next call, and the user would have no
/// idea whether they mistyped or the server is down. `/api/v1/me` answers both
/// questions in one round trip — 401 means the token is wrong, a transport
/// error means the server is unreachable, and they need different actions.
pub async fn connect(
    server_url: String,
    token: String,
    fingerprint: Option<String>,
) -> Result<SessionInfo, String> {
    let scope = normalize(&server_url)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("no_token: paste the token from the Compute Capsules desk".into());
    }
    // Shape only, and shallow on purpose: the SERVER decides whether a token is
    // live. A stricter check here would be a second rule that could disagree
    // with `tokens.py`, which is the one that matters. What this catches is the
    // ordinary mistake — a pasted URL, a truncated copy — before a round trip.
    if !token.starts_with("capsule.") || token.split('.').count() != 3 {
        return Err("bad_token_shape: that does not look like a capsule token — \
                    it should start with `capsule.`".into());
    }

    let client = client_with(PinnedVerifier::new(fingerprint))?;
    let res = client
        .get(format!("{scope}/api/v1/me"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| classify_transport(&e))?;

    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("bad_token: that token is not valid, or it has been revoked \
                    or has expired".into());
    }
    if !status.is_success() {
        let detail = body.get("error").and_then(|e| e.as_str()).unwrap_or("");
        return Err(format!("server_{}: {}", status.as_u16(), detail));
    }

    let username = body
        .get("username")
        .and_then(|u| u.as_str())
        .unwrap_or("")
        .to_string();
    let label = body
        .get("token")
        .and_then(|t| t.get("label"))
        .and_then(|l| l.as_str())
        .unwrap_or("")
        .to_string();

    let storage = save_session(
        &scope,
        &Session { token, username: username.clone(), label: label.clone() },
    );
    Ok(SessionInfo {
        signed_in: true,
        username: Some(username),
        label: Some(label),
        server: scope,
        storage: Some(storage),
    })
}

/// Forget the stored token. Local only, and the wording matters.
///
/// **This is not revocation and must not be presented as one.** A capsule token
/// lives until somebody revokes it on the server's Compute Capsules desk; all
/// this does is stop THIS machine holding a copy. Telling a user they had
/// "signed out" when the credential is still valid elsewhere would be a lie in
/// exactly the direction that matters.
///
/// The old `POST /api/logout/` call went with the password flow: it discarded a
/// Django session key, which is a thing that can be discarded. A token is not.
pub fn forget(server_url: String) -> Result<(), String> {
    // Normalise leniently: an address that no longer parses still has a stored
    // credential under whatever string it was, and refusing to clear it would
    // strand exactly the person trying to tidy up.
    if let Ok(scope) = normalize(&server_url) {
        clear_session(&scope);
    }
    Ok(())
}

/// The reply from an API call, handed back for the frontend's own error
/// taxonomy to classify. The status is passed through rather than turned into
/// a Result: a 404 and a 402 are both meaningful answers, not failures.
#[derive(Debug, Serialize)]
pub struct ApiReply {
    status: u16,
    body: String,
}

/// The only paths this proxy will carry.
///
/// This is NOT a general-purpose HTTP client, and the difference matters. Page
/// script cannot read the token, but it CAN `invoke` — an editor opens files
/// whose contents the user did not write, so a hostile document reaching this
/// command is the case to bound. An allowlist keeps the worst case to the
/// user's own workspaces rather than every endpoint on the server, and makes
/// "what can this command touch?" answerable by reading one line.
///
/// `/api/v1/` and nothing else. It named the vault's routes when this was
/// zinnia's Cloud tab; those endpoints are a different surface with a different
/// permission model and these apps do not use them. Adding a prefix here is
/// widening the blast radius of every document either app opens — do it
/// deliberately or not at all.
const ALLOWED_PREFIXES: &[&str] = &["/api/v1/"];

/// Bodies bigger than this are refused before anything is sent. The vault's own
/// editable-file ceiling is 2 MB; this leaves room for JSON overhead without
/// letting a caller stream something unbounded through the IPC channel.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

fn check_path(path: &str) -> Result<(), String> {
    // Anchored, and traversal refused: `/vault/api/../../admin/` would pass a
    // naive prefix test and reach somewhere it has no business.
    if !path.starts_with('/') || path.contains("..") {
        return Err("forbidden_path: that path is not allowed".into());
    }
    if ALLOWED_PREFIXES.iter().any(|p| path.starts_with(p)) {
        return Ok(());
    }
    Err("forbidden_path: that path is not allowed".into())
}

/// Make an authenticated call on the user's behalf.
///
/// The token is attached here and never leaves; the caller sees only status and
/// body. A 401 means the server has discarded the session, so it is cleared
/// centrally — the same rule `cloud_logout` follows, so a dead session can
/// never keep being reported as live.
pub async fn request(
    server_url: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    fingerprint: Option<String>,
) -> Result<ApiReply, String> {
    let scope = normalize(&server_url)?;
    check_path(&path)?;

    let verb = method.to_ascii_uppercase();
    if !matches!(verb.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return Err("bad_method: that method is not allowed".into());
    }

    let (session, _) = load_session(&scope).ok_or("unauthorized: not signed in")?;

    let encoded = match &body {
        Some(value) => {
            let text = serde_json::to_string(value).map_err(|e| format!("bad_body: {e}"))?;
            if text.len() > MAX_BODY_BYTES {
                return Err("too_large: that is too big to send".into());
            }
            Some(text)
        }
        None => None,
    };

    let client = client_with(PinnedVerifier::new(fingerprint))?;
    let mut request = client
        .request(
            reqwest::Method::from_bytes(verb.as_bytes()).map_err(|_| "bad_method".to_string())?,
            format!("{scope}{path}"),
        )
        .header("Authorization", format!("Bearer {}", session.token))
        // Load-bearing: the platform's subscription gate keys its JSON-vs-HTML
        // refusal on this header, so without it a 402 arrives as a web page.
        .header("Accept", "application/json");

    if let Some(text) = encoded {
        request = request.header("Content-Type", "application/json").body(text);
    }

    let res = request.send().await.map_err(|e| classify_transport(&e))?;
    let status = res.status().as_u16();
    if status == 401 {
        clear_session(&scope);
    }
    // Read as text, not JSON: Django answers some failures with an HTML page,
    // and the frontend's classifier already copes with a body it cannot parse.
    let body = res.text().await.unwrap_or_default();
    Ok(ApiReply { status, body })
}

/// Who we are, without touching the network.
///
/// Local only on purpose: this runs on every launch and every tab switch, and
/// a version that called the server would make the UI depend on reachability
/// to answer a question about local state.
pub fn status(server_url: String) -> Result<SessionInfo, String> {
    let scope = match normalize(&server_url) {
        Ok(scope) => scope,
        // An unusable stored address is simply "not signed in" — reporting it
        // as an error would put the tab in a failure state on every launch.
        Err(_) => {
            return Ok(SessionInfo {
                signed_in: false, username: None, label: None,
                server: String::new(), storage: None,
            })
        }
    };
    match load_session(&scope) {
        Some((session, storage)) => Ok(SessionInfo {
            signed_in: true,
            username: Some(session.username),
            label: Some(session.label),
            server: scope,
            storage: Some(storage),
        }),
        None => Ok(SessionInfo {
            signed_in: false, username: None, label: None,
            server: scope, storage: None,
        }),
    }
}

/// Transport failures the UI needs to tell apart, given the prefixes it
/// switches on. A certificate rejection is the one worth naming: it is the
/// difference between "your server is down" and "check this fingerprint".
fn classify_transport(err: &reqwest::Error) -> String {
    let text = err.to_string();
    let lower = text.to_lowercase();
    if lower.contains("certificate") || lower.contains("tls") || lower.contains("handshake") {
        format!("untrusted_cert: {text}")
    } else if err.is_timeout() {
        format!("timeout: {text}")
    } else {
        format!("unreachable: {text}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_anything_that_is_not_https() {
        // Enforced here rather than in the form: a UI-only check is bypassed by
        // anything else that can invoke the command.
        for url in ["http://server.test", "ftp://server.test", "ws://server.test"] {
            let err = normalize(url).unwrap_err();
            assert!(err.starts_with("insecure_scheme"), "{url} gave {err}");
        }
    }

    #[test]
    fn refuses_junk_and_emptiness() {
        assert!(normalize("").unwrap_err().starts_with("no_server"));
        assert!(normalize("   ").unwrap_err().starts_with("no_server"));
        assert!(normalize("not a url").unwrap_err().starts_with("bad_url"));
    }

    #[test]
    fn agrees_with_the_frontend_normalizer() {
        // These pairs are the contract with normalizeServerUrl in
        // src/api/client.ts. The two must not drift: this string is the keyring
        // account name, so a disagreement is a silent logout with the token
        // still on disk.
        let cases = [
            ("https://server.test", "https://server.test"),
            ("https://server.test/", "https://server.test"),
            ("https://server.test///", "https://server.test"),
            ("  https://server.test  ", "https://server.test"),
            ("HTTPS://Server.Test", "https://server.test"),
            ("https://server.test:8443", "https://server.test:8443"),
            // The default port is dropped, exactly as the JS URL.host getter
            // does — otherwise one server would key two different tokens.
            ("https://server.test:443", "https://server.test"),
            ("https://server.test/toto/", "https://server.test/toto"),
        ];
        for (input, want) in cases {
            assert_eq!(normalize(input).unwrap(), want, "input {input}");
        }
    }

    #[test]
    fn fingerprints_match_what_openssl_prints() {
        // A known answer, so the format cannot drift away from the thing the
        // user is asked to compare it against. `openssl x509 -fingerprint
        // -sha256` prints SHA-256 over the DER as uppercase hex pairs joined by
        // colons, which is what this produces — checked against the platform's
        // own certificate, where both agreed byte for byte.
        assert_eq!(
            fingerprint_of(&CertificateDer::from(vec![1, 2, 3])),
            "03:90:58:C6:F2:C0:CB:49:2C:53:3B:0A:4D:14:EF:77:\
             CC:0F:78:AB:CC:CE:D5:28:7D:84:A1:A2:01:1C:FB:81"
                .replace(['\n', ' '], ""),
        );
    }

    #[test]
    fn fingerprints_are_stable_and_readable() {
        // Uppercase hex with colons, so it can be compared by eye against
        // `openssl x509 -noout -fingerprint -sha256`.
        let cert = CertificateDer::from(vec![1, 2, 3]);
        let fp = fingerprint_of(&cert);
        assert_eq!(fp.len(), 32 * 3 - 1);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit() || c == ':'));
        assert_eq!(fp, fingerprint_of(&cert));
        assert_ne!(fp, fingerprint_of(&CertificateDer::from(vec![1, 2, 4])));
    }

    #[test]
    fn the_proxy_carries_only_allowlisted_paths() {
        // The command is reachable by any page script — a hostile document
        // cannot read the token but can still invoke. The allowlist is what
        // keeps that to the user's own workspaces instead of the whole server.
        for ok in [
            "/api/v1/me", "/api/v1/pool", "/api/v1/capsules",
            "/api/v1/workspaces/notebook/tree",
            "/api/v1/workspaces/notebook/files/7/save",
            "/api/v1/jobs/abc/logs?offset=0",
        ] {
            assert!(check_path(ok).is_ok(), "{ok} should be allowed");
        }
        for bad in [
            "/admin/", "/sso/api/register/", "/api/login/", "/api/logout/",
            // The VAULT's routes. Allowed when this was zinnia's Cloud tab and
            // deliberately not now: a different surface with a different
            // permission model, which these apps do not use. Listed here so a
            // revival cannot quietly re-widen the proxy.
            "/vault/api/files/", "/api/me/", "/api/apps/",
            "api/v1/pool",                 // unanchored
            "/api/v1/../../admin/",        // traversal past the prefix
            "//evil.test/api/v1/",         // protocol-relative
            "",
        ] {
            assert!(check_path(bad).is_err(), "{bad} should be refused");
        }
    }

    /// EVERYTHING THAT TOUCHES THE GLOBAL STORE, IN ONE TEST, ON PURPOSE.
    ///
    /// `KEYRING_SERVICE` is a process-wide `OnceLock` and the keyring is a
    /// process-wide side effect, so a separate `#[test]` calling `init()` races
    /// the ones that save and load: cargo runs tests in parallel, the service
    /// name changes between a save and its load, and the load misses. That is
    /// exactly what happened when these were three tests — intermittently,
    /// which is the worst way to find out.
    ///
    /// Merged rather than serialised with a mutex because the ordering is the
    /// point: `init()` must come first, and a reader should see that.
    #[test]
    fn the_store_and_the_service_name() {
        // -- the service name is whatever the app set ----------------------
        //
        // Two apps share this crate and must not share a credential.
        //
        // NOT ASSERTED: that `service()` starts as the unconfigured
        // placeholder. It is a process-wide `OnceLock`, so ANY test that calls
        // `init()` first makes that false — and one does, in the guard test
        // below. Asserting it made this fail intermittently depending on which
        // test cargo scheduled first, which is the worst shape of failure.
        // The fallback is one `unwrap_or` and is visible in a keyring browser
        // by design; what is worth pinning is the part with a decision in it.
        init("com.example.totoclient-tests");
        assert_eq!(service(), "com.example.totoclient-tests");
        // Idempotent and last-write-LOSES: a second name must not swap the
        // store underneath a live session and strand the first one's entry.
        init("com.example.other");
        assert_eq!(service(), "com.example.totoclient-tests");

        // -- a session round trips and clears ------------------------------
        //
        // Exercises whichever store is available on this machine; on a runner
        // with no secret service that is the in-memory one, which is the point
        // of it existing.
        let scope = "https://round-trip.test";
        clear_session(scope);
        assert!(load_session(scope).is_none());

        let storage = save_session(scope, &Session {
            token: "t0ken".into(), username: "ada".into(), label: "laptop".into(),
        });
        let (loaded, back) = load_session(scope).expect("session present after save");
        assert_eq!(loaded.token, "t0ken");
        assert_eq!(loaded.username, "ada");
        assert_eq!(loaded.label, "laptop");
        assert_eq!(storage, back);

        clear_session(scope);
        assert!(load_session(scope).is_none(), "clearing must leave nothing behind");

        // -- forget() is local only ----------------------------------------
        //
        // A capsule token lives until somebody revokes it on the server's desk;
        // this stops THIS machine holding a copy. It must never be presented
        // as revocation.
        save_session(scope, &Session {
            token: "t".into(), username: "ada".into(), label: "l".into(),
        });
        assert!(load_session(scope).is_some());
        forget("https://round-trip.test/".into()).unwrap();
        assert!(load_session(scope).is_none());

        // An address that no longer parses still has a credential under
        // whatever string it was; refusing would strand the person tidying up.
        assert!(forget("not a url".into()).is_ok());
        assert!(forget("".into()).is_ok());
    }

    /// `request`'s GUARDS, which run before any socket is opened.
    ///
    /// The whole function is reachable from page script — a hostile document
    /// cannot read the token but CAN invoke — so what it refuses is the
    /// security boundary, and every refusal below happens before the network.
    ///
    /// One test again, and for the same reason as the store test above: these
    /// need a session in the process-wide store, so running them beside the
    /// one that clears it would race.
    #[tokio::test]
    async fn request_refuses_before_it_reaches_the_network() {
        init("com.example.totoclient-tests");
        let server = "https://guards.test";
        clear_session(server);

        // -- no session: refused before anything is built ------------------
        let err = request(server.into(), "GET".into(), "/api/v1/pool".into(),
                          None, None).await.unwrap_err();
        assert!(err.starts_with("unauthorized"), "{err}");

        save_session(server, &Session {
            token: "t".into(), username: "ada".into(), label: "l".into(),
        });

        // -- a path outside the allowlist ----------------------------------
        for bad in ["/admin/", "/vault/api/files/", "/api/v1/../../admin/"] {
            let err = request(server.into(), "GET".into(), bad.into(), None, None)
                .await.unwrap_err();
            assert!(err.starts_with("forbidden_path"), "{bad} gave {err}");
        }

        // -- a method nobody should be able to reach for -------------------
        //
        // TRACE and CONNECT in particular: neither is something this API
        // offers, and both are the kind of verb a proxy is asked for when
        // somebody is probing what it will forward.
        for bad in ["TRACE", "CONNECT", "OPTIONS", "HEAD", "BREW"] {
            let err = request(server.into(), bad.into(), "/api/v1/pool".into(),
                              None, None).await.unwrap_err();
            assert!(err.starts_with("bad_method"), "{bad} gave {err}");
        }

        // -- case does not smuggle one past ---------------------------------
        // The verb is upper-cased before the match, so "get" is a GET rather
        // than a refusal — and "trace" is still refused.
        let err = request(server.into(), "trace".into(), "/api/v1/pool".into(),
                          None, None).await.unwrap_err();
        assert!(err.starts_with("bad_method"), "{err}");

        // -- an unbounded body ----------------------------------------------
        //
        // Refused BEFORE anything is sent. The IPC channel would otherwise
        // carry whatever a caller handed it straight into memory here.
        let huge = serde_json::json!({ "x": "y".repeat(MAX_BODY_BYTES + 1) });
        let err = request(server.into(), "POST".into(), "/api/v1/pool".into(),
                          Some(huge), None).await.unwrap_err();
        assert!(err.starts_with("too_large"), "{err}");

        // -- a scheme that is not https --------------------------------------
        let err = request("http://guards.test".into(), "GET".into(),
                          "/api/v1/pool".into(), None, None).await.unwrap_err();
        assert!(err.starts_with("insecure_scheme"), "{err}");

        clear_session(server);
    }

    #[test]
    fn status_reports_an_unusable_address_as_signed_out() {
        // Not as an error: this runs on every launch, and a stored address that
        // no longer parses should not put the tab into a failure state.
        let info = status("http://not-https.test".into()).unwrap();
        assert!(!info.signed_in);
        assert!(info.username.is_none());
    }
}
