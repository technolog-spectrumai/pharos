// Rust-owned HTTP gateway.
//
// The Vue frontend no longer does `fetch` directly: it calls `data_http` /
// `data_upload`, and Rust resolves the server URL + auth token (from the profile
// state), applies the silent-mode gate, performs the request with `reqwest`, and
// maintains a read-through response cache so previously-loaded data stays
// browsable offline / in silent mode.
//
// The cache is a simple on-disk store (one file per (server, path)) — deliberately
// not SQLite, to avoid linking a second `libsqlite3-sys` alongside the
// `tauri-plugin-sql` one used by the JS Notes cache.

use std::collections::HashMap;
use std::path::PathBuf;

use reqwest::Client;
use tauri::{AppHandle, Manager, State};

use crate::{active_config, load_profile_state, AppConfigState};

pub const SILENT_WRITE_BLOCKED: &str = "Silent mode is on — connections are blocked.";
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

    // Silent mode: serve reads from the local copy, block writes.
    if state.silent_mode {
        if !is_get {
            return Err(SILENT_WRITE_BLOCKED.to_string());
        }
        return cache_get(&data, &scope, &path).ok_or_else(|| SILENT_NO_CACHE.to_string());
    }

    if base.is_empty() {
        return Err(NO_SERVER.to_string());
    }

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

    if !status.is_success() {
        return Err(format!("{}: {}", status.as_u16(), text));
    }
    if !text.is_empty() && serde_json::from_str::<serde_json::Value>(&text).is_err() {
        return Err(format!(
            "Server returned a non-JSON response (HTTP {}). Check the server address in Settings.",
            status.as_u16()
        ));
    }

    if is_get {
        cache_put(&data, &scope, &path, &text);
    }
    Ok(text)
}

#[tauri::command]
pub async fn data_upload(
    app: AppHandle,
    config: State<'_, AppConfigState>,
    data: State<'_, DataState>,
    path: String,
    field: String,
    filename: String,
    bytes: Vec<u8>,
    extra: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let cfg = active_config(&config)?;
    let state = load_profile_state(&app, &cfg);
    if state.silent_mode {
        return Err(SILENT_WRITE_BLOCKED.to_string());
    }
    let base = state.server_url.trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err(NO_SERVER.to_string());
    }

    let part = reqwest::multipart::Part::bytes(bytes).file_name(filename);
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
