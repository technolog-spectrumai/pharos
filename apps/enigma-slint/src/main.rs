//! `enigma [--demo] [--name NAME] [--lang pl] [--data DIR] [enigma://…]`
//!
//! Without `--demo`: the real app. Its lock screen opens the profile vault (the same
//! data dir as the earlier Tauri app, so an existing profile opens with its passphrase),
//! then the app attaches to Your Beacon over Tor. `--demo` runs the in-memory demo world
//! (simulated Ann). An `enigma://room/…` argument is opened once unlocked (deep link).

use enigma_app::i18n::Lang;
use enigma_slint::Host;

fn main() -> Result<(), slint::PlatformError> {
    let args: Vec<String> = std::env::args().collect();
    let demo = args.iter().any(|a| a == "--demo");
    let after = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let name = after("--name").unwrap_or_else(|| "Me".into());
    let lang = after("--lang").map_or_else(
        || Lang::from_code(&std::env::var("LANG").unwrap_or_default().chars().take(2).collect::<String>()),
        |l| Lang::from_code(&l),
    );
    let link = args.iter().find(|a| a.starts_with("enigma://")).cloned();
    let mut host = if demo {
        Host::demo(&name)
    } else {
        let base = after("--data").map_or_else(enigma_slint::data_dir, std::path::PathBuf::from);
        match enigma_slint::real_host(&base) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("enigma: {e}");
                std::process::exit(2);
            }
        }
    };
    host.lang = lang;
    if let Some(c) = host.core_mut() {
        c.lang = lang;
    }
    enigma_slint::run(host, link)
}
