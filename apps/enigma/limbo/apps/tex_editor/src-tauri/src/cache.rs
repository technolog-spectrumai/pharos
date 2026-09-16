//! Four commands that keep a workspace readable with the server gone.
//!
//! SHIMS AND NOTHING ELSE, the same arrangement `platform.rs` has over
//! `totoclient`: the store is `hoard`, which takes no `tauri` dependency, so
//! this file names the app's commands and holds the handle.
//!
//! **Why `hoard` and not `tauri-plugin-fs`.** The manifest says, and still
//! says, that this app has no filesystem permission because *"a local
//! filesystem permission it never uses is surface for nothing"*. Offline
//! editing does not change that: the app still needs no access to the user's
//! documents, only to a private store of its own under the app data directory.
//! `hoard` gives exactly that — a keyed byte store, already used by sketch,
//! opened at one path this code chooses — so the permission stays absent and
//! the page still cannot read `~/.ssh`.
//!
//! **What is stored.** JSON envelopes written by `totoapi/src/api/offline.ts`,
//! one per workspace, opaque to this layer. Deliberately opaque: the shape is
//! the frontend's business and a Rust struct mirroring it would be a second
//! definition to keep in step.
//!
//! **What is NOT stored.** The token. It stays in the OS keyring where
//! `totoclient` put it, and nothing here can reach it.
use std::sync::Mutex;

use hoard::Hoard;
use tauri::{AppHandle, Manager, State};

/// The open store, or the reason it could not be opened.
///
/// A `Mutex<Option<..>>` rather than a `OnceCell`: opening can fail (a
/// read-only home directory, a full disk), and the app must still run. An
/// editor that refused to start because its CACHE would not open would be
/// worse than one that simply cannot work offline.
#[derive(Default)]
pub struct CacheHandle(Mutex<Option<Hoard>>);

/// Open the store under the app's own data directory.
///
/// Called once from `setup`. Failure is logged and swallowed — see the type's
/// docstring for why that is the right direction.
pub fn open(app: &AppHandle) -> CacheHandle {
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir.join("offline"),
        Err(err) => {
            log::warn!("no app data dir, offline editing is off: {err}");
            return CacheHandle(Mutex::new(None));
        }
    };
    match Hoard::open(&dir) {
        Ok(store) => CacheHandle(Mutex::new(Some(store))),
        Err(err) => {
            log::warn!("offline cache unavailable at {}: {err}", dir.display());
            CacheHandle(Mutex::new(None))
        }
    }
}

/// The one place the "is there a store?" question is answered, so the four
/// commands below cannot each invent their own sentence for it.
fn with<T>(
    handle: &State<'_, CacheHandle>,
    work: impl FnOnce(&Hoard) -> Result<T, hoard::HoardError>,
) -> Result<T, String> {
    let guard = handle
        .0
        .lock()
        .map_err(|_| "cache_poisoned: restart the app".to_string())?;
    let store = guard
        .as_ref()
        .ok_or_else(|| "cache_unavailable: this machine has no writable \
                        cache, so offline editing is off".to_string())?;
    work(store).map_err(|e| e.to_string())
}

/// Read one workspace envelope back, or `None` when it was never cached.
#[tauri::command]
pub fn cache_get(
    handle: State<'_, CacheHandle>,
    key: String,
) -> Result<Option<String>, String> {
    let bytes = with(&handle, |store| store.load(&key))?;
    match bytes {
        None => Ok(None),
        // Lossy on purpose. A cache entry that will not decode is a cache miss,
        // and the caller's next move — fetch it again — is exactly right. The
        // alternative is an app that cannot open a workspace because one byte
        // on disk went bad.
        Some(raw) => Ok(Some(String::from_utf8_lossy(&raw).into_owned())),
    }
}

#[tauri::command]
pub fn cache_set(
    handle: State<'_, CacheHandle>,
    key: String,
    value: String,
) -> Result<(), String> {
    with(&handle, |store| store.save(&key, value.as_bytes()))
}

#[tauri::command]
pub fn cache_remove(handle: State<'_, CacheHandle>, key: String) -> Result<(), String> {
    with(&handle, |store| store.forget(&key))
}

#[tauri::command]
pub fn cache_keys(handle: State<'_, CacheHandle>) -> Result<Vec<String>, String> {
    with(&handle, |store| store.boards())
}
