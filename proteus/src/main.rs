//! Proteus — the optional Pharos helper (Stage 3). Onion-only by design.
//!
//!   proteus init   [-c config.yaml]           make the master key and data folder
//!   proteus check  [-c config.yaml]           key permissions, disk encryption, config
//!   proteus serve  [-c config.yaml]           serve on an onion service
//!   proteus serve  --tcp 127.0.0.1:PORT       …on loopback TCP instead (tests, development)
//!   proteus status [-c config.yaml]           row counts and the onion address
//!   proteus backup [-c config.yaml] OUT       a consistent copy of the database

mod api;
mod config;
mod diskcrypt;
mod masterkey;
mod store;

use anyhow::{bail, Context, Result};
use api::{AppState, Limiter};
use config::Config;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use masterkey::MasterKey;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use store::Store;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Semaphore;

const DEFAULT_CONFIG: &str = "/etc/proteus/config.yaml";
const SWEEP_SECS: u64 = 600;

struct Args {
    cmd: String,
    config: PathBuf,
    tcp: Option<String>,
    rest: Vec<String>,
}

fn parse_args() -> Result<Args> {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().unwrap_or_else(|| "help".into());
    let mut a = Args { cmd, config: PathBuf::from(DEFAULT_CONFIG), tcp: None, rest: vec![] };
    while let Some(x) = it.next() {
        match x.as_str() {
            "-c" | "--config" => a.config = it.next().context("-c needs a path")?.into(),
            "--tcp" => a.tcp = Some(it.next().context("--tcp needs an address")?),
            _ => a.rest.push(x),
        }
    }
    Ok(a)
}

fn main() -> Result<()> {
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
        "backup" => {
            let out = a.rest.first().context("backup needs an output path")?;
            open_store(&load()?)?.backup(Path::new(out))?;
            println!("backed up to {out}; back up the master key separately");
            Ok(())
        }
        _ => {
            println!("{}", include_str!("main.rs").lines().skip(2).take(7).map(|l| l.trim_start_matches("//!")).collect::<Vec<_>>().join("\n"));
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
    Store::open(&cfg.data_dir.join("proteus.sqlite"), key, cfg.limits.clone())
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

async fn serve(cfg: Config, tcp: Option<String>) -> Result<()> {
    let disk = diskcrypt::check(&cfg.data_dir);
    if disk.is_encrypted() {
        eprintln!("proteus: disk: {}", disk.describe());
    } else {
        eprintln!("proteus: WARNING disk: {}", disk.describe());
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
                Ok(n) if n > 0 => eprintln!("proteus: swept {n} expired rows"),
                Err(e) => eprintln!("proteus: sweep: {e:#}"),
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
            bail!("--tcp is for loopback only; Proteus is reached over Tor");
        }
        let l = tokio::net::TcpListener::bind(sa).await?;
        eprintln!("proteus: serving on http://{} (loopback, development)", l.local_addr()?);
        loop {
            tokio::select! {
                _ = &mut stop => break,
                r = l.accept() => if let Ok((s, _)) = r { spawn_conn(s, app.clone(), slots.clone()) },
            }
        }
    } else {
        let tor = pharos_tor::Tor::start(cfg.data_dir.join("tor-state"), cfg.data_dir.join("tor-cache"), true).await?;
        let mut hosted = tor.host("proteus").await?;
        std::fs::write(cfg.data_dir.join("onion.txt"), format!("{}\n", hosted.onion))?;
        eprintln!("proteus: serving on {}", hosted.onion);
        loop {
            tokio::select! {
                _ = &mut stop => break,
                s = hosted.incoming.recv() => match s {
                    Some(s) => spawn_conn(s, app.clone(), slots.clone()),
                    None => bail!("the onion service stopped"),
                },
            }
        }
    }
    eprintln!("proteus: stopping");
    Ok(())
}

/// One HTTP/1 connection; past `max_concurrent` new connections are closed at once.
fn spawn_conn<S>(s: S, app: axum::Router, slots: Arc<Semaphore>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Ok(permit) = slots.try_acquire_owned() else { return };
    tokio::spawn(async move {
        let svc = TowerToHyperService::new(app);
        let conn = hyper::server::conn::http1::Builder::new()
            .max_buf_size(64 * 1024)
            .header_read_timeout(std::time::Duration::from_secs(30))
            .timer(hyper_util::rt::TokioTimer::new())
            .serve_connection(TokioIo::new(s), svc);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(120), conn).await;
        drop(permit);
    });
}
