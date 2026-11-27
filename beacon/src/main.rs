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

use beacon::{clients, config, page, runner};

use anyhow::{bail, Context, Result};
use config::Config;
use runner::{open_store, served_onion};
use std::path::{Path, PathBuf};

const DEFAULT_CONFIG: &str = "/etc/beacon/config.yaml";

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
/// Beacon runs on Linux only (desktop Linux or a Raspberry Pi). Elsewhere the
/// binary builds, so the workspace does, but only says so.
#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("beacon: Beacon runs on Linux only (desktop Linux or a Raspberry Pi)");
    std::process::ExitCode::FAILURE
}

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("beacon: {e:#}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
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
                .block_on(runner::serve_until(cfg, a.tcp, async {
                    let _ = tokio::signal::ctrl_c().await;
                }))
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
    if runner::init(cfg)? {
        println!("master key written to {} — back it up apart from the data", cfg.master_key.display());
    } else {
        println!("master key already at {}", cfg.master_key.display());
    }
    check(cfg)
}

fn check(cfg: &Config) -> Result<()> {
    let c = runner::check(cfg);
    println!("master key: {}", c.master_key);
    println!("disk: {}", c.disk.describe());
    if c.key_off_encrypted_disk {
        println!("note: the master key is not on the encrypted disk; see docs/disk-encryption.md");
    }
    if !c.key_ok() {
        bail!("not ready to serve");
    }
    Ok(())
}

fn status(cfg: &Config) -> Result<()> {
    let s = open_store(cfg)?;
    for (t, n) in s.counts()? {
        println!("{t:>8}: {n}");
    }
    match served_onion(cfg) {
        Some(o) => println!("   onion: {o}"),
        None => println!("   onion: (not served yet)"),
    }
    Ok(())
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
