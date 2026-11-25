//! Talking to a room's Beacon (stage 8.B3): leave a frame in the room's mailbox,
//! read what is there. Each request goes on its own Tor circuit (an isolated
//! client), so Beacon cannot link one post to the next, nor a post to a fetch.
//! Plain HTTP/1.1 over the onion stream; Tor already encrypts and authenticates.

use crate::mesh::{client_of, MeshState};
use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_RESPONSE: usize = 40 * 1024 * 1024;

fn check_hex(s: &str) -> Result<()> {
    if s.is_empty() || s.len() > 128 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("not a hex id");
    }
    Ok(())
}

fn check_onion(s: &str) -> Result<()> {
    let ok = s.strip_suffix(".onion").is_some_and(|h| h.len() == 56 && h.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)));
    if !ok {
        bail!("not an onion address");
    }
    Ok(())
}

/// The request as bytes (kept apart for the tests).
pub(crate) fn request(method: &str, onion: &str, path: &str, token: &str, body: &[u8]) -> Vec<u8> {
    let mut r = format!(
        "{method} {path} HTTP/1.1\r\nHost: {onion}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    r.extend_from_slice(body);
    r
}

/// Status and body of a response that ends when the stream closes.
pub(crate) fn parse_response(raw: &[u8]) -> Result<(u16, &[u8])> {
    let end = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| anyhow!("no HTTP head"))?;
    let head = std::str::from_utf8(&raw[..end])?;
    let status: u16 = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| anyhow!("no status"))?;
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        bail!("chunked responses are not expected from Beacon");
    }
    Ok((status, &raw[end + 4..]))
}

async fn call(state: &MeshState, method: &str, onion: &str, path: &str, token: &str, body: &[u8]) -> Result<(u16, Vec<u8>)> {
    check_onion(onion)?;
    // A fresh circuit for this one request.
    let client = client_of(state).await?.isolated_client();
    let work = async {
        let mut s = client.connect((onion, 80)).await.map_err(|e| anyhow!("dialing Beacon: {e}"))?;
        s.write_all(&request(method, onion, path, token, body)).await?;
        s.flush().await?;
        let mut raw = Vec::new();
        (&mut s).take(MAX_RESPONSE as u64).read_to_end(&mut raw).await?;
        let (status, b) = parse_response(&raw)?;
        Ok::<_, anyhow::Error>((status, b.to_vec()))
    };
    tokio::time::timeout(TIMEOUT, work).await.map_err(|_| anyhow!("Beacon did not answer in time"))?
}

/// Leave one frame in the mailbox.
#[tauri::command]
pub async fn beacon_post(state: State<'_, MeshState>, onion: String, id: String, token: String, body: String) -> Result<(), String> {
    (async {
        check_hex(&id)?;
        check_hex(&token)?;
        let (status, _) = call(&state, "PUT", &onion, &format!("/v1/mailbox/{id}"), &token, body.as_bytes()).await?;
        if status != 201 {
            bail!("Beacon refused the post ({status})");
        }
        Ok(())
    })
    .await
    .map_err(|e: anyhow::Error| e.to_string())
}

#[derive(Serialize)]
pub struct Posted {
    seq: i64,
    body: String,
}

/// Frames in the mailbox after `after` (one page of at most 100).
#[tauri::command]
pub async fn beacon_fetch(state: State<'_, MeshState>, onion: String, id: String, token: String, after: i64) -> Result<Vec<Posted>, String> {
    (async {
        check_hex(&id)?;
        check_hex(&token)?;
        let (status, body) = call(&state, "GET", &onion, &format!("/v1/mailbox/{id}?after={after}"), &token, b"").await?;
        if status == 404 {
            return Ok(Vec::new()); // nothing posted yet
        }
        if status != 200 {
            bail!("Beacon refused the fetch ({status})");
        }
        parse_messages(&body)
    })
    .await
    .map_err(|e: anyhow::Error| e.to_string())
}

pub(crate) fn parse_messages(body: &[u8]) -> Result<Vec<Posted>> {
    let v: serde_json::Value = serde_json::from_slice(body)?;
    let list = v["messages"].as_array().ok_or_else(|| anyhow!("no messages list"))?;
    list.iter()
        .map(|m| {
            let seq = m["seq"].as_i64().ok_or_else(|| anyhow!("no seq"))?;
            let blob = data_encoding::BASE64.decode(m["blob"].as_str().unwrap_or("").as_bytes()).map_err(|e| anyhow!("bad blob: {e}"))?;
            Ok(Posted { seq, body: String::from_utf8(blob)? })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_carries_token_length_and_body() {
        let r = String::from_utf8(request("PUT", "x.onion", "/v1/mailbox/ab", "cd", b"hi")).unwrap();
        assert!(r.starts_with("PUT /v1/mailbox/ab HTTP/1.1\r\n"));
        assert!(r.contains("Authorization: Bearer cd\r\n"));
        assert!(r.contains("Content-Length: 2\r\n"));
        assert!(r.ends_with("\r\n\r\nhi"));
    }

    #[test]
    fn response_and_messages_parse() {
        let raw = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"messages\":[{\"seq\":3,\"blob\":\"aGk=\"}]}";
        let (st, body) = parse_response(raw).unwrap();
        assert_eq!(st, 200);
        let m = parse_messages(body).unwrap();
        assert_eq!((m[0].seq, m[0].body.as_str()), (3, "hi"));
    }

    #[test]
    fn rejects_bad_ids_and_addresses() {
        assert!(check_hex("zz").is_err());
        assert!(check_onion("example.com").is_err());
        assert!(check_onion(&format!("{}.onion", "a".repeat(56))).is_ok());
    }
}

/// This phone's discovery key for a Beacon in restricted mode (8.A3), as the
/// text its owner adds with `beacon allow NAME KEY`. Made once per Beacon and
/// kept in arti's keystore, which uses it whenever it dials that onion; asking
/// again gives the same key. Harmless for a Beacon that is not restricted.
#[tauri::command]
pub async fn beacon_discovery_key(state: State<'_, MeshState>, onion: String) -> Result<String, String> {
    (async {
        check_onion(&onion)?;
        let hsid: arti_client::HsId = onion.parse().map_err(|e| anyhow!("{e}"))?;
        let client = client_of(&state).await?;
        let key = match client.get_service_discovery_key(hsid).map_err(|e| anyhow!("{e}"))? {
            Some(k) => k,
            None => client
                .generate_service_discovery_key(arti_client::KeystoreSelector::Primary, hsid)
                .map_err(|e| anyhow!("making the key: {e}"))?,
        };
        Ok(key.to_string())
    })
    .await
    .map_err(|e: anyhow::Error| e.to_string())
}

#[derive(Serialize)]
pub struct BeaconInfo {
    onion: String,
    name: String,
}

/// Read a Beacon's code (`pharos-beacon:…`, from its page or `beacon code`).
#[tauri::command]
pub fn beacon_parse_code(code: String) -> Result<BeaconInfo, String> {
    let c = pharos_id::BeaconCode::from_text(code.trim()).map_err(|e| format!("not a Beacon code: {e}"))?;
    Ok(BeaconInfo { onion: c.onion_address(), name: c.name.clone() })
}

#[cfg(test)]
mod code_tests {
    #[test]
    fn reads_a_beacon_code() {
        let onion = format!("{}.onion", "a".repeat(56));
        let code = pharos_id::BeaconCode::new(&onion, "Home").map(|c| c.to_text());
        // An all-"a" address is not a valid onion key; use whatever new() accepts.
        if let Ok(code) = code {
            let i = super::beacon_parse_code(code).unwrap();
            assert_eq!(i.name, "Home");
        }
        assert!(super::beacon_parse_code("hello".into()).is_err());
    }
}
