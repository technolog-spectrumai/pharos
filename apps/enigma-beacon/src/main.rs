//! enigma-beacon: run and manage a Beacon with a window.
//!
//!   enigma-beacon [-c config.yaml]        the Beacon of this config (on Tor)
//!   enigma-beacon --tcp 127.0.0.1:PORT    …served on loopback TCP instead (development)
//!   enigma-beacon --demo                  fake clients and rooms (screenshots)
//!   enigma-beacon --dark | --light        force the theme
//!
//! Without -c: /etc/beacon/config.yaml if it exists (the `beacon` package's), else
//! ~/.config/enigma-beacon/config.yaml (made on first save, data beside it).

use std::path::PathBuf;

use beacon::runner::Listen;
use enigma_beacon::model::{Mode, Model};

fn default_config() -> PathBuf {
    let etc = PathBuf::from("/etc/beacon/config.yaml");
    if etc.exists() {
        return etc;
    }
    let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))).unwrap_or_else(std::env::temp_dir);
    base.join("enigma-beacon").join("config.yaml")
}

/// Beacon runs on Linux only (desktop Linux or a Raspberry Pi). Elsewhere the
/// binary builds, so the workspace does, but only says so.
#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("enigma-beacon: Beacon runs on Linux only (desktop Linux or a Raspberry Pi)");
    std::process::ExitCode::FAILURE
}

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let after = |flag: &[&str]| args.iter().position(|a| flag.contains(&a.as_str())).and_then(|i| args.get(i + 1)).cloned();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        let usage: Vec<&str> = include_str!("main.rs").lines().skip(2).take(4).map(|l| l.trim_start_matches("//!   ")).collect();
        println!("Enigma Beacon {}\n\nusage:\n  {}", env!("CARGO_PKG_VERSION"), usage.join("\n  "));
        return std::process::ExitCode::SUCCESS;
    }
    let demo = args.iter().any(|a| a == "--demo");
    let config = after(&["-c", "--config"]).map(PathBuf::from).unwrap_or_else(|| if demo { std::env::temp_dir().join("enigma-beacon-demo").join("config.yaml") } else { default_config() });
    let mode = if demo {
        Mode::Demo
    } else if let Some(a) = after(&["--tcp"]) {
        match a.parse() {
            Ok(sa) => Mode::Real(Listen::Tcp(sa)),
            Err(e) => {
                eprintln!("enigma-beacon: --tcp {a}: {e}");
                return std::process::ExitCode::FAILURE;
            }
        }
    } else {
        Mode::Real(Listen::Tor)
    };
    let m = match Model::open(&config, mode) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("enigma-beacon: {e:#}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let dark = args.iter().any(|a| a == "--dark").then_some(true).or(args.iter().any(|a| a == "--light").then_some(false));
    let r = (|| {
        let (ui, m) = enigma_beacon::build(m)?;
        if let Some(d) = dark {
            ui.invoke_set_dark(d);
        }
        enigma_beacon::run_built(ui, m)
    })();
    match r {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("enigma-beacon: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
