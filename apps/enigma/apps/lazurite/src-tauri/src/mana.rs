//! Security Mana — an advisory budget for plaintext exposure.
//!
//! WHAT IT IS. A number the user can read: some actions deliberately increase
//! how much of the workspace is readable — opening an encrypted file for
//! editing, decrypting one for good, exporting plaintext, writing a plain-text
//! tag on an encrypted file — and each has a fixed price, shown before the
//! act and charged only after it succeeded. Two meters, a day's and a week's,
//! regenerate with time. It is inspired by enigma's Privacy HP, adapted from
//! a network's exposures to a folder's.
//!
//! WHAT IT IS NOT. Not a security score and not an enforcement mechanism.
//! Nothing here gates, delays or weakens anything: an exhausted meter WARNS
//! and the action still runs. Encrypting is never rewarded either — there is
//! no credit to farm; only spending, and time.
//!
//! WHERE THE PRICES COME FROM. The table below, and only there. The page names
//! an action id and a count; it never sends an amount. The numbers are product
//! constants, not security science: change them here, and only here.
//!
//! REGENERATION is derived, never stored. Each meter is a rolling window: the
//! day's meter is 100 minus what was spent in the last 24 hours, the week's
//! is 700 minus what was spent in the last 7 days. A charge simply ages out,
//! so nothing is written when Mana comes back, and offline use, restarts and
//! closed-app time need no reconciliation because there is no counter to
//! reconcile — the ledger is the whole state, and it lives with the workspace
//! in `.lazurite/metadata.json`. Two windows rather than one so that a burst
//! and a habit are both visible: the day catches the burst, the week the
//! habit.
//!
//! THE LEDGER holds when, which action, which file (relative path), what it
//! cost and a note that is a catalogue key. Never a passphrase, never a byte
//! of a file body. Zero-cost security events (an encryption) are recorded in
//! the same list so the security view can show recent actions in one place.

use std::path::Path;

use serde::Serialize;

use crate::meta::{self, LedgerEntry, MAX_LEDGER};
use crate::workspace::{self, WorkspaceState};

pub const DAILY_MAX: u32 = 100;
pub const WEEKLY_MAX: u32 = 700;
const DAY_MS: u64 = 86_400_000;
const WEEK_MS: u64 = 7 * DAY_MS;
/// Ledger rows the view is handed, newest first.
const LEDGER_VIEW: usize = 100;

/// One priced action. `base` once, `per_item` for each item beyond the base
/// (a folder's files), never more than `cap` in one go.
pub struct Price {
    pub id: &'static str,
    pub base: u32,
    pub per_item: u32,
    pub cap: u32,
}

/// The table. Product constants.
pub const PRICES: &[Price] = &[
    // Open an encrypted file for editing: its plaintext is in memory and on
    // screen for as long as it is open.
    Price { id: "unlock_temp", base: 5, per_item: 0, cap: 5 },
    // Decrypt one file permanently: plaintext on disk until encrypted again.
    Price { id: "decrypt_file", base: 15, per_item: 0, cap: 15 },
    // Decrypt everything under a folder: a base, then per file.
    Price { id: "decrypt_folder", base: 15, per_item: 5, cap: 100 },
    // Write plaintext outside the workspace from an encrypted file: a sheet's
    // CSV, a drawing's PNG.
    Price { id: "export_plain", base: 10, per_item: 0, cap: 10 },
    // A plain-text word about an encrypted file.
    Price { id: "tag_sealed", base: 3, per_item: 0, cap: 3 },
];

/// Zero-cost events worth a row in the history.
pub const EVENTS: &[&str] = &["encrypt_file", "encrypt_folder"];

pub fn price(id: &str) -> Option<&'static Price> {
    PRICES.iter().find(|p| p.id == id)
}

/// What `count` items of `id` cost. Unknown ids have no price.
pub fn cost_of(id: &str, count: u32) -> Option<u32> {
    let p = price(id)?;
    let extra = p.per_item.saturating_mul(count.saturating_sub(1));
    Some(p.base.saturating_add(extra).min(p.cap))
}

/// What was spent inside the last `window_ms`. A row from the future (a clock
/// set back) counts as now rather than escaping the window.
fn spent(ledger: &[LedgerEntry], now: u64, window_ms: u64) -> u32 {
    ledger
        .iter()
        .filter(|e| e.cost > 0 && now.saturating_sub(e.ts) < window_ms)
        .fold(0u32, |sum, e| sum.saturating_add(e.cost))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManaStatus {
    pub daily_max: u32,
    pub weekly_max: u32,
    pub daily_left: u32,
    pub weekly_left: u32,
    /// Either meter at zero. A warning, never a refusal.
    pub exhausted: bool,
}

pub fn status(ledger: &[LedgerEntry], now: u64) -> ManaStatus {
    let daily = DAILY_MAX.saturating_sub(spent(ledger, now, DAY_MS));
    let weekly = WEEKLY_MAX.saturating_sub(spent(ledger, now, WEEK_MS));
    ManaStatus {
        daily_max: DAILY_MAX,
        weekly_max: WEEKLY_MAX,
        daily_left: daily,
        weekly_left: weekly,
        exhausted: daily == 0 || weekly == 0,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub action: String,
    pub count: u32,
    pub cost: u32,
    pub daily_max: u32,
    pub weekly_max: u32,
    pub daily_left: u32,
    pub weekly_left: u32,
    /// What would be left after paying; saturating at zero.
    pub daily_after: u32,
    pub weekly_after: u32,
    /// The budget is already gone: the action still runs, with a warning.
    pub exhausted: bool,
}

pub fn quote(ledger: &[LedgerEntry], now: u64, action: &str, count: u32) -> Result<Quote, String> {
    let cost = cost_of(action, count).ok_or_else(|| format!("mana: unknown action {action}"))?;
    let s = status(ledger, now);
    Ok(Quote {
        action: action.to_string(),
        count,
        cost,
        daily_max: DAILY_MAX,
        weekly_max: WEEKLY_MAX,
        daily_left: s.daily_left,
        weekly_left: s.weekly_left,
        daily_after: s.daily_left.saturating_sub(cost),
        weekly_after: s.weekly_left.saturating_sub(cost),
        exhausted: s.exhausted,
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

fn append(root: &Path, entry: LedgerEntry) -> Result<meta::Metadata, String> {
    let mut m = meta::load(root)?;
    m.ledger.push(entry);
    if m.ledger.len() > MAX_LEDGER {
        let drop = m.ledger.len() - MAX_LEDGER;
        m.ledger.drain(..drop);
    }
    meta::save(root, &m)?;
    Ok(m)
}

/// Pay for an action that just succeeded. Called after, never before.
pub fn charge(root: &Path, now: u64, action: &str, count: u32, path: Option<&str>) -> Result<ManaStatus, String> {
    let cost = cost_of(action, count).ok_or_else(|| format!("mana: unknown action {action}"))?;
    let m = append(
        root,
        LedgerEntry {
            ts: now,
            action: action.to_string(),
            path: ledger_path(root, path),
            cost,
            note: format!("mana.notes.{action}"),
        },
    )?;
    Ok(status(&m.ledger, now))
}

/// Note a zero-cost security event.
pub fn record(root: &Path, now: u64, event: &str, path: Option<&str>) -> Result<(), String> {
    if !EVENTS.contains(&event) {
        return Err(format!("mana: unknown event {event}"));
    }
    append(
        root,
        LedgerEntry { ts: now, action: event.to_string(), path: ledger_path(root, path), cost: 0, note: format!("mana.notes.{event}") },
    )?;
    Ok(())
}

// ── the commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn mana_status(ws: tauri::State<'_, WorkspaceState>) -> Result<ManaStatus, String> {
    let root = ws.root()?;
    Ok(status(&meta::load(&root)?.ledger, now_ms()))
}

#[tauri::command]
pub fn mana_quote(ws: tauri::State<'_, WorkspaceState>, action: String, count: Option<u32>) -> Result<Quote, String> {
    let root = ws.root()?;
    quote(&meta::load(&root)?.ledger, now_ms(), &action, count.unwrap_or(1).max(1))
}

#[tauri::command]
pub fn mana_charge(ws: tauri::State<'_, WorkspaceState>, action: String, count: Option<u32>, path: Option<String>) -> Result<ManaStatus, String> {
    charge(&ws.root()?, now_ms(), &action, count.unwrap_or(1).max(1), path.as_deref())
}

#[tauri::command]
pub fn mana_record(ws: tauri::State<'_, WorkspaceState>, event: String, path: Option<String>) -> Result<(), String> {
    record(&ws.root()?, now_ms(), &event, path.as_deref())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PriceDto {
    pub id: &'static str,
    pub base: u32,
    pub per_item: u32,
    pub cap: u32,
}

/// The price table, for the security view: shown from here so the numbers on
/// screen are the numbers charged.
#[tauri::command]
pub fn mana_prices() -> Vec<PriceDto> {
    PRICES.iter().map(|p| PriceDto { id: p.id, base: p.base, per_item: p.per_item, cap: p.cap }).collect()
}

/// The recent ledger, newest first.
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

    const T0: u64 = 1_700_000_000_000;

    #[test]
    fn prices_are_fixed_and_bounded() {
        assert_eq!(cost_of("unlock_temp", 1), Some(5));
        assert_eq!(cost_of("decrypt_file", 3), Some(15), "no per-item price");
        assert_eq!(cost_of("decrypt_folder", 1), Some(15));
        assert_eq!(cost_of("decrypt_folder", 4), Some(30));
        assert_eq!(cost_of("decrypt_folder", 1000), Some(100), "capped per event");
        assert_eq!(cost_of("export_plain", 1), Some(10));
        assert_eq!(cost_of("tag_sealed", 1), Some(3));
        assert_eq!(cost_of("free_lunch", 1), None);
        assert!(PRICES.iter().all(|p| p.base > 0 && p.cap >= p.base));
    }

    #[test]
    fn a_charge_ages_out_of_each_window_and_nothing_is_stored_for_it() {
        let ledger = vec![LedgerEntry { ts: T0, action: "decrypt_folder".into(), path: None, cost: 100, note: String::new() }];
        assert_eq!(status(&ledger, T0).daily_left, 0);
        assert!(status(&ledger, T0).exhausted);
        assert_eq!(status(&ledger, T0 + DAY_MS / 2).daily_left, 0, "still inside the day");
        assert_eq!(status(&ledger, T0 + DAY_MS).daily_left, 100);
        assert!(!status(&ledger, T0 + DAY_MS).exhausted);
        // The same charge stays on the week's meter for the week.
        assert_eq!(status(&ledger, T0).weekly_left, 600);
        assert_eq!(status(&ledger, T0 + DAY_MS).weekly_left, 600);
        assert_eq!(status(&ledger, T0 + WEEK_MS).weekly_left, 700);
        // A clock set backwards does not let a charge escape.
        assert_eq!(status(&ledger, T0 - DAY_MS).daily_left, 0);
        // Zero-cost rows weigh nothing.
        let events = vec![LedgerEntry { ts: T0, action: "encrypt_file".into(), path: None, cost: 0, note: String::new() }];
        assert_eq!(status(&events, T0).daily_left, 100);
    }

    #[test]
    fn the_weekly_meter_binds_when_days_of_spending_add_up() {
        // 100 a day for a week: each day's meter heals, the week's does not.
        let ledger: Vec<LedgerEntry> = (0..7)
            .map(|d| LedgerEntry { ts: T0 + d * DAY_MS, action: "decrypt_folder".into(), path: None, cost: 100, note: String::new() })
            .collect();
        let s = status(&ledger, T0 + 6 * DAY_MS);
        assert_eq!(s.daily_left, 0);
        assert_eq!(s.weekly_left, 0);
        assert!(s.exhausted);
        // A day later the oldest charge has aged out of the week; the
        // day's meter is free again, the week's has room for one more day.
        let s = status(&ledger, T0 + 7 * DAY_MS);
        assert_eq!((s.daily_left, s.weekly_left), (100, 100));
    }

    #[test]
    fn a_quote_says_the_cost_and_what_would_be_left_and_charges_only_when_asked() {
        let root = scratch("mana-quote");
        put(&root, "secret.md", b"x");
        let q = quote(&[], T0, "unlock_temp", 1).unwrap();
        assert_eq!((q.cost, q.daily_left, q.daily_after, q.weekly_after, q.exhausted), (5, 100, 95, 695, false));
        assert!(quote(&[], T0, "nope", 1).is_err());
        // Quoting wrote nothing.
        assert!(!root.join(".lazurite").exists());

        let s = charge(&root, T0, "unlock_temp", 1, Some(&root.join("secret.md").to_string_lossy())).unwrap();
        assert_eq!(s.daily_left, 95);
        let m = meta::load(&root).unwrap();
        assert_eq!(m.ledger.len(), 1);
        assert_eq!(m.ledger[0].path.as_deref(), Some("secret.md"), "relative, never absolute");
        assert_eq!(m.ledger[0].cost, 5);
        assert_eq!(m.ledger[0].note, "mana.notes.unlock_temp");
        let text = std::fs::read_to_string(root.join(".lazurite/metadata.json")).unwrap();
        assert!(!text.contains(&root.to_string_lossy().into_owned()));

        // A folder decrypt charges by what actually happened.
        let s = charge(&root, T0, "decrypt_folder", 4, Some("")).unwrap();
        assert_eq!(s.daily_left, 95 - 30);
        assert_eq!(meta::load(&root).unwrap().ledger[1].path, None);
        // A path from outside is not kept at all, let alone absolute.
        charge(&root, T0, "tag_sealed", 1, Some("/etc/passwd")).unwrap();
        assert_eq!(meta::load(&root).unwrap().ledger[2].path, None);
        let mut m = meta::load(&root).unwrap();
        m.ledger.pop();
        meta::save(&root, &m).unwrap();

        // Exhausted is reported, not enforced: the charge still lands.
        let s = charge(&root, T0, "decrypt_folder", 100, None).unwrap();
        assert!(s.exhausted);
        let s = charge(&root, T0, "unlock_temp", 1, None).unwrap();
        assert_eq!(s.daily_left, 0);
        assert_eq!(meta::load(&root).unwrap().ledger.len(), 4);
    }

    #[test]
    fn events_are_recorded_at_zero_and_the_ledger_stays_bounded() {
        let root = scratch("mana-ledger");
        record(&root, T0, "encrypt_file", Some("a.md")).unwrap();
        assert!(record(&root, T0, "rob_a_bank", None).is_err());
        for i in 0..(MAX_LEDGER as u64 + 20) {
            charge(&root, T0 + i, "tag_sealed", 1, None).unwrap();
        }
        let m = meta::load(&root).unwrap();
        assert_eq!(m.ledger.len(), MAX_LEDGER);
        assert_eq!(m.ledger.last().unwrap().ts, T0 + MAX_LEDGER as u64 + 19, "the newest survive");
        assert!(m.ledger.iter().all(|e| e.action != "encrypt_file"), "the oldest row dropped off");
        // Tags in the same file survived the ledger churn.
        put(&root, "a.md", b"a");
        meta::set_tags(&root, "a.md", &["kept".into()]).unwrap();
        charge(&root, T0, "tag_sealed", 1, Some("a.md")).unwrap();
        assert_eq!(meta::tags_of(&root, "a.md").unwrap(), ["kept"]);
    }
}
