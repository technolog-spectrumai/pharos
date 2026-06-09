// Embedded Tor (Arti) transport for reaching a `.onion` server.
//
// When the active profile has `server_is_onion` on, the HTTP gateway (data.rs)
// and the realtime WS backend (realtime.rs) route through this module instead of
// connecting directly — nothing can resolve a `.onion` without Tor. We embed a
// pure-Rust Tor client (arti); no external tor daemon / Orbot is required. The
// client is bootstrapped lazily on first use (bootstrap builds circuits and is
// slow) and then cached for the lifetime of the process.
//
// The onion service speaks plain HTTP on port 80, so there is no TLS on top of
// the Tor stream — the circuit itself provides the encryption.

use std::sync::Arc;

use arti_client::{DataStream, TorClient, TorClientConfig};
use http_body_util::BodyExt;
use tokio::sync::OnceCell;
use tor_rtcompat::PreferredRuntime;

#[derive(Default)]
pub struct TorState {
    // create_bootstrapped yields an Arc<TorClient>, cached for the process lifetime.
    client: OnceCell<Arc<TorClient<PreferredRuntime>>>,
}

impl TorState {
    /// Bootstrap the embedded Tor client once, then open a stream to `host:port`.
    pub async fn connect(&self, host: &str, port: u16) -> Result<DataStream, String> {
        let client = self
            .client
            .get_or_try_init(|| async {
                TorClient::create_bootstrapped(TorClientConfig::default()).await
            })
            .await
            .map_err(|e| format!("Tor bootstrap failed: {e}"))?;
        client
            .connect((host, port))
            .await
            .map_err(|e| format!("Tor connect to {host}:{port} failed: {e}"))
    }

    /// Perform one HTTP/1.1 request over a fresh Tor stream, returning
    /// (status, body bytes). Plain HTTP — the onion circuit is the encryption.
    pub async fn http_request(
        &self,
        host: &str,
        port: u16,
        method: &str,
        path: &str,
        headers: &[(String, String)],
        body: Vec<u8>,
    ) -> Result<(u16, Vec<u8>), String> {
        let stream = self.connect(host, port).await?;
        let io = hyper_util::rt::TokioIo::new(stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
            .await
            .map_err(|e| e.to_string())?;
        // Drive the connection in the background while we send/receive.
        tokio::spawn(async move {
            let _ = conn.await;
        });

        let authority = if port == 80 {
            host.to_string()
        } else {
            format!("{host}:{port}")
        };
        let target = if path.is_empty() { "/" } else { path };
        let mut builder = hyper::Request::builder()
            .method(hyper::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?)
            .uri(target)
            .header(hyper::header::HOST, authority);
        for (k, v) in headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        let req = builder
            .body(http_body_util::Full::new(bytes::Bytes::from(body)))
            .map_err(|e| e.to_string())?;

        let resp = sender.send_request(req).await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let bytes = resp
            .into_body()
            .collect()
            .await
            .map_err(|e| e.to_string())?
            .to_bytes()
            .to_vec();
        Ok((status, bytes))
    }
}

/// Split a server URL into (host, port). Default port: 443 for https/wss, else 80.
pub fn host_port(url: &str) -> Result<(String, u16), String> {
    let (scheme, rest) = url.split_once("://").unwrap_or(("http", url));
    let default_port = match scheme {
        "https" | "wss" => 443,
        _ => 80,
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    if let Some((h, p)) = authority.rsplit_once(':') {
        if let Ok(port) = p.parse::<u16>() {
            if h.is_empty() {
                return Err("invalid server URL".to_string());
            }
            return Ok((h.to_string(), port));
        }
    }
    if authority.is_empty() {
        return Err("invalid server URL".to_string());
    }
    Ok((authority.to_string(), default_port))
}
