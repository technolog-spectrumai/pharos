//! Streams for the Beacon side (stage b2): a pluggable dialer, so the same code runs
//! over Tor, loopback TCP or in-process duplex pipes, and one task per link that
//! writes queued frames (padded, with cover in quiet slots) and reads frames until
//! either side ends.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::{pad, read_frame, write_frame_bounded, BoxFuture};

/// The read half of any stream.
pub type BoxRead = Box<dyn AsyncRead + Send + Unpin>;
/// The write half of any stream.
pub type BoxWrite = Box<dyn AsyncWrite + Send + Unpin>;

/// Splits a duplex stream into boxed halves.
pub fn boxed<S>(s: S) -> (BoxRead, BoxWrite)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let (r, w) = tokio::io::split(s);
    (Box::new(r), Box::new(w))
}

/// Opens a stream to an onion (or to whatever a test maps it to).
pub trait Dialer: Send + Sync + 'static {
    /// A fresh stream to `onion`.
    fn dial(&self, onion: &str) -> BoxFuture<Result<(BoxRead, BoxWrite)>>;
}

/// A dialer that reaches nobody (a Beacon served on loopback for development).
pub struct NoDialer;

impl Dialer for NoDialer {
    fn dial(&self, onion: &str) -> BoxFuture<Result<(BoxRead, BoxWrite)>> {
        let o = onion.to_string();
        Box::pin(async move { Err(anyhow!("no dialer: cannot reach {o}")) })
    }
}

/// Dials over arti (a [`crate::TorClient`]).
pub struct TorDialer {
    /// The client.
    pub client: Arc<crate::TorClient<crate::PreferredRuntime>>,
    /// The virtual port.
    pub port: u16,
}

impl Dialer for TorDialer {
    fn dial(&self, onion: &str) -> BoxFuture<Result<(BoxRead, BoxWrite)>> {
        let (c, o, p) = (self.client.clone(), onion.to_string(), self.port);
        Box::pin(async move {
            let ds = c.connect((o.as_str(), p)).await.map_err(|e| anyhow!("tor connect to {o} failed: {e}"))?;
            Ok(boxed(ds))
        })
    }
}

/// What every link shares.
#[derive(Clone, Debug)]
pub struct LinkCfg {
    /// Caps one frame.
    pub max_frame: usize,
    /// A stalled write fails after this.
    pub write_timeout: Duration,
    /// Cover traffic interval (seconds; 0 = none).
    pub cover_every: u64,
}

fn jittered(every: u64) -> Duration {
    // ±20 %, so the dummies are not a metronome.
    let r = chacha20poly1305::aead::rand_core::RngCore::next_u64(&mut chacha20poly1305::aead::OsRng);
    let jitter = (r % (every * 2 / 5 + 1)) as i64 - (every / 5) as i64;
    Duration::from_secs((every as i64 + jitter).max(1) as u64)
}

/// Runs one link until either half ends: writes every queued frame (padded) and, in a
/// slot with nothing real, `cover`; hands every non-cover frame read to `on_frame`.
/// Dropping the future (or aborting its task) closes the stream.
pub async fn run_link<F>(mut rd: BoxRead, mut wr: BoxWrite, mut rx: UnboundedReceiver<String>, cfg: LinkCfg, cover: &str, mut on_frame: F)
where
    F: FnMut(String) + Send,
{
    let cover_padded = pad(cover.to_string(), cfg.max_frame);
    let writer = async {
        loop {
            let next = if cfg.cover_every == 0 {
                rx.recv().await
            } else {
                match tokio::time::timeout(jittered(cfg.cover_every), rx.recv()).await {
                    Ok(f) => f,
                    Err(_) => Some(String::new()),
                }
            };
            let frame = match next {
                None => break,
                Some(f) if f.is_empty() => cover_padded.clone(),
                Some(f) => pad(f, cfg.max_frame),
            };
            if write_frame_bounded(&mut wr, &frame, cfg.write_timeout).await.is_err() {
                break;
            }
        }
    };
    let reader = async {
        while let Ok(f) = read_frame(&mut rd, cfg.max_frame).await {
            if f.trim_end() == cover {
                continue;
            }
            on_frame(f);
        }
    };
    tokio::select! {
        () = writer => {}
        () = reader => {}
    }
}

/// A stream whose first bytes were already read (to sniff what it is), put back in
/// front. The Beacon reads 4 bytes to tell HTTP from a link.
pub struct Prefixed<S> {
    head: Vec<u8>,
    at: usize,
    inner: S,
}

impl<S> Prefixed<S> {
    /// `head` comes first, then `inner`.
    pub fn new(head: Vec<u8>, inner: S) -> Self {
        Self { head, at: 0, inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> std::task::Poll<std::io::Result<()>> {
        if self.at < self.head.len() {
            let n = (self.head.len() - self.at).min(buf.remaining());
            let at = self.at;
            buf.put_slice(&self.head[at..at + n]);
            self.at += n;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>, buf: &[u8]) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// Whether the first 4 bytes of a stream start a link (a little-endian length below
/// 16 MiB, so the top byte is 0) rather than HTTP (an ASCII method such as `GET `).
pub fn is_link_prefix(head: &[u8; 4]) -> bool {
    head[3] == 0
}
