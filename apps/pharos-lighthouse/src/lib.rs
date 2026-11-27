//! Pharos Lighthouse: a Slint app to run and manage a Beacon on a desktop or a
//! Raspberry Pi with a screen. The logic is in [`model`]; this file maps a
//! [`model::Snapshot`] onto the window and its callbacks onto the model.

pub mod headless;
pub mod model;

use slint::{Image, Rgb8Pixel, SharedPixelBuffer};

slint::include_modules!();

/// The window glue (also compiled into enigma27-combo, on its own Slint types).
mod glue {
    use super::{model, AppWindow, Lh, LhClient, LhLog, LhRoom};
    #[allow(unused_imports)]
    use super::{load_theme, qr_image, save_theme};
    include!("glue.rs");
}
pub use glue::{apply_theme, attach, build, lh, load_fields, refresh, run, run_built, ticker};

/// Quiet zone around the QR code, in modules.
pub const QR_BORDER: usize = 4;

/// The code as a QR image: dark modules on white, a 4-module border, `scale` px a module.
#[must_use]
pub fn qr_image(code: &str, scale: usize) -> Option<Image> {
    let (n, mods) = beacon::page::qr_modules(code).ok()?;
    let side = (n + 2 * QR_BORDER) * scale;
    let mut buf = SharedPixelBuffer::<Rgb8Pixel>::new(side as u32, side as u32);
    let px = buf.make_mut_slice();
    px.fill(Rgb8Pixel { r: 255, g: 255, b: 255 });
    for y in 0..n {
        for x in 0..n {
            if mods[y * n + x] {
                for dy in 0..scale {
                    let row = ((y + QR_BORDER) * scale + dy) * side;
                    let col = (x + QR_BORDER) * scale;
                    px[row + col..row + col + scale].fill(Rgb8Pixel { r: 0x1b, g: 0x1f, b: 0x2a });
                }
            }
        }
    }
    Some(Image::from_rgb8(buf))
}


// ── theme (a viewer preference, not part of Beacon's config.yaml) ─────────────

/// Where the chosen theme is kept: `$XDG_CONFIG_HOME/pharos-lighthouse/theme`
/// (or `~/.config/pharos-lighthouse/theme`). One word: system, light or dark.
fn theme_file() -> Option<std::path::PathBuf> {
    Some(config_base()?.join("pharos-lighthouse").join("theme"))
}

/// The theme file under the app's earlier name (enigma-beacon), read when the new one is missing.
fn old_theme_file() -> Option<std::path::PathBuf> {
    Some(config_base()?.join("enigma-beacon").join("theme"))
}

fn config_base() -> Option<std::path::PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".config")))
}

/// 0 system, 1 light, 2 dark.
pub(crate) fn theme_from_word(w: &str) -> i32 {
    match w.trim() {
        "light" => 1,
        "dark" => 2,
        _ => 0,
    }
}

pub(crate) fn theme_word(choice: i32) -> &'static str {
    match choice {
        1 => "light",
        2 => "dark",
        _ => "system",
    }
}

pub fn load_theme() -> i32 {
    let read = |p: Option<std::path::PathBuf>| p.and_then(|p| std::fs::read_to_string(p).ok());
    read(theme_file()).or_else(|| read(old_theme_file())).map(|s| theme_from_word(&s)).unwrap_or(0)
}

pub fn save_theme(choice: i32) -> anyhow::Result<()> {
    let p = theme_file().ok_or_else(|| anyhow::anyhow!("no home folder to save the theme in"))?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&p, format!("{}\n", theme_word(choice)))?;
    Ok(())
}

#[cfg(test)]
mod theme_tests {
    use super::*;

    #[test]
    fn theme_words_round_trip_and_default_to_system() {
        for c in 0..3 {
            assert_eq!(theme_from_word(theme_word(c)), c);
        }
        assert_eq!(theme_from_word("purple"), 0);
        assert_eq!(theme_from_word("dark\n"), 2);
    }
}
