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
//! process it merely asked for.
//!
//! `workspace` is the folder the user chose and the boundary around it: every
//! read, write and listing resolves its path against the canonical root and
//! refuses `..`, symbolic links and anything outside. The fs plugin's runtime
//! scope could not express that rule and does not survive a restart; see the
//! module header.
//!
//! `search` walks the workspace for a query — names, paths, tags and, when
//! asked, the bodies of plain text files, read next to the disk rather than
//! one IPC round trip per file. It keeps no index and never reads an
//! encrypted body; see its header.
//!
//! `sealed` is how an encrypted file is edited: decrypted into memory under a
//! session whose key stays in Rust, re-sealed on every save, never written
//! plain. The page holds a token, not a key.
//!
//! `folder` encrypts or decrypts everything under a folder with one
//! passphrase: same walk rules as the search, one padova seal per file,
//! failures recorded and never undoing a success.
//!
//! `meta` is `.morion/metadata.json`: tags (plain text, by design, and
//! said so) and the Security Mana ledger. Never a passphrase, never a byte
//! of a file body.
//!
//! `mana` is the Security Mana budget: plain files drain it by the
//! kilobyte-hour, it regenerates slowly, and changing an encrypted file's
//! passphrase earns some back. One checkpoint in the metadata file; nothing
//! ticks. Advisory only — it asks, it never blocks.
//!
//! `archive` exports the whole workspace as one password-protected zip (the
//! zip format's own AES-256; files go in as they are, encrypted ones still
//! encrypted) and unpacks one back, never overwriting and never leaving the
//! workspace. Rust opens the save and open dialogs itself: the page never
//! hands it a path.
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

mod archive;
mod folder;
mod lock;
mod mana;
mod meta;
mod pdf;
mod sealed;
mod search;
mod secrets;
mod workspace;

/// This app's locker. The service name is what the OS keyring files the
/// passphrase under, and it is per app by decision — see `padova::Locker`.
/// The bundle identifier, so it leaks nothing but that the app is installed.
pub(crate) const LOCKER: padova::Locker = padova::Locker::new("com.spectrumaipl.zinnia");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(workspace::WorkspaceState::new())
        .manage(sealed::SealSessions::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            lock::lock_file,
            lock::unlock_file,
            lock::is_file_locked,
            lock::rekey_file,
            secrets::secret_remember,
            secrets::secret_forget,
            secrets::secret_status,
            pdf::pdf_status,
            pdf::pdf_render,
            pdf::pdf_cancel,
            search::workspace_search,
            workspace::workspace_open,
            workspace::workspace_list,
            workspace::workspace_read_text,
            workspace::workspace_read_bytes,
            workspace::workspace_write_text,
            sealed::sealed_open,
            sealed::sealed_open_bytes,
            sealed::sealed_write,
            sealed::sealed_close,
            folder::folder_preview,
            folder::folder_lock,
            folder::files_lock,
            meta::tags_get,
            meta::tags_set,
            meta::tags_all,
            mana::mana_status,
            mana::mana_rate,
            mana::mana_record,
            mana::mana_ledger,
            mana::mana_prices,
            archive::archive_export,
            archive::archive_import,
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
