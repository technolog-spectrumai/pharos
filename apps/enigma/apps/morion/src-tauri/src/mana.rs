//! Security Mana — an advisory budget for plaintext at rest.
//!
//! WHAT IT IS. A health bar for the workspace. Every file in it that is NOT
//! encrypted costs Mana for every hour it stays that way, at a price per
//! kilobyte-hour: a big plain file costs more than a small one, and ten plain
//! files cost ten times one. Encrypted files cost nothing, whether or not they
//! are open for editing — opening decrypts into memory, never onto the disk.
//! Mana comes back slowly on its own, and changing an encrypted file's
//! passphrase (re-encrypting it under a new key) earns some back. Encrypting a
//! plain file earns nothing directly: it stops that file's drain, which is the
//! point. It is inspired by enigma's Privacy HP, adapted from a network's
//! exposures to a folder's.
//!
//! WHAT IT IS NOT. Not a security score and not an enforcement mechanism.
//! Nothing here gates, delays or weakens anything: at zero, the page asks the
//! user to encrypt some files, and every action still runs.
//!
//! WHERE THE NUMBERS COME FROM. The constants below, and only there. The page
//! reads them (`mana_prices`) to show each row's rate, and never sends an
//! amount. They are product constants, not security science.
//!
//! NOTHING TICKS. There is no timer and no background work: the state is one
//! checkpoint in `.morion/metadata.json` — a level, the moment it was true,
//! and how many plain bytes the workspace held then — and the level at any
//! later moment is derived, `level + (regeneration − drain) × hours`, clamped
//! to `[0, MANA_MAX]`. Each time the page asks, the workspace is walked, and
//! a new checkpoint is written only when the plain bytes changed; the drain
//! between two looks is taken to be what the earlier look saw. Time with the
//! app closed counts like any other, because the plain files sat on the disk
//! just the same.
//!
//! THE LEDGER keeps security events — an encryption, a decryption, a
//! passphrase change and what it earned. Never a passphrase, never a byte of a
//! file body. Rows written by the earlier price-per-action budget keep their
//! `cost` and are still shown.

use std::path::Path;

use serde::Serialize;

use crate::folder;
use crate::meta::{self, LedgerEntry, ManaCheckpoint, MAX_LEDGER};
use crate::workspace::{self, WorkspaceState};

const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 24 * HOUR_MS;

/// A full bar.
pub const MANA_MAX: f64 = 100.0;
/// What one KiB of plaintext costs for each hour it stays plain. A 4 KiB note
/// costs 0.04 an hour; a 2 MiB photo, about 20.
pub const PRICE_PER_KB_HOUR: f64 = 0.01;
/// What comes back each hour, whatever the workspace holds: empty to full in
/// about four days with nothing plain. 100 KiB of plaintext cancels it out.
pub const REGEN_PER_HOUR: f64 = 1.0;
/// Earned by changing an encrypted file's passphrase…
pub const REKEY_REWARD: f64 = 10.0;
/// …at most once per file in this long…
pub const REKEY_COOLDOWN_MS: u64 = DAY_MS;
/// …and at most this much from every passphrase change in 24 hours, so a
/// folder of tiny files cannot be cycled into a full bar.
pub const REKEY_DAILY_CAP: f64 = 30.0;
/// The costliest plain files named in a status: what the "encrypt some
/// files" prompt offers first.
const TOP_FILES: usize = 10;
/// Ledger rows the view is handed, newest first.
const LEDGER_VIEW: usize = 100;

/// Zero-sum events worth a row in the history. A passphrase change is not
/// here: it is recorded by the command that made it, with what it earned, so
/// the page cannot claim one.
pub const EVENTS: &[&str] = &["encrypt_file", "encrypt_folder", "decrypt_file", "decrypt_folder"];

/// Mana an hour for `bytes` of plaintext. The page computes a row's rate the
/// same way, from the price it reads from here.
pub fn per_hour(bytes: u64) -> f64 {
    bytes as f64 / 1024.0 * PRICE_PER_KB_HOUR
}

/// The level a checkpoint implies at `now`. A clock set back gives the
/// checkpoint's own level rather than un-draining anything.
pub fn level_at(cp: &ManaCheckpoint, now: u64) -> f64 {
    let hours = now.saturating_sub(cp.at) as f64 / HOUR_MS as f64;
    (cp.level + (REGEN_PER_HOUR - per_hour(cp.plain_bytes)) * hours).clamp(0.0, MANA_MAX)
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlainFile {
    /// Relative to the workspace root, for showing.
    pub rel_path: String,
    /// Absolute, under the canonical root, for acting on.
    pub path: String,
    pub bytes: u64,
    pub per_hour: f64,
}

/// What the workspace holds in plain text right now.
pub struct Exposure {
    pub files: usize,
    pub bytes: u64,
    /// The costliest, most expensive first.
    pub top: Vec<PlainFile>,
    pub truncated: bool,
    pub deep: bool,
}

/// Walk the workspace — the folder walk's rules: no links, never `.morion` —
/// and count what is not encrypted.
pub fn measure(root: &Path) -> Exposure {
    let walked = folder::walk(root);
    let mut plain: Vec<(u64, std::path::PathBuf)> = Vec::new();
    for path in walked.files {
        if substrate::is_sealed_file(&path.to_string_lossy()) {
            continue;
        }
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        plain.push((bytes, path));
    }
    let files = plain.len();
    let bytes = plain.iter().map(|(b, _)| b).sum();
    // Biggest first; the walk's order breaks ties, so the list is stable.
    plain.sort_by(|a, b| b.0.cmp(&a.0));
    let top = plain
        .into_iter()
        .filter(|(b, _)| *b > 0)
        .take(TOP_FILES)
        .map(|(bytes, path)| PlainFile {
            rel_path: workspace::relative(root, &path),
            path: path.to_string_lossy().into_owned(),
            bytes,
            per_hour: per_hour(bytes),
        })
        .collect();
    Exposure { files, bytes, top, truncated: walked.truncated, deep: walked.deep }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManaStatus {
    pub max: f64,
    pub level: f64,
    /// What the plain files cost an hour, together.
    pub drain_per_hour: f64,
    pub regen_per_hour: f64,
    /// Regeneration less drain: negative while the bar is falling.
    pub net_per_hour: f64,
    pub plain_files: usize,
    pub plain_bytes: u64,
    /// At zero. A reason to ask for some encryption, never a refusal.
    pub exhausted: bool,
    pub top: Vec<PlainFile>,
    /// The walk stopped at its file cap: the drain counts only what it saw.
    pub truncated: bool,
    /// Folders below the walk's depth limit were not counted.
    pub deep: bool,
    /// Whether this level is kept in the workspace. False in a folder that
    /// cannot be written: Mana is then kept only while Morion runs.
    pub kept: bool,
}

fn status_of(level: f64, seen: Exposure, kept: bool) -> ManaStatus {
    let drain = per_hour(seen.bytes);
    ManaStatus {
        max: MANA_MAX,
        level: round2(level),
        drain_per_hour: drain,
        regen_per_hour: REGEN_PER_HOUR,
        net_per_hour: REGEN_PER_HOUR - drain,
        plain_files: seen.files,
        plain_bytes: seen.bytes,
        exhausted: level <= 0.0,
        top: seen.top,
        truncated: seen.truncated,
        deep: seen.deep,
        kept,
    }
}

/// Checkpoints for workspaces whose metadata cannot be written — read-only
/// media, a folder without permission. Held for as long as Morion runs, so the
/// bar still falls and fills there instead of starting full at every look.
fn volatile() -> &'static std::sync::Mutex<std::collections::BTreeMap<std::path::PathBuf, ManaCheckpoint>> {
    static HELD: std::sync::OnceLock<std::sync::Mutex<std::collections::BTreeMap<std::path::PathBuf, ManaCheckpoint>>> =
        std::sync::OnceLock::new();
    HELD.get_or_init(Default::default)
}

/// Where Mana stands now, moving the checkpoint when the plain bytes have
/// changed since it was taken. A workspace seen for the first time starts
/// full.
pub fn settle(root: &Path, now: u64) -> Result<ManaStatus, String> {
    let seen = measure(root);
    let stored = meta::load(root)?.mana;
    let held = volatile().lock().ok().and_then(|m| m.get(root).cloned());
    // What was kept in the workspace wins; a checkpoint held in memory is
    // only ever there because the workspace could not take one.
    let current = stored.clone().or(held);
    let level = current.as_ref().map_or(MANA_MAX, |cp| level_at(cp, now));
    let mut kept = stored.is_some();
    if current.as_ref().map(|cp| cp.plain_bytes) != Some(seen.bytes) {
        let bytes = seen.bytes;
        let written = meta::update(root, |m| {
            // Re-derived under the lock: another command may have moved it.
            let level = m.mana.as_ref().map_or(level, |cp| level_at(cp, now));
            m.mana = Some(ManaCheckpoint { level, at: now, plain_bytes: bytes });
            Ok(())
        });
        // A folder that cannot be written (read-only media, no permission)
        // still gets its bar, held in memory for as long as Morion runs.
        // Nothing about showing Mana may fail because the bookkeeping could
        // not be saved.
        kept = written.is_ok();
        if let Ok(mut map) = volatile().lock() {
            if kept {
                map.remove(root);
            } else {
                map.insert(root.to_path_buf(), ManaCheckpoint { level, at: now, plain_bytes: bytes });
            }
        }
    }
    Ok(status_of(level, seen, kept))
}

fn push(m: &mut meta::Metadata, entry: LedgerEntry) {
    m.ledger.push(entry);
    if m.ledger.len() > MAX_LEDGER {
        let drop = m.ledger.len() - MAX_LEDGER;
        m.ledger.drain(..drop);
    }
}

/// Credit a passphrase change on `path`, which has just succeeded, and record
/// it. Answers what was earned: the reward, less whatever the bar had no room
/// for, and nothing when this file earned within the cooldown or the day's
/// cap is used up. The history says which.
pub fn reward_rekey(root: &Path, now: u64, path: &Path) -> Result<f64, String> {
    let rel = workspace::relative(root, path);
    // Only needed when there is no checkpoint yet; walked outside the lock.
    let fresh = meta::load(root)?.mana.is_none().then(|| measure(root).bytes);
    meta::update(root, |m| {
        // A row from the future (a clock set back) counts as recent.
        let recent = |e: &&LedgerEntry, window: u64| e.action == "rekey_file" && now.saturating_sub(e.ts) < window;
        let earned_today: f64 = m.ledger.iter().filter(|e| recent(e, DAY_MS)).map(|e| e.gain).sum();
        let this_file = m
            .ledger
            .iter()
            .filter(|e| recent(e, REKEY_COOLDOWN_MS))
            .any(|e| e.gain > 0.0 && e.path.as_deref() == Some(rel.as_str()));
        let cp = m.mana.clone().unwrap_or(ManaCheckpoint { level: MANA_MAX, at: now, plain_bytes: fresh.unwrap_or(0) });
        let level = level_at(&cp, now);
        let offered = if this_file { 0.0 } else { REKEY_REWARD.min((REKEY_DAILY_CAP - earned_today).max(0.0)) };
        let gained = round2(offered.min(MANA_MAX - level));
        let note = if gained > 0.0 {
            "mana.notes.rekey_file"
        } else if offered > 0.0 {
            "mana.notes.rekey_full"
        } else if this_file {
            "mana.notes.rekey_cooldown"
        } else {
            "mana.notes.rekey_cap"
        };
        m.mana = Some(ManaCheckpoint { level: level + gained, at: now, plain_bytes: cp.plain_bytes });
        push(m, LedgerEntry { ts: now, action: "rekey_file".into(), path: Some(rel.clone()), cost: 0, gain: gained, note: note.into() });
        Ok(gained)
    })
}

/// The path as the ledger keeps it: relative to the workspace, or nothing. A
/// path that does not resolve inside the workspace is dropped, never kept as
/// it came — the ledger must not collect absolute paths from elsewhere.
fn ledger_path(root: &Path, given: Option<&str>) -> Option<String> {
    let given = given?.trim();
    if given.is_empty() {
        return None;
    }
    workspace::resolve(root, given, true).ok().map(|p| workspace::relative(root, &p))
}

/// Note a security event in the history. It moves no Mana: the drain it
/// changes is seen by the next `settle`.
pub fn record(root: &Path, now: u64, event: &str, path: Option<&str>) -> Result<(), String> {
    if !EVENTS.contains(&event) {
        return Err(format!("mana: unknown event {event}"));
    }
    let path = ledger_path(root, path);
    meta::update(root, |m| {
        push(m, LedgerEntry { ts: now, action: event.to_string(), path, cost: 0, gain: 0.0, note: format!("mana.notes.{event}") });
        Ok(())
    })
}

/// What a file or a folder costs now, and what it would cost decrypted — for
/// a dialog to say before encrypting or decrypting it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rate {
    pub plain_files: usize,
    pub plain_bytes: u64,
    /// Saved by encrypting them.
    pub plain_per_hour: f64,
    pub sealed_files: usize,
    /// Their plaintext size, near enough: the sealed body less the frame.
    pub sealed_bytes: u64,
    /// Added by decrypting them.
    pub sealed_per_hour: f64,
}

pub fn rate(root: &Path, given: &str) -> Result<Rate, String> {
    let path = workspace::resolve(root, given, false)?;
    let files = if path.is_dir() { folder::walk(&path).files } else { vec![path] };
    let mut r = Rate { plain_files: 0, plain_bytes: 0, plain_per_hour: 0.0, sealed_files: 0, sealed_bytes: 0, sealed_per_hour: 0.0 };
    for file in files {
        let name = file.to_string_lossy();
        let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        if substrate::is_sealed_file(&name) {
            r.sealed_files += 1;
            r.sealed_bytes += substrate::sealed_body_len(&name).unwrap_or(size);
        } else {
            r.plain_files += 1;
            r.plain_bytes += size;
        }
    }
    r.plain_per_hour = per_hour(r.plain_bytes);
    r.sealed_per_hour = per_hour(r.sealed_bytes);
    Ok(r)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── the commands ────────────────────────────────────────────────────────────

/// `async`: it walks the workspace, which must not stall the window.
#[tauri::command(async)]
pub fn mana_status(ws: tauri::State<'_, WorkspaceState>) -> Result<ManaStatus, String> {
    settle(&ws.root()?, now_ms())
}

#[tauri::command(async)]
pub fn mana_rate(ws: tauri::State<'_, WorkspaceState>, path: String) -> Result<Rate, String> {
    rate(&ws.root()?, &path)
}

#[tauri::command]
pub fn mana_record(ws: tauri::State<'_, WorkspaceState>, event: String, path: Option<String>) -> Result<(), String> {
    record(&ws.root()?, now_ms(), &event, path.as_deref())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prices {
    pub max: f64,
    pub per_kb_hour: f64,
    pub regen_per_hour: f64,
    pub rekey_reward: f64,
    pub rekey_cooldown_hours: f64,
    pub rekey_daily_cap: f64,
}

/// The constants, for the page: shown from here so the numbers on screen are
/// the numbers used.
#[tauri::command]
pub fn mana_prices() -> Prices {
    Prices {
        max: MANA_MAX,
        per_kb_hour: PRICE_PER_KB_HOUR,
        regen_per_hour: REGEN_PER_HOUR,
        rekey_reward: REKEY_REWARD,
        rekey_cooldown_hours: REKEY_COOLDOWN_MS as f64 / HOUR_MS as f64,
        rekey_daily_cap: REKEY_DAILY_CAP,
    }
}

/// The recent history, newest first.
#[tauri::command]
pub fn mana_ledger(ws: tauri::State<'_, WorkspaceState>) -> Result<Vec<LedgerEntry>, String> {
    let mut rows = meta::load(&ws.root()?)?.ledger;
    rows.reverse();
    rows.truncate(LEDGER_VIEW);
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::tests::{put, scratch};
    use crate::LOCKER;

    const T0: u64 = 1_700_000_000_000;
    const KIB: usize = 1024;

    fn checkpoint(root: &Path) -> ManaCheckpoint {
        meta::load(root).unwrap().mana.expect("a checkpoint")
    }

    #[test]
    fn the_price_is_per_kilobyte_hour() {
        assert_eq!(per_hour(0), 0.0);
        assert_eq!(per_hour(1024), PRICE_PER_KB_HOUR);
        assert!((per_hour(100 * 1024) - REGEN_PER_HOUR).abs() < 1e-9, "100 KiB cancels regeneration out");
        assert!((per_hour(512) - PRICE_PER_KB_HOUR / 2.0).abs() < 1e-12, "no rounding up to whole kilobytes");
    }

    #[test]
    fn plain_files_drain_encrypted_ones_do_not_and_the_level_is_derived_from_time() {
        let root = scratch("mana-drain");
        put(&root, "notes/a.md", &vec![b'a'; 200 * KIB]);
        put(&root, "b.md", &vec![b'b'; 100 * KIB]);
        put(&root, "sealed.md", &vec![b's'; 500 * KIB]);
        LOCKER.lock_file(&root.join("sealed.md").to_string_lossy(), Some("pw".into())).unwrap();

        // First look: full, and the checkpoint records what is plain.
        let s = settle(&root, T0).unwrap();
        assert_eq!(s.level, MANA_MAX);
        assert_eq!((s.plain_files, s.plain_bytes), (2, 300 * KIB as u64));
        assert!((s.drain_per_hour - 3.0).abs() < 1e-9);
        assert!((s.net_per_hour + 2.0).abs() < 1e-9);
        assert_eq!(s.top.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(), ["notes/a.md", "b.md"]);
        assert!((s.top[0].per_hour - 2.0).abs() < 1e-9);
        assert_eq!(checkpoint(&root), ManaCheckpoint { level: MANA_MAX, at: T0, plain_bytes: 300 * KIB as u64 });

        // Ten hours at −2 an hour. Nothing changed on disk, so nothing is
        // written: the level is derived.
        let written = std::fs::read(root.join(".morion/metadata.json")).unwrap();
        let s = settle(&root, T0 + 10 * HOUR_MS).unwrap();
        assert!((s.level - 80.0).abs() < 1e-9, "{}", s.level);
        assert_eq!(std::fs::read(root.join(".morion/metadata.json")).unwrap(), written);

        // It bottoms out at zero and stays there, exhausted.
        let s = settle(&root, T0 + 100 * HOUR_MS).unwrap();
        assert_eq!(s.level, 0.0);
        assert!(s.exhausted);

        // Encrypting the plain files stops the drain from the next look on;
        // Mana then only comes back, an hour at a time.
        LOCKER.lock_file(&root.join("notes/a.md").to_string_lossy(), Some("pw".into())).unwrap();
        LOCKER.lock_file(&root.join("b.md").to_string_lossy(), Some("pw".into())).unwrap();
        let s = settle(&root, T0 + 100 * HOUR_MS).unwrap();
        assert_eq!((s.plain_files, s.drain_per_hour, s.level), (0, 0.0, 0.0));
        assert_eq!(checkpoint(&root).plain_bytes, 0);
        let s = settle(&root, T0 + 130 * HOUR_MS).unwrap();
        assert!((s.level - 30.0).abs() < 1e-9, "{}", s.level);
        assert!(!s.exhausted);
        let s = settle(&root, T0 + 1000 * HOUR_MS).unwrap();
        assert_eq!(s.level, MANA_MAX, "never past full");
    }

    #[test]
    fn regeneration_outweighs_a_small_drain_and_a_clock_set_back_changes_nothing() {
        let cp = ManaCheckpoint { level: 50.0, at: T0, plain_bytes: 20 * KIB as u64 };
        // 20 KiB drains 0.2 an hour; regeneration is 1: +0.8 an hour.
        assert!((level_at(&cp, T0 + 10 * HOUR_MS) - 58.0).abs() < 1e-9);
        assert_eq!(level_at(&cp, T0 - 10 * HOUR_MS), 50.0);
    }

    #[test]
    fn the_drain_between_two_looks_is_what_the_earlier_look_saw() {
        let root = scratch("mana-piecewise");
        put(&root, "a.md", &vec![b'a'; 300 * KIB]);
        settle(&root, T0).unwrap(); // full, draining 3/h, net −2
        // Five hours later the file is encrypted. The five hours are charged
        // at the old rate; from here on, only regeneration.
        LOCKER.lock_file(&root.join("a.md").to_string_lossy(), Some("pw".into())).unwrap();
        let s = settle(&root, T0 + 5 * HOUR_MS).unwrap();
        assert!((s.level - 90.0).abs() < 1e-9, "{}", s.level);
        let s = settle(&root, T0 + 7 * HOUR_MS).unwrap();
        assert!((s.level - 92.0).abs() < 1e-9, "{}", s.level);
    }

    #[test]
    fn a_passphrase_change_earns_mana_once_per_file_per_day_within_a_daily_cap() {
        let root = scratch("mana-rekey");
        for name in ["a.md", "b.md", "c.md", "d.md"] {
            put(&root, name, b"secret");
            LOCKER.lock_file(&root.join(name).to_string_lossy(), Some("pw".into())).unwrap();
        }
        put(&root, "plain.md", &vec![b'p'; 1100 * KIB]); // 11/h drain, net −10
        settle(&root, T0).unwrap();
        let at = |h: u64| T0 + h * HOUR_MS;
        assert!((settle(&root, at(5)).unwrap().level - 50.0).abs() < 1e-9);

        assert_eq!(reward_rekey(&root, at(5), &root.join("a.md")).unwrap(), REKEY_REWARD);
        assert!((settle(&root, at(5)).unwrap().level - 60.0).abs() < 1e-9);
        // The same file again, the same day: nothing, and the history says so.
        assert_eq!(reward_rekey(&root, at(6), &root.join("a.md")).unwrap(), 0.0);
        assert_eq!(meta::load(&root).unwrap().ledger.last().unwrap().note, "mana.notes.rekey_cooldown");
        // Other files earn until the day's cap.
        assert_eq!(reward_rekey(&root, at(6), &root.join("b.md")).unwrap(), 10.0);
        assert_eq!(reward_rekey(&root, at(6), &root.join("c.md")).unwrap(), 10.0);
        assert_eq!(reward_rekey(&root, at(6), &root.join("d.md")).unwrap(), 0.0, "30 a day at most");
        assert_eq!(meta::load(&root).unwrap().ledger.last().unwrap().note, "mana.notes.rekey_cap");
        // A day on, the first file earns again.
        assert!(reward_rekey(&root, at(30), &root.join("a.md")).unwrap() > 0.0);

        let rows = meta::load(&root).unwrap().ledger;
        assert!(rows.iter().all(|r| r.action == "rekey_file" && r.path.as_deref().is_some_and(|p| !p.starts_with('/'))));
        assert_eq!(rows.iter().filter(|r| r.gain > 0.0).count(), 4);
        let text = std::fs::read_to_string(root.join(".morion/metadata.json")).unwrap();
        assert!(!text.contains("secret") && !text.contains("\"pw\""));
    }

    #[test]
    fn a_full_bar_has_no_room_for_a_reward() {
        let root = scratch("mana-rekey-full");
        put(&root, "a.md", b"x");
        LOCKER.lock_file(&root.join("a.md").to_string_lossy(), Some("pw".into())).unwrap();
        assert_eq!(reward_rekey(&root, T0, &root.join("a.md")).unwrap(), 0.0);
        let rows = meta::load(&root).unwrap().ledger;
        assert_eq!(rows[0].note, "mana.notes.rekey_full");
        // Earning nothing started no cooldown.
        let mut m = meta::load(&root).unwrap();
        m.mana.as_mut().unwrap().level = 95.0;
        meta::save(&root, &m).unwrap();
        assert_eq!(reward_rekey(&root, T0 + 1, &root.join("a.md")).unwrap(), 5.0, "only the room there is");
    }

    #[test]
    fn a_rate_says_what_encrypting_saves_and_decrypting_adds() {
        let root = scratch("mana-rate");
        put(&root, "d/plain.md", &vec![b'p'; 10 * KIB]);
        put(&root, "d/sealed.md", &vec![b's'; 20 * KIB]);
        LOCKER.lock_file(&root.join("d/sealed.md").to_string_lossy(), Some("pw".into())).unwrap();
        let r = rate(&root, "d").unwrap();
        assert_eq!((r.plain_files, r.plain_bytes, r.sealed_files), (1, 10 * KIB as u64, 1));
        // The sealed body is the plaintext plus a nonce and a tag.
        assert!(r.sealed_bytes >= 20 * KIB as u64 && r.sealed_bytes < 20 * KIB as u64 + 64, "{}", r.sealed_bytes);
        assert!((r.plain_per_hour - 0.1).abs() < 1e-9);
        let one = rate(&root, "d/plain.md").unwrap();
        assert_eq!((one.plain_files, one.sealed_files), (1, 0));
        assert!(rate(&root, "../elsewhere").unwrap_err().starts_with("outside_workspace"));
    }

    #[test]
    fn events_are_recorded_with_relative_paths_and_the_ledger_stays_bounded() {
        let root = scratch("mana-ledger");
        put(&root, "a.md", b"a");
        record(&root, T0, "encrypt_file", Some(&root.join("a.md").to_string_lossy())).unwrap();
        record(&root, T0, "decrypt_folder", Some("")).unwrap();
        record(&root, T0, "encrypt_file", Some("/etc/passwd")).unwrap();
        assert!(record(&root, T0, "rekey_file", None).is_err(), "earned only through the command that re-keys");
        let rows = meta::load(&root).unwrap().ledger;
        assert_eq!(rows[0].path.as_deref(), Some("a.md"));
        assert_eq!(rows[1].path, None);
        assert_eq!(rows[2].path, None, "a path from outside is not kept at all");
        assert!(rows.iter().all(|r| r.cost == 0 && r.gain == 0.0));

        for i in 0..(MAX_LEDGER as u64 + 20) {
            record(&root, T0 + i, "decrypt_file", None).unwrap();
        }
        let m = meta::load(&root).unwrap();
        assert_eq!(m.ledger.len(), MAX_LEDGER);
        assert!(m.ledger.iter().all(|e| e.action == "decrypt_file"), "the oldest rows dropped off");
        // Tags in the same file survived the churn.
        meta::set_tags(&root, "a.md", &["kept".into()]).unwrap();
        record(&root, T0, "encrypt_file", Some("a.md")).unwrap();
        assert_eq!(meta::tags_of(&root, "a.md").unwrap(), ["kept"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_written_still_has_a_bar() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch("mana-readonly");
        put(&root, "a.md", &vec![b'a'; 10 * KIB]);
        put(&root, "b.md", &vec![b'b'; 290 * KIB]); // 3/h drain, net −2
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o555)).unwrap();
        let first = settle(&root, T0);
        let later = settle(&root, T0 + 10 * HOUR_MS);
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let first = first.expect("a status, even with nowhere to keep it");
        assert_eq!((first.level, first.plain_files, first.kept), (MANA_MAX, 2, false));
        // Held in memory while Morion runs: the bar still falls.
        let later = later.unwrap();
        assert!((later.level - 80.0).abs() < 1e-9, "{}", later.level);
        assert!(!root.join(".morion").exists());
        // Writable again: the next change is kept in the workspace.
        put(&root, "c.md", b"c");
        let kept = settle(&root, T0 + 11 * HOUR_MS).unwrap();
        assert!(kept.kept);
        assert!(root.join(".morion/metadata.json").is_file());
    }

    #[test]
    fn rows_from_the_old_price_table_still_read() {
        let root = scratch("mana-old-rows");
        put(
            &root,
            ".morion/metadata.json",
            br#"{"version":1,"tags":{},"ledger":[{"ts":1,"action":"unlock_temp","path":"a.md","cost":5,"note":"mana.notes.unlock_temp"}]}"#,
        );
        let m = meta::load(&root).unwrap();
        assert_eq!((m.ledger[0].cost, m.ledger[0].gain), (5, 0.0));
        assert_eq!(m.mana, None);
        assert_eq!(settle(&root, T0).unwrap().level, MANA_MAX);
        assert_eq!(meta::load(&root).unwrap().ledger.len(), 1, "history kept");
    }
}
