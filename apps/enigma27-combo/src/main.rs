//! enigma27-combo: Enigma27 and its Lighthouse in one window.
//!
//!   enigma27-combo                     the real thing: Lighthouse on its own onion (Tor), the client attached in-process
//!   enigma27-combo --data DIR          the client's profiles somewhere else
//!   enigma27-combo -c config.yaml      another Lighthouse config
//!   enigma27-combo --demo              demo client (simulated Ann) + demo Lighthouse (screenshots)
//!   enigma27-combo --dark | --light    force the theme

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("enigma27-combo: runs on Linux only (the Lighthouse is Linux only); use enigma27 here");
    std::process::ExitCode::FAILURE
}

#[cfg(target_os = "linux")]
fn main() -> std::process::ExitCode {
    use beacon::runner::Listen;
    use enigma27::Host;
    use enigma27_combo::{Combo, RelaySlot};
    use pharos_lighthouse::model::{Mode, Model};
    use std::path::PathBuf;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let after = |flag: &[&str]| args.iter().position(|a| flag.contains(&a.as_str())).and_then(|i| args.get(i + 1)).cloned();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        let usage: Vec<&str> = include_str!("main.rs").lines().skip(2).take(5).map(|l| l.trim_start_matches("//!   ")).collect();
        println!("Enigma27 Combo {}\n\nusage:\n  {}", env!("CARGO_PKG_VERSION"), usage.join("\n  "));
        return std::process::ExitCode::SUCCESS;
    }
    let demo = args.iter().any(|a| a == "--demo");
    let slot = RelaySlot::default();
    let r = (|| -> anyhow::Result<()> {
        let (host, model) = if demo {
            let cfg = std::env::temp_dir().join("enigma27-combo-demo").join("config.yaml");
            let mut m = Model::open(&cfg, Mode::Demo)?;
            m.start()?;
            (Host::demo("Me"), m)
        } else {
            let cfg = after(&["-c", "--config"]).map_or_else(enigma27_combo::lighthouse_config, PathBuf::from);
            let mut m = Model::open(&cfg, Mode::Real(Listen::Tor))?;
            if let Err(e) = m.start() {
                eprintln!("enigma27-combo: Lighthouse not started: {e:#}");
            }
            let base = after(&["--data"]).map_or_else(enigma27_combo::client_dir, PathBuf::from);
            let host = enigma27_combo::real_host(&base, &slot, enigma_app::vault::KdfParams::default()).map_err(anyhow::Error::msg)?;
            (host, m)
        };
        let combo = Combo::build(host, model, slot)?;
        if let Some(d) = args.iter().any(|a| a == "--dark").then_some(true).or(args.iter().any(|a| a == "--light").then_some(false)) {
            combo.ui.invoke_set_dark(d);
        }
        combo.run()?;
        Ok(())
    })();
    match r {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("enigma27-combo: {e:#}");
            std::process::ExitCode::FAILURE
        }
    }
}
