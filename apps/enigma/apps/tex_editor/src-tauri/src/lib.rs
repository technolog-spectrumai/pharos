//! LaTeX Editor's Rust side.
//!
//! Deliberately thin, and meant to stay that way: the editor is the product and
//! it lives in the frontend. What is here is the one thing a webview cannot do
//! — reach the platform server.
//!
//! **Two independent reasons that call goes through Rust**, and either alone
//! would be enough:
//!
//!   1. the capsule API token lives in the OS secret store and is never handed
//!      to JavaScript, so nothing in the page can build an `Authorization`
//!      header — or leak one;
//!   2. this app's CSP is `connect-src 'self' ipc: http://ipc.localhost`, so a
//!      `fetch()` at a remote host is blocked by the webview before it reaches
//!      the network, silently. Widening it for a user-supplied origin means
//!      widening it to `https:`, which is the protection gone.
//!
//! `platform` is a SHIM over the `totoclient` crate, the same arrangement
//! `lock`/`secrets` have over padova: the crate takes no `tauri` dependency, so
//! each app names its own commands.
//!
//! NO `lock`/`secrets` here. This app edits files that live on a server, not
//! sealed files on this disk — adding the sealing surface would mean linking
//! libsecret and Argon2 for a feature the app does not offer.

mod platform;

/// The keyring service this app files its token under.
///
/// The bundle identifier, so a keyring browser shows only that the app is
/// installed. PER APP by decision: `tex_editor` uses its own, so two editors
/// pointed at two servers keep separate credentials.
///
/// **Changing this orphans anything a previous build stored** — the entry stays
/// on disk with nothing able to enumerate it.
const KEYRING_SERVICE: &str = "com.spectrumaipl.texeditor";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before the builder: `totoclient` reads this on its first keyring touch,
    // and a command that fired before it was set would file the token under the
    // crate's placeholder name.
    totoclient::init(KEYRING_SERVICE);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            platform::platform_probe,
            platform::platform_connect,
            platform::platform_forget,
            platform::platform_request,
            platform::platform_status,
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
