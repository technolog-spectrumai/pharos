//! Local-disk text I/O for the Locations GeoJSON editor.
//!
//! "Load/save from disk" pairs a native dialog (tauri-plugin-dialog) with these
//! tiny std::fs helpers so the chosen path is actually read/written. The plain
//! browser build doesn't use these (it falls back to <input type=file> / blob
//! downloads); they exist for the desktop/mobile webview where direct disk
//! access is the reliable path.

#[tauri::command]
pub fn fs_read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}
