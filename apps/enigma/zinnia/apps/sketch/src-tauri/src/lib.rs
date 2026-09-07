//! Zinnia's Rust side.
//!
//! Deliberately thin, and meant to stay that way: the editors are the product
//! and they live in the frontend. Everything the desktop shell needs so far —
//! native file dialogs, reading and writing the files those editors open, and
//! opening a link in the user's browser — is a stock plugin.
//!
//! When something genuinely cannot be done from the webview, add a command with
//! a comment saying which plugin was ruled out and why. `lock` is the one such
//! case left: sealing a file needs Argon2id and an AEAD over the whole byte
//! range, which is not something to hand a page that also renders untrusted
//! `.svg` and deck HTML.
//!
//! `lock` and `secrets` are SHIMS. The sealing itself lives in the padova crate
//! and the frame in substrate (`crates/`), because more than one app comes out
//! of this tree and each decides which commands it registers. `secrets` is
//! deliberately write-only from the frontend's side — no command hands the
//! passphrase back, because this app renders markup that arrived in a file —
//! and padova enforces that in the type system rather than by convention.
//!
//! The `cloud` module — sign-in and the pinned-certificate TLS stack — used to
//! be a third. It is parked in limbo/cloud; reviving it means putting back the
//! crates its LIMBO.md lists, not just the file.

mod lock;
mod secrets;

/// This app's locker. The service name is what the OS keyring files the
/// passphrase under, and it is per app by decision — see `padova::Locker`.
/// The bundle identifier, so it leaks nothing but that the app is installed.
pub(crate) const LOCKER: padova::Locker = padova::Locker::new("com.spectrumaipl.sketch");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            lock::lock_file,
            lock::unlock_file,
            lock::is_file_locked,
            secrets::secret_remember,
            secrets::secret_forget,
            secrets::secret_status,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
