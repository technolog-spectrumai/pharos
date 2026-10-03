//! A whole workspace as one password-protected `.zip`, and back.
//!
//! EXPORT puts every file in the workspace into a zip AS IT IS: a plain file
//! goes in plain, an encrypted file goes in still encrypted — nothing is
//! decrypted, re-encrypted or converted. The archive itself is sealed with the
//! zip format's own AES-256 (WinZip AE-2, via the `zip` crate): no cryptography
//! is invented here, and any AES-capable zip tool opens it. The walk is the
//! folder walk's — no symbolic links, nothing outside the workspace — and
//! `.morion/metadata.json` (tags, the Mana history) goes along, since it is
//! part of the workspace. No passphrase is recorded anywhere: not the
//! archive's password, and not a file's (no file ever had one stored).
//!
//! IMPORT unpacks such an archive into the open workspace. Every entry is a
//! path that has to earn its place: nothing absolute, no `..`, no symbolic
//! links, nothing inside `.morion/` but the metadata file, and nothing that
//! would land outside the workspace through a link already on disk. A file
//! that already exists is KEPT, never overwritten, and the report says so.
//! Each entry is written to a temporary beside its target and moved into
//! place only once it has been read to the end — which is when AES-256's
//! authentication code is checked — so a wrong password or a damaged archive
//! leaves nothing half-written. The metadata file is merged rather than
//! copied when the workspace has one: the imported files' tags join the tags
//! already there, and the workspace keeps its own Mana history.
//!
//! WHAT A ZIP DOES NOT HIDE. The names, sizes and dates of the files inside
//! are readable without the password — the format keeps them in the clear.
//! The page says so before an export.
//!
//! THE DIALOGS ARE OPENED HERE, in Rust, not handed a path by the page: the
//! page renders markup that arrived in files, and a command that wrote a zip
//! wherever it was told, or read one from anywhere, would be a way out of the
//! workspace for a script. The user picks the place in the native dialog.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use zip::write::SimpleFileOptions;
use zip::{AesMode, CompressionMethod, ZipArchive, ZipWriter};

use crate::folder;
use crate::meta::{self, Metadata, META_FILE};
use crate::workspace::{self, WorkspaceState, META_DIR};

/// No single entry larger than this is unpacked: a zip bomb stops here.
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Nor more than this in total.
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024 * 1024;
/// Nor more entries than this.
const MAX_ENTRIES: usize = 100_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    /// Where the archive was written.
    pub path: String,
    /// Files in it (the metadata file included).
    pub files: usize,
    /// Of those, already encrypted — they are in the archive still encrypted.
    pub sealed: usize,
    /// Bytes read from the workspace.
    pub bytes: u64,
    /// Symbolic links seen and left out.
    pub links: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Skipped {
    /// As the archive named it.
    pub path: String,
    /// A `prefix: prose` reason.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Written into the workspace, relative to its root.
    pub written: Vec<String>,
    /// Already in the workspace, and kept as they were.
    pub kept: Vec<String>,
    /// Refused, each with why.
    pub skipped: Vec<Skipped>,
    /// Files whose tags came along.
    pub tagged: usize,
}

// ── dates: zip keeps a civil date and time, the disk a timestamp ────────────
// Written and read as UTC, so a round trip through this app is exact to the
// zip format's two seconds. No calendar crate for two conversions.

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// (year, month, day) → days since 1970-01-01.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn zip_time(modified: std::time::SystemTime) -> Option<zip::DateTime> {
    let secs = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    zip::DateTime::from_date_and_time(
        u16::try_from(y).ok()?,
        mo as u8,
        d as u8,
        (rem / 3600) as u8,
        (rem % 3600 / 60) as u8,
        (rem % 60) as u8,
    )
    .ok()
}

fn system_time(dt: zip::DateTime) -> Option<std::time::SystemTime> {
    let days = days_from_civil(i64::from(dt.year()), u32::from(dt.month()), u32::from(dt.day()));
    let secs = days * 86_400 + i64::from(dt.hour()) * 3600 + i64::from(dt.minute()) * 60 + i64::from(dt.second());
    Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(u64::try_from(secs).ok()?))
}

// ── export ──────────────────────────────────────────────────────────────────

fn io(e: impl std::fmt::Display) -> String {
    format!("archive_io: {e}")
}

/// Write the whole workspace under `root` into a new archive at `dest`,
/// sealed with `password`. The archive is built beside `dest` and moved into
/// place when complete, so a failure leaves no half-written zip under the
/// chosen name.
pub fn export_to(root: &Path, dest: &Path, password: &str) -> Result<ExportReport, String> {
    if password.is_empty() {
        return Err("archive_no_password: an archive needs a password".into());
    }
    // An archive inside the workspace would be walked into itself, and would
    // then sit in the workspace as one more file.
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let parent = std::fs::canonicalize(parent).map_err(io)?;
    if parent.starts_with(root) {
        return Err("archive_inside: save the archive outside the workspace".into());
    }
    let walked = folder::walk(root);
    if walked.truncated {
        return Err("archive_too_many: the workspace has more files than one archive takes".into());
    }
    if walked.deep {
        return Err("archive_too_deep: the workspace has folders deeper than one archive takes".into());
    }
    let mut files = walked.files;
    let metadata = root.join(META_DIR).join(META_FILE);
    if metadata.is_file() && !std::fs::symlink_metadata(&metadata).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
        files.push(metadata);
    }

    let name = dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "archive.zip".into());
    let part = parent.join(format!(".{name}.part"));
    let result = (|| {
        let out = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(&part).map_err(io)?;
        let mut zip = ZipWriter::new(std::io::BufWriter::new(out));
        let mut report = ExportReport { path: parent.join(&name).to_string_lossy().into_owned(), files: 0, sealed: 0, bytes: 0, links: walked.links };
        for path in &files {
            let meta = std::fs::metadata(path).map_err(io)?;
            let mut options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .large_file(meta.len() >= u64::from(u32::MAX))
                .with_aes_encryption(AesMode::Aes256, password);
            if let Some(time) = meta.modified().ok().and_then(zip_time) {
                options = options.last_modified_time(time);
            }
            zip.start_file(workspace::relative(root, path), options).map_err(io)?;
            let mut file = std::fs::File::open(path).map_err(io)?;
            report.bytes += std::io::copy(&mut file, &mut zip).map_err(io)?;
            report.files += 1;
            if substrate::is_sealed_file(&path.to_string_lossy()) {
                report.sealed += 1;
            }
        }
        let mut out = zip.finish().map_err(io)?;
        out.flush().map_err(io)?;
        out.get_ref().sync_all().map_err(io)?;
        Ok(report)
    })();
    match result {
        Ok(report) => {
            std::fs::rename(&part, parent.join(&name)).map_err(io)?;
            Ok(report)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

// ── import ──────────────────────────────────────────────────────────────────

/// The workspace-relative path an entry may be written to, or why not.
/// `Ok(None)` is the metadata file, which is merged rather than written.
fn entry_target(name: &str) -> Result<Option<PathBuf>, String> {
    let path = Path::new(name);
    let mut rel = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(p) => rel.push(p),
            Component::CurDir => {}
            _ => return Err("outside_workspace: the archive names a path outside the workspace".into()),
        }
    }
    if rel.as_os_str().is_empty() {
        return Err("not_found: the archive names an empty path".into());
    }
    let first = rel.components().next().map(|c| c.as_os_str().to_owned());
    if first.as_deref() == Some(std::ffi::OsStr::new(META_DIR)) {
        return if rel == Path::new(META_DIR).join(META_FILE) {
            Ok(None)
        } else {
            Err("metadata: only .morion/metadata.json is taken from an archive".into())
        };
    }
    if rel.components().any(|c| c.as_os_str() == META_DIR) {
        return Err("metadata: .morion is Morion's own".into());
    }
    Ok(Some(rel))
}

/// Make the folders `rel` needs under `root`, refusing a symbolic link on the
/// way — an existing link would carry the write out of the workspace. Answers
/// the folders it created, outermost first, so a failed entry can take them
/// away again (`remove_made`).
fn prepare_parent(root: &Path, rel: &Path) -> Result<Vec<PathBuf>, String> {
    let mut here = root.to_path_buf();
    let mut made = Vec::new();
    if let Some(parent) = rel.parent() {
        for part in parent.components() {
            here.push(part);
            let step = match std::fs::symlink_metadata(&here) {
                Ok(m) if m.file_type().is_symlink() => Err("symlink: a folder on the way is a symbolic link".to_string()),
                Ok(m) if !m.is_dir() => Err("archive_blocked: a file is in the way of a folder the archive needs".to_string()),
                Ok(_) => Ok(()),
                Err(_) => std::fs::create_dir(&here).map(|()| made.push(here.clone())).map_err(io),
            };
            if let Err(e) = step {
                remove_made(&made);
                return Err(e);
            }
        }
    }
    Ok(made)
}

/// Take away folders an entry created, innermost first, as long as they are
/// still empty — a later entry may have filled one, and that one stays.
fn remove_made(made: &[PathBuf]) {
    for dir in made.iter().rev() {
        let _ = std::fs::remove_dir(dir);
    }
}

fn zip_error(e: zip::result::ZipError) -> String {
    match e {
        zip::result::ZipError::InvalidPassword => "archive_wrong_password: wrong password for this archive".into(),
        zip::result::ZipError::UnsupportedArchive(what) => format!("archive_damaged: {what}"),
        other => format!("archive_damaged: {other}"),
    }
}

/// Read one entry to the end into a temporary beside `target` and move it
/// into place. Reading to the end is what checks AES's authentication code:
/// until then nothing is where the file will be.
fn write_entry(entry: &mut impl Read, target: &Path, declared: u64, modified: Option<std::time::SystemTime>) -> Result<u64, String> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = dir.join(format!(".{name}.morion-import"));
    let result = (|| {
        let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp).map_err(io)?;
        // By hand rather than io::copy, to tell the two failures apart: a
        // READ that fails is the archive (AES's authentication code, a broken
        // deflate stream), a WRITE that fails is this disk.
        let mut buf = vec![0u8; 64 * 1024];
        let mut written: u64 = 0;
        loop {
            let n = entry.read(&mut buf).map_err(|_| "archive_damaged: an entry failed its integrity check".to_string())?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > MAX_ENTRY_BYTES {
                return Err("archive_too_large: an entry is too big to unpack here".to_string());
            }
            out.write_all(&buf[..n]).map_err(io)?;
        }
        if written != declared {
            return Err("archive_damaged: an entry is not the size the archive says".to_string());
        }
        out.sync_all().map_err(io)?;
        if let Some(time) = modified {
            let _ = out.set_modified(time);
        }
        Ok(written)
    })();
    match result {
        Ok(n) => {
            // Checked once more at the last moment: never over an existing file.
            if std::fs::symlink_metadata(target).is_ok() {
                let _ = std::fs::remove_file(&temp);
                return Err("exists".into());
            }
            std::fs::rename(&temp, target).map_err(io)?;
            Ok(n)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(e)
        }
    }
}

/// Unpack the archive at `src` into the workspace under `root`.
pub fn import_from(root: &Path, src: &Path, password: &str) -> Result<ImportReport, String> {
    let file = std::fs::File::open(src).map_err(io)?;
    let mut zip = ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("archive_damaged: that is not a zip archive ({e})"))?;
    if zip.len() > MAX_ENTRIES {
        return Err("archive_too_large: the archive holds too many files".into());
    }
    // The password is checked on the first encrypted entry, before anything
    // is written, so a wrong one changes nothing at all. Opening the entry is
    // the check: AES keeps a password verifier beside the salt. (It lets one
    // wrong password in 65,536 through; that one then fails the entry's
    // authentication code as it is read, and is reported as damage.)
    for i in 0..zip.len() {
        let encrypted = zip.by_index_raw(i).map_err(zip_error)?.encrypted();
        if encrypted {
            if password.is_empty() {
                return Err("archive_no_password: this archive needs its password".into());
            }
            zip.by_index_decrypt(i, password.as_bytes()).map_err(zip_error)?;
            break;
        }
    }

    let mut report = ImportReport { written: Vec::new(), kept: Vec::new(), skipped: Vec::new(), tagged: 0 };
    let mut total: u64 = 0;
    let mut imported_meta: Option<Metadata> = None;
    // From here on files may already have been written, so nothing returns
    // early with an error: every failure is a line in the report, which is
    // the only place the user learns what did come in.
    for i in 0..zip.len() {
        let (name, is_dir, is_link, size, encrypted) = match zip.by_index_raw(i) {
            Ok(raw) => (raw.name().to_string(), raw.is_dir(), raw.is_symlink(), raw.size(), raw.encrypted()),
            Err(e) => {
                report.skipped.push(Skipped { path: format!("#{i}"), reason: zip_error(e) });
                break;
            }
        };
        if is_dir {
            continue;
        }
        if is_link {
            report.skipped.push(Skipped { path: name, reason: "symlink: symbolic links are not unpacked".into() });
            continue;
        }
        let target = match entry_target(&name) {
            Ok(t) => t,
            Err(reason) => {
                report.skipped.push(Skipped { path: name, reason });
                continue;
            }
        };
        if size > MAX_ENTRY_BYTES || total.saturating_add(size) > MAX_TOTAL_BYTES {
            report.skipped.push(Skipped { path: name, reason: "archive_too_large: too big to unpack here".into() });
            continue;
        }
        let opened = if encrypted { zip.by_index_decrypt(i, password.as_bytes()) } else { zip.by_index(i) };
        let mut entry = match opened {
            Ok(entry) => entry,
            Err(e) => {
                // The archive's password already opened its first encrypted
                // entry, so a refusal here is this entry's own password, not
                // the archive's — and other files may already be in.
                let reason = match e {
                    zip::result::ZipError::InvalidPassword => {
                        "archive_entry_password: this file has a different password from the rest of the archive".to_string()
                    }
                    other => zip_error(other),
                };
                let damaged = reason.starts_with("archive_damaged");
                report.skipped.push(Skipped { path: name, reason });
                // Damage means the rest cannot be trusted; one entry under
                // another password says nothing about the others.
                if damaged {
                    break;
                }
                continue;
            }
        };
        let Some(rel) = target else {
            // The metadata file: read, checked, merged below — never written as it came.
            let mut bytes = Vec::new();
            let parsed = (&mut entry)
                .take(64 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .ok()
                .and_then(|_| serde_json::from_slice::<Metadata>(&bytes).ok());
            match parsed {
                Some(m) => imported_meta = Some(m),
                None => report.skipped.push(Skipped {
                    path: name,
                    reason: "archive_meta: the archive's tags and history are damaged and were left out".into(),
                }),
            }
            continue;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let dest = root.join(&rel);
        if std::fs::symlink_metadata(&dest).is_ok() {
            report.kept.push(rel_str);
            continue;
        }
        let made = match prepare_parent(root, &rel) {
            Ok(made) => made,
            Err(reason) => {
                report.skipped.push(Skipped { path: name, reason });
                continue;
            }
        };
        let modified = entry.last_modified().and_then(system_time);
        match write_entry(&mut entry, &dest, size, modified) {
            Ok(n) => {
                total += n;
                report.written.push(rel_str);
            }
            Err(e) if e == "exists" => report.kept.push(rel_str),
            // A failed check on one entry means the archive cannot be
            // trusted: stop, keeping what was already verified and written.
            Err(e) if e.starts_with("archive_damaged") => {
                remove_made(&made);
                report.skipped.push(Skipped { path: name, reason: e });
                break;
            }
            Err(reason) => {
                remove_made(&made);
                report.skipped.push(Skipped { path: name, reason });
            }
        }
    }

    // Tags come along for the files that were written; the workspace keeps
    // its own history and Mana. A workspace with no metadata yet takes the
    // archive's whole — it is the same workspace, restored.
    if let Some(theirs) = imported_meta {
        let fresh = !root.join(META_DIR).join(META_FILE).exists();
        let written: std::collections::BTreeSet<&str> = report.written.iter().map(String::as_str).collect();
        let tags: BTreeMap<String, Vec<String>> = theirs
            .tags
            .iter()
            .filter(|(path, _)| written.contains(path.as_str()))
            .filter_map(|(path, tags)| meta::normalise_tags(tags).ok().map(|t| (path.clone(), t)))
            .filter(|(_, t)| !t.is_empty())
            .collect();
        let count = tags.len();
        let merged = meta::update(root, |m| {
            if fresh {
                m.ledger = theirs.ledger.clone();
                m.mana = theirs.mana.clone();
            }
            m.tags.extend(tags);
            Ok(())
        });
        // The files are in whatever happens to the tags: a workspace whose own
        // metadata is damaged keeps them, and the report says the tags did not
        // come along rather than the import failing after the fact.
        match merged {
            Ok(()) => report.tagged = count,
            Err(reason) => report.skipped.push(Skipped { path: format!("{META_DIR}/{META_FILE}"), reason }),
        }
    }
    Ok(report)
}

// ── the commands ────────────────────────────────────────────────────────────

fn today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

fn chosen(path: tauri_plugin_dialog::FilePath) -> Result<PathBuf, String> {
    path.into_path().map_err(|_| "archive_io: the picker gave no file on this device".to_string())
}

/// Export: Rust asks where, then writes. `None` when the user cancelled.
/// `async`: a big workspace is minutes of compression, off the main thread.
#[tauri::command(async)]
pub fn archive_export(app: tauri::AppHandle, ws: tauri::State<'_, WorkspaceState>, password: String) -> Result<Option<ExportReport>, String> {
    use tauri_plugin_dialog::DialogExt;
    let root = ws.root()?;
    if password.is_empty() {
        return Err("archive_no_password: an archive needs a password".into());
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "workspace".into());
    let Some(dest) = app
        .dialog()
        .file()
        .add_filter("Zip", &["zip"])
        .set_file_name(format!("{name}-{}.zip", today()))
        .blocking_save_file()
    else {
        return Ok(None);
    };
    export_to(&root, &chosen(dest)?, &password).map(Some)
}

/// Import: Rust asks which archive, then unpacks. `None` when cancelled.
#[tauri::command(async)]
pub fn archive_import(app: tauri::AppHandle, ws: tauri::State<'_, WorkspaceState>, password: String) -> Result<Option<ImportReport>, String> {
    use tauri_plugin_dialog::DialogExt;
    let root = ws.root()?;
    let Some(src) = app.dialog().file().add_filter("Zip", &["zip"]).blocking_pick_file() else {
        return Ok(None);
    };
    // An archive may sit anywhere, the workspace included: it is only read.
    import_from(&root, &chosen(src)?, &password).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::tests::{put, scratch};
    use crate::LOCKER;

    fn outside(name: &str) -> PathBuf {
        let dir = scratch(&format!("{name}-out"));
        dir.join("backup.zip")
    }

    #[test]
    fn dates_survive_the_round_trip_through_the_zip_calendar() {
        // The zip calendar starts in 1980; an older file simply goes without a date.
        assert!(zip_time(std::time::UNIX_EPOCH).is_none());
        for secs in [315_532_800u64, 951_782_400, 1_700_000_000, 4_102_444_798] {
            let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
            let back = system_time(zip_time(t).unwrap()).unwrap();
            let delta = t.duration_since(back).unwrap_or_else(|e| e.duration());
            assert!(delta.as_secs() <= 2, "{secs}: {delta:?}");
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(days_from_civil(2024, 3, 1), civil_days(2024, 3, 1));
    }

    fn civil_days(y: i64, m: u32, d: u32) -> i64 {
        (0..40_000).find(|&n| civil_from_days(n) == (y, m, d)).unwrap()
    }

    #[test]
    fn everything_goes_out_as_it_is_and_comes_back_into_an_empty_workspace() {
        let root = scratch("archive-src");
        put(&root, "notes/a.md", b"plain words");
        put(&root, "notes/deep/b.txt", b"deeper");
        put(&root, "secret.md", b"hidden words");
        LOCKER.lock_file(&root.join("secret.md").to_string_lossy(), Some("filepw".into())).unwrap();
        let sealed_bytes = std::fs::read(root.join("secret.md")).unwrap();
        meta::set_tags(&root, "notes/a.md", &["work".into()]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", root.join("link")).unwrap();

        let dest = outside("archive-src");
        let report = export_to(&root, &dest, "zip-pw").unwrap();
        assert_eq!((report.files, report.sealed), (4, 1), "three files and the metadata");
        #[cfg(unix)]
        assert_eq!(report.links, 1);
        assert!(dest.is_file());
        assert!(!dest.with_file_name(".backup.zip.part").exists(), "no temporary left");
        // Nothing readable in the archive's bytes: the bodies are AES-sealed,
        // and no passphrase is in it.
        let raw = std::fs::read(&dest).unwrap();
        for needle in [&b"plain words"[..], b"deeper", b"zip-pw", b"filepw", b"work"] {
            assert!(!raw.windows(needle.len()).any(|w| w == needle), "{:?} in the archive", String::from_utf8_lossy(needle));
        }

        let into = scratch("archive-dst");
        let back = import_from(&into, &dest, "zip-pw").unwrap();
        let mut written = back.written.clone();
        written.sort();
        assert_eq!(written, ["notes/a.md", "notes/deep/b.txt", "secret.md"]);
        assert!(back.kept.is_empty() && back.skipped.is_empty(), "{back:?}");
        assert_eq!(std::fs::read(into.join("notes/a.md")).unwrap(), b"plain words");
        assert_eq!(std::fs::read(into.join("secret.md")).unwrap(), sealed_bytes, "still encrypted, byte for byte");
        let (_, plain) = LOCKER.open_sealed(&into.join("secret.md").to_string_lossy(), Some("filepw".into())).unwrap();
        assert_eq!(plain, b"hidden words");
        assert_eq!(meta::tags_of(&into, "notes/a.md").unwrap(), ["work"]);
        assert_eq!(back.tagged, 1);
        // Dates came along.
        let a = std::fs::metadata(root.join("notes/a.md")).unwrap().modified().unwrap();
        let b = std::fs::metadata(into.join("notes/a.md")).unwrap().modified().unwrap();
        assert!(a.duration_since(b).unwrap_or_else(|e| e.duration()).as_secs() <= 2);
        assert!(!into.join("link").exists());
    }

    #[test]
    fn a_wrong_password_writes_nothing_and_an_existing_file_is_kept() {
        let root = scratch("archive-pw");
        put(&root, "a.md", b"from the archive");
        put(&root, "b.md", b"b");
        let dest = outside("archive-pw");
        export_to(&root, &dest, "right").unwrap();

        let into = scratch("archive-pw-dst");
        put(&into, "a.md", b"mine, already here");
        let err = import_from(&into, &dest, "wrong").unwrap_err();
        assert!(err.starts_with("archive_wrong_password"), "{err}");
        assert!(import_from(&into, &dest, "").unwrap_err().starts_with("archive_no_password"));
        assert!(!into.join("b.md").exists(), "nothing written on a wrong password");

        let back = import_from(&into, &dest, "right").unwrap();
        assert_eq!(back.written, ["b.md"]);
        assert_eq!(back.kept, ["a.md"]);
        assert_eq!(std::fs::read(into.join("a.md")).unwrap(), b"mine, already here", "never overwritten");
        let leftovers: Vec<_> = std::fs::read_dir(&into).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("morion-import")).collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn an_archive_is_not_written_into_the_workspace_it_holds() {
        let root = scratch("archive-inside");
        put(&root, "a.md", b"a");
        let err = export_to(&root, &root.join("backup.zip"), "pw").unwrap_err();
        assert!(err.starts_with("archive_inside"), "{err}");
        assert!(export_to(&root, &outside("archive-inside"), "").unwrap_err().starts_with("archive_no_password"));
    }

    /// A hand-made archive with every kind of hostile name in it.
    #[test]
    fn hostile_entries_are_refused_one_by_one_and_the_rest_come_in() {
        let into = scratch("archive-hostile");
        let evil_dir = scratch("archive-hostile-elsewhere");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&evil_dir, into.join("linked")).unwrap();
        let src = outside("archive-hostile");
        {
            let mut zip = ZipWriter::new(std::fs::File::create(&src).unwrap());
            let opts = SimpleFileOptions::default();
            for name in ["../escape.md", "/abs.md", ".morion/other.json", "d/.morion/x", "linked/through.md", "fine/ok.md"] {
                zip.start_file(name, opts).unwrap();
                zip.write_all(b"x").unwrap();
            }
            zip.add_symlink("link.md", "/etc/passwd", opts).unwrap();
            zip.start_file(".morion/metadata.json", opts).unwrap();
            zip.write_all(br#"{"version":1,"tags":{"fine/ok.md":["t"],"not-written.md":["u"]},"ledger":[]}"#).unwrap();
            zip.finish().unwrap();
        }
        // An unencrypted zip needs no password.
        let back = import_from(&into, &src, "").unwrap();
        assert_eq!(back.written, ["fine/ok.md"]);
        let reasons: BTreeMap<String, String> = back.skipped.iter().map(|s| (s.path.clone(), s.reason.clone())).collect();
        assert!(reasons["../escape.md"].starts_with("outside_workspace"));
        assert!(reasons["/abs.md"].starts_with("outside_workspace"));
        assert!(reasons[".morion/other.json"].starts_with("metadata"));
        assert!(reasons["d/.morion/x"].starts_with("metadata"));
        assert!(reasons["link.md"].starts_with("symlink"));
        #[cfg(unix)]
        assert!(reasons["linked/through.md"].starts_with("symlink"));
        assert!(!into.parent().unwrap().join("escape.md").exists());
        assert_eq!(std::fs::read_dir(&evil_dir).unwrap().count(), 0, "nothing went through the link");
        // Only the written file's tags came along.
        let tags = meta::all_tags(&into).unwrap();
        assert_eq!(tags.keys().collect::<Vec<_>>(), ["fine/ok.md"]);
    }

    #[test]
    fn an_existing_workspace_keeps_its_own_history_and_gains_the_tags() {
        let root = scratch("archive-merge-src");
        put(&root, "a.md", b"a");
        meta::set_tags(&root, "a.md", &["theirs".into()]).unwrap();
        crate::mana::record(&root, 1, "encrypt_file", None).unwrap();
        let dest = outside("archive-merge");
        export_to(&root, &dest, "pw").unwrap();

        let into = scratch("archive-merge-dst");
        put(&into, "mine.md", b"m");
        meta::set_tags(&into, "mine.md", &["mine".into()]).unwrap();
        crate::mana::record(&into, 2, "decrypt_file", None).unwrap();
        import_from(&into, &dest, "pw").unwrap();
        let m = meta::load(&into).unwrap();
        assert_eq!(m.tags.get("mine.md").unwrap(), &vec!["mine".to_string()]);
        assert_eq!(m.tags.get("a.md").unwrap(), &vec!["theirs".to_string()]);
        assert_eq!(m.ledger.len(), 1);
        assert_eq!(m.ledger[0].action, "decrypt_file", "the workspace's own history");
    }

    /// One flipped byte in the body: the entry fails its check, nothing of it
    /// is left behind, and the import stops rather than trusting the rest.
    #[test]
    fn a_tampered_archive_is_refused_without_leaving_half_a_file() {
        let root = scratch("archive-tamper");
        // Incompressible, so the middle of the archive is the entry's body.
        let mut x: u32 = 1;
        let noise: Vec<u8> = (0..256 * 1024).map(|_| { x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223); (x >> 24) as u8 }).collect();
        put(&root, "big.bin", &noise);
        let dest = outside("archive-tamper");
        export_to(&root, &dest, "pw").unwrap();
        let mut bytes = std::fs::read(&dest).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0x40;
        std::fs::write(&dest, &bytes).unwrap();

        let into = scratch("archive-tamper-dst");
        let back = import_from(&into, &dest, "pw").unwrap();
        assert!(back.written.is_empty(), "{back:?}");
        assert!(back.skipped[0].reason.starts_with("archive_damaged"), "{back:?}");
        let left: Vec<_> = std::fs::read_dir(&into).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(left.is_empty(), "nothing written, no temporary: {left:?}");
    }

    /// Files already written must never be reported as a failed import: a
    /// workspace whose own metadata is damaged still gets the files, and the
    /// report says the tags did not come along.
    #[test]
    fn a_damaged_workspace_metadata_file_does_not_undo_the_report() {
        let root = scratch("archive-meta-src");
        put(&root, "a.md", b"a");
        meta::set_tags(&root, "a.md", &["t".into()]).unwrap();
        let dest = outside("archive-meta");
        export_to(&root, &dest, "pw").unwrap();

        let into = scratch("archive-meta-dst");
        put(&into, ".morion/metadata.json", b"{broken");
        let back = import_from(&into, &dest, "pw").unwrap();
        assert_eq!(back.written, ["a.md"]);
        assert_eq!(back.tagged, 0);
        assert!(back.skipped.iter().any(|s| s.path == ".morion/metadata.json" && s.reason.starts_with("meta_damaged")), "{back:?}");
        assert_eq!(std::fs::read(into.join(".morion/metadata.json")).unwrap(), b"{broken", "left as it was");
    }

    #[test]
    fn a_refused_entry_leaves_no_empty_folders_and_a_blocking_file_is_named() {
        let into = scratch("archive-folders");
        put(&into, "blocked", b"a file where a folder would go");
        let src = outside("archive-folders");
        {
            let mut zip = ZipWriter::new(std::fs::File::create(&src).unwrap());
            let opts = SimpleFileOptions::default();
            zip.start_file("blocked/inside.md", opts).unwrap();
            zip.write_all(b"x").unwrap();
            zip.start_file(".morion/metadata.json", opts).unwrap();
            zip.write_all(b"not json").unwrap();
            zip.finish().unwrap();
        }
        let back = import_from(&into, &src, "").unwrap();
        let reasons: BTreeMap<String, String> = back.skipped.iter().map(|s| (s.path.clone(), s.reason.clone())).collect();
        assert!(reasons["blocked/inside.md"].starts_with("archive_blocked"), "{back:?}");
        assert!(reasons[".morion/metadata.json"].starts_with("archive_meta"), "{back:?}");

        // A damaged entry deep in new folders takes its folders with it.
        let root = scratch("archive-folders-src");
        let mut x: u32 = 7;
        let noise: Vec<u8> = (0..256 * 1024).map(|_| { x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223); (x >> 24) as u8 }).collect();
        put(&root, "deep/er/still/noise.bin", &noise);
        let dest = outside("archive-folders-tamper");
        export_to(&root, &dest, "pw").unwrap();
        let mut bytes = std::fs::read(&dest).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0x40;
        std::fs::write(&dest, &bytes).unwrap();
        let clean = scratch("archive-folders-clean");
        let back = import_from(&clean, &dest, "pw").unwrap();
        assert!(back.written.is_empty());
        assert!(!clean.join("deep").exists(), "no empty folders left behind");
    }

    #[test]
    fn a_workspace_deeper_than_the_walk_is_not_exported_as_if_whole() {
        let root = scratch("archive-deep");
        let deep: String = (0..40).map(|i| format!("d{i}/")).collect();
        put(&root, &format!("{deep}bottom.md"), b"far down");
        let err = export_to(&root, &outside("archive-deep"), "pw").unwrap_err();
        assert!(err.starts_with("archive_too_deep"), "{err}");
        let preview = folder::preview(&root, "").unwrap();
        assert!(preview.deep && !preview.truncated, "said apart from the file cap");
    }

    #[test]
    fn an_entry_under_another_password_is_skipped_and_the_rest_come_in() {
        let into = scratch("archive-two-pw");
        let src = outside("archive-two-pw");
        {
            let mut zip = ZipWriter::new(std::fs::File::create(&src).unwrap());
            let first = SimpleFileOptions::default().with_aes_encryption(AesMode::Aes256, "one");
            let second = SimpleFileOptions::default().with_aes_encryption(AesMode::Aes256, "two");
            zip.start_file("a.md", first).unwrap();
            zip.write_all(b"a").unwrap();
            zip.start_file("b.md", second).unwrap();
            zip.write_all(b"b").unwrap();
            zip.finish().unwrap();
        }
        let back = import_from(&into, &src, "one").unwrap();
        assert_eq!(back.written, ["a.md"]);
        assert!(back.skipped[0].reason.starts_with("archive_entry_password"), "{back:?}");
    }

    #[test]
    fn not_a_zip_is_said_plainly() {
        let into = scratch("archive-junk");
        let src = outside("archive-junk");
        std::fs::write(&src, b"this is not a zip").unwrap();
        assert!(import_from(&into, &src, "pw").unwrap_err().starts_with("archive_damaged"));
    }
}
