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
//! `pdf` supervises a renderer process — a child that must not touch the UI
//! thread, must not write outside its own directory, must not run forever and
//! must not reach the network; four things a webview cannot promise about a
//! process it merely asked for. `secrets` is the OS secret store, holding one passphrase so
//! sealing a second file need not mean typing it again. It is deliberately
//! write-only from the frontend's side — no command hands the passphrase back,
//! because this app renders markup that arrived in a file.
//!
//! The `cloud` module — sign-in and the pinned-certificate TLS stack — used to
//! be a third. It is parked in limbo/cloud; reviving it means putting back the
//! crates its LIMBO.md lists, not just the file. `secrets` shares only the
//! keyring crate with it, and none of its code.

mod lock;
mod pdf;
mod secrets;

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
            pdf::pdf_status,
            pdf::pdf_render,
            pdf::pdf_cancel,
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
