//! The workspace: one folder the user chose, and the boundary around it.
//!
//! A workspace is nothing more than a directory. Lazurite reads and writes the
//! files inside it and never imports or copies them anywhere. What this module
//! adds is the BOUNDARY: every path a command is handed is resolved against the
//! canonical root, and a path that would leave the folder — through `..`, an
//! absolute path elsewhere, or a symbolic link — is refused before any I/O.
//!
//! The plugin ruled out is `fs`. Its scope is a runtime grant made by the
//! folder dialog: it does not survive a restart (so the remembered workspace
//! could not reopen on launch), it cannot say "never follow a symlink", and it
//! would leave the boundary split between a plugin's allow-list and this
//! app's own rules. One place, in Rust, testable, is what a boundary should
//! be. The `fs` plugin stays for what it is good at — an export the user aims
//! at a location of their own choosing through the native save dialog.
//!
//! Symbolic links are never followed, anywhere: a listing leaves them out, and
//! a path that has one as any component is refused. That is the simplest rule
//! that cannot be argued around, and it is the same rule the folder
//! encryption and the search apply.
//!
//! A `.lazurite/` folder is Lazurite's own metadata (tags, the Mana ledger):
//! this workspace's at the root, a nested workspace's further down. At any
//! depth it is refused to every path-taking command and hidden from listings,
//! walks and every bulk operation.

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Lazurite's metadata directory, at the root of a workspace.
pub const META_DIR: &str = ".lazurite";

/// The most a text or byte read hands to the page. An editor buffer larger
/// than this is not something this app can usefully show.
pub const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;

/// The open workspace, canonical. `None` until one is opened.
pub struct WorkspaceState(pub Mutex<Option<PathBuf>>);

impl WorkspaceState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// The root, or the error every command gives without one.
    pub fn root(&self) -> Result<PathBuf, String> {
        self.0
            .lock()
            .map_err(|_| "no_workspace: the workspace state is poisoned".to_string())?
            .clone()
            .ok_or_else(|| "no_workspace: choose a workspace folder first".to_string())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WorkspaceInfo {
    /// Canonical, absolute.
    pub root: String,
    /// The folder's own name, for the menu.
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntryDto {
    pub name: String,
    /// Absolute, under the canonical root.
    pub path: String,
    pub is_directory: bool,
    pub size: Option<u64>,
    /// Milliseconds since the epoch.
    pub modified: Option<u64>,
    /// Whether the file is an encrypted frame — read here, once, from the
    /// first bytes, so the listing needs no probe per row.
    pub sealed: bool,
}

fn info_for(root: &Path) -> WorkspaceInfo {
    WorkspaceInfo {
        root: root.to_string_lossy().into_owned(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
    }
}

/// Canonicalise a folder the user picked. The dialog may hand back a path
/// through a symlink; the canonical form is what everything else compares
/// against, so it is settled once here.
pub fn open_root(root: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(root)
        .map_err(|e| format!("cannot_open: cannot open that folder: {e}"))?;
    if !canonical.is_dir() {
        return Err("cannot_open: that is not a folder".into());
    }
    Ok(canonical)
}

/// Whether one path component names a symbolic link. A missing path is not a
/// link; the caller decides whether missing is allowed.
fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Resolve `given` to a path inside `root`, or refuse.
///
/// `given` may be absolute (what listings hand back) or relative to the root.
/// The rules, in the order they are applied:
///
/// 1. no `..` anywhere — a path that climbs is refused before it is looked at;
/// 2. it must lie under the root; an absolute path elsewhere is refused. A
///    path whose PREFIX resolves into the root (the dialog handed back a
///    symlinked spelling of the workspace itself) is accepted in canonical
///    form;
/// 3. nothing inside a `.lazurite/` folder, at any depth: that is Lazurite's
///    own metadata — this workspace's at the root, and a nested workspace's
///    further down — written only by `meta.rs`. No editor, encryption or tag
///    may reach it through a path, and listings and walks never show it;
/// 4. no component under the root may be a symbolic link, whatever it points
///    at — links are never followed;
/// 5. every component must exist, except the last one when `may_create` (a
///    file about to be written).
///
/// What comes back is `root` joined with the plain relative path, so the
/// caller writes exactly where the user is looking.
pub fn resolve(root: &Path, given: &str, may_create: bool) -> Result<PathBuf, String> {
    if given.trim().is_empty() {
        return Ok(root.to_path_buf());
    }
    let given_path = Path::new(given);
    let candidate = if given_path.is_absolute() {
        given_path.to_path_buf()
    } else {
        root.join(given_path)
    };
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("outside_workspace: that path climbs out of the workspace".into());
    }

    // Under the root as spelled — or, failing that, under it once the spelling
    // is canonicalised (the picked folder reached through a link, say).
    let rel: PathBuf = match candidate.strip_prefix(root) {
        Ok(rel) => rel.to_path_buf(),
        Err(_) => {
            let parent = candidate
                .parent()
                .ok_or_else(|| "outside_workspace: that path is not inside the workspace".to_string())?;
            let canonical_parent = std::fs::canonicalize(parent)
                .map_err(|_| "outside_workspace: that path is not inside the workspace".to_string())?;
            let rel_parent = canonical_parent
                .strip_prefix(root)
                .map_err(|_| "outside_workspace: that path is not inside the workspace".to_string())?;
            let name = candidate
                .file_name()
                .ok_or_else(|| "outside_workspace: that path is not inside the workspace".to_string())?;
            rel_parent.join(name)
        }
    };

    let components: Vec<_> = rel
        .components()
        .filter(|c| !matches!(c, Component::CurDir))
        .collect();
    if components.iter().any(|c| matches!(c, Component::Normal(part) if *part == META_DIR)) {
        return Err("metadata: that is Lazurite's own metadata folder".into());
    }
    let mut walked = root.to_path_buf();
    for (i, component) in components.iter().enumerate() {
        let Component::Normal(part) = component else {
            return Err("outside_workspace: that path is not inside the workspace".into());
        };
        walked.push(part);
        let last = i + 1 == components.len();
        if is_symlink(&walked) {
            return Err("symlink: Lazurite does not follow symbolic links".into());
        }
        if !walked.exists() && !(last && may_create) {
            return Err(format!("not_found: no such file in the workspace: {}", rel.display()));
        }
    }
    Ok(walked)
}

/// A file's path relative to the root, forward slashes — what tags and the
/// ledger are keyed by, and what the user is shown.
pub fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// List one folder inside the workspace: folders first, then files, each
/// alphabetical. Symbolic links and `.lazurite` are left out.
pub fn list_dir(root: &Path, dir: &Path) -> Result<Vec<EntryDto>, String> {
    if !dir.is_dir() {
        return Err("not_found: that is not a folder in the workspace".into());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == META_DIR {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        let meta = entry.metadata().ok();
        let is_directory = kind.is_dir();
        out.push(EntryDto {
            name,
            path: path.to_string_lossy().into_owned(),
            is_directory,
            size: meta.as_ref().filter(|_| !is_directory).map(|m| m.len()),
            modified: meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64),
            sealed: !is_directory && substrate::is_sealed_file(&path.to_string_lossy()),
        });
    }
    out.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let _ = root;
    Ok(out)
}

fn read_checked(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("not_found: {e}"))?;
    if meta.is_dir() {
        return Err("not_found: that is a folder, not a file".into());
    }
    if meta.len() > MAX_READ_BYTES {
        return Err("too_large: that file is too big to open here".into());
    }
    if substrate::is_sealed_file(&path.to_string_lossy()) {
        return Err("locked: that file is encrypted".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

/// The bytes of a plain file. An encrypted one is refused: opening it goes
/// through the sealed commands, which decrypt in memory and never here.
pub fn read_bytes(root: &Path, given: &str) -> Result<Vec<u8>, String> {
    read_checked(&resolve(root, given, false)?)
}

/// The text of a plain file. Not lossy: a file that is not UTF-8 is not text,
/// and handing it to an editor as if it were would corrupt it on the next save.
pub fn read_text(root: &Path, given: &str) -> Result<String, String> {
    String::from_utf8(read_bytes(root, given)?).map_err(|_| "not_text: that file is not a text file".into())
}

/// Write text to a file in the workspace, creating it if it does not exist.
/// A file that is encrypted on disk is never overwritten with plaintext by
/// this path — saving one goes through its sealed session.
pub fn write_text(root: &Path, given: &str, text: &str) -> Result<(), String> {
    let path = resolve(root, given, true)?;
    if path.is_dir() {
        return Err("not_found: that is a folder, not a file".into());
    }
    if path.exists() && substrate::is_sealed_file(&path.to_string_lossy()) {
        return Err("locked: that file is encrypted on disk; save it through its passphrase".into());
    }
    substrate::atomic_write(&path.to_string_lossy(), text.as_bytes())
}

// ── the commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn workspace_open(state: tauri::State<'_, WorkspaceState>, root: String) -> Result<WorkspaceInfo, String> {
    let canonical = open_root(Path::new(&root))?;
    let info = info_for(&canonical);
    *state.0.lock().map_err(|_| "no_workspace: state poisoned".to_string())? = Some(canonical);
    Ok(info)
}

#[tauri::command]
pub fn workspace_list(state: tauri::State<'_, WorkspaceState>, dir: String) -> Result<Vec<EntryDto>, String> {
    let root = state.root()?;
    let dir = resolve(&root, &dir, false)?;
    list_dir(&root, &dir)
}

#[tauri::command]
pub fn workspace_read_text(state: tauri::State<'_, WorkspaceState>, path: String) -> Result<String, String> {
    read_text(&state.root()?, &path)
}

/// Raw bytes, for pictures. A `tauri::ipc::Response` travels as a body, not as
/// a JSON array of numbers.
#[tauri::command]
pub fn workspace_read_bytes(state: tauri::State<'_, WorkspaceState>, path: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(read_bytes(&state.root()?, &path)?))
}

#[tauri::command]
pub fn workspace_write_text(state: tauri::State<'_, WorkspaceState>, path: String, text: String) -> Result<(), String> {
    write_text(&state.root()?, &path, &text)
}


#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fresh workspace per test, canonical, keyed by pid and name.
    pub(crate) fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lazurite-ws-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    pub(crate) fn put(root: &Path, rel: &str, body: &[u8]) -> PathBuf {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn a_file_inside_resolves_by_absolute_or_relative_path() {
        let root = scratch("inside");
        let file = put(&root, "notes/a.md", b"a");
        assert_eq!(resolve(&root, &file.to_string_lossy(), false).unwrap(), file);
        assert_eq!(resolve(&root, "notes/a.md", false).unwrap(), file);
        assert_eq!(resolve(&root, "", false).unwrap(), root);
    }

    #[test]
    fn climbing_out_with_dot_dot_is_refused_before_any_io() {
        let root = scratch("dotdot");
        let outside = root.parent().unwrap().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();
        let err = resolve(&root, "../secret.txt", false).unwrap_err();
        assert!(err.starts_with("outside_workspace"), "{err}");
        let spelled = format!("{}/notes/../../secret.txt", root.display());
        let err = resolve(&root, &spelled, false).unwrap_err();
        assert!(err.starts_with("outside_workspace"), "{err}");
        std::fs::remove_file(outside).ok();
    }

    #[test]
    fn an_absolute_path_elsewhere_is_refused() {
        let root = scratch("elsewhere");
        let other = scratch("elsewhere-other");
        let file = put(&other, "b.txt", b"b");
        let err = resolve(&root, &file.to_string_lossy(), false).unwrap_err();
        assert!(err.starts_with("outside_workspace"), "{err}");
        // A sibling whose name merely STARTS with the root's is not inside it.
        let sibling = format!("{}-other/b.txt", root.display());
        let _ = std::fs::create_dir_all(format!("{}-other", root.display()));
        std::fs::write(&sibling, b"b").ok();
        let err = resolve(&root, &sibling, false).unwrap_err();
        assert!(err.starts_with("outside_workspace"), "{err}");
        let _ = std::fs::remove_dir_all(format!("{}-other", root.display()));
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_refused_whatever_they_point_at() {
        use std::os::unix::fs::symlink;
        let root = scratch("links");
        let other = scratch("links-target");
        put(&other, "secret.txt", b"s");
        put(&root, "real/inner.txt", b"i");
        symlink(other.join("secret.txt"), root.join("out.txt")).unwrap();
        symlink(&other, root.join("outdir")).unwrap();
        symlink(root.join("real"), root.join("indir")).unwrap();

        for given in ["out.txt", "outdir/secret.txt", "indir/inner.txt"] {
            let err = resolve(&root, given, false).unwrap_err();
            assert!(err.starts_with("symlink") || err.starts_with("outside_workspace"), "{given}: {err}");
        }
        // …and a listing simply does not show them.
        let names: Vec<_> = list_dir(&root, &root).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["real"]);
    }

    #[cfg(unix)]
    #[test]
    fn the_workspace_reached_through_a_link_is_still_the_workspace() {
        use std::os::unix::fs::symlink;
        let real = scratch("linked-real");
        put(&real, "a.txt", b"a");
        let link = std::env::temp_dir().join(format!("lazurite-ws-link-{}", std::process::id()));
        let _ = std::fs::remove_file(&link);
        symlink(&real, &link).unwrap();
        // Opening canonicalises, so the root is the real folder…
        assert_eq!(open_root(&link).unwrap(), real);
        // …and a path spelled through the link resolves to the real file.
        let spelled = link.join("a.txt");
        assert_eq!(resolve(&real, &spelled.to_string_lossy(), false).unwrap(), real.join("a.txt"));
        std::fs::remove_file(link).ok();
    }

    #[test]
    fn lazuritess_own_metadata_folder_is_out_of_reach() {
        let root = scratch("metadata");
        put(&root, &format!("{META_DIR}/metadata.json"), b"{}");
        for given in [
            format!("{META_DIR}/metadata.json"),
            META_DIR.to_string(),
            root.join(META_DIR).join("metadata.json").to_string_lossy().into_owned(),
            format!("{META_DIR}/new.md"),
        ] {
            let err = resolve(&root, &given, true).unwrap_err();
            assert!(err.starts_with("metadata"), "{given}: {err}");
        }
        assert!(write_text(&root, &format!("{META_DIR}/metadata.json"), "{}").unwrap_err().starts_with("metadata"));
        assert!(read_text(&root, &format!("{META_DIR}/metadata.json")).unwrap_err().starts_with("metadata"));
        // A folder that merely starts with the name is an ordinary folder.
        put(&root, ".lazurite-notes/a.md", b"a");
        assert!(resolve(&root, ".lazurite-notes/a.md", false).is_ok());
        // A nested workspace's metadata is metadata too, and just as hidden.
        put(&root, "sub/.lazurite/metadata.json", b"{}");
        assert!(resolve(&root, "sub/.lazurite/metadata.json", false).unwrap_err().starts_with("metadata"));
        let names: Vec<_> = list_dir(&root, &root.join("sub")).unwrap().into_iter().map(|e| e.name).collect();
        assert!(names.is_empty(), "{names:?}");
    }

    #[test]
    fn a_new_file_may_be_created_but_not_under_a_missing_folder() {
        let root = scratch("create");
        assert!(resolve(&root, "fresh.md", true).is_ok());
        let err = resolve(&root, "fresh.md", false).unwrap_err();
        assert!(err.starts_with("not_found"), "{err}");
        let err = resolve(&root, "nofolder/fresh.md", true).unwrap_err();
        assert!(err.starts_with("not_found"), "{err}");
    }

    #[test]
    fn listing_hides_the_metadata_folder_and_marks_sealed_files() {
        let root = scratch("listing");
        put(&root, "b.txt", b"b");
        put(&root, "sub/c.md", b"c");
        put(&root, &format!("{META_DIR}/metadata.json"), b"{}");
        let framed = substrate::FrameSpec::ZINNIA.frame(b"{}", b"ciphertext-here");
        put(&root, "a.md", &framed);
        let rows = list_dir(&root, &root).unwrap();
        let names: Vec<_> = rows.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["sub", "a.md", "b.txt"]);
        assert!(rows[1].sealed && !rows[2].sealed);
        assert_eq!(rows[2].size, Some(1));
    }

    #[test]
    fn reading_and_writing_stay_inside_and_never_touch_ciphertext() {
        let root = scratch("rw");
        put(&root, "a.txt", b"hello");
        assert_eq!(read_text(&root, "a.txt").unwrap(), "hello");
        write_text(&root, "a.txt", "bye").unwrap();
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"bye");
        write_text(&root, "new/never.txt", "x").unwrap_err();
        write_text(&root, "created.txt", "x").unwrap();
        assert!(root.join("created.txt").exists());

        let framed = substrate::FrameSpec::ZINNIA.frame(b"{}", b"ciphertext-here");
        put(&root, "sealed.md", &framed);
        assert!(read_text(&root, "sealed.md").unwrap_err().starts_with("locked"));
        let err = write_text(&root, "sealed.md", "plaintext").unwrap_err();
        assert!(err.starts_with("locked"), "{err}");
        assert_eq!(std::fs::read(root.join("sealed.md")).unwrap(), framed, "ciphertext untouched");

        put(&root, "bin.dat", &[0xff, 0xfe, 0x00]);
        assert!(read_text(&root, "bin.dat").unwrap_err().starts_with("not_text"));
        assert_eq!(read_bytes(&root, "bin.dat").unwrap(), vec![0xff, 0xfe, 0x00]);

        assert_eq!(relative(&root, &root.join("sub").join("x.md")), "sub/x.md");
    }

    #[test]
    fn nothing_works_without_an_open_workspace() {
        let state = WorkspaceState::new();
        assert!(state.root().unwrap_err().starts_with("no_workspace"));
        let root = scratch("state");
        *state.0.lock().unwrap() = Some(root.clone());
        assert_eq!(state.root().unwrap(), root);
    }
}
