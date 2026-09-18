//! Encrypting or decrypting every file under a folder, with one passphrase.
//!
//! One walk, one rule set, shared with the search: symbolic links are never
//! followed, `.morion/` is never touched, and the walk stays inside the
//! workspace because it starts from a resolved path and only ever descends.
//!
//! Each file is sealed on its own — its own salt, its own key — by padova's
//! `lock_file`, exactly as if the user had encrypted it alone. That costs an
//! Argon2id derivation per file (most of a second each), which is the price
//! of files that stay independently portable; the modal says so.
//!
//! What "safely" means here: a file already in the target state is skipped
//! and reported as such, a failure on one file is recorded and the walk goes
//! on, and nothing that succeeded is ever undone by something that did not.
//! The one early stop is a wrong passphrase while decrypting: every remaining
//! file would fail the same way at the same cost, so they are reported as
//! `untried` — still encrypted, and said so — instead of tried.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::workspace::{self, META_DIR};
use crate::LOCKER;

/// Folders deeper than this are not entered.
const MAX_DEPTH: usize = 32;
/// Files visited before the walk stops and says so.
const MAX_FILES: usize = 20_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderPreview {
    pub files: usize,
    pub plain: usize,
    pub sealed: usize,
    /// Symbolic links seen and left alone.
    pub links: usize,
    /// True when the file cap stopped the walk early.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FolderFailure {
    /// Relative to the workspace root.
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderReport {
    /// Files now in the requested state because of this run.
    pub done: Vec<String>,
    /// Files already in the requested state, left alone.
    pub skipped: Vec<String>,
    /// Files not tried because the run stopped at a wrong passphrase. Still
    /// as they were — encrypted, for a decrypt run.
    pub untried: Vec<String>,
    pub failed: Vec<FolderFailure>,
    pub links: usize,
    pub truncated: bool,
}

pub(crate) struct Walk {
    pub(crate) files: Vec<PathBuf>,
    pub(crate) links: usize,
    pub(crate) truncated: bool,
}

/// Every regular file under `dir`, in a stable order. Links are counted,
/// never followed; `.morion` is never entered. The search walks the same
/// way, so what one operation sees the other sees.
pub(crate) fn walk(dir: &Path) -> Walk {
    let mut out = Walk { files: Vec::new(), links: 0, truncated: false };
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(dir.to_path_buf(), 0)]);
    while let Some((here, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&here) else { continue };
        let mut entries: Vec<std::fs::DirEntry> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            if name == META_DIR {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                out.links += 1;
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            if out.files.len() >= MAX_FILES {
                out.truncated = true;
                return out;
            }
            out.files.push(path);
        }
    }
    out
}

pub fn preview(root: &Path, given: &str) -> Result<FolderPreview, String> {
    let dir = workspace::resolve(root, given, false)?;
    if !dir.is_dir() {
        return Err("not_found: that is not a folder in the workspace".into());
    }
    let walked = walk(&dir);
    let sealed = walked.files.iter().filter(|p| substrate::is_sealed_file(&p.to_string_lossy())).count();
    Ok(FolderPreview {
        files: walked.files.len(),
        plain: walked.files.len() - sealed,
        sealed,
        links: walked.links,
        truncated: walked.truncated,
    })
}

/// Encrypt (or, with `unlock`, decrypt) every file under `given`.
pub fn run(root: &Path, given: &str, password: Option<String>, unlock: bool) -> Result<FolderReport, String> {
    let dir = workspace::resolve(root, given, false)?;
    if !dir.is_dir() {
        return Err("not_found: that is not a folder in the workspace".into());
    }
    let walked = walk(&dir);
    let mut report = FolderReport {
        done: Vec::new(),
        skipped: Vec::new(),
        untried: Vec::new(),
        failed: Vec::new(),
        links: walked.links,
        truncated: walked.truncated,
    };
    let mut stop = false;
    for path in &walked.files {
        let rel = workspace::relative(root, path);
        let path_str = path.to_string_lossy().into_owned();
        let sealed = substrate::is_sealed_file(&path_str);
        if sealed != unlock {
            report.skipped.push(rel);
            continue;
        }
        if stop {
            report.untried.push(rel);
            continue;
        }
        let result = if unlock {
            LOCKER.unlock_file(&path_str, password.clone())
        } else {
            LOCKER.lock_file(&path_str, password.clone())
        };
        match result {
            Ok(_) => report.done.push(rel),
            Err(error) => {
                // A wrong passphrase would fail every remaining file the same
                // way, a second each: say so once and leave the rest alone.
                if unlock && (error.starts_with("wrong_password") || error.starts_with("no_passphrase")) {
                    stop = true;
                }
                report.failed.push(FolderFailure { path: rel, error });
            }
        }
    }
    Ok(report)
}

// ── the commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn folder_preview(ws: tauri::State<'_, workspace::WorkspaceState>, dir: String) -> Result<FolderPreview, String> {
    preview(&ws.root()?, &dir)
}

/// `async`: one Argon2id derivation per file.
#[tauri::command(async)]
pub fn folder_lock(
    ws: tauri::State<'_, workspace::WorkspaceState>,
    dir: String,
    password: Option<String>,
    unlock: bool,
) -> Result<FolderReport, String> {
    run(&ws.root()?, &dir, password, unlock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::tests::{put, scratch};

    #[test]
    fn encrypts_everything_below_skipping_what_already_is_and_what_is_not_a_file() {
        let root = scratch("folder-lock");
        put(&root, "a.md", b"a");
        put(&root, "deep/er/b.txt", b"b");
        put(&root, "deep/c.pdf", b"%PDF-1.4 c");
        put(&root, &format!("{META_DIR}/metadata.json"), b"{}");
        put(&root, "deep/already.md", b"x");
        LOCKER.lock_file(&root.join("deep/already.md").to_string_lossy(), Some("pw".into())).unwrap();
        #[cfg(unix)]
        {
            let other = scratch("folder-lock-other");
            put(&other, "outside.md", b"o");
            std::os::unix::fs::symlink(&other, root.join("link")).unwrap();
            std::os::unix::fs::symlink(other.join("outside.md"), root.join("link.md")).unwrap();
        }

        let before = preview(&root, "").unwrap();
        assert_eq!((before.files, before.plain, before.sealed), (4, 3, 1));

        let report = run(&root, "", Some("pw".into()), false).unwrap();
        assert_eq!(report.done.len(), 3, "{:?}", report.done);
        assert!(report.done.contains(&"a.md".to_string()));
        assert!(report.done.contains(&"deep/c.pdf".to_string()));
        assert!(report.done.contains(&"deep/er/b.txt".to_string()));
        assert_eq!(report.skipped, ["deep/already.md"]);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        #[cfg(unix)]
        {
            assert_eq!(report.links, 2);
            assert_eq!(std::fs::read(root.join("link.md")).unwrap(), b"o", "the link's target was not touched");
        }
        assert_eq!(std::fs::read(root.join(META_DIR).join("metadata.json")).unwrap(), b"{}");
        for rel in ["a.md", "deep/er/b.txt", "deep/c.pdf", "deep/already.md"] {
            assert!(substrate::is_sealed_file(&root.join(rel).to_string_lossy()), "{rel} sealed");
        }
        let after = preview(&root, "").unwrap();
        assert_eq!((after.plain, after.sealed), (0, 4));

        // Decrypting all of it, from a sub-folder only, leaves the rest sealed.
        let report = run(&root, "deep", Some("pw".into()), true).unwrap();
        assert_eq!(report.done.len(), 3);
        assert_eq!(std::fs::read(root.join("deep/c.pdf")).unwrap(), b"%PDF-1.4 c");
        assert!(substrate::is_sealed_file(&root.join("a.md").to_string_lossy()));
    }

    #[test]
    fn a_wrong_passphrase_stops_after_the_first_file_and_destroys_nothing() {
        let root = scratch("folder-wrong");
        for name in ["a.md", "b.md", "c.md"] {
            put(&root, name, name.as_bytes());
            LOCKER.lock_file(&root.join(name).to_string_lossy(), Some("right".into())).unwrap();
        }
        let sealed: Vec<_> = ["a.md", "b.md", "c.md"].iter().map(|n| std::fs::read(root.join(n)).unwrap()).collect();
        let report = run(&root, "", Some("wrong".into()), true).unwrap();
        assert!(report.done.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].error.starts_with("wrong_password"));
        assert!(report.skipped.is_empty());
        assert_eq!(report.untried, ["b.md", "c.md"]);
        for (i, name) in ["a.md", "b.md", "c.md"].iter().enumerate() {
            assert_eq!(std::fs::read(root.join(name)).unwrap(), sealed[i], "{name} untouched");
        }
    }

    #[cfg(unix)]
    #[test]
    fn one_file_that_cannot_be_read_does_not_stop_or_undo_the_others() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("folder-failure");
        put(&root, "a.md", b"a");
        let bad = put(&root, "b.md", b"b");
        put(&root, "c.md", b"c");
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&bad).is_ok() {
            // Running as root: permissions do not bite, and neither would the
            // failure this test is about.
            return;
        }
        let report = run(&root, "", Some("pw".into()), false).unwrap();
        assert_eq!(report.done, ["a.md", "c.md"]);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].path, "b.md");
        assert!(substrate::is_sealed_file(&root.join("a.md").to_string_lossy()));
        assert!(substrate::is_sealed_file(&root.join("c.md").to_string_lossy()));
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn stays_inside_the_workspace() {
        let root = scratch("folder-boundary");
        assert!(preview(&root, "../").unwrap_err().starts_with("outside_workspace"));
        assert!(run(&root, "/tmp", Some("pw".into()), false).unwrap_err().starts_with("outside_workspace"));
    }
}
