//! Files → Devices per-file sync — the thin Rust half (maps.rs pattern).
//!
//! The bytes ride file_xfer.rs verbatim (its offer/download commands and its
//! airplane/Tor gates apply unchanged); the shared allowed-files list and the
//! dlink_file_* signaling live in the frontend (rakotis fileSyncModel /
//! useDeviceSync + the app's fileSync store). This module only owns the disk
//! side: a sanitized tmp path per offer, hash verification, and the landing
//! tree — the user-visible enigma folder `~/Enigma26[-<profile>]` (Files tree
//! redesign; the old flat `<profile_dir>/synced/` stays readable through the
//! records' absolute paths but receives nothing new). Received files are the
//! user's own plaintext files, deliberately outside the sealed store (like
//! exported sketches and map blobs; the SHARED LIST is sealed kv, ns
//! `filesync`).
//!
//! No managed state and nothing to tear down: transfers belong to
//! FileXferState, which lib.rs already shuts down on profile switch /
//! airplane / Tor.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
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

/// The user-visible Enigma26 folder (Files tree redesign): ~/Enigma26 for the
/// default profile, ~/Enigma26-<profile> otherwise. This is where NEW imports
/// land — the old <profile_dir>/synced/ folder stays readable (local records
/// carry absolute paths), it just stops receiving files.
fn enigma_root(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<crate::AppConfigState>();
    let cfg = crate::active_config(&state)?;
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = if cfg.profile == "default" {
        home.join("Enigma26")
    } else {
        home.join(format!("Enigma26-{}", crate::safe_filename_component(&cfg.profile)))
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// How deep the tree may go — mirrors FILESYNC_DIR_MAX_SEGMENTS in the model.
const DIR_MAX_SEGMENTS: usize = 16;

/// Entry dirs come off the wire (and out of stored lists): split on both
/// separators, refuse traversal outright, and run every segment through the
/// same sanitizer names get. "" stays the root; "." segments are dropped.
fn sanitize_dir(dir: &str) -> Result<PathBuf, String> {
    let mut out = PathBuf::new();
    let mut n = 0usize;
    for seg in dir.split(['/', '\\']) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("invalid dir".to_string());
        }
        n += 1;
        if n > DIR_MAX_SEGMENTS {
            return Err("dir too deep".to_string());
        }
        out.push(sanitize_file_name(seg));
    }
    Ok(out)
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

/// Move with a copy fallback: the tmp dir (app data) and the enigma root
/// (home) can sit on different mounts, where rename can't cross.
fn move_file(tmp: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(tmp, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(tmp, dest).map_err(|e| format!("move failed: {e}"))?;
    let _ = std::fs::remove_file(tmp);
    Ok(())
}

/// Pure core of filesync_import, split out for tests: verify the downloaded
/// tmp file against the announced hash, then move it into place atomically.
/// A hash mismatch removes the tmp file and errors — a corrupted or spoofed
/// transfer must never land under a trusted name.
///
/// `dest_dir` is `root` + the entry's sanitized dir; both are the enigma root
/// side of the tree (never tmp, which lives under the profile dir).
fn verify_and_place(
    tmp: &Path,
    root: &Path,
    dest_dir: &Path,
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
    // but only a path we own: anything outside the enigma root — old synced/
    // records included, which thereby re-land under the root — falls back to a
    // fresh unique name rather than letting a stored record steer the write.
    let dest = match prior_path {
        Some(p) if p.starts_with(root) && p.parent() != Some(&root.join("tmp")) => p.to_path_buf(),
        _ => {
            std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
            unique_dest(dest_dir, &sanitize_file_name(name))
        }
    };
    move_file(tmp, &dest)?;
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

/// Completion handoff after file://done — verify + land under the enigma root
/// (in the entry's dir subfolder; "" / absent = root). Old synced/ prior paths
/// are refused as overwrite targets, so re-receives migrate to the root.
#[tauri::command]
pub async fn filesync_import(
    app: AppHandle,
    offer_id: String,
    name: String,
    expected_hash: String,
    prior_path: Option<String>,
    dir: Option<String>,
) -> Result<FilesyncImported, String> {
    ensure_enabled()?;
    let safe = sanitize_offer_id(&offer_id)?;
    let tmp = tmp_dir(&app)?.join(format!("recv-{safe}.part"));
    if !tmp.is_file() {
        return Err("received file not found".to_string());
    }
    let root = enigma_root(&app)?;
    let dest_dir = root.join(sanitize_dir(dir.as_deref().unwrap_or(""))?);
    let (dest, hash, size) = tauri::async_runtime::spawn_blocking(move || {
        verify_and_place(
            &tmp,
            &root,
            &dest_dir,
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

#[derive(Serialize)]
pub struct FilesyncRoot {
    pub path: String,
}

/// The enigma folder for the active profile (created on first ask).
// registered in lib.rs by hand
#[tauri::command]
pub fn filesync_root(app: AppHandle) -> Result<FilesyncRoot, String> {
    ensure_enabled()?;
    Ok(FilesyncRoot { path: enigma_root(&app)?.display().to_string() })
}

/// filesync_scan bounds — a UI rail, not a protocol limit (the enigma folder
/// is the user's own; a runaway tree must not hang the scan).
const SCAN_MAX_FILES: usize = 2000;
const SCAN_MAX_DEPTH: usize = DIR_MAX_SEGMENTS;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesyncScanFile {
    /// POSIX-relative dir inside the root ("" = root; never the file name).
    pub dir: String,
    pub name: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesyncScan {
    pub root: String,
    pub truncated: bool,
    pub files: Vec<FilesyncScanFile>,
}

/// Pure core of filesync_scan, split out for tests. Breadth-first with sorted
/// entries (deterministic), no symlink follow, dotfiles/dotdirs skipped.
fn scan_tree(root: &Path, max_files: usize) -> (Vec<FilesyncScanFile>, bool) {
    let mut files = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), String::new(), 0usize)]);
    while let Some((dir, rel, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            // DirEntry::file_type never follows symlinks — a link is neither
            // branch, so it (and anything behind it) is skipped wholesale.
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if depth < SCAN_MAX_DEPTH {
                    let sub = if rel.is_empty() { name } else { format!("{rel}/{name}") };
                    queue.push_back((entry.path(), sub, depth + 1));
                }
            } else if kind.is_file() {
                if files.len() >= max_files {
                    return (files, true);
                }
                let Ok(meta) = entry.metadata() else { continue };
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                files.push(FilesyncScanFile { dir: rel.clone(), name, size: meta.len(), mtime_ms });
            }
        }
    }
    (files, false)
}

/// Walk the enigma folder for the Files tree (bounded; `truncated` flags a
/// stop at the file cap).
// registered in lib.rs by hand
#[tauri::command]
pub async fn filesync_scan(app: AppHandle) -> Result<FilesyncScan, String> {
    ensure_enabled()?;
    let root = enigma_root(&app)?;
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let (files, truncated) = scan_tree(&root, SCAN_MAX_FILES);
        FilesyncScan { root: root.display().to_string(), truncated, files }
    })
    .await
    .map_err(|e| e.to_string())?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesyncMigrateItem {
    pub entry_id: String,
    /// Absolute path from the local record (typically old <profile>/synced/).
    pub src_path: String,
    pub dir: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesyncMigrated {
    pub entry_id: String,
    /// "migrated" | "missing" | "failed".
    pub status: String,
    pub new_path: Option<String>,
}

/// Pure core of filesync_migrate, split out for tests: copy one source into
/// root/dir/name (unique_dest on collision). Never deletes the source.
fn migrate_one(root: &Path, src: &Path, dir: &str, name: &str) -> Result<PathBuf, String> {
    let dest_dir = root.join(sanitize_dir(dir)?);
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = unique_dest(&dest_dir, &sanitize_file_name(name));
    // fs::copy streams kernel-side — no whole-file buffering.
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// Copy existing entries' files into the enigma tree (one-shot migration from
/// the old flat synced/ layout). Sources are never deleted — the caller
/// updates its local records to the returned paths.
// registered in lib.rs by hand
#[tauri::command]
pub async fn filesync_migrate(
    app: AppHandle,
    items: Vec<FilesyncMigrateItem>,
) -> Result<Vec<FilesyncMigrated>, String> {
    ensure_enabled()?;
    let root = enigma_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        items
            .into_iter()
            .map(|it| {
                let src = PathBuf::from(&it.src_path);
                if !src.is_file() {
                    return FilesyncMigrated { entry_id: it.entry_id, status: "missing".into(), new_path: None };
                }
                match migrate_one(&root, &src, &it.dir, &it.name) {
                    Ok(dest) => FilesyncMigrated {
                        entry_id: it.entry_id,
                        status: "migrated".into(),
                        new_path: Some(dest.display().to_string()),
                    },
                    Err(_) => FilesyncMigrated { entry_id: it.entry_id, status: "failed".into(), new_path: None },
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
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
        assert!(verify_and_place(&tmp, &synced, &synced, "a.txt", &"0".repeat(64), None).is_err());
        assert!(!tmp.exists());

        // Right hash: lands under the sanitized name.
        std::fs::write(&tmp, b"hello sync").unwrap();
        let (dest, hash, size) =
            verify_and_place(&tmp, &synced, &synced, "../a.txt", &good_hash, None).unwrap();
        assert_eq!(dest, synced.join("a.txt")); // "../a.txt" sanitizes to "a.txt"
        assert_eq!(hash, good_hash);
        assert_eq!(size, 10);
        assert!(dest.is_file());

        // Right hash into a subdir (the tree redesign's dir landing).
        std::fs::write(&tmp, b"hello sync").unwrap();
        let sub = synced.join("docs").join("work");
        let (dest_sub, _, _) =
            verify_and_place(&tmp, &synced, &sub, "deep.txt", &good_hash, None).unwrap();
        assert_eq!(dest_sub, sub.join("deep.txt"));
        assert!(dest_sub.is_file());

        // Re-receive with a prior path inside the root overwrites it in place.
        std::fs::write(&tmp, b"hello sync").unwrap();
        let (dest2, _, _) =
            verify_and_place(&tmp, &synced, &synced, "ignored.bin", &good_hash, Some(&dest)).unwrap();
        assert_eq!(dest2, dest);

        // A prior path OUTSIDE the root is refused — fresh unique name instead.
        std::fs::write(&tmp, b"hello sync").unwrap();
        let outside = std::env::temp_dir().join("fsync-escape.txt");
        let (dest3, _, _) =
            verify_and_place(&tmp, &synced, &synced, "b.txt", &good_hash, Some(&outside)).unwrap();
        assert!(dest3.starts_with(&synced));
        assert!(!outside.exists());

        let _ = std::fs::remove_dir_all(&synced);
    }

    #[test]
    fn sanitize_dir_keeps_clean_trees_and_defuses_hostile_ones() {
        // Clean relative dirs pass through.
        assert_eq!(sanitize_dir("docs/work"), Ok(PathBuf::from("docs/work")));
        assert_eq!(sanitize_dir(""), Ok(PathBuf::new()));
        // Traversal is refused outright, wherever it hides.
        assert!(sanitize_dir("..").is_err());
        assert!(sanitize_dir("a/../b").is_err());
        assert!(sanitize_dir("..\\x").is_err());
        // Absolute shapes lose their anchors and become relative.
        assert_eq!(sanitize_dir("/etc/passwd"), Ok(PathBuf::from("etc/passwd")));
        assert_eq!(sanitize_dir("a//b"), Ok(PathBuf::from("a/b")));
        assert_eq!(sanitize_dir("a\\b"), Ok(PathBuf::from("a/b")));
        // "." segments drop; weird segments go through the name sanitizer.
        assert_eq!(sanitize_dir("./a/./b"), Ok(PathBuf::from("a/b")));
        assert_eq!(sanitize_dir("h:i/.hidden"), Ok(PathBuf::from("hi/hidden")));
        // Depth is bounded.
        assert!(sanitize_dir(&vec!["d"; DIR_MAX_SEGMENTS].join("/")).is_ok());
        assert!(sanitize_dir(&vec!["d"; DIR_MAX_SEGMENTS + 1].join("/")).is_err());
    }

    #[test]
    fn scan_tree_lists_relative_paths_and_honors_bounds() {
        let root = temp_dir("scan");
        std::fs::write(root.join("top.txt"), b"1").unwrap();
        std::fs::write(root.join(".hidden"), b"x").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("cfg"), b"x").unwrap();
        std::fs::create_dir_all(root.join("docs").join("work")).unwrap();
        std::fs::write(root.join("docs").join("work").join("deep.txt"), b"22").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("top.txt"), root.join("link.txt")).unwrap();

        let (files, truncated) = scan_tree(&root, SCAN_MAX_FILES);
        assert!(!truncated);
        let mut listed: Vec<(String, String)> =
            files.iter().map(|f| (f.dir.clone(), f.name.clone())).collect();
        listed.sort();
        // Dotfiles, dot-dirs and the symlink never appear.
        assert_eq!(
            listed,
            vec![
                ("".to_string(), "top.txt".to_string()),
                ("docs/work".to_string(), "deep.txt".to_string()),
            ]
        );
        assert_eq!(files.iter().find(|f| f.name == "deep.txt").unwrap().size, 2);

        // The file cap stops the walk and flags it.
        let (capped, hit) = scan_tree(&root, 1);
        assert!(hit);
        assert_eq!(capped.len(), 1);

        // Anything deeper than SCAN_MAX_DEPTH is out of reach.
        let mut deep = root.clone();
        for i in 0..=SCAN_MAX_DEPTH {
            deep = deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("too-deep.txt"), b"x").unwrap();
        let (bounded, _) = scan_tree(&root, SCAN_MAX_FILES);
        assert!(!bounded.iter().any(|f| f.name == "too-deep.txt"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_one_copies_without_deleting_and_suffixes_collisions() {
        let root = temp_dir("migrate-root");
        let src_dir = temp_dir("migrate-src");
        let src = src_dir.join("report.pdf");
        std::fs::write(&src, b"payload").unwrap();

        // First copy lands under root/dir/name; the source stays.
        let dest = migrate_one(&root, &src, "docs", "report.pdf").unwrap();
        assert_eq!(dest, root.join("docs").join("report.pdf"));
        assert!(dest.is_file());
        assert!(src.is_file());

        // Second run collides and lands as " (2)", extension kept.
        let dest2 = migrate_one(&root, &src, "docs", "report.pdf").unwrap();
        assert_eq!(dest2, root.join("docs").join("report (2).pdf"));

        // A traversal dir fails the whole item (no write anywhere).
        assert!(migrate_one(&root, &src, "../escape", "report.pdf").is_err());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&src_dir);
    }
}
