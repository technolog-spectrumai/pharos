//! pharos-lighthouse: run and manage a Beacon with a window.
//!
//!   pharos-lighthouse [-c config.yaml]        the Beacon of this config (on Tor)
//!   pharos-lighthouse --tcp 127.0.0.1:PORT    …served on loopback TCP instead (development)
//!   pharos-lighthouse --demo                  fake clients and rooms (screenshots)
//!   pharos-lighthouse --dark | --light        force the theme
//!
//! Without -c: /etc/beacon/config.yaml if it exists (the `beacon` package's), else
//! ~/.config/pharos-lighthouse/config.yaml (made on first save, data beside it).

use std::path::PathBuf;

use beacon::runner::Listen;
use pharos_lighthouse::model::{Mode, Model};

fn default_config() -> PathBuf {
    let etc = PathBuf::from("/etc/beacon/config.yaml");
    if etc.exists() {
        return etc;
    }
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))).unwrap_or_else(std::env::temp_dir);
    let new = base.join("pharos-lighthouse").join("config.yaml");
    // Before the rename the app was enigma-beacon: keep using a Beacon set up there.
    let old = base.join("enigma-beacon").join("config.yaml");
    if !new.exists() && old.exists() {
        return old;
    }
    new
}

/// Beacon runs on Linux only (desktop Linux or a Raspberry Pi). Elsewhere the
/// binary builds, so the workspace does, but only says so.
#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("pharos-lighthouse: Beacon runs on Linux only (desktop Linux or a Raspberry Pi)");
    std::process::ExitCode::FAILURE
}

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let after = |flag: &[&str]| args.iter().position(|a| flag.contains(&a.as_str())).and_then(|i| args.get(i + 1)).cloned();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        let usage: Vec<&str> = include_str!("main.rs").lines().skip(2).take(4).map(|l| l.trim_start_matches("//!   ")).collect();
        println!("Pharos Lighthouse {}\n\nusage:\n  {}", env!("CARGO_PKG_VERSION"), usage.join("\n  "));
        return std::process::ExitCode::SUCCESS;
    }
    let demo = args.iter().any(|a| a == "--demo");
    let config = after(&["-c", "--config"]).map(PathBuf::from).unwrap_or_else(|| if demo { std::env::temp_dir().join("pharos-lighthouse-demo").join("config.yaml") } else { default_config() });
    let mode = if demo {
        Mode::Demo
    } else if let Some(a) = after(&["--tcp"]) {
        match a.parse() {
            Ok(sa) => Mode::Real(Listen::Tcp(sa)),
            Err(e) => {
                eprintln!("pharos-lighthouse: --tcp {a}: {e}");
                return std::process::ExitCode::FAILURE;
            }
        }
    } else {
        Mode::Real(Listen::Tor)
    };
    let m = match Model::open(&config, mode) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("pharos-lighthouse: {e:#}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let dark = args.iter().any(|a| a == "--dark").then_some(true).or(args.iter().any(|a| a == "--light").then_some(false));
    let r = (|| {
        let (ui, m) = pharos_lighthouse::build(m)?;
        // --dark / --light win over the saved choice, for this run only.
        if let Some(d) = dark {
            pharos_lighthouse::lh(&ui).set_theme_choice(if d { 2 } else { 1 });
            ui.invoke_set_dark(d);
        }
        pharos_lighthouse::run_built(ui, m)
    })();
    match r {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("pharos-lighthouse: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
