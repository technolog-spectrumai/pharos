//! Running a Beacon from code: what `beacon serve` does, startable and stoppable
//! from a library call (the `enigma-beacon` app), reporting its phase, address and
//! relay statistics. `beacon serve` is [`serve_until`] with Ctrl-C.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use beacon_node::link::{BoxRead, BoxWrite, Dialer, LinkCfg};
use beacon_node::queue::QueueLimits;
use beacon_node::relay::{Relay, RelayConfig};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{oneshot, Semaphore};

use crate::api::{self, AppState, Limiter};
use crate::config::Config;
use crate::masterkey::MasterKey;
use crate::store::Store;
use crate::{clients, diskcrypt, page, relay_store};

const SWEEP_SECS: u64 = 600;

/// Where a running Beacon is in its life.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    Off,
    StartingTor,
    PublishingOnion,
    Online,
    Error(String),
}

impl Phase {
    /// One short word or two for a UI.
    #[must_use]
    pub fn label(&self) -> &str {
        match self {
            Phase::Off => "off",
            Phase::StartingTor => "starting Tor",
            Phase::PublishingOnion => "publishing onion",
            Phase::Online => "online",
            Phase::Error(_) => "error",
        }
    }
}

/// How the Beacon is reached.
#[derive(Clone)]
pub enum Listen {
    /// An onion service (the real thing).
    Tor,
    /// Loopback TCP (tests, development).
    Tcp(SocketAddr),
    /// No listener: only the relay runs, reached in-process (tests, demos), e.g.
    /// through a [`beacon_node::relay::Directory`]; `dialer` reaches other Beacons.
    Memory { onion: String, dialer: Arc<dyn Dialer> },
}

/// A note for the log (Unix seconds, text).
pub type Note = (u64, String);

/// What a running Beacon reports.
#[derive(Clone, Debug)]
pub struct Status {
    pub phase: Phase,
    pub onion: Option<String>,
    /// Unix seconds when it came online.
    pub online_since: Option<u64>,
    /// One line on Tor: "not running", "bootstrapping", "connected", "not used (…)".
    pub tor: String,
    pub notes: Vec<Note>,
}

impl Default for Status {
    fn default() -> Self {
        Status { phase: Phase::Off, onion: None, online_since: None, tor: "not running".into(), notes: vec![] }
    }
}

#[derive(Default)]
struct Shared {
    status: Mutex<Status>,
    relay: Mutex<Option<Arc<Relay>>>,
    echo: bool,
}

impl Shared {
    fn set(&self, f: impl FnOnce(&mut Status)) {
        f(&mut self.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
    }
    fn note(&self, text: impl Into<String>) {
        let text = text.into();
        if self.echo {
            eprintln!("beacon: {text}");
        }
        self.set(|s| {
            s.notes.push((api::now_secs(), text));
            if s.notes.len() > 200 {
                s.notes.remove(0);
            }
        });
    }
}

/// A Beacon started with [`start`].
pub struct Running {
    shared: Arc<Shared>,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

/// Starts serving `cfg` on `listen` in `rt`. Errors end up in [`Status::phase`].
pub fn start(cfg: Config, listen: Listen, rt: &tokio::runtime::Handle, echo: bool) -> Running {
    let shared = Arc::new(Shared { echo, ..Shared::default() });
    let (tx, rx) = oneshot::channel();
    let sh = shared.clone();
    let task = rt.spawn(async move {
        let r = serve_inner(cfg, listen, sh.clone(), async {
            let _ = rx.await;
        })
        .await;
        if let Some(rel) = sh.relay.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
            rel.stop();
        }
        match r {
            Ok(()) => {
                sh.note("stopped");
                sh.set(|s| {
                    s.phase = Phase::Off;
                    s.online_since = None;
                    s.tor = "not running".into();
                });
            }
            Err(e) => {
                let m = format!("{e:#}");
                sh.note(format!("error: {m}"));
                sh.set(|s| {
                    s.phase = Phase::Error(m);
                    s.online_since = None;
                });
            }
        }
    });
    Running { shared, stop: Some(tx), task }
}

impl Running {
    #[must_use]
    pub fn status(&self) -> Status {
        self.shared.status.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
    /// The relay, while it runs.
    #[must_use]
    pub fn relay(&self) -> Option<Arc<Relay>> {
        self.shared.relay.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }
    /// Asks it to stop; it reaches [`Phase::Off`] soon after.
    pub fn stop(&mut self) {
        if let Some(t) = self.stop.take() {
            let _ = t.send(());
        }
    }
    /// Its task ended (stopped, or failed).
    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.task.is_finished()
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop();
    }
}

/// `beacon serve`: runs until `stop` resolves.
pub async fn serve_until(cfg: Config, tcp: Option<String>, stop: impl std::future::Future<Output = ()>) -> Result<()> {
    let listen = match tcp {
        Some(a) => Listen::Tcp(a.parse().context("--tcp address")?),
        None => Listen::Tor,
    };
    let sh = Arc::new(Shared { echo: true, ..Shared::default() });
    let r = serve_inner(cfg, listen, sh.clone(), stop).await;
    if let Some(rel) = sh.relay.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() {
        rel.stop();
    }
    r
}

/// Makes the folder, private.
pub fn create_private_dir(p: &Path) -> Result<()> {
    std::fs::create_dir_all(p).with_context(|| format!("{}", p.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// What `beacon check` finds.
#[derive(Clone, Debug)]
pub struct Check {
    /// "ok" or "PROBLEM: …".
    pub master_key: String,
    pub disk: diskcrypt::Verdict,
    /// The master key is not on the encrypted disk the data is on.
    pub key_off_encrypted_disk: bool,
}

impl Check {
    #[must_use]
    pub fn key_ok(&self) -> bool {
        !self.master_key.starts_with("PROBLEM")
    }
}

#[must_use]
pub fn check(cfg: &Config) -> Check {
    let master_key = MasterKey::load(&cfg.master_key).map(|_| "ok".to_string()).unwrap_or_else(|e| format!("PROBLEM: {e:#}"));
    let disk = diskcrypt::check(&cfg.data_dir);
    let key_disk = diskcrypt::check(cfg.master_key.parent().unwrap_or(Path::new("/")));
    Check { master_key, key_off_encrypted_disk: !key_disk.is_encrypted() && disk.is_encrypted(), disk }
}

/// `beacon init`: the data folder and (if missing) the master key; `true` if it made the key.
pub fn init(cfg: &Config) -> Result<bool> {
    create_private_dir(&cfg.data_dir)?;
    if cfg.master_key.exists() {
        return Ok(false);
    }
    if let Some(p) = cfg.master_key.parent() {
        std::fs::create_dir_all(p)?;
    }
    MasterKey::create(&cfg.master_key)?;
    Ok(true)
}

pub fn open_store(cfg: &Config) -> Result<Store> {
    let key = MasterKey::load(&cfg.master_key)?;
    Store::open(&cfg.data_dir.join("beacon.sqlite"), key, cfg.limits.clone())
}

/// The onion this Beacon was last served on (written when served over Tor).
#[must_use]
pub fn served_onion(cfg: &Config) -> Option<String> {
    std::fs::read_to_string(cfg.data_dir.join("onion.txt")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Add the page (3.8) for `onion`, unless the config turns it off.
fn with_page(app: axum::Router, cfg: &Config, onion: Option<&str>, sh: &Shared) -> Result<axum::Router> {
    match (cfg.page, onion) {
        (false, _) => Ok(app),
        (true, None) => {
            sh.note("no page yet: the address is made when it is first served over Tor");
            Ok(app)
        }
        (true, Some(o)) => {
            let p = page::Page::build(o, &cfg.name)?;
            sh.note(format!("its page, with the code for Enigma, is at http://{}/", p.onion));
            Ok(app.merge(page::router(Arc::new(p))))
        }
    }
}

async fn serve_inner(cfg: Config, listen: Listen, sh: Arc<Shared>, stop: impl std::future::Future<Output = ()>) -> Result<()> {
    let disk = diskcrypt::check(&cfg.data_dir);
    if disk.is_encrypted() {
        sh.note(format!("disk: {}", disk.describe()));
    } else {
        sh.note(format!("WARNING disk: {}", disk.describe()));
    }
    create_private_dir(&cfg.data_dir)?;
    let store = open_store(&cfg)?;
    let state = Arc::new(AppState { limiter: Limiter::new(cfg.limits.requests_per_minute), store, clock: api::now_secs });
    let app = api::router(state.clone());
    let slots = Arc::new(Semaphore::new(cfg.limits.max_concurrent));

    let sweeper = state.clone();
    let sw_sh = sh.clone();
    let sweep = tokio::spawn(async move {
        loop {
            match sweeper.store.sweep(api::now_secs()) {
                Ok(n) if n > 0 => sw_sh.note(format!("swept {n} expired rows")),
                Err(e) => sw_sh.note(format!("sweep: {e:#}")),
                _ => {}
            }
            tokio::time::sleep(std::time::Duration::from_secs(SWEEP_SECS)).await;
        }
    });
    struct Abort(tokio::task::JoinHandle<()>);
    impl Drop for Abort {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _sweep = Abort(sweep);

    tokio::pin!(stop);
    let online = |onion: &str| {
        sh.set(|s| {
            s.phase = Phase::Online;
            s.onion = Some(onion.to_string());
            s.online_since = Some(api::now_secs());
        });
    };

    match listen {
        Listen::Tcp(sa) => {
            if !sa.ip().is_loopback() {
                bail!("--tcp is for loopback only; Beacon is reached over Tor");
            }
            let l = tokio::net::TcpListener::bind(sa).await?;
            sh.note(format!("serving on http://{} (loopback, development)", l.local_addr()?));
            let app = with_page(app, &cfg, served_onion(&cfg).as_deref(), &sh)?;
            let onion = served_onion(&cfg).unwrap_or_else(|| l.local_addr().map(|a| a.to_string()).unwrap_or_default());
            let relay = start_relay(&cfg, &onion, Arc::new(beacon_node::link::NoDialer), &sh)?;
            sh.set(|s| s.tor = "not used (loopback)".into());
            online(&onion);
            loop {
                tokio::select! {
                    () = &mut stop => break,
                    r = l.accept() => if let Ok((s, _)) = r { spawn_conn(s, app.clone(), slots.clone(), relay.clone()) },
                }
            }
        }
        Listen::Memory { onion, dialer } => {
            start_relay(&cfg, &onion, dialer, &sh)?;
            sh.set(|s| s.tor = "not used (in-process)".into());
            online(&onion);
            stop.await;
        }
        Listen::Tor => {
            sh.set(|s| {
                s.phase = Phase::StartingTor;
                s.tor = "bootstrapping".into();
            });
            // arti's state (the onion key, guards, full vanguard sets) lives in the
            // data folder, so it survives restarts and the guards stay put.
            let tor = tokio::select! {
                () = &mut stop => return Ok(()),
                t = pharos_tor::Tor::start(cfg.data_dir.join("tor-state"), cfg.data_dir.join("tor-cache"), true, pharos_tor::Vanguards::Full) => Arc::new(t?),
            };
            sh.set(|s| {
                s.phase = Phase::PublishingOnion;
                s.tor = "connected".into();
            });
            // The onion's keystore nickname keeps the former name (Proteus): it selects
            // the stored identity key, so changing it would change the address.
            let hosting = async {
                if cfg.restricted_discovery {
                    let dir = cfg.clients_dir();
                    clients::prepare(&dir)?;
                    let n = clients::list(&dir)?.len();
                    sh.note(format!("restricted discovery on, {n} phone(s) allowed"));
                    tor.host_restricted("proteus", &dir).await
                } else {
                    tor.host("proteus").await
                }
            };
            let mut hosted = tokio::select! {
                () = &mut stop => return Ok(()),
                h = hosting => h?,
            };
            std::fs::write(cfg.data_dir.join("onion.txt"), format!("{}\n", hosted.onion))?;
            sh.note(format!("serving on {}", hosted.onion));
            let app = with_page(app, &cfg, Some(&hosted.onion), &sh)?;
            let relay = start_relay(&cfg, &hosted.onion, Arc::new(TorDialer(tor.clone())), &sh)?;
            online(&hosted.onion);
            loop {
                tokio::select! {
                    () = &mut stop => break,
                    s = hosted.incoming.recv() => match s {
                        Some(s) => spawn_conn(s, app.clone(), slots.clone(), relay.clone()),
                        None => bail!("the onion service stopped"),
                    },
                }
            }
        }
    }
    sh.note("stopping");
    Ok(())
}

/// One connection: HTTP/1 or (stage b2) a client / Beacon link, told apart by its
/// first bytes. Past `max_concurrent` new HTTP connections are closed at once; links
/// are long-lived and counted by the relay (`relay.max_clients`) instead.
fn spawn_conn<S>(s: S, app: axum::Router, slots: Arc<Semaphore>, relay: Option<Arc<Relay>>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let permit = slots.clone().try_acquire_owned().ok();
        if permit.is_none() && relay.is_none() {
            return;
        }
        crate::route_conn(s, app, relay).await;
        drop(permit);
    });
}

/// Dialling other Beacons over Tor.
struct TorDialer(Arc<pharos_tor::Tor>);

impl Dialer for TorDialer {
    fn dial(&self, onion: &str) -> beacon_node::BoxFuture<Result<(BoxRead, BoxWrite)>> {
        let (t, o) = (self.0.clone(), onion.to_string());
        Box::pin(async move { Ok(beacon_node::link::boxed(t.dial(&o, pharos_tor::DIAL_TIMEOUT).await?)) })
    }
}

/// The relay's node key (signs its Beacon links): 32 random bytes, sealed with the
/// master key in `node.key`, made on first use.
pub fn node_seed(cfg: &Config) -> Result<[u8; 32]> {
    let key = MasterKey::load(&cfg.master_key)?;
    let p = cfg.data_dir.join("node.key");
    if let Ok(b) = std::fs::read(&p) {
        let plain = key.open("relay-node-key", &b)?;
        return plain.as_slice().try_into().context("node.key does not hold 32 bytes");
    }
    let mut seed = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut seed);
    std::fs::write(&p, key.seal("relay-node-key", &seed))?;
    Ok(seed)
}

fn start_relay(cfg: &Config, onion: &str, dialer: Arc<dyn Dialer>, sh: &Shared) -> Result<Option<Arc<Relay>>> {
    if !cfg.relay.enabled {
        return Ok(None);
    }
    let r = &cfg.relay;
    let limits = QueueLimits { max_frames: r.max_queue_frames, max_bytes: r.max_queue_bytes, ttl_secs: r.queue_ttl_days * 86_400, ..QueueLimits::default() };
    let q = relay_store::SqliteQueue::open(&cfg.data_dir.join("relay.sqlite"), MasterKey::load(&cfg.master_key)?, limits)?;
    let mut rc = RelayConfig::new(onion);
    rc.max_clients = r.max_clients;
    rc.link = LinkCfg { max_frame: 16 * 1024 * 1024, write_timeout: std::time::Duration::from_secs(20), cover_every: 30 };
    let relay = Relay::start(rc, &node_seed(cfg)?, dialer, Arc::new(q));
    *sh.relay.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(relay.clone());
    sh.note("relay on (client links and the Beacon mesh on the same onion)");
    Ok(Some(relay))
}
