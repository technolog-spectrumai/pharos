//! `enigma://` links (Belisario step 12): Teutates opens the co-op's room in Enigma, where its
//! chat now lives: `enigma://room/<room name>[/<#tag>][?to=<name>&quote=<text>]`.
//! The link is kept until the window takes it (`deeplink_take`) and also announced
//! (`deeplink://open`) to a window that is already up; the window (src/deeplink.ts) opens the
//! saved room of that name. Copied from Morion's (apps/morion/src-tauri/src/deeplink.rs).

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct DeepLinkState(Mutex<Option<String>>);

/// Keeps a link that arrived and tells the window.
pub fn arrived(app: &AppHandle, url: &str) {
    if !url.starts_with("enigma://") {
        return;
    }
    if let Ok(mut g) = app.state::<DeepLinkState>().0.lock() {
        *g = Some(url.to_string());
    }
    let _ = app.emit("deeplink://open", url);
}

/// Wires the plugin: the link the app was started with, and later ones.
pub fn setup(app: &tauri::App) {
    use tauri_plugin_deep_link::DeepLinkExt as _;
    #[cfg(desktop)]
    let _ = app.deep_link().register_all();
    let h = app.handle().clone();
    app.deep_link().on_open_url(move |ev| {
        for u in ev.urls() {
            arrived(&h, u.as_str());
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for u in urls {
            arrived(app.handle(), u.as_str());
        }
    }
    // Linux and Windows hand the link over as an argument.
    for a in std::env::args().skip(1) {
        arrived(app.handle(), &a);
    }
}

/// The link waiting for the window, once.
#[tauri::command]
pub fn deeplink_take(st: State<'_, DeepLinkState>) -> Option<String> {
    st.0.lock().ok().and_then(|mut g| g.take())
}
