//! Key ring — ONE passphrase locks/unlocks MANY local files.
//!
//! Where local_lock.rs makes each locked file a self-contained vault under its
//! own passphrase, the key ring keeps a per-profile ring file whose single
//! passphrase covers every file added to it: each file is sealed under its own
//! random DEK (gervasius XChaCha20-Poly1305, never the passphrase directly),
//! and the DEKs live in an entry table sealed inside the ring. The whole entry
//! table — including paths, which are sensitive — is ciphertext; only the ring
//! vault header (salt + wrapped ring key) and an advisory entry count are in
//! the clear, because they reveal nothing without the passphrase.
//!
//! Ring file `<profile_dir>/keyring.enig`:
//! ```text
//!   MAGIC(8 "ENIGRING") || VERSION(1) || header_len(u32 LE) || header(JSON)
//!     || sealed
//! ```
//! where `header` is the gervasius `VaultHeader` (version, kdf params, salt,
//! wrapped ring key) plus `entry_count`, and `sealed = nonce(24) || ct+tag`
//! over the JSON entry table `{entries: {entryId: {dekHex, path, name, size,
//! lockedAt}}}` under the ring key.
//!
//! Locked file (`<original>.enigr`):
//! ```text
//!   MAGIC(8 "ENIGRLK1") || VERSION(1) || entry_id_len(u16 LE) || entry_id
//!     || sealed
//! ```
//! sealed with that entry's DEK. Locking writes the frame to a sibling temp
//! file, fsyncs, renames to `<original>.enigr`, and only then removes the
//! original (mirroring local_lock's in-place safety); unlocking restores the
//! original filename the same way and then drops the entry from the ring.
//!
//! DEVICE-LOCAL BY DESIGN: the ring file (and everything about it) must never
//! enter `device_link::DEVLINK_SYNC_KV` or any other sync path — its entries
//! reference absolute local paths and hold raw file keys.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use gervasius::{create_vault_with_params, open, rewrap, seal, unlock, CryptoError, Dek, VaultHeader};
use iroh::SecretKey;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ── constants / gates ─────────────────────────────────────────────────────────

/// Returned by every keyring command in a build with keyring.enabled: false.
pub(crate) const KEYRING_DISABLED: &str = "Key ring is disabled in this build.";

/// Marks the ring file.
const RING_MAGIC: &[u8; 8] = b"ENIGRING";
const RING_VERSION: u8 = 1;
/// Marks a keyring-locked file (version is part of the magic string's intent;
/// the explicit version byte still follows for future evolution).
const FILE_MAGIC: &[u8; 8] = b"ENIGRLK1";
const FILE_VERSION: u8 = 1;
/// AEAD associated data for the sealed entry table.
const RING_AAD: &[u8] = b"enigma:keyring:ring:v1";
/// AEAD associated data for locked file bodies — constant (not the filename),
/// so a locked file can be renamed or moved without breaking decryption.
const FILE_AAD: &[u8] = b"enigma:keyring:file:v1";
/// Appended to the original filename when a file is locked.
const LOCKED_EXT: &str = ".enigr";
/// Ring filename inside the profile dir.
/// Pre-multi-ring layout: one ring at `<profile>/keyring.enig`. Still read (and
/// still writable) so an existing ring keeps working; it is listed under the id
/// `default`. New rings live in `<profile>/keyrings/<id>.enig`.
const RING_FILE: &str = "keyring.enig";
const RING_DIR: &str = "keyrings";
const DEFAULT_RING_ID: &str = "default";

fn ensure_keyring_enabled() -> Result<(), String> {
    if !crate::build_config::keyring::ENABLED {
        return Err(KEYRING_DISABLED.to_string());
    }
    Ok(())
}

// ── public result types ───────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyringStatus {
    pub exists: bool,
    pub entry_count: u32,
    /// The ring's user-chosen label ("" for rings created before names).
    pub name: String,
}

/// One per-file outcome of a lock/unlock. `status` is `"locked"`,
/// `"already-locked"`, `"unlocked"` or `"failed"`; `new_path` is set on
/// success (the `.enigr` path after a lock, the restored path after an
/// unlock); `error` is set when `status == "failed"`.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyringFileOutcome {
    pub path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One remembered file, decrypted out of the ring for the UI list.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyringEntryInfo {
    /// The ORIGINAL path (without `.enigr`).
    pub path: String,
    pub name: String,
    /// Plaintext byte length at lock time.
    pub size: u64,
    /// Epoch millis when it was locked.
    pub locked_at: u64,
    /// Whether the locked `.enigr` file is still on disk.
    pub present: bool,
}

// ── ring file format ──────────────────────────────────────────────────────────

/// The clear part of the ring file: the gervasius vault header plus an
/// advisory (unauthenticated) entry count so `keyring_status` needs no
/// passphrase. Everything else is sealed.
#[derive(Serialize, Deserialize, Clone)]
struct RingHeader {
    #[serde(flatten)]
    vault: VaultHeader,
    entry_count: u32,
    /// User-chosen ring label. Plaintext like `entry_count` — it names the
    /// ring, never its contents. Defaulted so pre-name rings keep loading.
    #[serde(default)]
    name: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct RingEntry {
    /// The file's random 32-byte DEK, lowercase hex. Sensitive — only ever
    /// serialized into the sealed payload.
    #[serde(rename = "dekHex")]
    dek_hex: String,
    /// Present only inside a rotation window: the pre-rotation DEK, kept until
    /// the file on disk is confirmed re-sealed. Lets a crash mid-rotate strand
    /// nothing — whichever DEK the file was actually sealed with still opens
    /// it (see `entry_open`). Dropped by the final rewrite.
    #[serde(rename = "oldDekHex", default, skip_serializing_if = "Option::is_none")]
    old_dek_hex: Option<String>,
    /// Original path (without `.enigr`).
    path: String,
    name: String,
    size: u64,
    #[serde(rename = "lockedAt")]
    locked_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct RingTable {
    entries: BTreeMap<String, RingEntry>,
}

fn crypto_err(e: CryptoError) -> String {
    match e {
        CryptoError::Aead => "wrong passphrase or corrupt data".to_string(),
        other => other.to_string(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

fn random_bytes32() -> [u8; 32] {
    // iroh's key generation is the vetted entropy source already linked in
    // (same idiom as device_link.rs).
    SecretKey::generate().to_bytes()
}

fn new_entry_id() -> String {
    data_encoding::HEXLOWER.encode(&random_bytes32()[..16])
}

/// Write `bytes` to a sibling temp file, fsync, then rename into place. The
/// temp file only ever holds the same bytes the final file does; best-effort
/// cleanup if the rename fails.
fn write_fsync_rename(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = PathBuf::from(format!("{}.enigr.tmp", path.display()));
    let write = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Parse a ring file into its header and the sealed entry table (borrowed).
fn parse_ring_frame(bytes: &[u8]) -> Result<(RingHeader, &[u8]), String> {
    let head = RING_MAGIC.len() + 1 + 4;
    if bytes.len() < head || &bytes[..RING_MAGIC.len()] != RING_MAGIC {
        return Err("not a key ring file".to_string());
    }
    if bytes[RING_MAGIC.len()] != RING_VERSION {
        return Err("unsupported key ring version".to_string());
    }
    let hl_off = RING_MAGIC.len() + 1;
    let header_len =
        u32::from_le_bytes([bytes[hl_off], bytes[hl_off + 1], bytes[hl_off + 2], bytes[hl_off + 3]])
            as usize;
    let header_end = head + header_len;
    if bytes.len() < header_end {
        return Err("key ring file is truncated".to_string());
    }
    let header: RingHeader =
        serde_json::from_slice(&bytes[head..header_end]).map_err(|e| e.to_string())?;
    Ok((header, &bytes[header_end..]))
}

fn build_ring_frame(header: &RingHeader, sealed: &[u8]) -> Result<Vec<u8>, String> {
    let header_json = serde_json::to_vec(header).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(RING_MAGIC.len() + 1 + 4 + header_json.len() + sealed.len());
    out.extend_from_slice(RING_MAGIC);
    out.push(RING_VERSION);
    out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_json);
    out.extend_from_slice(sealed);
    Ok(out)
}

/// Open the ring under `passphrase`: header + live ring key + entry table.
fn read_ring(ring: &Path, passphrase: &str) -> Result<(RingHeader, Dek, RingTable), String> {
    let bytes = std::fs::read(ring).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "no key ring exists yet".to_string(),
        _ => e.to_string(),
    })?;
    let (header, sealed) = parse_ring_frame(&bytes)?;
    let dek = unlock(&header.vault, passphrase).map_err(crypto_err)?;
    let plain = open(&dek, RING_AAD, sealed).map_err(crypto_err)?;
    let table: RingTable = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
    Ok((header, dek, table))
}

/// Seal `table` under the ring key and write the frame atomically. Refreshes
/// the clear entry count.
fn write_ring(ring: &Path, header: &RingHeader, dek: &Dek, table: &RingTable) -> Result<(), String> {
    let plain = serde_json::to_vec(table).map_err(|e| e.to_string())?;
    let sealed = seal(dek, RING_AAD, &plain).map_err(crypto_err)?;
    let header = RingHeader {
        vault: header.vault.clone(),
        entry_count: table.entries.len() as u32,
        name: header.name.clone(),
    };
    write_fsync_rename(ring, &build_ring_frame(&header, &sealed)?)
}

// ── locked file format ────────────────────────────────────────────────────────

fn has_file_magic(bytes: &[u8]) -> bool {
    bytes.len() >= FILE_MAGIC.len() && &bytes[..FILE_MAGIC.len()] == FILE_MAGIC
}

/// Parse a locked-file frame into its entry id and the sealed body (borrowed).
fn parse_file_frame(bytes: &[u8]) -> Result<(String, &[u8]), String> {
    let head = FILE_MAGIC.len() + 1 + 2;
    if !has_file_magic(bytes) || bytes.len() < head {
        return Err("not a keyring-locked file".to_string());
    }
    if bytes[FILE_MAGIC.len()] != FILE_VERSION {
        return Err("unsupported locked-file version".to_string());
    }
    let il_off = FILE_MAGIC.len() + 1;
    let id_len = u16::from_le_bytes([bytes[il_off], bytes[il_off + 1]]) as usize;
    let id_end = head + id_len;
    if bytes.len() < id_end {
        return Err("locked file is truncated".to_string());
    }
    let entry_id = std::str::from_utf8(&bytes[head..id_end])
        .map_err(|_| "malformed entry id".to_string())?
        .to_string();
    Ok((entry_id, &bytes[id_end..]))
}

fn build_file_frame(entry_id: &str, sealed: &[u8]) -> Result<Vec<u8>, String> {
    let id = entry_id.as_bytes();
    if id.len() > u16::MAX as usize {
        return Err("entry id too long".to_string());
    }
    let mut out = Vec::with_capacity(FILE_MAGIC.len() + 1 + 2 + id.len() + sealed.len());
    out.extend_from_slice(FILE_MAGIC);
    out.push(FILE_VERSION);
    out.extend_from_slice(&(id.len() as u16).to_le_bytes());
    out.extend_from_slice(id);
    out.extend_from_slice(sealed);
    Ok(out)
}

fn dek_from_hex(hex: &str) -> Result<Dek, String> {
    let bytes = data_encoding::HEXLOWER
        .decode(hex.as_bytes())
        .map_err(|_| "corrupt ring entry key".to_string())?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| "corrupt ring entry key".to_string())?;
    Ok(Dek::from_bytes(arr))
}

fn locked_path_for(original: &str) -> String {
    format!("{original}{LOCKED_EXT}")
}

// ── core operations (path-parameterized so the inline tests need no Tauri) ────

fn status_at(ring: &Path) -> Result<KeyringStatus, String> {
    let bytes = match std::fs::read(ring) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(KeyringStatus { exists: false, entry_count: 0, name: String::new() })
        }
        Err(e) => return Err(e.to_string()),
    };
    let (header, _) = parse_ring_frame(&bytes)?;
    Ok(KeyringStatus { exists: true, entry_count: header.entry_count, name: header.name })
}

/// Ring names are labels, not paths: trimmed, control chars out, bounded.
fn sanitize_ring_name(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect()
}

fn init_at(ring: &Path, passphrase: &str, name: &str) -> Result<(), String> {
    if ring.exists() {
        return Err("a key ring already exists".to_string());
    }
    let (vault, dek) =
        create_vault_with_params(passphrase, crate::kdf_params()).map_err(crypto_err)?;
    let header = RingHeader { vault, entry_count: 0, name: sanitize_ring_name(name) };
    write_ring(ring, &header, &dek, &RingTable::default())
}

fn failed(path: &str, error: String) -> KeyringFileOutcome {
    KeyringFileOutcome { path: path.to_string(), status: "failed".into(), new_path: None, error: Some(error) }
}

fn lock_at(ring: &Path, passphrase: &str, paths: &[String]) -> Result<Vec<KeyringFileOutcome>, String> {
    // Verify the passphrase against the ring FIRST — nothing touches disk on a
    // wrong passphrase.
    let (header, dek, mut table) = read_ring(ring, passphrase)?;

    // Phase 1: classify every path and mint entries for the lockable ones. The
    // ring is re-sealed with the new entries BEFORE any file is sealed, so a
    // sealed file whose DEK was never persisted cannot exist.
    struct Candidate {
        path: String,
        entry_id: String,
        plain: Vec<u8>,
    }
    let mut outcomes: Vec<KeyringFileOutcome> = Vec::with_capacity(paths.len());
    let mut candidates: Vec<Candidate> = Vec::new();
    for path in paths {
        let plain = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                outcomes.push(failed(path, e.to_string()));
                continue;
            }
        };
        if has_file_magic(&plain) || path.ends_with(LOCKED_EXT) {
            outcomes.push(KeyringFileOutcome {
                path: path.clone(),
                status: "already-locked".into(),
                new_path: None,
                error: None,
            });
            continue;
        }
        let new_path = locked_path_for(path);
        if Path::new(&new_path).exists() {
            outcomes.push(failed(path, format!("{new_path} already exists")));
            continue;
        }
        let entry_id = new_entry_id();
        table.entries.insert(
            entry_id.clone(),
            RingEntry {
                dek_hex: data_encoding::HEXLOWER.encode(&random_bytes32()),
                old_dek_hex: None,
                path: path.clone(),
                name: file_name(path),
                size: plain.len() as u64,
                locked_at: now_ms(),
            },
        );
        candidates.push(Candidate { path: path.clone(), entry_id, plain });
    }
    if !candidates.is_empty() {
        write_ring(ring, &header, &dek, &table)?;
    }

    // Phase 2: seal each candidate to <path>.enigr (temp + fsync + rename),
    // then remove the original. A failure drops its now-orphaned entry again.
    let mut dirty = false;
    for c in candidates {
        let result = (|| -> Result<String, String> {
            let file_dek = dek_from_hex(&table.entries[&c.entry_id].dek_hex)?;
            let sealed = seal(&file_dek, FILE_AAD, &c.plain).map_err(crypto_err)?;
            let frame = build_file_frame(&c.entry_id, &sealed)?;
            let new_path = locked_path_for(&c.path);
            write_fsync_rename(Path::new(&new_path), &frame)?;
            std::fs::remove_file(&c.path).map_err(|e| e.to_string())?;
            Ok(new_path)
        })();
        match result {
            Ok(new_path) => outcomes.push(KeyringFileOutcome {
                path: c.path,
                status: "locked".into(),
                new_path: Some(new_path),
                error: None,
            }),
            Err(e) => {
                table.entries.remove(&c.entry_id);
                dirty = true;
                outcomes.push(failed(&c.path, e));
            }
        }
    }
    if dirty {
        write_ring(ring, &header, &dek, &table)?;
    }
    Ok(outcomes)
}

fn unlock_at(
    ring: &Path,
    passphrase: &str,
    paths: &[String],
) -> Result<Vec<KeyringFileOutcome>, String> {
    let (header, dek, mut table) = read_ring(ring, passphrase)?;

    let mut outcomes: Vec<KeyringFileOutcome> = Vec::with_capacity(paths.len());
    let mut dirty = false;
    for path in paths {
        let result = (|| -> Result<(String, String), String> {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let (entry_id, sealed) = parse_file_frame(&bytes)?;
            let entry =
                table.entries.get(&entry_id).ok_or_else(|| "no ring entry for this file".to_string())?;
            let plain = entry_open(entry, sealed)?;
            // Restore next to the locked file (the user may have moved it);
            // fall back to the recorded original path.
            let dest = path
                .strip_suffix(LOCKED_EXT)
                .map(str::to_string)
                .unwrap_or_else(|| entry.path.clone());
            write_fsync_rename(Path::new(&dest), &plain)?;
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            Ok((entry_id, dest))
        })();
        match result {
            Ok((entry_id, dest)) => {
                table.entries.remove(&entry_id);
                dirty = true;
                outcomes.push(KeyringFileOutcome {
                    path: path.clone(),
                    status: "unlocked".into(),
                    new_path: Some(dest),
                    error: None,
                });
            }
            Err(e) => outcomes.push(failed(path, e)),
        }
    }
    if dirty {
        write_ring(ring, &header, &dek, &table)?;
    }
    Ok(outcomes)
}

fn unlock_all_at(ring: &Path, passphrase: &str) -> Result<Vec<KeyringFileOutcome>, String> {
    let (_, _, table) = read_ring(ring, passphrase)?;
    let paths: Vec<String> = table
        .entries
        .values()
        .map(|e| locked_path_for(&e.path))
        .filter(|p| Path::new(p).exists())
        .collect();
    unlock_at(ring, passphrase, &paths)
}

fn entries_at(ring: &Path, passphrase: &str) -> Result<Vec<KeyringEntryInfo>, String> {
    let (_, _, table) = read_ring(ring, passphrase)?;
    let mut list: Vec<KeyringEntryInfo> = table
        .entries
        .values()
        .map(|e| KeyringEntryInfo {
            path: e.path.clone(),
            name: e.name.clone(),
            size: e.size,
            locked_at: e.locked_at,
            present: Path::new(&locked_path_for(&e.path)).exists(),
        })
        .collect();
    list.sort_by(|a, b| a.locked_at.cmp(&b.locked_at).then_with(|| a.path.cmp(&b.path)));
    Ok(list)
}

/// Re-wrap the ring key under `new` (gervasius `rewrap`: fresh salt, same
/// key), leaving the sealed entry table byte-identical — every locked file
/// stays openable and no file is re-encrypted.
/// Open a sealed file payload with the entry's DEK, falling back to the
/// rotation-window DEK when one is present (the file may not have been
/// re-sealed yet when the rotate was interrupted).
fn entry_open(entry: &RingEntry, sealed: &[u8]) -> Result<Vec<u8>, String> {
    let dek = dek_from_hex(&entry.dek_hex)?;
    if let Ok(plain) = open(&dek, FILE_AAD, sealed) {
        return Ok(plain);
    }
    if let Some(old_hex) = &entry.old_dek_hex {
        let old_dek = dek_from_hex(old_hex)?;
        if let Ok(plain) = open(&old_dek, FILE_AAD, sealed) {
            return Ok(plain);
        }
    }
    Err("corrupt file (or a key from a different ring)".to_string())
}

/// Full rotation: fresh ring key material under the NEW passphrase and a fresh
/// DEK for every locked file, which is re-sealed on disk. Crash-safe by
/// carrying both DEKs through the window:
///   1. the ring is rewritten first — new passphrase, new DEKs, old DEKs kept
///      as `old_dek_hex` fallbacks (files on disk still carry the old seal);
///   2. each present file is unsealed (fallback-aware) and re-sealed in place
///      under its new DEK;
///   3. the fallbacks are dropped in one final rewrite.
/// An interruption anywhere leaves every file openable: the ring knows both
/// keys until the file's re-seal is confirmed. Files missing from disk keep
/// their old DEK verbatim (re-sealing bytes we cannot read is impossible) and
/// report "missing".
fn rotate_at(ring: &Path, old: &str, new: &str) -> Result<Vec<KeyringFileOutcome>, String> {
    let (old_header, _, table) = read_ring(ring, old)?; // verifies the old passphrase

    // Fresh vault: new salt, new KDF run, new ring DEK — under the new passphrase.
    let (vault, ring_dek) =
        create_vault_with_params(new, crate::kdf_params()).map_err(crypto_err)?;
    let header =
        RingHeader { vault, entry_count: table.entries.len() as u32, name: old_header.name };

    // Phase 1: new DEKs for every entry whose file is on disk, old DEK kept as
    // the fallback. Persisted BEFORE any file changes.
    let mut next = RingTable::default();
    let mut missing: Vec<String> = Vec::new();
    for (id, entry) in &table.entries {
        let locked = locked_path_for(&entry.path);
        let on_disk = Path::new(&locked).is_file();
        let mut rotated = entry.clone();
        if on_disk {
            rotated.old_dek_hex = Some(rotated.dek_hex.clone());
            rotated.dek_hex = data_encoding::HEXLOWER.encode(&random_bytes32());
        } else {
            missing.push(entry.path.clone());
        }
        next.entries.insert(id.clone(), rotated);
    }
    write_ring(ring, &header, &ring_dek, &next)?;

    // Phase 2: re-seal each present file under its new DEK.
    let mut outcomes: Vec<KeyringFileOutcome> = missing
        .iter()
        .map(|path| KeyringFileOutcome {
            path: path.clone(),
            status: "missing".into(),
            new_path: None,
            error: None,
        })
        .collect();
    let ids: Vec<String> = next.entries.keys().cloned().collect();
    for id in ids {
        let entry = next.entries[&id].clone();
        let Some(old_hex) = entry.old_dek_hex.clone() else { continue };
        let locked = locked_path_for(&entry.path);
        let result = (|| -> Result<(), String> {
            let bytes = std::fs::read(&locked).map_err(|e| e.to_string())?;
            let (frame_id, sealed) = parse_file_frame(&bytes)?;
            if frame_id != id {
                return Err("file belongs to a different ring entry".to_string());
            }
            let old_dek = dek_from_hex(&old_hex)?;
            let plain = open(&old_dek, FILE_AAD, sealed)
                .map_err(|_| "corrupt file (or a key from a different ring)".to_string())?;
            let new_dek = dek_from_hex(&entry.dek_hex)?;
            let resealed = seal(&new_dek, FILE_AAD, &plain).map_err(crypto_err)?;
            write_fsync_rename(Path::new(&locked), &build_file_frame(&id, &resealed)?)
        })();
        match result {
            Ok(()) => {
                // Re-seal confirmed on disk — the fallback has done its job.
                next.entries.get_mut(&id).unwrap().old_dek_hex = None;
                outcomes.push(KeyringFileOutcome {
                    path: entry.path.clone(),
                    status: "rotated".into(),
                    new_path: Some(locked),
                    error: None,
                });
            }
            Err(e) => {
                // The file was never re-sealed: keep the OLD DEK as primary so
                // the entry matches what is actually on disk, no fallback left.
                let slot = next.entries.get_mut(&id).unwrap();
                slot.dek_hex = old_hex;
                slot.old_dek_hex = None;
                outcomes.push(failed(&entry.path, e));
            }
        }
    }

    // Phase 3: drop the fallbacks (and any failure reverts) in one rewrite.
    write_ring(ring, &header, &ring_dek, &next)?;
    Ok(outcomes)
}

/// Relabel a ring in place. The name is a clear header field, so this rewrites
/// the frame without touching the sealed table or any file.
fn rename_at(ring: &Path, passphrase: &str, name: &str) -> Result<(), String> {
    let (header, dek, table) = read_ring(ring, passphrase)?; // verifies the passphrase
    let header = RingHeader {
        vault: header.vault,
        entry_count: header.entry_count,
        name: sanitize_ring_name(name),
    };
    write_ring(ring, &header, &dek, &table)
}

fn change_passphrase_at(ring: &Path, old: &str, new: &str) -> Result<(), String> {
    let bytes = std::fs::read(ring).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "no key ring exists yet".to_string(),
        _ => e.to_string(),
    })?;
    let (header, sealed) = parse_ring_frame(&bytes)?;
    let dek = unlock(&header.vault, old).map_err(crypto_err)?;
    let vault = rewrap(&header.vault, &dek, new).map_err(crypto_err)?;
    let header = RingHeader { vault, entry_count: header.entry_count, name: header.name };
    write_fsync_rename(ring, &build_ring_frame(&header, sealed)?)
}

// ── Tauri commands (registered in lib.rs by hand) ─────────────────────────────

fn profile_root(app: &AppHandle) -> Result<PathBuf, String> {
    let state = app.state::<crate::AppConfigState>();
    let cfg = crate::active_config(&state)?;
    Ok(crate::profile_dir(app, &cfg))
}

/// Ring ids are minted here (hex), never user input — so they cannot escape the
/// rings directory. `default` maps to the legacy single-ring file.
fn valid_ring_id(id: &str) -> bool {
    id == DEFAULT_RING_ID
        || (!id.is_empty()
            && id.len() <= 64
            && id.chars().all(|c| c.is_ascii_alphanumeric()))
}

fn ring_path(app: &AppHandle, ring_id: &str) -> Result<PathBuf, String> {
    if !valid_ring_id(ring_id) {
        return Err("invalid key ring id".to_string());
    }
    let root = profile_root(app)?;
    if ring_id == DEFAULT_RING_ID {
        return Ok(root.join(RING_FILE));
    }
    Ok(root.join(RING_DIR).join(format!("{ring_id}.enig")))
}

/// One ring as the picker sees it. `name` and `entry_count` live in the clear
/// in the ring header, so listing needs no passphrase — you can see WHICH rings
/// exist without being able to open any of them.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyringSummary {
    pub id: String,
    pub name: String,
    pub entry_count: u32,
}

fn summarize(id: &str, path: &Path) -> Option<KeyringSummary> {
    let status = status_at(path).ok()?;
    status.exists.then(|| KeyringSummary {
        id: id.to_string(),
        name: status.name,
        entry_count: status.entry_count,
    })
}

/// Every ring on this profile, newest layout plus the legacy single ring.
/// Needs no passphrase: names and counts are clear-text header fields, so the
/// picker can show WHICH rings exist without opening any.
#[tauri::command]
pub fn keyring_list(app: AppHandle) -> Result<Vec<KeyringSummary>, String> {
    ensure_keyring_enabled()?;
    let root = profile_root(&app)?;
    let mut rings = Vec::new();
    if let Some(s) = summarize(DEFAULT_RING_ID, &root.join(RING_FILE)) {
        rings.push(s);
    }
    if let Ok(dir) = std::fs::read_dir(root.join(RING_DIR)) {
        for entry in dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("enig") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if !valid_ring_id(id) || id == DEFAULT_RING_ID {
                continue;
            }
            if let Some(s) = summarize(id, &path) {
                rings.push(s);
            }
        }
    }
    rings.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(rings)
}

/// Create a new ring and return its id. Each ring has its own name, its own
/// passphrase and its own set of locked files.
#[tauri::command]
pub fn keyring_create(app: AppHandle, name: String, passphrase: String) -> Result<String, String> {
    ensure_keyring_enabled()?;
    let root = profile_root(&app)?;
    // First ring on a profile that never had one keeps the legacy path, so the
    // common single-ring case stays exactly where it always was.
    let legacy = root.join(RING_FILE);
    let (id, path) = if !legacy.exists() {
        (DEFAULT_RING_ID.to_string(), legacy)
    } else {
        let id = new_entry_id();
        let dir = root.join(RING_DIR);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{id}.enig"));
        (id, path)
    };
    init_at(&path, &passphrase, &name)?;
    Ok(id)
}

/// Rename a ring. The passphrase is required so only a holder can relabel it.
#[tauri::command]
pub fn keyring_rename(
    app: AppHandle,
    ring_id: String,
    passphrase: String,
    name: String,
) -> Result<(), String> {
    ensure_keyring_enabled()?;
    rename_at(&ring_path(&app, &ring_id)?, &passphrase, &name)
}

/// Delete a ring. Refuses while it still holds keys — deleting then would make
/// every `.enigr` file it owns permanently unopenable.
#[tauri::command]
pub fn keyring_delete(app: AppHandle, ring_id: String, passphrase: String) -> Result<(), String> {
    ensure_keyring_enabled()?;
    let path = ring_path(&app, &ring_id)?;
    let (_, _, table) = read_ring(&path, &passphrase)?;
    if !table.entries.is_empty() {
        return Err(format!(
            "this ring still holds {} locked file(s) — unlock them first",
            table.entries.len()
        ));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn keyring_status(app: AppHandle, ring_id: String) -> Result<KeyringStatus, String> {
    ensure_keyring_enabled()?;
    status_at(&ring_path(&app, &ring_id)?)
}

#[tauri::command]
pub fn keyring_lock(
    app: AppHandle,
    ring_id: String,
    passphrase: String,
    paths: Vec<String>,
) -> Result<Vec<KeyringFileOutcome>, String> {
    ensure_keyring_enabled()?;
    lock_at(&ring_path(&app, &ring_id)?, &passphrase, &paths)
}

#[tauri::command]
pub fn keyring_unlock(
    app: AppHandle,
    ring_id: String,
    passphrase: String,
    paths: Vec<String>,
) -> Result<Vec<KeyringFileOutcome>, String> {
    ensure_keyring_enabled()?;
    unlock_at(&ring_path(&app, &ring_id)?, &passphrase, &paths)
}

#[tauri::command]
pub fn keyring_unlock_all(
    app: AppHandle,
    ring_id: String,
    passphrase: String,
) -> Result<Vec<KeyringFileOutcome>, String> {
    ensure_keyring_enabled()?;
    unlock_all_at(&ring_path(&app, &ring_id)?, &passphrase)
}

#[tauri::command]
pub fn keyring_entries(
    app: AppHandle,
    ring_id: String,
    passphrase: String,
) -> Result<Vec<KeyringEntryInfo>, String> {
    ensure_keyring_enabled()?;
    entries_at(&ring_path(&app, &ring_id)?, &passphrase)
}

#[tauri::command]
pub fn keyring_change_passphrase(
    app: AppHandle,
    ring_id: String,
    old: String,
    new: String,
) -> Result<(), String> {
    ensure_keyring_enabled()?;
    change_passphrase_at(&ring_path(&app, &ring_id)?, &old, &new)
}

/// Rotate the whole ring: new passphrase, new ring key material, and a fresh
/// DEK for every locked file (re-sealed on disk). `keyring_change_passphrase`
/// only re-wraps; this one assumes the old keys may be burnt.
#[tauri::command]
pub fn keyring_rotate(
    app: AppHandle,
    ring_id: String,
    old: String,
    new: String,
) -> Result<Vec<KeyringFileOutcome>, String> {
    ensure_keyring_enabled()?;
    rotate_at(&ring_path(&app, &ring_id)?, &old, &new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotate_rekeys_files_and_passphrase() {
        let dir = tmp_dir("rotate");
        let ring = dir.join(RING_FILE);
        init_at(&ring, "old-pass", "Main").unwrap();

        let a = dir.join("a.txt");
        std::fs::write(&a, b"alpha").unwrap();
        let outcomes = lock_at(&ring, "old-pass", &[a.display().to_string()]).unwrap();
        assert_eq!(outcomes[0].status, "locked");
        let locked = outcomes[0].new_path.clone().unwrap();
        let sealed_before = std::fs::read(&locked).unwrap();

        let rotated = rotate_at(&ring, "old-pass", "new-pass").unwrap();
        assert_eq!(rotated.len(), 1);
        assert_eq!(rotated[0].status, "rotated");

        // The bytes on disk changed (new DEK), the old passphrase is dead, and
        // the new one opens the file back to its plaintext.
        assert_ne!(std::fs::read(&locked).unwrap(), sealed_before);
        assert!(read_ring(&ring, "old-pass").is_err());
        let unlocked = unlock_at(&ring, "new-pass", &[locked]).unwrap();
        assert_eq!(unlocked[0].status, "unlocked");
        assert_eq!(std::fs::read(&a).unwrap(), b"alpha");

        // No rotation-window fallbacks survive.
        let (_, _, table) = read_ring(&ring, "new-pass").unwrap();
        assert!(table.entries.values().all(|e| e.old_dek_hex.is_none()));
    }

    #[test]
    fn rotate_keeps_a_missing_files_old_dek() {
        let dir = tmp_dir("rotate_missing");
        let ring = dir.join(RING_FILE);
        init_at(&ring, "p1", "Main").unwrap();

        let a = dir.join("gone.txt");
        std::fs::write(&a, b"data").unwrap();
        let outcomes = lock_at(&ring, "p1", &[a.display().to_string()]).unwrap();
        let locked = outcomes[0].new_path.clone().unwrap();
        // Simulate the user moving the sealed file away before rotating.
        let stash = dir.join("stash.enigr");
        std::fs::rename(&locked, &stash).unwrap();

        let rotated = rotate_at(&ring, "p1", "p2").unwrap();
        assert_eq!(rotated[0].status, "missing");

        // The entry kept its old DEK, so putting the file back still works.
        std::fs::rename(&stash, &locked).unwrap();
        let unlocked = unlock_at(&ring, "p2", &[locked]).unwrap();
        assert_eq!(unlocked[0].status, "unlocked");
    }

    #[test]
    fn rename_relabels_without_touching_the_keys() {
        let dir = tmp_dir("rename");
        let ring = dir.join(RING_FILE);
        init_at(&ring, "pw", "Old name").unwrap();
        let a = write_plain(&dir, "a.txt", b"payload");
        let locked = lock_at(&ring, "pw", &[a.clone()]).unwrap()[0].new_path.clone().unwrap();

        rename_at(&ring, "pw", "  New name  ").unwrap();
        assert_eq!(status_at(&ring).unwrap().name, "New name");
        // The passphrase and every key still work.
        assert_eq!(unlock_at(&ring, "pw", &[locked]).unwrap()[0].status, "unlocked");
        assert_eq!(std::fs::read(&a).unwrap(), b"payload");
    }

    #[test]
    fn rename_needs_the_right_passphrase() {
        let dir = tmp_dir("rename_wrong");
        let ring = dir.join(RING_FILE);
        init_at(&ring, "right", "Name").unwrap();
        assert!(rename_at(&ring, "wrong", "Hijacked").is_err());
        assert_eq!(status_at(&ring).unwrap().name, "Name");
    }

    #[test]
    fn ring_ids_cannot_escape_the_rings_directory() {
        // Ids are minted internally; the guard is what keeps a crafted id from
        // pointing ring_path at an arbitrary file.
        assert!(valid_ring_id("default"));
        assert!(valid_ring_id("a1b2c3"));
        for bad in ["../secrets", "a/b", "", "with.dot", "with-dash", "sp ace", &"x".repeat(65)] {
            assert!(!valid_ring_id(bad), "{bad} should be rejected");
        }
    }

    #[test]
    fn ring_name_survives_rotate_and_passphrase_change() {
        let dir = tmp_dir("named");
        let ring = dir.join(RING_FILE);
        init_at(&ring, "p1", "  Personal\u{7}  ").unwrap();
        // Sanitized: trimmed, control chars dropped.
        assert_eq!(status_at(&ring).unwrap().name, "Personal");

        change_passphrase_at(&ring, "p1", "p2").unwrap();
        assert_eq!(status_at(&ring).unwrap().name, "Personal");

        rotate_at(&ring, "p2", "p3").unwrap();
        assert_eq!(status_at(&ring).unwrap().name, "Personal");
    }

    #[test]
    fn entry_open_falls_back_to_the_rotation_window_dek() {
        // A file still sealed with the OLD dek while the entry already carries
        // the new one — exactly the crash-mid-rotate state.
        let old_dek_bytes = random_bytes32();
        let old_dek = dek_from_hex(&data_encoding::HEXLOWER.encode(&old_dek_bytes)).unwrap();
        let sealed = seal(&old_dek, FILE_AAD, b"payload").unwrap();
        let entry = RingEntry {
            dek_hex: data_encoding::HEXLOWER.encode(&random_bytes32()),
            old_dek_hex: Some(data_encoding::HEXLOWER.encode(&old_dek_bytes)),
            path: "/x/f.txt".into(),
            name: "f.txt".into(),
            size: 7,
            locked_at: 0,
        };
        assert_eq!(entry_open(&entry, &sealed).unwrap(), b"payload");
    }

    /// A fresh per-test directory under the OS temp dir (same idiom as
    /// local_lock's tmp_path, but a whole dir since the ring + files interact).
    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("enigma_keyring_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_plain(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn init_lock_unlock_roundtrips() {
        let dir = tmp_dir("roundtrip");
        let ring = dir.join(RING_FILE);
        let a = write_plain(&dir, "a.txt", b"alpha contents");
        let b = write_plain(&dir, "b.bin", &[0u8, 1, 2, 3, 255]);

        assert!(!status_at(&ring).unwrap().exists);
        init_at(&ring, "one-pass-many-files", "Main").unwrap();
        let st = status_at(&ring).unwrap();
        assert!(st.exists);
        assert_eq!(st.entry_count, 0);

        let outcomes = lock_at(&ring, "one-pass-many-files", &[a.clone(), b.clone()]).unwrap();
        assert!(outcomes.iter().all(|o| o.status == "locked"), "{outcomes:?}");
        // Originals are gone; the .enigr files are opaque frames.
        assert!(!Path::new(&a).exists() && !Path::new(&b).exists());
        let locked_a = std::fs::read(locked_path_for(&a)).unwrap();
        assert!(has_file_magic(&locked_a));
        assert!(!locked_a.windows(5).any(|w| w == b"alpha"), "plaintext leaked");
        assert_eq!(status_at(&ring).unwrap().entry_count, 2);

        let entries = entries_at(&ring, "one-pass-many-files").unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.present));

        // Re-locking the locked frame reports already-locked, not a new entry.
        let again = lock_at(&ring, "one-pass-many-files", &[locked_path_for(&a)]).unwrap();
        assert_eq!(again[0].status, "already-locked");

        let outcomes = unlock_all_at(&ring, "one-pass-many-files").unwrap();
        assert!(outcomes.iter().all(|o| o.status == "unlocked"), "{outcomes:?}");
        assert_eq!(std::fs::read(&a).unwrap(), b"alpha contents");
        assert_eq!(std::fs::read(&b).unwrap(), [0u8, 1, 2, 3, 255]);
        assert!(!Path::new(&locked_path_for(&a)).exists());
        assert_eq!(status_at(&ring).unwrap().entry_count, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_passphrase_fails_cleanly() {
        let dir = tmp_dir("wrongpass");
        let ring = dir.join(RING_FILE);
        let f = write_plain(&dir, "s.txt", b"secret");
        init_at(&ring, "right", "Main").unwrap();

        // Wrong passphrase on lock: nothing on disk changes.
        let err = lock_at(&ring, "wrong", &[f.clone()]).unwrap_err();
        assert!(err.contains("wrong passphrase"), "got: {err}");
        assert_eq!(std::fs::read(&f).unwrap(), b"secret");
        assert!(!Path::new(&locked_path_for(&f)).exists());

        // Wrong passphrase on unlock: the locked file survives untouched.
        lock_at(&ring, "right", &[f.clone()]).unwrap();
        let locked = std::fs::read(locked_path_for(&f)).unwrap();
        let err = unlock_at(&ring, "wrong", &[locked_path_for(&f)]).unwrap_err();
        assert!(err.contains("wrong passphrase"), "got: {err}");
        assert_eq!(std::fs::read(locked_path_for(&f)).unwrap(), locked);
        assert!(!Path::new(&f).exists());

        // Double init is refused.
        let err = init_at(&ring, "whatever", "Main").unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ring_survives_lock_of_missing_file() {
        let dir = tmp_dir("missing");
        let ring = dir.join(RING_FILE);
        let real = write_plain(&dir, "real.txt", b"real data");
        let missing = dir.join("missing.txt").to_string_lossy().into_owned();
        init_at(&ring, "pw", "Main").unwrap();

        let outcomes = lock_at(&ring, "pw", &[real.clone(), missing.clone()]).unwrap();
        let by_path = |p: &str| outcomes.iter().find(|o| o.path == p).unwrap();
        assert_eq!(by_path(&real).status, "locked");
        assert_eq!(by_path(&missing).status, "failed");
        assert!(by_path(&missing).error.is_some());

        // The ring is intact: one entry, still openable, and the good file
        // still unlocks.
        assert_eq!(status_at(&ring).unwrap().entry_count, 1);
        assert_eq!(entries_at(&ring, "pw").unwrap().len(), 1);
        unlock_all_at(&ring, "pw").unwrap();
        assert_eq!(std::fs::read(&real).unwrap(), b"real data");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn change_passphrase_keeps_entries_openable() {
        let dir = tmp_dir("changepass");
        let ring = dir.join(RING_FILE);
        let f = write_plain(&dir, "keep.txt", b"keep me openable");
        init_at(&ring, "old-pass", "Main").unwrap();
        lock_at(&ring, "old-pass", &[f.clone()]).unwrap();

        change_passphrase_at(&ring, "old-pass", "new-pass").unwrap();

        // Old passphrase no longer opens the ring; the new one does, and the
        // file locked before the change unlocks under it.
        let err = entries_at(&ring, "old-pass").unwrap_err();
        assert!(err.contains("wrong passphrase"), "got: {err}");
        assert_eq!(entries_at(&ring, "new-pass").unwrap().len(), 1);
        let outcomes = unlock_all_at(&ring, "new-pass").unwrap();
        assert_eq!(outcomes[0].status, "unlocked");
        assert_eq!(std::fs::read(&f).unwrap(), b"keep me openable");

        // Wrong current passphrase fails closed and changes nothing.
        let err = change_passphrase_at(&ring, "old-pass", "x").unwrap_err();
        assert!(err.contains("wrong passphrase"), "got: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
