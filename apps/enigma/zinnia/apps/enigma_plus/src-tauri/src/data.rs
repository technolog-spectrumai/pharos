// Rust-owned HTTP gateway.
//
// The Vue frontend no longer does `fetch` directly: it calls `data_http` /
// `data_upload`, and Rust resolves the server URL + auth token (from the profile
// state), applies the silent-mode gate, performs the request with `reqwest`, and
// maintains a read-through response cache so previously-loaded data stays
// browsable offline / in silent mode.
//
// The cache is a simple on-disk store (one file per (server, path)) — pure files,
// no SQLite. The app avoids libsqlite3-sys everywhere except the one arti pulls in
// (tor-dirmgr/rusqlite) for the embedded Tor client; the local KV cache is fjall
// (see kv.rs), so there is no `libsqlite3-sys` `links = "sqlite3"` collision.

use std::collections::HashMap;
use std::path::PathBuf;

use reqwest::Client;
use tauri::{AppHandle, Manager, State};

use crate::{active_config, load_profile_state, AppConfigState};

pub const SERVER_OFF: &str = "Server data is off (offline or server-data switch).";
pub const SILENT_NO_CACHE: &str =
    "No offline copy of this data — connect once to download it.";
pub const NO_SERVER: &str = "No server configured — set a server address in Settings.";

pub struct DataState {
    client: Client,
    cache_dir: PathBuf,
}

pub fn init(app: &AppHandle) -> DataState {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let cache_dir = base.join("httpcache");
    let _ = std::fs::create_dir_all(&cache_dir);
    DataState {
        client: Client::new(),
        cache_dir,
    }
}

// ── cache helpers ───────────────────────────────────────────────────────────

fn enc(s: &str) -> String {
    // base32 keeps filenames safe across platforms.
    data_encoding::BASE32_NOPAD.encode(s.as_bytes())
}

fn scope_of(server_url: &str) -> String {
    let trimmed = server_url.trim_end_matches('/');
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

fn scope_dir(data: &DataState, scope: &str) -> PathBuf {
    data.cache_dir.join(enc(scope))
}

fn cache_get(data: &DataState, scope: &str, path: &str) -> Option<String> {
    let file = scope_dir(data, scope).join(enc(path));
    std::fs::read_to_string(file).ok()
}

fn cache_put(data: &DataState, scope: &str, path: &str, body: &str) {
    let dir = scope_dir(data, scope);
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(dir.join(enc(path)), body);
    }
}

// ── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn data_http(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    data: State<'_, DataState>,
    tor: State<'_, crate::tor::TorState>,
    method: String,
    path: String,
    body: Option<String>,
    include_auth: bool,
) -> Result<String, String> {
    let cfg = active_config(&config)?;
    let state = load_profile_state(&app, &cfg);
    let scope = scope_of(&state.server_url);
    let base = state.server_url.trim_end_matches('/').to_string();
    let is_get = method.eq_ignore_ascii_case("GET");

    // Server data off (or offline): serve reads from the local copy, block writes.
    if crate::data_blocked(&state) {
        if !is_get {
            return Err(SERVER_OFF.to_string());
        }
        return cache_get(&data, &scope, &path).ok_or_else(|| SILENT_NO_CACHE.to_string());
    }

    if base.is_empty() {
        return Err(NO_SERVER.to_string());
    }

    // Onion servers go through the embedded Tor client (hyper over a Tor stream);
    // everything else uses the pooled reqwest client directly.
    let (status_code, text) = if state.server_is_onion {
        let (host, port) = crate::tor::host_port(&base)?;
        let mut headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("X-Requested-With".to_string(), "XMLHttpRequest".to_string()),
        ];
        if include_auth {
            if let Some(token) = &state.auth_token {
                headers.push(("Authorization".to_string(), format!("Bearer {token}")));
            }
        }
        let body_bytes = body.unwrap_or_default().into_bytes();
        let tls = base.starts_with("https");
        let (code, bytes) = tor
            .http_request(&host, port, tls, &method, &path, &headers, body_bytes)
            .await?;
        (code, String::from_utf8_lossy(&bytes).into_owned())
    } else {
        let url = format!("{base}{path}");
        let verb = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut req = data
            .client
            .request(verb, &url)
            .header("Content-Type", "application/json")
            .header("X-Requested-With", "XMLHttpRequest");
        if include_auth {
            if let Some(token) = &state.auth_token {
                req = req.bearer_auth(token);
            }
        }
        if let Some(b) = body {
            req = req.body(b);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        (status.as_u16(), text)
    };

    if !(200..300).contains(&status_code) {
        return Err(format!("{}: {}", status_code, text));
    }
    if !text.is_empty() && serde_json::from_str::<serde_json::Value>(&text).is_err() {
        return Err(format!(
            "Server returned a non-JSON response (HTTP {}). Check the server address in Settings.",
            status_code
        ));
    }

    if is_get {
        cache_put(&data, &scope, &path, &text);
    }
    Ok(text)
}

/// Build a `multipart/form-data` body by hand (the onion HTTP path uses hyper,
/// which has no multipart helper). Returns (content-type header, body bytes).
fn build_multipart(
    field: &str,
    filename: &str,
    bytes: &[u8],
    content_type: &str,
    extra: Option<&HashMap<String, String>>,
) -> (String, Vec<u8>) {
    let boundary = format!("----enigma{}", uuid::Uuid::new_v4().simple());
    let mut body: Vec<u8> = Vec::new();
    if let Some(fields) = extra {
        for (k, v) in fields {
            body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{k}\"\r\n\r\n").as_bytes(),
            );
            body.extend_from_slice(v.as_bytes());
            body.extend_from_slice(b"\r\n");
        }
    }
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// Resolve the MIME type for an uploaded part. Trust the caller-provided type
/// (the browser's `File.type`) when it's usable, otherwise sniff the bytes, and
/// finally fall back to a generic binary type. Without this, parts default to
/// `application/octet-stream` and the server rejects images as an unsupported type.
fn effective_mime(provided: Option<&str>, bytes: &[u8]) -> String {
    if let Some(ct) = provided {
        let ct = ct.trim();
        if !ct.is_empty() && ct != "application/octet-stream" {
            return ct.to_string();
        }
    }
    sniff_image_mime(bytes).to_string()
}

#[tauri::command]
pub async fn data_upload(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    data: State<'_, DataState>,
    tor: State<'_, crate::tor::TorState>,
    path: String,
    field: String,
    filename: String,
    bytes: Vec<u8>,
    content_type: Option<String>,
    extra: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let cfg = active_config(&config)?;
    let state = load_profile_state(&app, &cfg);
    if crate::data_blocked(&state) {
        return Err(SERVER_OFF.to_string());
    }
    let base = state.server_url.trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err(NO_SERVER.to_string());
    }

    // Onion uploads: build the multipart body by hand and send it over Tor.
    let mime = effective_mime(content_type.as_deref(), &bytes);
    if state.server_is_onion {
        let (host, port) = crate::tor::host_port(&base)?;
        let (multipart_ct, body_bytes) = build_multipart(&field, &filename, &bytes, &mime, extra.as_ref());
        let mut headers = vec![
            ("Content-Type".to_string(), multipart_ct),
            ("X-Requested-With".to_string(), "XMLHttpRequest".to_string()),
        ];
        if let Some(token) = &state.auth_token {
            headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        let tls = base.starts_with("https");
        let (status, resp_bytes) = tor
            .http_request(&host, port, tls, "POST", &path, &headers, body_bytes)
            .await?;
        let text = String::from_utf8_lossy(&resp_bytes).into_owned();
        if !(200..300).contains(&status) {
            return Err(format!("{}: {}", status, text));
        }
        return Ok(text);
    }

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new().part(field, part);
    if let Some(fields) = extra {
        for (k, v) in fields {
            form = form.text(k, v);
        }
    }

    let url = format!("{base}{path}");
    let mut req = data
        .client
        .post(&url)
        .header("X-Requested-With", "XMLHttpRequest")
        .multipart(form);
    if let Some(token) = &state.auth_token {
        req = req.bearer_auth(token);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{}: {}", status.as_u16(), text));
    }
    Ok(text)
}

/// Fetch a vault image over the active transport (Tor-aware) and return it as a
/// `data:` URL. The webview can't load a `.onion` (or cross-origin) image directly,
/// so image display goes through Rust — same reason as the data gateway.
#[tauri::command]
pub async fn vault_image_data_url(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    data: State<'_, DataState>,
    tor: State<'_, crate::tor::TorState>,
    path: String,
) -> Result<String, String> {
    let cfg = active_config(&config)?;
    let state = load_profile_state(&app, &cfg);
    if crate::data_blocked(&state) {
        return Err(SERVER_OFF.to_string());
    }
    let base = state.server_url.trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err(NO_SERVER.to_string());
    }

    // download_url may be absolute (http://host/..) or server-relative (/vault/..).
    // Reduce to a server-relative path so it rides the active transport (incl. onion).
    let rel = match path.find("://") {
        Some(i) => match path[i + 3..].find('/') {
            Some(slash) => path[i + 3 + slash..].to_string(),
            None => "/".to_string(),
        },
        None => path.clone(),
    };

    let (status, bytes) = if state.server_is_onion {
        let (host, port) = crate::tor::host_port(&base)?;
        let tls = base.starts_with("https");
        let mut headers = vec![("X-Requested-With".to_string(), "XMLHttpRequest".to_string())];
        if let Some(token) = &state.auth_token {
            headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        tor.http_request(&host, port, tls, "GET", &rel, &headers, Vec::new())
            .await?
    } else {
        let url = format!("{base}{rel}");
        let mut req = data
            .client
            .get(&url)
            .header("X-Requested-With", "XMLHttpRequest");
        if let Some(token) = &state.auth_token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let b = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
        (status, b)
    };

    if !(200..300).contains(&status) {
        return Err(format!("{}: image fetch failed", status));
    }
    let mime = sniff_image_mime(&bytes);
    let b64 = data_encoding::BASE64.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 11 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.windows(4).take(64).any(|w| w == b"<svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

#[tauri::command]
pub fn data_cache_count(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    data: State<'_, DataState>,
    server_url: Option<String>,
) -> Result<u64, String> {
    let scope = resolve_scope(&app, &config, server_url)?;
    let dir = scope_dir(&data, &scope);
    let count = std::fs::read_dir(dir)
        .map(|rd| rd.filter(|e| e.is_ok()).count() as u64)
        .unwrap_or(0);
    Ok(count)
}

#[tauri::command]
pub fn data_cache_clear(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    data: State<'_, DataState>,
    server_url: Option<String>,
) -> Result<(), String> {
    let scope = resolve_scope(&app, &config, server_url)?;
    let dir = scope_dir(&data, &scope);
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn resolve_scope(
    app: &AppHandle,
    config: &State<'_, AppConfigState>,
    server_url: Option<String>,
) -> Result<String, String> {
    let url = match server_url {
        Some(u) => u,
        None => {
            let cfg = active_config(config)?;
            load_profile_state(app, &cfg).server_url
        }
    };
    Ok(scope_of(&url))
}

#[cfg(test)]
mod tests {
    use super::{build_multipart, effective_mime, scope_of};
    use std::collections::HashMap;

    #[test]
    fn scope_trims_trailing_slash_and_handles_empty() {
        assert_eq!(scope_of("http://x.onion/"), "http://x.onion");
        assert_eq!(scope_of("http://x.onion"), "http://x.onion");
        assert_eq!(scope_of(""), "default");
    }

    #[test]
    fn multipart_has_boundary_file_part_and_extra_fields() {
        let mut extra = HashMap::new();
        extra.insert("kind".to_string(), "image".to_string());
        let (content_type, body) = build_multipart("file", "a.png", b"PNGDATA", "image/png", Some(&extra));

        assert!(content_type.starts_with("multipart/form-data; boundary="));
        let boundary = content_type.rsplit("boundary=").next().unwrap();
        let text = String::from_utf8_lossy(&body);

        assert!(text.contains("Content-Disposition: form-data; name=\"file\"; filename=\"a.png\""));
        assert!(text.contains("Content-Type: image/png"));
        assert!(text.contains("PNGDATA"));
        assert!(text.contains("Content-Disposition: form-data; name=\"kind\""));
        assert!(text.contains("image"));
        assert!(text.contains(&format!("--{boundary}--")));
    }

    #[test]
    fn multipart_preserves_raw_binary_bytes() {
        let (content_type, body) = build_multipart("f", "x.bin", &[0u8, 1, 2, 0, 3], "application/octet-stream", None);
        assert!(content_type.contains("boundary="));
        assert!(body.windows(5).any(|w| w == [0u8, 1, 2, 0, 3]));
    }

    #[test]
    fn effective_mime_prefers_provided_then_sniffs() {
        let png = [0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0];
        assert_eq!(effective_mime(Some("image/png"), b"not-a-png"), "image/png");
        assert_eq!(effective_mime(Some(""), &png), "image/png");
        assert_eq!(effective_mime(Some("application/octet-stream"), &png), "image/png");
        assert_eq!(effective_mime(None, &png), "image/png");
        assert_eq!(effective_mime(None, b"????"), "application/octet-stream");
    }
}
