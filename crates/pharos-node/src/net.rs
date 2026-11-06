//! How a node reaches others: dial an onion, host one under a given key.
//! [`TorNet`] is arti; [`MemNet`] is an in-process stand-in for tests, which
//! can also route an "onion" to a loopback TCP address (a real Relay).

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}
pub type BoxIo = Box<dyn Io>;

/// A hosted onion: its address and its inbound streams. Dropping it stops hosting.
pub struct Listener {
    pub onion: String,
    pub incoming: mpsc::Receiver<BoxIo>,
    pub guard: Box<dyn Send + Sync>,
}

pub trait Net: Clone + Send + Sync + 'static {
    fn dial(&self, onion: &str) -> impl Future<Output = Result<BoxIo>> + Send;
    fn host(&self, nickname: &str, expanded_key: [u8; 64], onion: &str) -> impl Future<Output = Result<Listener>> + Send;
}

#[derive(Clone, Default)]
pub struct MemNet {
    routes: Arc<Mutex<HashMap<String, Route>>>,
}

#[derive(Clone)]
enum Route {
    Host(mpsc::Sender<BoxIo>),
    Tcp(std::net::SocketAddr),
}

impl MemNet {
    /// Make `onion` reach a TCP address (a Relay serving with `--tcp`).
    pub fn route_tcp(&self, onion: &str, addr: std::net::SocketAddr) {
        self.routes.lock().unwrap().insert(onion.to_string(), Route::Tcp(addr));
    }
    /// Take an onion off the network (a friend going offline).
    pub fn unroute(&self, onion: &str) {
        self.routes.lock().unwrap().remove(onion);
    }
}

impl Net for MemNet {
    async fn dial(&self, onion: &str) -> Result<BoxIo> {
        let route = self.routes.lock().unwrap().get(onion).cloned();
        match route {
            Some(Route::Host(tx)) => {
                let (a, b) = tokio::io::duplex(256 * 1024);
                tx.send(Box::new(b)).await.map_err(|_| anyhow!("{onion} is not listening"))?;
                Ok(Box::new(a))
            }
            Some(Route::Tcp(addr)) => Ok(Box::new(tokio::net::TcpStream::connect(addr).await?)),
            None => Err(anyhow!("{onion} is unreachable")),
        }
    }

    async fn host(&self, _nickname: &str, _key: [u8; 64], onion: &str) -> Result<Listener> {
        let (tx, rx) = mpsc::channel(16);
        self.routes.lock().unwrap().insert(onion.to_string(), Route::Host(tx));
        struct Unhost(MemNet, String);
        impl Drop for Unhost {
            fn drop(&mut self) {
                self.0.unroute(&self.1);
            }
        }
        Ok(Listener { onion: onion.to_string(), incoming: rx, guard: Box::new(Unhost(self.clone(), onion.to_string())) })
    }
}

#[cfg(feature = "tor")]
#[derive(Clone)]
pub struct TorNet(pub pharos_tor::Tor);

#[cfg(feature = "tor")]
impl Net for TorNet {
    async fn dial(&self, onion: &str) -> Result<BoxIo> {
        Ok(Box::new(self.0.dial(onion, pharos_tor::DIAL_TIMEOUT).await?))
    }

    async fn host(&self, nickname: &str, expanded_key: [u8; 64], onion: &str) -> Result<Listener> {
        let mut h = self.0.host_with_key(nickname, expanded_key).await?;
        if h.onion != onion {
            return Err(anyhow!("arti hosts {} for a key we derived as {onion}", h.onion));
        }
        let (tx, rx) = mpsc::channel(16);
        let pump = tokio::spawn(async move {
            while let Some(s) = h.incoming.recv().await {
                if tx.send(Box::new(s) as BoxIo).await.is_err() {
                    break;
                }
            }
        });
        struct Abort(tokio::task::JoinHandle<()>);
        impl Drop for Abort {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        Ok(Listener { onion: onion.to_string(), incoming: rx, guard: Box::new(Abort(pump)) })
    }
}
