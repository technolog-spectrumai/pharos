//! The onion transport, from Enigma's `p2p_tor.rs`, cut to what Pharos needs:
//! start arti, host an onion service and hand out its inbound streams, and
//! dial an onion with a timeout. Framing and size caps are pharos-wire's.
//!
//! An onion can be hosted with a key we supply ([`Tor::host_with_key`]: a
//! friendship's weekly rendezvous key, D2) or with arti's own persistent key
//! ([`Tor::host`]: Proteus' stable address).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use arti_client::config::TorClientConfigBuilder;
use arti_client::{DataStream, TorClient};
use futures::StreamExt;
use safelog::DisplayRedacted;
use tokio::sync::mpsc;
use tor_cell::relaycell::msg::Connected;
use tor_hsservice::config::OnionServiceConfigBuilder;
use tor_hsservice::{handle_rend_requests, HsNickname, RunningOnionService};
use tor_rtcompat::PreferredRuntime;

/// The virtual port every Pharos onion listens on.
pub const PORT: u16 = 80;
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(60);
/// How many inbound streams wait unaccepted before new ones are dropped.
const BACKLOG: usize = 32;

pub use arti_client::DataStream as Stream;

#[derive(Clone)]
pub struct Tor {
    client: Arc<TorClient<PreferredRuntime>>,
}

/// A running onion service and its inbound streams. Dropping it stops the service.
pub struct Hosted {
    pub onion: String,
    pub incoming: mpsc::Receiver<DataStream>,
    _service: Arc<RunningOnionService>,
    _task: tokio::task::JoinHandle<()>,
}

impl Tor {
    /// Bootstrap arti with its state (keys) in `state_dir` and its directory cache in `cache_dir`.
    pub async fn start(state_dir: PathBuf, cache_dir: PathBuf, strict_permissions: bool) -> Result<Self> {
        std::fs::create_dir_all(&state_dir)?;
        std::fs::create_dir_all(&cache_dir)?;
        let mut b = TorClientConfigBuilder::from_directories(state_dir, cache_dir);
        if !strict_permissions {
            // A desktop profile directory may be group-readable; the vault seals what matters.
            b.storage().permissions().dangerously_trust_everyone();
        }
        let cfg = b.build().map_err(|e| anyhow!("tor config: {e}"))?;
        let client = TorClient::create_bootstrapped(cfg).await.map_err(|e| anyhow!("tor bootstrap: {e}"))?;
        Ok(Tor { client })
    }

    /// Host an onion under arti's own (persistent) key for `nickname`.
    pub async fn host(&self, nickname: &str) -> Result<Hosted> {
        let cfg = service_config(nickname)?;
        let (svc, rend) = self
            .client
            .launch_onion_service(cfg)
            .map_err(|e| anyhow!("launch onion service: {e}"))?
            .ok_or_else(|| anyhow!("onion service disabled"))?;
        finish(svc, rend).await
    }

    /// Host an onion whose identity key is `expanded_secret` (64 bytes: clamped
    /// scalar ‖ hash prefix, as pharos-rendezvous derives it).
    pub async fn host_with_key(&self, nickname: &str, expanded_secret: [u8; 64]) -> Result<Hosted> {
        let kp = hsid_keypair(expanded_secret)?;
        let cfg = service_config(nickname)?;
        let (svc, rend) = self
            .client
            .launch_onion_service_with_hsid(cfg, kp)
            .map_err(|e| anyhow!("launch onion service: {e}"))?
            .ok_or_else(|| anyhow!("onion service disabled"))?;
        finish(svc, rend).await
    }

    /// Dial `onion` on [`PORT`], giving up after `timeout`.
    pub async fn dial(&self, onion: &str, timeout: Duration) -> Result<DataStream> {
        tokio::time::timeout(timeout, self.client.connect((onion, PORT)))
            .await
            .map_err(|_| anyhow!("dialing {onion} timed out"))?
            .map_err(|e| anyhow!("dialing {onion}: {e}"))
    }
}

fn service_config(nickname: &str) -> Result<tor_hsservice::OnionServiceConfig> {
    let nick = HsNickname::new(nickname.to_string()).map_err(|e| anyhow!("onion nickname {nickname:?}: {e}"))?;
    OnionServiceConfigBuilder::default().nickname(nick).build().map_err(|e| anyhow!("onion config: {e}"))
}

/// Build arti's identity keypair from the 64-byte expanded secret.
pub fn hsid_keypair(expanded_secret: [u8; 64]) -> Result<tor_hscrypto::pk::HsIdKeypair> {
    let kp = tor_llcrypto::pk::ed25519::ExpandedKeypair::from_secret_key_bytes(expanded_secret)
        .context("not a valid expanded ed25519 secret")?;
    Ok(kp.into())
}

/// The onion address arti will publish for `expanded_secret`.
pub fn onion_of(expanded_secret: [u8; 64]) -> Result<String> {
    let kp = hsid_keypair(expanded_secret)?;
    let id: tor_hscrypto::pk::HsIdKey = (&kp).into();
    let hsid: tor_hscrypto::pk::HsId = id.id();
    let addr = hsid.display_unredacted().to_string();
    Ok(addr)
}

async fn finish<S>(svc: Arc<RunningOnionService>, rend: S) -> Result<Hosted>
where
    S: futures::Stream<Item = tor_hsservice::RendRequest> + Send + 'static,
{
    let mut onion = None;
    for _ in 0..100 {
        if let Some(id) = svc.onion_address() {
            onion = Some(id.display_unredacted().to_string());
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let onion = onion.ok_or_else(|| anyhow!("onion address was not ready"))?;
    let (tx, rx) = mpsc::channel(BACKLOG);
    let task = tokio::spawn(async move {
        let mut streams = Box::pin(handle_rend_requests(rend));
        while let Some(req) = streams.next().await {
            match req.accept(Connected::new_empty()).await {
                Ok(ds) => {
                    // Full backlog: drop the stream rather than queue without bound.
                    if let Err(mpsc::error::TrySendError::Closed(_)) = tx.try_send(ds) {
                        break;
                    }
                }
                Err(_) => continue,
            }
        }
    });
    Ok(Hosted { onion, incoming: rx, _service: svc, _task: task })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pharos_rendezvous::FriendshipSecret;

    #[test]
    fn our_derived_onion_is_the_one_arti_publishes() {
        let s = FriendshipSecret::from_bytes([0x42; 32]);
        for week in [0, 1, 2900, u64::MAX / 2] {
            let k = s.rendezvous(&[0xa1; 16], week);
            assert_eq!(onion_of(k.expanded_secret()).unwrap(), k.onion_address());
        }
    }

    #[test]
    fn nicknames_are_checked() {
        assert!(service_config("pharos-rv-1").is_ok());
        assert!(service_config("bad nick!").is_err());
    }
}
