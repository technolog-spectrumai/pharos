//! Beacon as a library: the parts `main.rs` wires together, so tests can serve
//! a real Beacon on loopback.
pub mod api;
pub mod clients;
pub mod config;
pub mod diskcrypt;
pub mod masterkey;
pub mod page;
pub mod relay_store;
pub mod store;

use std::sync::Arc;

use beacon_node::relay::Relay;

/// One inbound stream on the onion (stage b2): the first 4 bytes tell a client or
/// Beacon link (a little-endian frame length, top byte 0) from HTTP (an ASCII
/// method). Links go to the relay, the rest to the HTTP API, both on the same
/// onion and virtual port.
pub async fn route_conn<S>(mut s: S, app: axum::Router, relay: Option<Arc<Relay>>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use tokio::io::AsyncReadExt;
    let mut head = [0u8; 4];
    let Ok(Ok(_)) = tokio::time::timeout(std::time::Duration::from_secs(30), s.read_exact(&mut head)).await else { return };
    match relay {
        Some(r) if beacon_node::link::is_link_prefix(&head) => {
            let (rd, wr) = beacon_node::link::boxed(beacon_node::link::Prefixed::new(head.to_vec(), s));
            r.serve(rd, wr).await;
        }
        _ => serve_conn(beacon_node::link::Prefixed::new(head.to_vec(), s), app).await,
    }
}

/// Serve `app` on one connection (HTTP/1, capped in time).
pub async fn serve_conn<S>(s: S, app: axum::Router)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let svc = hyper_util::service::TowerToHyperService::new(app);
    let conn = hyper::server::conn::http1::Builder::new()
        .max_buf_size(64 * 1024)
        .header_read_timeout(std::time::Duration::from_secs(30))
        .timer(hyper_util::rt::TokioTimer::new())
        .serve_connection(hyper_util::rt::TokioIo::new(s), svc);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(120), conn).await;
}
