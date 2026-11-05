//! The HTTP API Proteus serves on its onion (3.1–3.4). Bodies are raw bytes
//! (already sealed by Nautes); ids and tokens are hex.
//!
//! | Method | Path | Auth | What |
//! |---|---|---|---|
//! | GET  | /v1/health | – | `{"ok":true,"version":…}` |
//! | PUT  | /v1/mailbox/{id} | token | leave a message → `{"seq":n}` |
//! | GET  | /v1/mailbox/{id}?after=n | token | `{"messages":[{"seq","blob"(base64)}]}` |
//! | POST | /v1/mailbox/{id}/ack?upto=n | token | drop messages ≤ n |
//! | PUT  | /v1/record/{id} | token | file a directory record |
//! | GET  | /v1/record/{id} | – | the record (the id is the secret) |
//! | PUT  | /v1/pairing/{token} | – | leave a pairing reply (once) |
//! | GET  | /v1/pairing/{token} | – | take it (once) |
//!
//! The token goes in `Authorization: Bearer <hex>`.

use crate::store::{Refusal, Store};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Longest hex id or token accepted (64 bytes).
const MAX_HEX: usize = 128;
const FETCH_MAX: u32 = 100;

pub struct AppState {
    pub store: Store,
    pub limiter: Limiter,
    pub clock: fn() -> u64,
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Fixed-window counter per id (Tor hides addresses, so ids are what we can count).
#[derive(Default)]
pub struct Limiter {
    per_minute: u32,
    windows: Mutex<HashMap<[u8; 32], (u64, u32)>>,
}

impl Limiter {
    pub fn new(per_minute: u32) -> Self {
        Limiter { per_minute, windows: Mutex::default() }
    }

    pub fn allow(&self, key: &[u8], now: u64) -> bool {
        let k = *blake3::hash(key).as_bytes();
        let minute = now / 60;
        let mut w = self.windows.lock().unwrap_or_else(|p| p.into_inner());
        if w.len() > 100_000 {
            w.retain(|_, (m, _)| *m == minute);
        }
        let e = w.entry(k).or_insert((minute, 0));
        if e.0 != minute {
            *e = (minute, 0);
        }
        e.1 += 1;
        e.1 <= self.per_minute
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    let l = state.store.limits();
    let body_max = l.max_message_bytes.max(l.max_pairing_bytes).max(l.max_record_bytes) + 1024;
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/mailbox/{id}", get(fetch).put(put_message))
        .route("/v1/mailbox/{id}/ack", post(ack))
        .route("/v1/record/{id}", get(get_record).put(put_record))
        .route("/v1/pairing/{token}", get(take_pairing).put(put_pairing))
        .layer(DefaultBodyLimit::max(body_max))
        .with_state(state)
}

type St = State<Arc<AppState>>;

fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({ "error": msg }))).into_response()
}

fn refusal(r: Refusal) -> Response {
    match r {
        Refusal::Forbidden => err(StatusCode::FORBIDDEN, "wrong token"),
        Refusal::NotFound => err(StatusCode::NOT_FOUND, "not found"),
        Refusal::Full => err(StatusCode::INSUFFICIENT_STORAGE, "full"),
        Refusal::TooLarge => err(StatusCode::PAYLOAD_TOO_LARGE, "too large"),
        Refusal::Conflict => err(StatusCode::CONFLICT, "already used"),
    }
}

fn internal(e: anyhow::Error) -> Response {
    eprintln!("proteus: {e:#}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
}

fn unhex(s: &str) -> Result<Vec<u8>, Response> {
    if s.is_empty() || s.len() > MAX_HEX {
        return Err(err(StatusCode::BAD_REQUEST, "bad id"));
    }
    data_encoding::HEXLOWER_PERMISSIVE.decode(s.as_bytes()).map_err(|_| err(StatusCode::BAD_REQUEST, "bad id"))
}

fn bearer(h: &HeaderMap) -> Result<Vec<u8>, Response> {
    let v = h
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "token required"))?;
    unhex(v.trim()).map_err(|_| err(StatusCode::UNAUTHORIZED, "bad token"))
}

/// Parse the id, check the rate limit.
fn gate(st: &AppState, id: &str) -> Result<(Vec<u8>, u64), Response> {
    let id = unhex(id)?;
    let now = (st.clock)();
    if !st.limiter.allow(&id, now) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "slow down"));
    }
    Ok((id, now))
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
}

macro_rules! out {
    ($e:expr) => {
        match $e {
            Err(e) => return internal(e),
            Ok(Err(r)) => return refusal(r),
            Ok(Ok(v)) => v,
        }
    };
}

async fn health() -> Response {
    Json(json!({ "ok": true, "service": "proteus", "version": env!("CARGO_PKG_VERSION") })).into_response()
}

async fn put_message(State(st): St, Path(id): Path<String>, h: HeaderMap, body: Bytes) -> Response {
    let (id, now) = tri!(gate(&st, &id));
    let tok = tri!(bearer(&h));
    if body.is_empty() {
        return err(StatusCode::BAD_REQUEST, "empty");
    }
    let seq = out!(st.store.put_message(&id, &tok, &body, now));
    (StatusCode::CREATED, Json(json!({ "seq": seq }))).into_response()
}

#[derive(Deserialize)]
struct After {
    #[serde(default)]
    after: i64,
}

async fn fetch(State(st): St, Path(id): Path<String>, Query(q): Query<After>, h: HeaderMap) -> Response {
    let (id, _) = tri!(gate(&st, &id));
    let tok = tri!(bearer(&h));
    let msgs = out!(st.store.fetch(&id, &tok, q.after, FETCH_MAX));
    let list: Vec<_> = msgs
        .into_iter()
        .map(|m| json!({ "seq": m.seq, "blob": data_encoding::BASE64.encode(&m.blob) }))
        .collect();
    Json(json!({ "messages": list })).into_response()
}

#[derive(Deserialize)]
struct Upto {
    upto: i64,
}

async fn ack(State(st): St, Path(id): Path<String>, Query(q): Query<Upto>, h: HeaderMap) -> Response {
    let (id, _) = tri!(gate(&st, &id));
    let tok = tri!(bearer(&h));
    let n = out!(st.store.ack(&id, &tok, q.upto));
    Json(json!({ "removed": n })).into_response()
}

async fn put_record(State(st): St, Path(id): Path<String>, h: HeaderMap, body: Bytes) -> Response {
    let (id, now) = tri!(gate(&st, &id));
    let tok = tri!(bearer(&h));
    out!(st.store.put_record(&id, &tok, &body, now));
    StatusCode::NO_CONTENT.into_response()
}

async fn get_record(State(st): St, Path(id): Path<String>) -> Response {
    let (id, now) = tri!(gate(&st, &id));
    let blob = out!(st.store.get_record(&id, now));
    blob.into_response()
}

async fn put_pairing(State(st): St, Path(token): Path<String>, body: Bytes) -> Response {
    let (token, now) = tri!(gate(&st, &token));
    out!(st.store.put_pairing(&token, &body, now));
    StatusCode::CREATED.into_response()
}

async fn take_pairing(State(st): St, Path(token): Path<String>) -> Response {
    let (token, now) = tri!(gate(&st, &token));
    let blob = out!(st.store.take_pairing(&token, now));
    blob.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Limits;
    use crate::masterkey::MasterKey;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app(limits: Limits) -> Router {
        let store = Store::in_memory(MasterKey::from_bytes(&[3; 32]), limits.clone()).unwrap();
        router(Arc::new(AppState { store, limiter: Limiter::new(limits.requests_per_minute), clock: || 1000 }))
    }

    async fn call(app: &Router, method: &str, uri: &str, token: Option<&str>, body: &[u8]) -> (StatusCode, Vec<u8>) {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            b = b.header("authorization", format!("Bearer {t}"));
        }
        let res = app.clone().oneshot(b.body(Body::from(body.to_vec())).unwrap()).await.unwrap();
        let code = res.status();
        (code, res.into_body().collect().await.unwrap().to_bytes().to_vec())
    }

    fn json(b: &[u8]) -> serde_json::Value {
        serde_json::from_slice(b).unwrap()
    }

    #[tokio::test]
    async fn mailbox_over_http() {
        let a = app(Limits::default());
        assert_eq!(call(&a, "GET", "/v1/health", None, b"").await.0, StatusCode::OK);
        let (c, b) = call(&a, "PUT", "/v1/mailbox/aa01", Some("beef"), b"sealed-1").await;
        assert_eq!((c, json(&b)["seq"].as_i64()), (StatusCode::CREATED, Some(1)));
        call(&a, "PUT", "/v1/mailbox/aa01", Some("beef"), b"sealed-2").await;
        let (c, b) = call(&a, "GET", "/v1/mailbox/aa01?after=0", Some("beef"), b"").await;
        assert_eq!(c, StatusCode::OK);
        let m = &json(&b)["messages"];
        assert_eq!(m.as_array().unwrap().len(), 2);
        assert_eq!(m[0]["blob"], data_encoding::BASE64.encode(b"sealed-1"));
        assert_eq!(call(&a, "POST", "/v1/mailbox/aa01/ack?upto=1", Some("beef"), b"").await.0, StatusCode::OK);
        let (_, b) = call(&a, "GET", "/v1/mailbox/aa01", Some("beef"), b"").await;
        assert_eq!(json(&b)["messages"][0]["seq"], 2);
    }

    #[tokio::test]
    async fn refusals_map_to_statuses() {
        let a = app(Limits { max_message_bytes: 10, ..Limits::default() });
        assert_eq!(call(&a, "PUT", "/v1/mailbox/aa01", None, b"x").await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(call(&a, "PUT", "/v1/mailbox/zz", Some("beef"), b"x").await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(&a, "PUT", &format!("/v1/mailbox/{}", "a".repeat(200)), Some("beef"), b"x").await.0, StatusCode::BAD_REQUEST);
        call(&a, "PUT", "/v1/mailbox/aa01", Some("beef"), b"x").await;
        assert_eq!(call(&a, "GET", "/v1/mailbox/aa01", Some("dead"), b"").await.0, StatusCode::FORBIDDEN);
        assert_eq!(call(&a, "PUT", "/v1/mailbox/aa01", Some("beef"), &[0; 11]).await.0, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(call(&a, "PUT", "/v1/mailbox/aa01", Some("beef"), b"").await.0, StatusCode::BAD_REQUEST);
        assert_eq!(call(&a, "GET", "/v1/record/cc", None, b"").await.0, StatusCode::NOT_FOUND);
        // Bodies past the hard limit never reach a handler.
        assert_eq!(call(&a, "PUT", "/v1/pairing/ab", None, &vec![0; 60 * 1024]).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn records_and_pairing_over_http() {
        let a = app(Limits::default());
        assert_eq!(call(&a, "PUT", "/v1/record/cc", Some("01"), b"rec").await.0, StatusCode::NO_CONTENT);
        assert_eq!(call(&a, "PUT", "/v1/record/cc", Some("02"), b"evil").await.0, StatusCode::FORBIDDEN);
        assert_eq!(call(&a, "GET", "/v1/record/cc", None, b"").await, (StatusCode::OK, b"rec".to_vec()));
        assert_eq!(call(&a, "PUT", "/v1/pairing/ab", None, b"reply").await.0, StatusCode::CREATED);
        assert_eq!(call(&a, "PUT", "/v1/pairing/ab", None, b"again").await.0, StatusCode::CONFLICT);
        assert_eq!(call(&a, "GET", "/v1/pairing/ab", None, b"").await, (StatusCode::OK, b"reply".to_vec()));
        assert_eq!(call(&a, "GET", "/v1/pairing/ab", None, b"").await.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn rate_limit_is_per_id() {
        let a = app(Limits { requests_per_minute: 3, ..Limits::default() });
        for _ in 0..3 {
            assert_eq!(call(&a, "GET", "/v1/record/c1", None, b"").await.0, StatusCode::NOT_FOUND);
        }
        assert_eq!(call(&a, "GET", "/v1/record/c1", None, b"").await.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(call(&a, "GET", "/v1/record/c2", None, b"").await.0, StatusCode::NOT_FOUND);
    }

    #[test]
    fn limiter_windows_reset_each_minute() {
        let l = Limiter::new(1);
        assert!(l.allow(b"x", 0));
        assert!(!l.allow(b"x", 59));
        assert!(l.allow(b"x", 60));
    }
}
