//! Relay as a library: the parts `main.rs` wires together, also used by the
//! end-to-end tests in pharos-node (a real Relay on loopback).
pub mod api;
pub mod config;
pub mod diskcrypt;
pub mod masterkey;
pub mod page;
pub mod store;

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
