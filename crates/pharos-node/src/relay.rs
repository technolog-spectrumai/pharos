//! A Relay client: HTTP/1.1 over one stream to its onion (see relay/src/api.rs).

use crate::net::Net;
use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, StatusCode};
use serde::Deserialize;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(90);

fn hex(b: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(b)
}

pub async fn call<N: Net>(
    net: &N,
    onion: &str,
    method: Method,
    path: &str,
    token: Option<&[u8]>,
    body: Vec<u8>,
) -> Result<(StatusCode, Bytes)> {
    let fut = async {
        let io = net.dial(onion).await?;
        let (mut send, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(io)).await?;
        let driver = tokio::spawn(conn);
        let mut req = Request::builder().method(method).uri(path).header("host", onion);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {}", hex(t)));
        }
        let res = send.send_request(req.body(Full::new(Bytes::from(body)))?).await?;
        let status = res.status();
        let bytes = res.into_body().collect().await?.to_bytes();
        driver.abort();
        Ok::<_, anyhow::Error>((status, bytes))
    };
    tokio::time::timeout(TIMEOUT, fut).await.map_err(|_| anyhow!("Relay {onion} timed out"))?
}

pub async fn put_message<N: Net>(net: &N, onion: &str, id: &[u8], token: &[u8], blob: Vec<u8>) -> Result<()> {
    let (s, b) = call(net, onion, Method::PUT, &format!("/v1/mailbox/{}", hex(id)), Some(token), blob).await?;
    if s != StatusCode::CREATED {
        bail!("Relay refused the message: {s} {}", String::from_utf8_lossy(&b));
    }
    Ok(())
}

#[derive(Deserialize)]
struct Fetched {
    messages: Vec<Item>,
}
#[derive(Deserialize)]
struct Item {
    seq: i64,
    blob: String,
}

pub async fn fetch<N: Net>(net: &N, onion: &str, id: &[u8], token: &[u8], after: i64) -> Result<Vec<(i64, Vec<u8>)>> {
    let (s, b) = call(net, onion, Method::GET, &format!("/v1/mailbox/{}?after={after}", hex(id)), Some(token), vec![]).await?;
    if s != StatusCode::OK {
        bail!("Relay refused the fetch: {s}");
    }
    let f: Fetched = serde_json::from_slice(&b)?;
    f.messages
        .into_iter()
        .map(|m| Ok((m.seq, data_encoding::BASE64.decode(m.blob.as_bytes())?)))
        .collect()
}

pub async fn ack<N: Net>(net: &N, onion: &str, id: &[u8], token: &[u8], upto: i64) -> Result<()> {
    let (s, _) = call(net, onion, Method::POST, &format!("/v1/mailbox/{}/ack?upto={upto}", hex(id)), Some(token), vec![]).await?;
    if s != StatusCode::OK {
        bail!("Relay refused the ack: {s}");
    }
    Ok(())
}

pub async fn put_record<N: Net>(net: &N, onion: &str, id: &[u8], token: &[u8], blob: Vec<u8>) -> Result<()> {
    let (s, _) = call(net, onion, Method::PUT, &format!("/v1/record/{}", hex(id)), Some(token), blob).await?;
    if s != StatusCode::NO_CONTENT {
        bail!("Relay refused the record: {s}");
    }
    Ok(())
}

pub async fn get_record<N: Net>(net: &N, onion: &str, id: &[u8]) -> Result<Option<Vec<u8>>> {
    let (s, b) = call(net, onion, Method::GET, &format!("/v1/record/{}", hex(id)), None, vec![]).await?;
    match s {
        StatusCode::OK => Ok(Some(b.to_vec())),
        StatusCode::NOT_FOUND => Ok(None),
        s => bail!("Relay refused the lookup: {s}"),
    }
}

pub async fn put_pairing<N: Net>(net: &N, onion: &str, token: &[u8], blob: Vec<u8>) -> Result<()> {
    let (s, _) = call(net, onion, Method::PUT, &format!("/v1/pairing/{}", hex(token)), None, blob).await?;
    if s != StatusCode::CREATED {
        bail!("Relay refused the pairing reply: {s}");
    }
    Ok(())
}

pub async fn take_pairing<N: Net>(net: &N, onion: &str, token: &[u8]) -> Result<Option<Vec<u8>>> {
    let (s, b) = call(net, onion, Method::GET, &format!("/v1/pairing/{}", hex(token)), None, vec![]).await?;
    match s {
        StatusCode::OK => Ok(Some(b.to_vec())),
        StatusCode::NOT_FOUND => Ok(None),
        s => bail!("Relay refused: {s}"),
    }
}

pub async fn health<N: Net>(net: &N, onion: &str) -> Result<()> {
    let (s, _) = call(net, onion, Method::GET, "/v1/health", None, vec![]).await?;
    if s != StatusCode::OK {
        bail!("Relay health: {s}");
    }
    Ok(())
}
