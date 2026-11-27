//! Beacon — the optional Pharos helper (Stage 3). Onion-only by design.
//!
//!   beacon init   [-c config.yaml]           make the master key and data folder
//!   beacon check  [-c config.yaml]           key permissions, disk encryption, config
//!   beacon serve  [-c config.yaml]           serve on an onion service
//!   beacon serve  --tcp 127.0.0.1:PORT       …on loopback TCP instead (tests, development)
//!   beacon status [-c config.yaml]           row counts and the onion address
//!   beacon backup [-c config.yaml] OUT       a consistent copy of the database
//!   beacon code   [-c config.yaml] [--png F] its code for Enigma, as text and a QR (and a PNG)
//!   beacon allow  [-c config.yaml] NAME KEY  let a phone find it (restricted_discovery)
//!   beacon deny   [-c config.yaml] NAME      take a phone off the list
//!   beacon clients [-c config.yaml]          the phones on the list

use beacon::{api, clients, config, diskcrypt, masterkey, page, relay_store, store};

use anyhow::{bail, Context, Result};
use api::{AppState, Limiter};
use beacon_node::link::{BoxRead, BoxWrite, Dialer, LinkCfg};
use beacon_node::queue::QueueLimits;
use beacon_node::relay::{Relay, RelayConfig};
use config::Config;
use masterkey::MasterKey;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use store::Store;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Semaphore;

const DEFAULT_CONFIG: &str = "/etc/beacon/config.yaml";
const SWEEP_SECS: u64 = 600;

struct Args {
    cmd: String,
    config: PathBuf,
    tcp: Option<String>,
    png: Option<PathBuf>,
    rest: Vec<String>,
}

fn parse_args() -> Result<Args> {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().unwrap_or_else(|| "help".into());
    let mut a = Args { cmd, config: PathBuf::from(DEFAULT_CONFIG), tcp: None, png: None, rest: vec![] };
    while let Some(x) = it.next() {
        match x.as_str() {
            "-c" | "--config" => a.config = it.next().context("-c needs a path")?.into(),
            "--tcp" => a.tcp = Some(it.next().context("--tcp needs an address")?),
            "--png" => a.png = Some(it.next().context("--png needs a file")?.into()),
            _ => a.rest.push(x),
        }
    }
    Ok(a)
}

/// Errors are one line for the person at the terminal (or in the journal),
/// whatever RUST_BACKTRACE says; the exit status says it failed.
fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("beacon: {e:#}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let a = parse_args()?;
    let load = || Config::load(&a.config);
    match a.cmd.as_str() {
        "init" => init(&load()?),
        "check" => check(&load()?),
        "serve" => {
            let cfg = load()?;
            tokio::runtime::Builder::new_multi_thread()
                // A Pi has four cores and little memory; a couple of workers is plenty.
                .worker_threads(2)
                .enable_all()
                .build()?
                .block_on(serve(cfg, a.tcp))
        }
        "status" => status(&load()?),
        "code" => code(&load()?, a.png.as_deref()),
        "backup" => {
            let out = a.rest.first().context("backup needs an output path")?;
            open_store(&load()?)?.backup(Path::new(out))?;
            println!("backed up to {out}; back up the master key separately");
            Ok(())
        }
        "allow" => {
            let (name, key) = match a.rest.as_slice() {
                [n, k] => (n.as_str(), k.as_str()),
                _ => bail!("allow needs a NAME and the phone's KEY"),
            };
            let cfg = load()?;
            clients::allow(&cfg.clients_dir(), name, key)?;
            println!("{name} is allowed{}", if cfg.restricted_discovery { "; it can find Beacon within minutes" } else { " (restricted_discovery is off, so everyone can find Beacon)" });
            Ok(())
        }
        "deny" => {
            let name = a.rest.first().context("deny needs a NAME")?;
            clients::deny(&load()?.clients_dir(), name)?;
            println!("{name} is off the list (it may still reach Beacon for a while)");
            Ok(())
        }
        "clients" => {
            for n in clients::list(&load()?.clients_dir())? {
                println!("{n}");
            }
            Ok(())
        }
        _ => {
            let usage: Vec<&str> = include_str!("main.rs").lines().skip(2).take(10).map(|l| l.trim_start_matches("//!   ")).collect();
            println!("Beacon {}: the optional Pharos helper, reached only over Tor.\n\nusage:\n  {}", env!("CARGO_PKG_VERSION"), usage.join("\n  "));
            Ok(())
        }
    }
}

fn init(cfg: &Config) -> Result<()> {
    create_private_dir(&cfg.data_dir)?;
    if cfg.master_key.exists() {
        println!("master key already at {}", cfg.master_key.display());
    } else {
        MasterKey::create(&cfg.master_key)?;
        println!("master key written to {} — back it up apart from the data", cfg.master_key.display());
    }
    check(cfg)
}

fn create_private_dir(p: &Path) -> Result<()> {
    std::fs::create_dir_all(p).with_context(|| format!("{}", p.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn check(cfg: &Config) -> Result<()> {
    let key = MasterKey::load(&cfg.master_key).map(|_| "ok".to_string()).unwrap_or_else(|e| format!("PROBLEM: {e:#}"));
    println!("master key: {key}");
    let disk = diskcrypt::check(&cfg.data_dir);
    println!("disk: {}", disk.describe());
    let key_disk = diskcrypt::check(cfg.master_key.parent().unwrap_or(Path::new("/")));
    if !key_disk.is_encrypted() && disk.is_encrypted() {
        println!("note: the master key is not on the encrypted disk; see docs/disk-encryption.md");
    }
    if key.starts_with("PROBLEM") {
        bail!("not ready to serve");
    }
    Ok(())
}

fn open_store(cfg: &Config) -> Result<Store> {
    let key = MasterKey::load(&cfg.master_key)?;
    Store::open(&cfg.data_dir.join("beacon.sqlite"), key, cfg.limits.clone())
}

fn status(cfg: &Config) -> Result<()> {
    let s = open_store(cfg)?;
    for (t, n) in s.counts()? {
        println!("{t:>8}: {n}");
    }
    match std::fs::read_to_string(cfg.data_dir.join("onion.txt")) {
        Ok(o) => println!("   onion: {}", o.trim()),
        Err(_) => println!("   onion: (not served yet)"),
    }
    Ok(())
}

/// The onion this Beacon was last served on (written by `serve`).
fn served_onion(cfg: &Config) -> Option<String> {
    std::fs::read_to_string(cfg.data_dir.join("onion.txt")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Its code for Enigma: the text, the QR in the terminal, and optionally a PNG.
fn code(cfg: &Config, png: Option<&Path>) -> Result<()> {
    let onion = served_onion(cfg).context("no address yet: run `beacon serve` once; Tor makes the address then")?;
    let p = page::Page::build(&onion, &cfg.name)?;
    println!("{}\n", p.code);
    print!("{}", page::qr_terminal(&p.code)?);
    println!("\n{} — {}", cfg.name, p.onion);
    if let Some(f) = png {
        std::fs::write(f, page::qr_png(&p.code)?)?;
        println!("QR image written to {}", f.display());
    }
    Ok(())
}

/// Add the page (3.8) for `onion`, unless the config turns it off.
fn with_page(app: axum::Router, cfg: &Config, onion: Option<&str>) -> Result<axum::Router> {
    match (cfg.page, onion) {
        (false, _) => Ok(app),
        (true, None) => {
            eprintln!("beacon: no page yet: the address is made when it is first served over Tor");
            Ok(app)
        }
        (true, Some(o)) => {
            let p = page::Page::build(o, &cfg.name)?;
            eprintln!("beacon: its page, with the code for Enigma, is at http://{}/", p.onion);
            Ok(app.merge(page::router(Arc::new(p))))
        }
    }
}

async fn serve(cfg: Config, tcp: Option<String>) -> Result<()> {
    let disk = diskcrypt::check(&cfg.data_dir);
    if disk.is_encrypted() {
        eprintln!("beacon: disk: {}", disk.describe());
    } else {
        eprintln!("beacon: WARNING disk: {}", disk.describe());
    }
    create_private_dir(&cfg.data_dir)?;
    let store = open_store(&cfg)?;
    let state = Arc::new(AppState { limiter: Limiter::new(cfg.limits.requests_per_minute), store, clock: api::now_secs });
    let app = api::router(state.clone());
    let slots = Arc::new(Semaphore::new(cfg.limits.max_concurrent));

    let sweeper = state.clone();
    tokio::spawn(async move {
        loop {
            match sweeper.store.sweep(api::now_secs()) {
                Ok(n) if n > 0 => eprintln!("beacon: swept {n} expired rows"),
                Err(e) => eprintln!("beacon: sweep: {e:#}"),
                _ => {}
            }
            tokio::time::sleep(std::time::Duration::from_secs(SWEEP_SECS)).await;
        }
    });

    let stop = tokio::signal::ctrl_c();
    tokio::pin!(stop);

    if let Some(addr) = tcp {
        let sa: std::net::SocketAddr = addr.parse().context("--tcp address")?;
        if !sa.ip().is_loopback() {
            bail!("--tcp is for loopback only; Beacon is reached over Tor");
        }
        let l = tokio::net::TcpListener::bind(sa).await?;
        eprintln!("beacon: serving on http://{} (loopback, development)", l.local_addr()?);
        let app = with_page(app, &cfg, served_onion(&cfg).as_deref())?;
        let onion = served_onion(&cfg).unwrap_or_else(|| format!("{}", l.local_addr().map(|a| a.to_string()).unwrap_or_default()));
        let relay = start_relay(&cfg, &onion, Arc::new(beacon_node::link::NoDialer))?;
        loop {
            tokio::select! {
                _ = &mut stop => break,
                r = l.accept() => if let Ok((s, _)) = r { spawn_conn(s, app.clone(), slots.clone(), relay.clone()) },
            }
        }
    } else {
        // arti's state (the onion key, guards, full vanguard sets) lives in the
        // data folder, so it survives restarts and the guards stay put.
        let tor = Arc::new(pharos_tor::Tor::start(cfg.data_dir.join("tor-state"), cfg.data_dir.join("tor-cache"), true, pharos_tor::Vanguards::Full).await?);
        // The onion's keystore nickname keeps the former name (Proteus): it selects
        // the stored identity key, so changing it would change the address.
        let mut hosted = if cfg.restricted_discovery {
            let dir = cfg.clients_dir();
            clients::prepare(&dir)?;
            let n = clients::list(&dir)?.len();
            eprintln!("beacon: restricted discovery on, {n} phone(s) allowed");
            tor.host_restricted("proteus", &dir).await?
        } else {
            tor.host("proteus").await?
        };
        std::fs::write(cfg.data_dir.join("onion.txt"), format!("{}\n", hosted.onion))?;
        eprintln!("beacon: serving on {}", hosted.onion);
        let app = with_page(app, &cfg, Some(&hosted.onion))?;
        let relay = start_relay(&cfg, &hosted.onion, Arc::new(TorDialer(tor.clone())))?;
        loop {
            tokio::select! {
                _ = &mut stop => break,
                s = hosted.incoming.recv() => match s {
                    Some(s) => spawn_conn(s, app.clone(), slots.clone(), relay.clone()),
                    None => bail!("the onion service stopped"),
                },
            }
        }
    }
    eprintln!("beacon: stopping");
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
        beacon::route_conn(s, app, relay).await;
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
fn node_seed(cfg: &Config) -> Result<[u8; 32]> {
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

fn start_relay(cfg: &Config, onion: &str, dialer: Arc<dyn Dialer>) -> Result<Option<Arc<Relay>>> {
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
    eprintln!("beacon: relay on (client links and the Beacon mesh on the same onion)");
    Ok(Some(relay))
}
