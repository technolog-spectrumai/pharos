//! `enigma`: the desktop app. `--demo` runs the in-memory demo world (simulated Ann);
//! without it the real backend shows "not connected yet" until stage 2 wires it.
//! `--name NAME` sets the nickname, `--lang pl` the language.

use enigma_app::i18n::Lang;

fn main() -> Result<(), slint::PlatformError> {
    let args: Vec<String> = std::env::args().collect();
    let demo = args.iter().any(|a| a == "--demo");
    let after = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let name = after("--name").unwrap_or_else(|| "Me".into());
    let lang = after("--lang").map_or_else(
        || Lang::from_code(&std::env::var("LANG").unwrap_or_default().chars().take(2).collect::<String>()),
        |l| Lang::from_code(&l),
    );
    enigma_slint::run(demo, &name, lang)
}
