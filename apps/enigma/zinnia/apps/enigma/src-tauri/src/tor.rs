// Embedded Tor (Arti) transport for reaching a `.onion` server.
//
// When the active profile has `server_is_onion` on, the HTTP gateway (data.rs)
// and the realtime WS backend (realtime.rs) route through this module instead of
// connecting directly — nothing can resolve a `.onion` without Tor. We embed a
// pure-Rust Tor client (arti); no external tor daemon / Orbot is required. The
// client is bootstrapped lazily on first use (bootstrap builds circuits and is
// slow) and then cached for the lifetime of the process.
//
// The onion service may speak plain HTTP (the Tor circuit is the encryption) OR
// HTTPS (TLS on top of the Tor stream). For TLS we accept the server certificate
// WITHOUT name/CA verification: the Tor circuit already authenticates the .onion
// address, and onion TLS certs are self-signed — the address itself is the identity.

use std::sync::Arc;

use arti_client::{DataStream, TorClient, TorClientConfig};
use http_body_util::BodyExt;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::OnceCell;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::{self, ClientConfig};
use tokio_rustls::TlsConnector;
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

    /// Open a TLS-wrapped Tor stream (for https/wss onion endpoints). The server
    /// cert is accepted without verification — see the module note for why.
    pub async fn connect_tls(&self, host: &str, port: u16) -> Result<TlsStream<DataStream>, String> {
        let stream = self.connect(host, port).await?;
        tls_wrap(stream, host).await
    }

    /// Perform one HTTP/1.1 request over a fresh Tor stream, returning
    /// (status, body bytes). `tls` selects HTTPS (TLS over the Tor stream) vs HTTP.
    pub async fn http_request(
        &self,
        host: &str,
        port: u16,
        tls: bool,
        method: &str,
        path: &str,
        headers: &[(String, String)],
        body: Vec<u8>,
    ) -> Result<(u16, Vec<u8>), String> {
        if tls {
            let stream = self.connect_tls(host, port).await?;
            send_http(stream, host, port, tls, method, path, headers, body).await
        } else {
            let stream = self.connect(host, port).await?;
            send_http(stream, host, port, tls, method, path, headers, body).await
        }
    }
}

/// Wrap any byte stream in TLS using the accept-any-cert config (for https/wss
/// over a Tor stream, and reused by the E2E harness for clearnet streams).
pub(crate) async fn tls_wrap<S>(stream: S, host: &str) -> Result<TlsStream<S>, String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|e| format!("invalid TLS server name {host:?}: {e}"))?;
    TlsConnector::from(tls_config())
        .connect(server_name, stream)
        .await
        .map_err(|e| format!("TLS handshake to {host} failed: {e}"))
}

/// Send one HTTP/1.1 request over an established (plain or TLS) stream.
pub(crate) async fn send_http<S>(
    stream: S,
    host: &str,
    port: u16,
    tls: bool,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: Vec<u8>,
) -> Result<(u16, Vec<u8>), String>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let io = hyper_util::rt::TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| e.to_string())?;
    // Drive the connection in the background while we send/receive.
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let default_port = if tls { 443 } else { 80 };
    let authority = if port == default_port {
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

/// A process-wide rustls client config that accepts any server certificate.
/// Safe here only because every use is over a Tor circuit that already
/// authenticates the .onion address (see the module note).
pub(crate) fn tls_config() -> Arc<ClientConfig> {
    static CONFIG: std::sync::OnceLock<Arc<ClientConfig>> = std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
            let config = ClientConfig::builder_with_provider(provider.clone())
                .with_safe_default_protocol_versions()
                .expect("rustls default protocol versions")
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

/// Accepts any certificate but still validates handshake signatures (using the
/// crypto provider's algorithms). The .onion address is the real identity.
#[derive(Debug)]
struct AcceptAnyServerCert(Arc<tokio_rustls::rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
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

#[cfg(test)]
mod tests {
    use super::host_port;

    fn hp(url: &str) -> (String, u16) {
        host_port(url).expect("parse")
    }

    #[test]
    fn defaults_http_ws_to_80() {
        assert_eq!(hp("http://abc.onion"), ("abc.onion".into(), 80));
        assert_eq!(hp("ws://abc.onion"), ("abc.onion".into(), 80));
        // No scheme → treated as http (port 80).
        assert_eq!(hp("abc.onion"), ("abc.onion".into(), 80));
    }

    #[test]
    fn defaults_https_wss_to_443() {
        assert_eq!(hp("https://x.onion"), ("x.onion".into(), 443));
        assert_eq!(hp("wss://x.onion"), ("x.onion".into(), 443));
    }

    #[test]
    fn explicit_port_wins() {
        assert_eq!(hp("http://abc.onion:8080"), ("abc.onion".into(), 8080));
        assert_eq!(hp("https://abc.onion:8443"), ("abc.onion".into(), 8443));
    }

    #[test]
    fn strips_path_and_trailing_slash() {
        assert_eq!(hp("http://abc.onion/admin/login/"), ("abc.onion".into(), 80));
        assert_eq!(hp("http://abc.onion:9000/x?y=1"), ("abc.onion".into(), 9000));
    }

    #[test]
    fn rejects_empty() {
        assert!(host_port("").is_err());
        assert!(host_port("http://").is_err());
    }
}
