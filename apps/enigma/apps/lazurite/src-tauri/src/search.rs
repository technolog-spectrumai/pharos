//! Notes search: one command, one walk, nothing kept.
//!
//! The plugin ruled out is `fs`. The webview can already list a folder with it
//! (the Files panel does), but a search over CONTENTS would read every note
//! through IPC in full, one round trip per file, and re-implement the walk in
//! the page. Reading capped bytes next to the disk and returning fifty short
//! rows is what a native command is for.
//!
//! What it deliberately is not: an index. Every call walks the folder afresh
//! and holds nothing between calls — no database, no cache, no background
//! thread. A sealed file is matched by its NAME and PATH only: its body is
//! ciphertext, and this never asks for a passphrase, so nothing decrypted is
//! ever read here, let alone written anywhere.
//!
//! The core takes a `Path` and returns plain data so it can be tested without
//! tauri; the command at the bottom is the shim that registers it.

use std::collections::VecDeque;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The most rows one search returns. A list longer than this is a listing,
/// not a result, and the query wants narrowing rather than scrolling.
pub const MAX_HITS: usize = 50;
/// Folders deeper than this are not entered; a notes folder is not a build
/// tree, and this is what keeps a cyclic layout finite.
const MAX_DEPTH: usize = 16;
/// Notes looked at before the walk gives up and answers with what it has.
const MAX_FILES: usize = 5_000;
/// Bytes of a body read for matching. A note is small; a 1 MiB "note" is
/// something else, and its first megabyte is still searched.
const MAX_BODY_BYTES: u64 = 1024 * 1024;
/// Characters of the matching line handed back.
const SNIPPET_CHARS: usize = 120;
/// What counts as a note. Anything else in the folder is ignored, not
/// searched-and-hidden.
const NOTE_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

/// One matching note — exactly what the result list draws, nothing more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NoteHit {
    /// Absolute, what the app opens.
    pub path: String,
    /// Relative to the notes root, forward slashes, what the list shows.
    pub rel_path: String,
    pub name: String,
    /// The first matching line of the body, trimmed and capped; empty when
    /// only the name or path matched.
    pub snippet: String,
}

/// Whether a file name is one this search reads.
fn is_note_name(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => {
            let ext = ext.to_ascii_lowercase();
            NOTE_EXTENSIONS.iter().any(|e| *e == ext)
        }
        _ => false,
    }
}

/// The first `MAX_BODY_BYTES` of a file as text, lossily. `None` when it
/// cannot be read — a note that vanished mid-walk is not an error.
fn read_body(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_BODY_BYTES).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The first line of `body` containing `needle` (already lowercased),
/// trimmed and cut to `SNIPPET_CHARS` characters.
fn snippet_for(body: &str, needle: &str) -> Option<String> {
    let line = body
        .lines()
        .find(|line| line.to_lowercase().contains(needle))?;
    Some(line.trim().chars().take(SNIPPET_CHARS).collect())
}

/// Whether `path` matches, and how. Name and path are always consulted; the
/// body only for a file that is not sealed.
fn match_file(path: &Path, rel: &str, name: &str, needle: &str) -> Option<NoteHit> {
    let by_name = name.to_lowercase().contains(needle) || rel.to_lowercase().contains(needle);
    let sealed = substrate::is_sealed_file(&path.to_string_lossy());
    let snippet = if sealed {
        None
    } else {
        read_body(path).and_then(|body| snippet_for(&body, needle))
    };
    if !by_name && snippet.is_none() {
        return None;
    }
    Some(NoteHit {
        path: path.to_string_lossy().into_owned(),
        rel_path: rel.to_owned(),
        name: name.to_owned(),
        snippet: snippet.unwrap_or_default(),
    })
}

/// Search the notes under `root` for `query`, at most `limit` hits.
///
/// Breadth-first, entries sorted, so the same folder answers the same way
/// twice. Symlinks are not followed (`DirEntry::file_type` reports the link,
/// not its target), dotfiles and dotfolders are skipped, and a file outside
/// `root` cannot be reached because the walk only ever descends.
pub fn search_notes(root: &Path, query: &str, limit: usize) -> Result<Vec<NoteHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let root = fs::canonicalize(root).map_err(|e| format!("root: {e}"))?;
    if !root.is_dir() {
        return Err("root: not a folder".into());
    }

    let mut hits = Vec::new();
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::from([(root.clone(), 0)]);
    let mut looked_at = 0usize;

    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut entries: Vec<fs::DirEntry> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }
            if !kind.is_file() || !is_note_name(&name) {
                continue;
            }
            looked_at += 1;
            if looked_at > MAX_FILES {
                return Ok(hits);
            }
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if let Some(hit) = match_file(&path, &rel, &name, &needle) {
                hits.push(hit);
                if hits.len() >= limit {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

/// Search the notes folder. `root` is the folder the user picked for the Files
/// panel; the walk never leaves it. `async` because a large folder is real
/// disk time, and the input field must keep painting while it happens.
#[tauri::command(async)]
pub fn notes_search(root: String, query: String) -> Result<Vec<NoteHit>, String> {
    search_notes(Path::new(&root), &query, MAX_HITS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder per test, keyed by pid and name so parallel tests and
    /// parallel runs never share one.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lazurite-search-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(root: &Path, rel: &str, body: &[u8]) -> PathBuf {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    fn names(hits: &[NoteHit]) -> Vec<&str> {
        hits.iter().map(|h| h.rel_path.as_str()).collect()
    }

    #[test]
    fn finds_a_nested_note_by_its_name() {
        let root = scratch("nested");
        put(&root, "a/b/c/idea.md", b"nothing here");
        let hits = search_notes(&root, "idea", MAX_HITS).unwrap();
        assert_eq!(names(&hits), ["a/b/c/idea.md"]);
        assert_eq!(hits[0].name, "idea.md");
        assert_eq!(hits[0].snippet, "");
        assert!(Path::new(&hits[0].path).is_absolute());
    }

    #[test]
    fn matches_the_relative_path_not_only_the_name() {
        let root = scratch("relpath");
        put(&root, "projects/rocket/log.txt", b"launch");
        put(&root, "other.txt", b"launch");
        let hits = search_notes(&root, "rocket", MAX_HITS).unwrap();
        assert_eq!(names(&hits), ["projects/rocket/log.txt"]);
    }

    #[test]
    fn matches_the_body_and_hands_back_the_line() {
        let root = scratch("body");
        put(&root, "shopping.md", b"# Shopping\n\n- milk\n- Eggs and BREAD\n");
        let hits = search_notes(&root, "bread", MAX_HITS).unwrap();
        assert_eq!(names(&hits), ["shopping.md"]);
        assert_eq!(hits[0].snippet, "- Eggs and BREAD");
    }

    #[test]
    fn reads_only_the_note_extensions() {
        let root = scratch("exts");
        for name in ["a.md", "b.markdown", "c.txt", "D.MD", "e.rs", "f.png", "g", ".hidden.md"] {
            put(&root, name, b"needle");
        }
        let hits = search_notes(&root, "needle", MAX_HITS).unwrap();
        assert_eq!(names(&hits), ["D.MD", "a.md", "b.markdown", "c.txt"]);
    }

    #[test]
    fn a_sealed_note_matches_by_name_only() {
        let root = scratch("sealed");
        let framed = substrate::FrameSpec::ZINNIA.frame(b"{}", b"the secret plan is here");
        put(&root, "plan.md", &framed);
        put(&root, "open.md", b"the secret plan is public");

        // The body of a sealed file is never consulted…
        let hits = search_notes(&root, "secret plan", MAX_HITS).unwrap();
        assert_eq!(names(&hits), ["open.md"]);
        // …but its name still is, and it comes back without a snippet.
        let hits = search_notes(&root, "plan", MAX_HITS).unwrap();
        assert_eq!(names(&hits), ["open.md", "plan.md"]);
        let sealed = hits.iter().find(|h| h.name == "plan.md").unwrap();
        assert_eq!(sealed.snippet, "");
    }

    #[test]
    fn never_leaves_the_root() {
        let parent = scratch("outside");
        let root = parent.join("notes");
        put(&root, "inside.md", b"marker");
        put(&parent, "elsewhere/outside.md", b"marker");
        put(&parent, "outside-too.md", b"marker");
        let hits = search_notes(&root, "marker", MAX_HITS).unwrap();
        assert_eq!(names(&hits), ["inside.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_a_symlink_out_of_the_root() {
        let parent = scratch("symlink");
        let root = parent.join("notes");
        fs::create_dir_all(&root).unwrap();
        put(&parent, "secret/leak.md", b"marker");
        std::os::unix::fs::symlink(parent.join("secret"), root.join("link")).unwrap();
        let hits = search_notes(&root, "marker", MAX_HITS).unwrap();
        assert!(hits.is_empty(), "{:?}", names(&hits));
    }

    #[test]
    fn stops_at_the_limit() {
        let root = scratch("limit");
        for i in 0..(MAX_HITS + 10) {
            put(&root, &format!("note-{i:03}.md"), b"common");
        }
        assert_eq!(search_notes(&root, "common", MAX_HITS).unwrap().len(), MAX_HITS);
        assert_eq!(search_notes(&root, "common", 3).unwrap().len(), 3);
    }

    #[test]
    fn an_empty_query_finds_nothing_and_a_missing_root_is_an_error() {
        let root = scratch("empty");
        put(&root, "a.md", b"x");
        assert!(search_notes(&root, "   ", MAX_HITS).unwrap().is_empty());
        assert!(search_notes(&root.join("nope"), "x", MAX_HITS).is_err());
    }

    #[test]
    fn matching_is_case_insensitive_and_ascii_extension_aware() {
        assert!(is_note_name("Notes.MD"));
        assert!(is_note_name("a.b.txt"));
        assert!(!is_note_name(".md"));
        assert!(!is_note_name("md"));
        assert_eq!(snippet_for("Alpha\nBeta GAMMA\n", "gamma").as_deref(), Some("Beta GAMMA"));
        assert_eq!(snippet_for("Alpha", "zeta"), None);
    }
}
