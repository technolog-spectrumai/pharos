//! Workspace metadata: `.morion/metadata.json` at the root of the workspace.
//!
//! One small JSON file, plain text by design, holding two things:
//!
//! * **tags** — up to three short words per file, keyed by the file's path
//!   relative to the root. They work for encrypted files exactly as for plain
//!   ones, because they are about the path, not the contents; and for the same
//!   reason they are NOT encrypted and the UI says so. A tag on an encrypted
//!   file is a deliberate leak of one word about it.
//! * **ledger** — the Security Mana ledger (see `mana.rs`): when, which action,
//!   which file, what it cost, why.
//!
//! What is never here: a passphrase, a decrypted byte, a search snippet, or
//! anything else read out of a file body. The file is written atomically, and
//! a damaged one is refused rather than silently replaced, so a stray edit
//! cannot erase every tag in the workspace.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::workspace::{self, META_DIR};

pub const META_FILE: &str = "metadata.json";
pub const META_VERSION: u32 = 1;
/// Tags per file. Three is the product decision: a label, not a taxonomy.
pub const MAX_TAGS: usize = 3;
pub const MAX_TAG_CHARS: usize = 32;
/// Ledger rows kept. Old rows drop off the end; the meters only ever look a
/// week back, and a history view wants recent, not everything.
pub const MAX_LEDGER: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerEntry {
    /// Milliseconds since the epoch.
    pub ts: u64,
    /// An action id from `mana.rs`, or a zero-cost security event.
    pub action: String,
    /// Workspace-relative path, when the action was about one file or folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Mana spent. Zero for an action that merely happened.
    pub cost: u32,
    /// One short sentence, a catalogue key the UI renders.
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Metadata {
    pub version: u32,
    #[serde(default)]
    pub tags: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub ledger: Vec<LedgerEntry>,
}

impl Default for Metadata {
    fn default() -> Self {
        Self { version: META_VERSION, tags: BTreeMap::new(), ledger: Vec::new() }
    }
}

fn meta_path(root: &Path) -> std::path::PathBuf {
    root.join(META_DIR).join(META_FILE)
}

/// The metadata, or an empty one when there is none yet. A file that exists
/// and does not parse is an error: overwriting it would lose every tag.
pub fn load(root: &Path) -> Result<Metadata, String> {
    let path = meta_path(root);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("meta_damaged: .morion/metadata.json is damaged ({e}); nothing was changed")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Metadata::default()),
        Err(e) => Err(format!("meta: {e}")),
    }
}

pub fn save(root: &Path, meta: &Metadata) -> Result<(), String> {
    let dir = root.join(META_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("meta: {e}"))?;
    let bytes = serde_json::to_vec_pretty(meta).map_err(|e| format!("meta: {e}"))?;
    substrate::atomic_write(&meta_path(root).to_string_lossy(), &bytes)
}

/// Trim, drop empties and repeats (case-insensitively), cap length and count.
/// More than three is refused rather than truncated: the user chose them.
pub fn normalise_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let tag = raw.trim();
        if tag.is_empty() {
            continue;
        }
        if tag.chars().count() > MAX_TAG_CHARS {
            return Err(format!("tag_too_long: a tag may have at most {MAX_TAG_CHARS} characters"));
        }
        if out.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            continue;
        }
        out.push(tag.to_string());
    }
    if out.len() > MAX_TAGS {
        return Err(format!("too_many_tags: at most {MAX_TAGS} tags per file"));
    }
    Ok(out)
}

/// The key a file's tags are filed under.
fn key_for(root: &Path, given: &str) -> Result<String, String> {
    let path = workspace::resolve(root, given, false)?;
    if path.is_dir() {
        return Err("tag_folder: a folder cannot be tagged".into());
    }
    Ok(workspace::relative(root, &path))
}

pub fn tags_of(root: &Path, given: &str) -> Result<Vec<String>, String> {
    let key = key_for(root, given)?;
    Ok(load(root)?.tags.get(&key).cloned().unwrap_or_default())
}

pub fn set_tags(root: &Path, given: &str, tags: &[String]) -> Result<Vec<String>, String> {
    let key = key_for(root, given)?;
    let tags = normalise_tags(tags)?;
    let mut meta = load(root)?;
    if tags.is_empty() {
        meta.tags.remove(&key);
    } else {
        meta.tags.insert(key, tags.clone());
    }
    save(root, &meta)?;
    Ok(tags)
}

pub fn all_tags(root: &Path) -> Result<BTreeMap<String, Vec<String>>, String> {
    Ok(load(root)?.tags)
}

// ── the commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn tags_get(ws: tauri::State<'_, workspace::WorkspaceState>, path: String) -> Result<Vec<String>, String> {
    tags_of(&ws.root()?, &path)
}

#[tauri::command]
pub fn tags_set(ws: tauri::State<'_, workspace::WorkspaceState>, path: String, tags: Vec<String>) -> Result<Vec<String>, String> {
    set_tags(&ws.root()?, &path, &tags)
}

#[tauri::command]
pub fn tags_all(ws: tauri::State<'_, workspace::WorkspaceState>) -> Result<BTreeMap<String, Vec<String>>, String> {
    all_tags(&ws.root()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::tests::{put, scratch};
    use crate::LOCKER;

    #[test]
    fn tags_round_trip_through_the_metadata_file_and_key_by_relative_path() {
        let root = scratch("tags");
        put(&root, "notes/a.md", b"a");
        assert_eq!(tags_of(&root, "notes/a.md").unwrap(), Vec::<String>::new());
        let set = set_tags(&root, &root.join("notes/a.md").to_string_lossy(), &["work".into(), " Ideas ".into(), "work".into(), "".into()]).unwrap();
        assert_eq!(set, ["work", "Ideas"]);
        assert_eq!(tags_of(&root, "notes/a.md").unwrap(), ["work", "Ideas"]);

        let text = std::fs::read_to_string(root.join(META_DIR).join(META_FILE)).unwrap();
        assert!(text.contains("\"notes/a.md\""), "keyed by relative path: {text}");
        assert!(!text.contains(&root.to_string_lossy().into_owned()), "no absolute path in the file");
        let all = all_tags(&root).unwrap();
        assert_eq!(all.get("notes/a.md").unwrap(), &vec!["work".to_string(), "Ideas".to_string()]);

        // Clearing removes the row rather than leaving an empty one.
        set_tags(&root, "notes/a.md", &[]).unwrap();
        assert!(all_tags(&root).unwrap().is_empty());
    }

    #[test]
    fn at_most_three_tags_each_no_longer_than_the_cap() {
        let root = scratch("tags-limit");
        put(&root, "a.md", b"a");
        let err = set_tags(&root, "a.md", &["1".into(), "2".into(), "3".into(), "4".into()]).unwrap_err();
        assert!(err.starts_with("too_many_tags"), "{err}");
        let long = "x".repeat(MAX_TAG_CHARS + 1);
        assert!(set_tags(&root, "a.md", &[long]).unwrap_err().starts_with("tag_too_long"));
        // Refused means unchanged: nothing was written.
        assert!(!root.join(META_DIR).exists());
        assert_eq!(set_tags(&root, "a.md", &["1".into(), "2".into(), "3".into()]).unwrap().len(), 3);
    }

    #[test]
    fn an_encrypted_file_is_tagged_like_any_other_and_the_tags_stay_plain() {
        let root = scratch("tags-sealed");
        put(&root, "secret.md", b"the body");
        LOCKER.lock_file(&root.join("secret.md").to_string_lossy(), Some("pw".into())).unwrap();
        set_tags(&root, "secret.md", &["taxes".into()]).unwrap();
        let text = std::fs::read_to_string(root.join(META_DIR).join(META_FILE)).unwrap();
        assert!(text.contains("taxes"), "tags are plaintext metadata by design");
        assert!(!text.contains("the body"));
        assert!(substrate::is_sealed_file(&root.join("secret.md").to_string_lossy()), "the file itself is untouched");
        // The metadata file is not something that gets encrypted or listed.
        assert!(!substrate::is_sealed_file(&root.join(META_DIR).join(META_FILE).to_string_lossy()));
    }

    #[test]
    fn a_damaged_metadata_file_is_refused_rather_than_overwritten() {
        let root = scratch("tags-damaged");
        put(&root, "a.md", b"a");
        put(&root, &format!("{META_DIR}/{META_FILE}"), b"{not json");
        let err = set_tags(&root, "a.md", &["x".into()]).unwrap_err();
        assert!(err.starts_with("meta_damaged"), "{err}");
        assert!(!err.contains(&root.to_string_lossy().into_owned()), "no absolute path in a message");
        assert_eq!(std::fs::read(root.join(META_DIR).join(META_FILE)).unwrap(), b"{not json");
        // Missing is not damaged.
        std::fs::remove_file(root.join(META_DIR).join(META_FILE)).unwrap();
        assert_eq!(load(&root).unwrap(), Metadata::default());
    }

    #[test]
    fn tags_stay_inside_the_workspace_and_off_folders() {
        let root = scratch("tags-boundary");
        put(&root, "d/a.md", b"a");
        assert!(set_tags(&root, "../x.md", &["t".into()]).unwrap_err().starts_with("outside_workspace"));
        assert!(set_tags(&root, "d", &["t".into()]).unwrap_err().starts_with("tag_folder"));
        assert!(tags_of(&root, "missing.md").unwrap_err().starts_with("not_found"));
    }
}
