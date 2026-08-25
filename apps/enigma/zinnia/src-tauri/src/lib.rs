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
//! The `cloud` module — sign-in, the pinned-certificate TLS stack and the
//! keyring-backed token — used to be the other one. It is parked in
//! limbo/cloud; reviving it means putting back the crates its LIMBO.md lists,
//! not just the file.

mod lock;

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
