//! Zinnia's Rust side.
//!
//! Deliberately thin, and meant to stay that way: the editors are the product
//! and they live in the frontend. Everything the desktop shell needs so far —
//! native file dialogs, reading and writing the files those editors open, and
//! opening a link in the user's browser — is a stock plugin. There are no
//! custom commands, so there is nothing here for the frontend to drift against.
//!
//! When something genuinely cannot be done from the webview, add a command with
//! a comment saying which plugin was ruled out and why.
//!
//! `cloud` is the first and so far only such case — see its module docs for the
//! two things a webview cannot do here: keep a token out of reach of the
//! documents this app opens, and reach a server whose certificate the user has
//! chosen to trust.

mod cloud;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            cloud::cloud_probe,
            cloud::cloud_login,
            cloud::cloud_logout,
            cloud::cloud_status,
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
