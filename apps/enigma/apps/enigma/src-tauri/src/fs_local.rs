//! Local-disk file I/O for "save as…" flows (currently the Sketch board's SVG and
//! PNG export).
//!
//! "Save to disk" pairs a native dialog (tauri-plugin-dialog) with these tiny
//! std::fs helpers so the chosen path is actually written. The plain browser build
//! doesn't use these (it falls back to blob downloads); they exist for the
//! desktop/mobile webview where direct disk access is the reliable path.

use data_encoding::BASE64;

#[tauri::command]
pub fn fs_write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Write binary content supplied as base64.
///
/// Base64 rather than `Vec<u8>` because the payloads that need this are canvas
/// data URLs, which are *already* base64 — decoding in the webview only to
/// re-serialize a 1M-element JSON number array across the IPC boundary would cost
/// far more than it saves. `data_encoding` is already a dependency (device_link,
/// vox), so this adds no new crate and needs no new capability: these are app
/// commands, not plugin commands.
#[tauri::command]
pub fn fs_write_base64_file(path: String, b64: String) -> Result<(), String> {
    let bytes = BASE64
        .decode(b64.as_bytes())
        .map_err(|e| format!("invalid base64: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("enigma_fs_local_test_{}_{}", std::process::id(), name));
        p
    }

    #[test]
    fn writes_decoded_bytes() {
        let path = tmp_path("b64");
        // PNG magic — the exact kind of payload this exists for.
        let raw: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        fs_write_base64_file(path.to_string_lossy().into(), BASE64.encode(raw)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), raw);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_malformed_base64_without_creating_a_file() {
        let path = tmp_path("bad");
        let err = fs_write_base64_file(path.to_string_lossy().into(), "not!base64".into())
            .unwrap_err();
        assert!(err.contains("invalid base64"), "{err}");
        assert!(!path.exists(), "a rejected write must not leave a file behind");
    }

    #[test]
    fn round_trips_text() {
        let path = tmp_path("txt");
        fs_write_text_file(path.to_string_lossy().into(), "<svg/>".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "<svg/>");
        let _ = std::fs::remove_file(&path);
    }
}
