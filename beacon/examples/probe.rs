//! Real-Tor check of a running Beacon (8.E2): dial its onion with a fresh arti
//! client, read /v1/health, leave a message in a mailbox and read it back.
//!
//!   cargo run -p beacon --example probe -- <onion> <scratch-dir>
//!
//! Used by .github/workflows/real-tor.yml after `beacon serve` has published its onion.

use anyhow::{bail, Context, Result};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn http(tor: &pharos_tor::Tor, onion: &str, req: String) -> Result<String> {
    let mut s = tor.dial(onion, Duration::from_secs(120)).await?;
    s.write_all(req.as_bytes()).await?;
    s.flush().await?;
    let mut out = Vec::new();
    s.read_to_end(&mut out).await?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let onion = args.next().context("usage: probe <onion> <scratch-dir>")?;
    let dir = std::path::PathBuf::from(args.next().context("usage: probe <onion> <scratch-dir>")?);
    let tor = pharos_tor::Tor::start(dir.join("state"), dir.join("cache"), false, pharos_tor::Vanguards::Lite).await?;

    let health = http(&tor, &onion, format!("GET /v1/health HTTP/1.1\r\nHost: {onion}\r\nConnection: close\r\n\r\n")).await?;
    println!("health: {}", health.lines().last().unwrap_or(""));
    if !health.starts_with("HTTP/1.1 200") {
        bail!("health failed:\n{health}");
    }

    let (id, token) = ("ab".repeat(32), "cd".repeat(32));
    let put = http(&tor, &onion, format!(
        "PUT /v1/mailbox/{id} HTTP/1.1\r\nHost: {onion}\r\nAuthorization: Bearer {token}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"
    )).await?;
    if !put.starts_with("HTTP/1.1 201") {
        bail!("post failed:\n{put}");
    }
    // Beacon holds new messages back for up to release_delay_secs (8.D3).
    tokio::time::sleep(Duration::from_secs(12)).await;
    let get = http(&tor, &onion, format!(
        "GET /v1/mailbox/{id}?after=0 HTTP/1.1\r\nHost: {onion}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    )).await?;
    if !get.contains("aGVsbG8=") {
        bail!("the message did not come back:\n{get}");
    }
    println!("ok: posted and read back over the real Tor network");
    Ok(())
}
