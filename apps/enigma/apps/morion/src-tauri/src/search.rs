//! Searching the workspace: one command, one walk, nothing kept.
//!
//! The plugin ruled out is `fs`. The webview can list a folder with it, but a
//! search over CONTENTS would read every file through IPC in full, one round
//! trip per file, and re-implement the walk in the page. Reading capped bytes
//! next to the disk and returning fifty short rows is what a native command
//! is for.
//!
//! What it deliberately is not: an index. Every call walks the workspace
//! afresh and holds nothing between calls — no database, no cache, no
//! background thread — which is also what keeps an encryption honest: the
//! moment a file is sealed, the next search cannot see its body, because
//! there is nowhere a previous search's reading could have survived.
//!
//! Three algorithms, one walk:
//!
//! * **quick** — file names, relative paths and tags. Never reads a file's
//!   contents (every mode reads the first bytes, to know which files are
//!   encrypted).
//! * **full** — quick, plus the contents of plain text files, in walk order.
//! * **hybrid** — the same matches, ranked: an exact or leading name match
//!   and a tag match outrank a path match, which outranks a line of text.
//!
//! An encrypted file is matched by its name, path and tags ONLY. Its body is
//! ciphertext and is never read, in any mode, and no passphrase is ever asked
//! for by a search. Rust decides what "encrypted" means (`is_sealed_file`),
//! not the page.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::folder::walk;
use crate::meta;
use crate::workspace::{self, WorkspaceState};

/// The most rows one search returns. A list longer than this is a listing,
/// not a result, and the query wants narrowing rather than scrolling.
pub const MAX_HITS: usize = 50;
/// Bytes of a body read for matching. A note is small; a 1 MiB "note" is
/// something else, and its first megabyte is still searched.
const MAX_BODY_BYTES: u64 = 1024 * 1024;
/// Characters of the matching line handed back.
const SNIPPET_CHARS: usize = 120;
/// What full-text search reads: the kinds Morion itself opens as text.
/// Anything else is matched by name, path and tags, never by contents.
const TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "json", "xml", "pxml", "svg", "csv", "py", "js", "mjs", "cjs", "ts",
    "html", "htm", "css", "yml", "yaml", "sh", "tex", "sty", "toml", "ini", "cfg", "conf", "rs", "log",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Quick,
    Full,
    Hybrid,
}

impl Mode {
    pub fn parse(s: &str) -> Result<Mode, String> {
        match s {
            "quick" => Ok(Mode::Quick),
            "full" => Ok(Mode::Full),
            "hybrid" => Ok(Mode::Hybrid),
            other => Err(format!("search: unknown algorithm {other}")),
        }
    }
}

/// One matching file — exactly what the result list draws, nothing more.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// Absolute, what the app opens.
    pub path: String,
    /// Relative to the root, forward slashes, what the list shows.
    pub rel_path: String,
    pub name: String,
    pub tags: Vec<String>,
    /// Which of name, tag, path, text matched, in that order.
    pub matched: Vec<&'static str>,
    /// The first matching line of the body, trimmed and capped; empty when
    /// the body was not searched or did not match.
    pub snippet: String,
    pub score: u32,
    pub sealed: bool,
}

fn is_text_name(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => {
            let ext = ext.to_ascii_lowercase();
            TEXT_EXTENSIONS.contains(&ext.as_str())
        }
        _ => false,
    }
}

/// The first `MAX_BODY_BYTES` of a file as text, lossily. `None` when it
/// cannot be read — a file that vanished mid-walk is not an error.
fn read_body(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_BODY_BYTES).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The first line of `body` containing `needle` (already lowercased), how
/// many lines contain it, and the line trimmed and cut to `SNIPPET_CHARS`.
fn body_match(body: &str, needle: &str) -> Option<(String, u32)> {
    let mut first: Option<String> = None;
    let mut count = 0u32;
    for line in body.lines() {
        if line.to_lowercase().contains(needle) {
            count += 1;
            if first.is_none() {
                first = Some(line.trim().chars().take(SNIPPET_CHARS).collect());
            }
        }
    }
    first.map(|s| (s, count))
}

/// Score one file against the needle. `None` when nothing matched.
fn score_file(
    path: &Path,
    rel: &str,
    name: &str,
    tags: &[String],
    needle: &str,
    mode: Mode,
    sealed: bool,
) -> Option<(u32, Vec<&'static str>, String)> {
    let mut score = 0u32;
    let mut matched = Vec::new();
    let lname = name.to_lowercase();
    // The stem is what a person calls the file: "budget" is an exact match
    // for budget.md, and a leading match for budgets-2026.md.
    let stem = lname.rsplit_once('.').map(|(s, _)| s).filter(|s| !s.is_empty()).unwrap_or(&lname);
    if stem == needle {
        score += 100;
        matched.push("name");
    } else if stem.starts_with(needle) {
        score += 80;
        matched.push("name");
    } else if lname.contains(needle) {
        score += 60;
        matched.push("name");
    }
    let tag_score = tags
        .iter()
        .map(|t| {
            let lt = t.to_lowercase();
            if lt == needle { 70 } else if lt.contains(needle) { 50 } else { 0 }
        })
        .max()
        .unwrap_or(0);
    if tag_score > 0 {
        score += tag_score;
        matched.push("tag");
    }
    if !matched.contains(&"name") && rel.to_lowercase().contains(needle) {
        score += 40;
        matched.push("path");
    }
    let mut snippet = String::new();
    // The body: only when the mode reads bodies, only for text, NEVER for a
    // sealed file — its bytes are ciphertext and no passphrase is asked here.
    if mode != Mode::Quick && !sealed && is_text_name(name) {
        if let Some((line, count)) = read_body(path).and_then(|b| body_match(&b, needle)) {
            score += 20 + (count.saturating_sub(1)).min(5) * 2;
            matched.push("text");
            snippet = line;
        }
    }
    if matched.is_empty() {
        None
    } else {
        Some((score, matched, snippet))
    }
}

/// Search the workspace under `root` for `query`.
pub fn search(root: &Path, query: &str, mode: Mode, limit: usize) -> Result<Vec<Hit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let tags: BTreeMap<String, Vec<String>> = meta::all_tags(root).unwrap_or_default();
    let walked = walk(root);
    let mut hits = Vec::new();
    for path in &walked.files {
        let rel = workspace::relative(root, path);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let sealed = substrate::is_sealed_file(&path.to_string_lossy());
        let file_tags = tags.get(&rel).cloned().unwrap_or_default();
        if let Some((score, matched, snippet)) = score_file(path, &rel, &name, &file_tags, &needle, mode, sealed) {
            hits.push(Hit {
                path: path.to_string_lossy().into_owned(),
                rel_path: rel,
                name,
                tags: file_tags,
                matched,
                snippet,
                score,
                sealed,
            });
            // Walk order is the answer for quick and full; hybrid ranks, so it
            // has to see everything before it can cut.
            if mode != Mode::Hybrid && hits.len() >= limit {
                break;
            }
        }
    }
    if mode == Mode::Hybrid {
        hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.rel_path.cmp(&b.rel_path)));
        hits.truncate(limit);
    }
    Ok(hits)
}

/// `async`: a full-text search over a large workspace is real disk time, and
/// the input field must keep painting while it happens.
#[tauri::command(async)]
pub fn workspace_search(ws: tauri::State<'_, WorkspaceState>, query: String, mode: String) -> Result<Vec<Hit>, String> {
    search(&ws.root()?, &query, Mode::parse(&mode)?, MAX_HITS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::tests::{put, scratch};
    use crate::LOCKER;

    fn rels(hits: &[Hit]) -> Vec<&str> {
        hits.iter().map(|h| h.rel_path.as_str()).collect()
    }

    #[test]
    fn quick_matches_names_paths_and_tags_and_never_opens_a_file() {
        let root = scratch("search-quick");
        put(&root, "a/idea.md", b"nothing to see");
        put(&root, "b/plan.txt", b"an idea in the body");
        put(&root, "c/other.md", b"x");
        meta::set_tags(&root, "c/other.md", &["idea-tag".into()]).unwrap();
        put(&root, "ideas/z.pdf", b"%PDF");
        let hits = search(&root, "idea", Mode::Quick, MAX_HITS).unwrap();
        assert_eq!(rels(&hits), ["a/idea.md", "c/other.md", "ideas/z.pdf"]);
        assert_eq!(hits[0].matched, ["name"]);
        assert_eq!(hits[1].matched, ["tag"]);
        assert_eq!(hits[1].tags, ["idea-tag"]);
        assert_eq!(hits[2].matched, ["path"]);
        assert!(hits.iter().all(|h| h.snippet.is_empty()));
    }

    #[test]
    fn full_adds_text_bodies_of_text_files_only_in_walk_order() {
        let root = scratch("search-full");
        put(&root, "b/plan.txt", b"an idea in the body");
        put(&root, "a/idea.md", b"nothing");
        put(&root, "binary.png", b"idea idea idea");
        let hits = search(&root, "idea", Mode::Full, MAX_HITS).unwrap();
        assert_eq!(rels(&hits), ["a/idea.md", "b/plan.txt"]);
        assert_eq!(hits[1].matched, ["text"]);
        assert_eq!(hits[1].snippet, "an idea in the body");
    }

    #[test]
    fn hybrid_ranks_a_name_or_tag_above_a_line_of_text() {
        let root = scratch("search-hybrid");
        put(&root, "a/body.md", b"budget budget budget\nbudget");
        put(&root, "z/budget.md", b"nothing");
        put(&root, "m/tagged.md", b"nothing");
        meta::set_tags(&root, "m/tagged.md", &["budget".into()]).unwrap();
        put(&root, "n/budgets-2026.md", b"nothing");
        let hits = search(&root, "budget", Mode::Hybrid, MAX_HITS).unwrap();
        assert_eq!(rels(&hits), ["z/budget.md", "n/budgets-2026.md", "m/tagged.md", "a/body.md"]);
        assert!(hits[0].score > hits[1].score && hits[1].score > hits[2].score && hits[2].score > hits[3].score);
        assert_eq!(hits[3].matched, ["text"]);
        // Full leaves them in walk order instead.
        let full = search(&root, "budget", Mode::Full, MAX_HITS).unwrap();
        assert_eq!(rels(&full), ["a/body.md", "m/tagged.md", "n/budgets-2026.md", "z/budget.md"]);
    }

    #[test]
    fn an_encrypted_file_is_found_by_name_path_and_tag_and_never_by_its_body() {
        let root = scratch("search-sealed");
        put(&root, "vault/secret.md", b"the launch code is 4471");
        put(&root, "open.md", b"the launch code is public");
        let sealed = root.join("vault/secret.md");
        LOCKER.lock_file(&sealed.to_string_lossy(), Some("pw".into())).unwrap();
        meta::set_tags(&root, "vault/secret.md", &["codes".into()]).unwrap();

        for mode in [Mode::Quick, Mode::Full, Mode::Hybrid] {
            let hits = search(&root, "launch code", mode, MAX_HITS).unwrap();
            assert_eq!(rels(&hits), if mode == Mode::Quick { vec![] } else { vec!["open.md"] }, "{mode:?}");
            let hits = search(&root, "4471", mode, MAX_HITS).unwrap();
            assert!(hits.is_empty(), "{mode:?}: ciphertext was searched");
        }
        let by_name = search(&root, "secret", Mode::Full, MAX_HITS).unwrap();
        assert_eq!(rels(&by_name), ["vault/secret.md"]);
        assert!(by_name[0].sealed && by_name[0].snippet.is_empty());
        assert_eq!(by_name[0].matched, ["name"]);
        assert_eq!(rels(&search(&root, "codes", Mode::Full, MAX_HITS).unwrap()), ["vault/secret.md"]);
        assert_eq!(rels(&search(&root, "vault", Mode::Quick, MAX_HITS).unwrap()), ["vault/secret.md"]);
    }

    #[test]
    fn encrypting_a_file_removes_its_body_from_the_next_search() {
        // Nothing is cached: the same query, asked again after the file was
        // sealed, cannot see what it saw before.
        let root = scratch("search-after-seal");
        put(&root, "n.md", b"needle in here");
        assert_eq!(search(&root, "needle", Mode::Full, MAX_HITS).unwrap()[0].snippet, "needle in here");
        LOCKER.lock_file(&root.join("n.md").to_string_lossy(), Some("pw".into())).unwrap();
        assert!(search(&root, "needle", Mode::Full, MAX_HITS).unwrap().is_empty());
    }

    #[test]
    fn skips_the_metadata_folder_and_links_and_stops_at_the_limit() {
        let root = scratch("search-limits");
        put(&root, ".morion/metadata.json", b"{\"tags\":{\"x\":[\"needle\"]}}");
        for i in 0..(MAX_HITS + 5) {
            put(&root, &format!("needle-{i:03}.md"), b"");
        }
        #[cfg(unix)]
        {
            let other = scratch("search-limits-other");
            put(&other, "needle-link-target.md", b"");
            std::os::unix::fs::symlink(other.join("needle-link-target.md"), root.join("needle-link.md")).unwrap();
        }
        let hits = search(&root, "needle", Mode::Quick, MAX_HITS).unwrap();
        assert_eq!(hits.len(), MAX_HITS);
        assert!(hits.iter().all(|h| !h.rel_path.contains("link") && !h.rel_path.starts_with(".morion")));
        assert_eq!(search(&root, "needle", Mode::Hybrid, 3).unwrap().len(), 3);
        assert!(search(&root, "   ", Mode::Full, MAX_HITS).unwrap().is_empty());
        assert!(Mode::parse("fuzzy").is_err());
    }
}
