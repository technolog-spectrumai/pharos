//! Files → Devices per-file sync — the thin Rust half (maps.rs pattern).
//!
//! The bytes ride file_xfer.rs verbatim (its offer/download commands and its
//! airplane/Tor gates apply unchanged); the shared allowed-files list and the
//! dlink_file_* signaling live in the frontend (rakotis fileSyncModel /
//! useDeviceSync + the app's fileSync store). This module only owns the disk
//! side of RECEIVING: a sanitized tmp path per offer, hash verification, and
//! the landing folder `<profile_dir>/synced/` — received files are the user's
//! own plaintext files, deliberately outside the sealed store (like exported
//! sketches and map blobs; the SHARED LIST is sealed kv, ns `filesync`).
//!
//! No managed state and nothing to tear down: transfers belong to
//! FileXferState, which lib.rs already shuts down on profile switch /
//! airplane / Tor.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const FSYNC_DISABLED: &str = "Device linking is disabled in this build.";

fn ensure_enabled() -> Result<(), String> {
    if !crate::build_config::devices::ALLOW_LINKING {
        return Err(FSYNC_DISABLED.to_string());
    }
    Ok(())
}

// ── paths ─────────────────────────────────────────────────────────────────────

fn synced_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<crate::AppConfigState>();
    let cfg = crate::active_config(&state)?;
    let dir = crate::profile_dir(app, &cfg).join("synced");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn tmp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = synced_dir(app)?.join("tmp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Drop stale tmp files (crash leftovers) older than a day — maps sweep_tmp
/// clone, called whenever a new receive path is minted.
fn sweep_tmp(app: &AppHandle) {
    let Ok(dir) = tmp_dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > 24 * 3600);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Offer ids come off the wire — allow exactly the shape file_xfer mints
/// (UUIDs) before they touch a path (maps.rs precedent).
fn sanitize_offer_id(s: &str) -> Result<String, String> {
    if s.is_empty() || s.len() > 64 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("invalid offer id".to_string());
    }
    Ok(s.to_string())
}

/// Display names come off the wire too: strip anything that could steer the
/// path (separators, NUL/control bytes, a leading dot) and bound the length.
/// Falls back to "file" rather than erroring — a hostile name must not be able
/// to veto the transfer the user asked for.
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != ':' && *c != '\0')
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    let bounded: String = trimmed.chars().take(120).collect();
    if bounded.is_empty() {
        "file".to_string()
    } else {
        bounded
    }
}

/// First free "name", "name (2)", "name (3)" … inside `dir`, extension kept.
fn unique_dest(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), Some(e.to_string())),
        _ => (name.to_string(), None),
    };
    for n in 2u32.. {
        let candidate = match &ext {
            Some(e) => dir.join(format!("{stem} ({n}).{e}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("u32 exhausted");
}

/// Pure core of filesync_import, split out for tests: verify the downloaded
/// tmp file against the announced hash, then move it into place atomically.
/// A hash mismatch removes the tmp file and errors — a corrupted or spoofed
/// transfer must never land under a trusted name.
fn verify_and_place(
    tmp: &Path,
    synced: &Path,
    name: &str,
    expected_hash: &str,
    prior_path: Option<&Path>,
) -> Result<(PathBuf, String, u64), String> {
    let (hash, size) = crate::maps::blake3_file(tmp)?;
    if !expected_hash.eq_ignore_ascii_case(&hash) {
        let _ = std::fs::remove_file(tmp);
        return Err("hash mismatch — transfer discarded".to_string());
    }
    // Re-receives overwrite the entry's existing copy ("destination replaced"),
    // but only a path we own: anything outside synced/ falls back to a fresh
    // unique name rather than letting a stored record steer the write.
    let dest = match prior_path {
        Some(p) if p.starts_with(synced) && p.parent() != Some(&synced.join("tmp")) => p.to_path_buf(),
        _ => unique_dest(synced, &sanitize_file_name(name)),
    };
    std::fs::rename(tmp, &dest).map_err(|e| format!("move failed: {e}"))?;
    Ok((dest, hash, size))
}

// ── commands ──────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct FilesyncHashed {
    pub hash: String,
    pub size: u64,
}

/// BLAKE3 + size of a local file — the add-entry / pre-push staleness check.
#[tauri::command]
pub async fn filesync_hash(path: String) -> Result<FilesyncHashed, String> {
    ensure_enabled()?;
    let (hash, size) = tauri::async_runtime::spawn_blocking(move || {
        crate::maps::blake3_file(Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(FilesyncHashed { hash, size })
}

/// Where file_download should stream an incoming synced file.
#[tauri::command]
pub fn filesync_recv_path(app: AppHandle, offer_id: String) -> Result<String, String> {
    ensure_enabled()?;
    let safe = sanitize_offer_id(&offer_id)?;
    sweep_tmp(&app);
    Ok(tmp_dir(&app)?.join(format!("recv-{safe}.part")).display().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesyncImported {
    pub path: String,
    pub name: String,
    pub hash: String,
    pub size: u64,
}

/// Completion handoff after file://done — verify + land in synced/.
#[tauri::command]
pub async fn filesync_import(
    app: AppHandle,
    offer_id: String,
    name: String,
    expected_hash: String,
    prior_path: Option<String>,
) -> Result<FilesyncImported, String> {
    ensure_enabled()?;
    let safe = sanitize_offer_id(&offer_id)?;
    let tmp = tmp_dir(&app)?.join(format!("recv-{safe}.part"));
    if !tmp.is_file() {
        return Err("received file not found".to_string());
    }
    let synced = synced_dir(&app)?;
    let (dest, hash, size) = tauri::async_runtime::spawn_blocking(move || {
        verify_and_place(
            &tmp,
            &synced,
            &name,
            &expected_hash,
            prior_path.as_deref().map(Path::new),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let file_name = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    Ok(FilesyncImported {
        path: dest.display().to_string(),
        name: file_name,
        hash,
        size,
    })
}

/// The landing folder, for the frontend's "open folder" (opener plugin).
#[tauri::command]
pub fn filesync_dir(app: AppHandle) -> Result<String, String> {
    ensure_enabled()?;
    Ok(synced_dir(&app)?.display().to_string())
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fsync-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_file_name_strips_hostile_shapes() {
        assert_eq!(sanitize_file_name("notes.txt"), "notes.txt");
        assert_eq!(sanitize_file_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_file_name("a/b\\c:d"), "abcd");
        assert_eq!(sanitize_file_name(".hidden"), "hidden");
        assert_eq!(sanitize_file_name("  \u{0}\u{7}  "), "file");
        assert_eq!(sanitize_file_name(""), "file");
        assert_eq!(sanitize_file_name(&"x".repeat(500)).chars().count(), 120);
    }

    #[test]
    fn sanitize_offer_id_allows_uuids_only() {
        assert!(sanitize_offer_id("123e4567-e89b-42d3-a456-556642440000").is_ok());
        assert!(sanitize_offer_id("").is_err());
        assert!(sanitize_offer_id("../x").is_err());
        assert!(sanitize_offer_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn unique_dest_suffixes_collisions_keeping_extension() {
        let dir = temp_dir("dest");
        std::fs::write(dir.join("a.pdf"), b"x").unwrap();
        std::fs::write(dir.join("a (2).pdf"), b"x").unwrap();
        assert_eq!(unique_dest(&dir, "a.pdf"), dir.join("a (3).pdf"));
        assert_eq!(unique_dest(&dir, "fresh.pdf"), dir.join("fresh.pdf"));
        std::fs::write(dir.join("noext"), b"x").unwrap();
        assert_eq!(unique_dest(&dir, "noext"), dir.join("noext (2)"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_and_place_rejects_wrong_hash_and_lands_good_files() {
        let synced = temp_dir("place");
        let tmp_parent = synced.join("tmp");
        std::fs::create_dir_all(&tmp_parent).unwrap();
        let tmp = tmp_parent.join("recv-x.part");
        let mut f = std::fs::File::create(&tmp).unwrap();
        f.write_all(b"hello sync").unwrap();
        drop(f);
        let (good_hash, _) = crate::maps::blake3_file(&tmp).unwrap();

        // Wrong hash: rejected AND the tmp file is gone.
        std::fs::write(&tmp, b"hello sync").unwrap();
        assert!(verify_and_place(&tmp, &synced, "a.txt", &"0".repeat(64), None).is_err());
        assert!(!tmp.exists());

        // Right hash: lands under the sanitized name.
        std::fs::write(&tmp, b"hello sync").unwrap();
        let (dest, hash, size) =
            verify_and_place(&tmp, &synced, "../a.txt", &good_hash, None).unwrap();
        assert_eq!(dest, synced.join("a.txt")); // "../a.txt" sanitizes to "a.txt"
        assert_eq!(hash, good_hash);
        assert_eq!(size, 10);
        assert!(dest.is_file());

        // Re-receive with a prior path inside synced/ overwrites it in place.
        std::fs::write(&tmp, b"hello sync").unwrap();
        let (dest2, _, _) =
            verify_and_place(&tmp, &synced, "ignored.bin", &good_hash, Some(&dest)).unwrap();
        assert_eq!(dest2, dest);

        // A prior path OUTSIDE synced/ is refused — fresh unique name instead.
        std::fs::write(&tmp, b"hello sync").unwrap();
        let outside = std::env::temp_dir().join("fsync-escape.txt");
        let (dest3, _, _) =
            verify_and_place(&tmp, &synced, "b.txt", &good_hash, Some(&outside)).unwrap();
        assert!(dest3.starts_with(&synced));
        assert!(!outside.exists());

        let _ = std::fs::remove_dir_all(&synced);
    }
}
