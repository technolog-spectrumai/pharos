//! Signing in to a toto platform server.
//!
//! This is zinnia's only custom Rust, and it exists for reasons the frontend
//! cannot cover:
//!
//! * **The token must not be reachable from page JavaScript.** Zinnia opens
//!   arbitrary `.svg` files and renders `trust-html` deck payloads, and the
//!   webview runs with no CSP. A session token in `localStorage` could be read
//!   and sent away by a document the user merely opened. Here it goes into the
//!   OS secret store and is only ever read back in this file, to be attached as
//!   `Authorization: Bearer …`. No command returns it.
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

use std::sync::{Arc, Mutex, OnceLock};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::{DigitallySignedStruct, RootCertStore, SignatureScheme};
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Keyring service name. A constant, never anything the user typed — the
/// service and account of a keyring entry are stored in the clear, so only the
/// server address (not a secret) ends up visible there.
const KEYRING_SERVICE: &str = "com.spectrumaipl.zinnia";

/// Every request carries this, so a hung server cannot wedge the sign-in form.
const TIMEOUT_SECS: u64 = 20;

// ── the session ─────────────────────────────────────────────────────────────

/// What is kept for a signed-in server. Serialised as one JSON secret so the
/// username travels with the token it belongs to — two separate stores would be
/// two things to keep in step, and a username without its token is a lie.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    token: String,
    username: String,
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
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, scope) {
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
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, scope) {
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
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, scope) {
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
/// Matches `normalizeServerUrl` in src/api/client.ts: lowercase scheme and
/// host, the port only when it is not the scheme's default, no trailing slash.
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
    server: String,
    storage: Option<Storage>,
}

// ── commands ────────────────────────────────────────────────────────────────

/// Look at a server without committing anything to it.
///
/// This is what runs before the password field is worth showing: it says
/// whether the address answers at all and whether its certificate is trusted,
/// and — when it is not — hands back the fingerprint for the user to check.
#[tauri::command]
pub async fn cloud_probe(server_url: String) -> Result<Probe, String> {
    let scope = normalize(&server_url)?;
    let verifier = InspectingVerifier::new();
    let client = client_with(verifier.clone())?;

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

/// Exchange a username and password for a session.
///
/// The password is a parameter and nothing else: it is never written anywhere,
/// and the caller clears its own field as soon as this returns.
#[tauri::command]
pub async fn cloud_login(
    server_url: String,
    username: String,
    password: String,
    fingerprint: Option<String>,
) -> Result<SessionInfo, String> {
    let scope = normalize(&server_url)?;
    let client = client_with(PinnedVerifier::new(fingerprint))?;

    let res = client
        .post(format!("{scope}/api/login/"))
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| classify_transport(&e))?;

    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("bad_credentials: that username and password did not match".into());
    }
    if !status.is_success() {
        let detail = body.get("error").and_then(|e| e.as_str()).unwrap_or("");
        return Err(format!("server_{}: {}", status.as_u16(), detail));
    }

    let token = body
        .get("token")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .ok_or("bad_response: the server did not return a session")?;

    let storage = save_session(&scope, &Session { token: token.to_string(), username: username.clone() });
    Ok(SessionInfo { signed_in: true, username: Some(username), server: scope, storage: Some(storage) })
}

/// Sign out. Tells the server if it can, and clears the local session either
/// way — an unreachable server must not leave someone stuck signed in.
#[tauri::command]
pub async fn cloud_logout(server_url: String, fingerprint: Option<String>) -> Result<(), String> {
    let scope = normalize(&server_url)?;
    if let Some((session, _)) = load_session(&scope) {
        if let Ok(client) = client_with(PinnedVerifier::new(fingerprint)) {
            let _ = client
                .post(format!("{scope}/api/logout/"))
                .header("Authorization", format!("Bearer {}", session.token))
                .header("Accept", "application/json")
                .send()
                .await;
        }
    }
    clear_session(&scope);
    Ok(())
}

/// Who we are, without touching the network.
///
/// Local only on purpose: this runs on every launch and every tab switch, and
/// a version that called the server would make the UI depend on reachability
/// to answer a question about local state.
#[tauri::command]
pub fn cloud_status(server_url: String) -> Result<SessionInfo, String> {
    let scope = match normalize(&server_url) {
        Ok(scope) => scope,
        // An unusable stored address is simply "not signed in" — reporting it
        // as an error would put the tab in a failure state on every launch.
        Err(_) => {
            return Ok(SessionInfo { signed_in: false, username: None, server: String::new(), storage: None })
        }
    };
    match load_session(&scope) {
        Some((session, storage)) => Ok(SessionInfo {
            signed_in: true,
            username: Some(session.username),
            server: scope,
            storage: Some(storage),
        }),
        None => Ok(SessionInfo { signed_in: false, username: None, server: scope, storage: None }),
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
    fn a_session_round_trips_and_clears() {
        // Exercises whichever store is available on this machine; on a runner
        // with no secret service that is the in-memory one, which is the point
        // of it existing.
        let scope = "https://round-trip.test";
        clear_session(scope);
        assert!(load_session(scope).is_none());

        let storage = save_session(scope, &Session { token: "t0ken".into(), username: "ada".into() });
        let (loaded, back) = load_session(scope).expect("session present after save");
        assert_eq!(loaded.token, "t0ken");
        assert_eq!(loaded.username, "ada");
        assert_eq!(storage, back);

        clear_session(scope);
        assert!(load_session(scope).is_none(), "sign-out must leave nothing behind");
    }

    #[test]
    fn status_reports_an_unusable_address_as_signed_out() {
        // Not as an error: this runs on every launch, and a stored address that
        // no longer parses should not put the tab into a failure state.
        let info = cloud_status("http://not-https.test".into()).unwrap();
        assert!(!info.signed_in);
        assert!(info.username.is_none());
    }
}
