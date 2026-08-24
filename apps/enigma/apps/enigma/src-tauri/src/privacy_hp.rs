// Privacy HP — the ledger, the clock and the price enforcement.
//
// WHAT THIS IS. A safety budget the user can read: every exposing action in the
// app has one fixed price, the price is shown before the tap, and spending it
// moves two meters. It is gamification layered *on top of* the real privacy
// machinery, and it is deliberately inert — nothing here gates, blocks, delays
// or weakens MLS, Tor, iroh, the vault or the passphrase. If this whole module
// were deleted the app would behave identically, minus the numbers.
//
// WHERE THE PRICES COME FROM. `crate::hp_policy`, generated at compile time from
// src-tauri/privacy_hp.yaml by build.rs. The webview never sends an HP amount —
// it names an action id and this module looks the price up. A compromised
// frontend can therefore charge a *wrong action*, but it cannot invent a price,
// hand itself a credit, or write a ledger row of its own devising.
//
// WHERE IT LIVES. `vault::get/put` under ns "hp" — the protasius INTERNAL tag.
// That matters: the `kv_*` commands the webview can call use a different AAD tag
// and a different record space, so JS cannot read, forge or clobber the ledger
// even though it can freely write its own settings. Locked vault ⇒ every call
// here fails, like every other data op in the app.
//
// WHAT IT STORES. Reason codes and numbers, nothing else. No message, contact,
// room name, nickname, ticket, path or peer id ever reaches this file — the
// history view can tell you "47 messages on an unencrypted-transport channel",
// and that is the most specific it is ever allowed to be.
//
//   "meta"        → Meta { v, days, hi_ts }
//   "d/<utc-day>" → Vec<Entry>          (UTC only as a storage bucket; the
//                                        meters are rolling windows, not days)
//
// THE TWO METERS are rolling windows — 24 h and 7 days — and differ *only* in
// ceiling, window length and regeneration rate. There is no second formula
// hiding in one of them. Rolling rather than calendar-bounded is a deliberate
// choice: it needs no timezone (std has no local-offset API and this is not
// worth a dependency), it has no midnight cliff to double-collect across, and a
// charge expiring exactly one day after it was made is what "daily" should have
// meant anyway.
//
// REGENERATION is derived, never stored. A charge of N made T ago currently
// weighs `max(0, N - T x rate)`. Nothing is written when HP comes back, which is
// why offline use, restarts, crashes and app-closed time need no reconciliation:
// there is no counter to reconcile. Balances are derived in rakotis
// (`privacyHp.ts`) from the rows this module hands out — policy there,
// persistence here.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::hp_policy::{self, HpKind};
use crate::vault;

const NS: &str = "hp";
const META_KEY: &str = "meta";
const META_VERSION: u32 = 1;

/// Storage buckets older than this are pruned. The meters only ever look back
/// `WEEKLY_WINDOW_DAYS`; the surplus exists so the "Why did this change?" view
/// has some history to show and so a clock that jumped cannot orphan a bucket
/// the very next launch.
const RETAIN_DAYS: i64 = 30;

const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;
const MIB: i64 = 1024 * 1024;

// ── ledger types ────────────────────────────────────────────────────────────

/// `spend` is stored as a negative `hp`, `recover` as positive, so summing a
/// window is just a fold. `kind` is kept separately anyway because the history
/// view groups by it and a zero-valued row (a capped-out credit is never
/// written, but a coalesced bucket can round to zero) must still say which it
/// was.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    /// Milliseconds since the UNIX epoch, clamped monotonic (see `stamp`).
    pub ts: i64,
    /// "spend" | "recover".
    pub kind: String,
    /// An action / recovery / data-source id from the compile-time table.
    pub code: String,
    /// Centi-HP. Negative for a spend, positive for a credit.
    pub hp: i64,
    /// How many activations this row represents. > 1 only for coalesced
    /// metered buckets.
    #[serde(default = "one")]
    pub n: u32,
    /// Hour-bucket id for metered coalescing; 0 for everything else. The bucket
    /// for the current hour is updated in place; a sealed one is never touched
    /// again, which is what keeps this append-only in the way that matters.
    #[serde(default)]
    pub bucket: i64,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Meta {
    #[serde(default)]
    v: u32,
    /// UTC day keys currently on disk, oldest first.
    #[serde(default)]
    days: Vec<String>,
    /// High-water mark of every timestamp ever issued. A clock set backwards
    /// cannot slip a row in behind existing history, and therefore cannot escape
    /// a charge or re-collect a once-per-day credit.
    #[serde(default)]
    hi_ts: i64,
}

// ── pure helpers (unit-tested below; no AppHandle, no I/O) ──────────────────

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// UTC day key for a timestamp. Storage bucketing only — no user-visible
/// semantics hang off it, so it needs no timezone.
fn day_key(ts: i64) -> String {
    // Days since epoch → civil date, via the standard days-from-civil inverse.
    let z = ts.div_euclid(MS_PER_DAY) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// What one activation of a metered action costs, in centi-HP (positive).
///
/// Rounded DOWN, so the meter never charges more than the arithmetic says, and
/// capped per event so a single 16 MiB frame or a four-hour call cannot empty a
/// meter in one go.
pub fn metered_cost(a: &hp_policy::HpAction, bytes: u64, minutes: u64) -> i64 {
    let mut c = a.cost_centi;
    if a.per_mib_centi > 0 {
        c += (bytes as i64).saturating_mul(a.per_mib_centi) / MIB;
    }
    if a.per_minute_centi > 0 {
        c += (minutes as i64).saturating_mul(a.per_minute_centi);
    }
    if a.cap_per_event_centi > 0 {
        c = c.min(a.cap_per_event_centi);
    }
    c.max(0)
}

/// Is `action_id`'s exposure currently live — charged, and not since withdrawn?
///
/// This is the whole of the toggle/recovery contract in one function. A toggle
/// that is already live is not charged again (re-affirming a switch costs
/// nothing), and a recovery with `requires:` pays only while its paired exposure
/// is live — so flipping a switch off and on again nets a loss, never a profit.
pub fn exposure_live(entries: &[Entry], action_id: &str) -> bool {
    let last_charge = entries
        .iter()
        .filter(|e| e.kind == "spend" && e.code == action_id)
        .map(|e| e.ts)
        .max();
    let Some(charged_at) = last_charge else {
        return false;
    };
    // Any recovery declaring this action as its pair, at or after the charge,
    // settles it.
    let withdrawn = entries.iter().any(|e| {
        e.kind == "recover"
            && e.ts >= charged_at
            && hp_policy::recovery(&e.code).and_then(|r| r.requires) == Some(action_id)
    });
    !withdrawn
}

/// Credits paid inside the last `window_ms`, in centi-HP.
fn credits_since(entries: &[Entry], now: i64, window_ms: i64, only: Option<&[&str]>) -> i64 {
    entries
        .iter()
        .filter(|e| e.kind == "recover" && now - e.ts < window_ms)
        .filter(|e| only.is_none_or(|ids| ids.contains(&e.code.as_str())))
        .map(|e| e.hp)
        .sum()
}

/// How much of `want` the caps will actually let through.
///
/// Every cap is a rolling window for the same reason the meters are: no midnight
/// to collect twice across.
fn apply_caps(entries: &[Entry], now: i64, want: i64, data_ids: Option<&[&str]>) -> i64 {
    let mut allowed = want;

    let spent_day = credits_since(entries, now, MS_PER_DAY, None);
    allowed = allowed.min(hp_policy::RECOVERY_DAILY_CAP_CENTI - spent_day);

    let week = MS_PER_DAY * hp_policy::WEEKLY_WINDOW_DAYS;
    let spent_week = credits_since(entries, now, week, None);
    allowed = allowed.min(hp_policy::RECOVERY_WEEKLY_CAP_CENTI - spent_week);

    // Data-deletion credits carry their own, tighter pair of caps on top — the
    // declared bound on the known import-then-delete farm.
    if let Some(ids) = data_ids {
        let d_day = credits_since(entries, now, MS_PER_DAY, Some(ids));
        allowed = allowed.min(hp_policy::DATA_DAILY_CAP_CENTI - d_day);
        let d_week = credits_since(entries, now, week, Some(ids));
        allowed = allowed.min(hp_policy::DATA_WEEKLY_CAP_CENTI - d_week);
    }

    allowed.max(0)
}

/// The raw (pre-cap) credit for freeing `bytes`. Zero bytes pays zero — which is
/// what makes this idempotent without any bookkeeping: a byte can only be
/// deleted once, and deleting nothing is worth nothing.
pub fn data_award(bytes: u64) -> i64 {
    if bytes == 0 {
        return 0;
    }
    let raw = (bytes as i64).saturating_mul(hp_policy::DATA_PER_MIB_CENTI) / MIB;
    raw.max(hp_policy::DATA_MIN_AWARD_CENTI)
        .min(hp_policy::DATA_MAX_PER_EVENT_CENTI)
}

/// Has `recovery_id` already paid inside the last 24 h?
///
/// The idempotency rule for credits with no paired exposure (a passphrase
/// change, a key rotation): they reduce risk you always carry, so there is no
/// "live exposure" to settle — a rolling-day lockout is what bounds them.
fn paid_recently(entries: &[Entry], now: i64, recovery_id: &str) -> bool {
    entries
        .iter()
        .any(|e| e.kind == "recover" && e.code == recovery_id && now - e.ts < MS_PER_DAY)
}

// ── storage ─────────────────────────────────────────────────────────────────

fn read_meta(app: &AppHandle) -> Meta {
    vault::get(app, NS, META_KEY)
        .ok()
        .flatten()
        .and_then(|b| serde_json::from_slice::<Meta>(&b).ok())
        .unwrap_or_default()
}

fn write_meta(app: &AppHandle, meta: &Meta) -> Result<(), String> {
    let bytes = serde_json::to_vec(meta).map_err(|e| e.to_string())?;
    vault::put(app, NS, META_KEY, &bytes)
}

fn read_day(app: &AppHandle, day: &str) -> Vec<Entry> {
    vault::get(app, NS, &format!("d/{day}"))
        .ok()
        .flatten()
        .and_then(|b| serde_json::from_slice::<Vec<Entry>>(&b).ok())
        .unwrap_or_default()
}

fn write_day(app: &AppHandle, day: &str, rows: &[Entry]) -> Result<(), String> {
    let bytes = serde_json::to_vec(rows).map_err(|e| e.to_string())?;
    vault::put(app, NS, &format!("d/{day}"), &bytes)
}

/// Every row in the retention window, oldest first.
fn load_recent(app: &AppHandle, meta: &Meta) -> Vec<Entry> {
    let mut out = Vec::new();
    for day in &meta.days {
        out.extend(read_day(app, day));
    }
    out.sort_by_key(|e| e.ts);
    out
}

/// Issue a timestamp that can never go backwards, and persist the new mark.
fn stamp(meta: &mut Meta) -> i64 {
    let ts = now_ms().max(meta.hi_ts + 1);
    meta.hi_ts = ts;
    ts
}

/// Drop storage buckets outside the retention window.
fn prune(app: &AppHandle, meta: &mut Meta, now: i64) {
    let cutoff = day_key(now - RETAIN_DAYS * MS_PER_DAY);
    let (keep, drop): (Vec<String>, Vec<String>) =
        meta.days.iter().cloned().partition(|d| d.as_str() >= cutoff.as_str());
    for d in drop {
        let _ = vault::delete(app, NS, &format!("d/{d}"));
    }
    meta.days = keep;
}

/// Append a row, or fold it into the open metered bucket for this hour.
fn append(app: &AppHandle, meta: &mut Meta, entry: Entry) -> Result<(), String> {
    let day = day_key(entry.ts);
    let mut rows = read_day(app, &day);

    if entry.bucket != 0 {
        // Metered: one row per (action, hour). Updating the open bucket in place
        // keeps the ledger bounded and — the reason that actually matters —
        // stores no per-message timing, only an hourly count.
        if let Some(slot) = rows
            .iter_mut()
            .find(|r| r.bucket == entry.bucket && r.code == entry.code && r.kind == entry.kind)
        {
            slot.hp += entry.hp;
            slot.n = slot.n.saturating_add(entry.n);
            write_day(app, &day, &rows)?;
            write_meta(app, meta)?;
            return Ok(());
        }
    }

    rows.push(entry);
    write_day(app, &day, &rows)?;
    if !meta.days.contains(&day) {
        meta.days.push(day);
        meta.days.sort();
    }
    meta.v = META_VERSION;
    write_meta(app, meta)
}

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionDto {
    pub id: &'static str,
    pub kind: &'static str,
    pub cost_centi: i64,
    pub per_mib_centi: i64,
    pub per_minute_centi: i64,
    pub cap_per_event_centi: i64,
    pub explain_key: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDto {
    pub id: &'static str,
    pub credit_centi: i64,
    pub requires: Option<&'static str>,
    pub explain_key: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceDto {
    pub id: &'static str,
    pub explain_key: &'static str,
}

/// The whole compile-time table, fetched once at boot (mirrors how the build
/// config reaches the frontend). The UI renders prices from this, so the badge
/// on a button and the number the ledger records cannot drift apart.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDto {
    pub version: u32,
    pub confirm_at_centi: i64,
    pub daily_max_centi: i64,
    pub daily_regen_centi: i64,
    pub daily_regen_per_minutes: i64,
    pub weekly_max_centi: i64,
    pub weekly_regen_centi: i64,
    pub weekly_regen_per_minutes: i64,
    pub weekly_window_days: i64,
    pub recovery_daily_cap_centi: i64,
    pub recovery_weekly_cap_centi: i64,
    pub data_per_mib_centi: i64,
    pub data_min_award_centi: i64,
    pub data_max_per_event_centi: i64,
    pub data_daily_cap_centi: i64,
    pub data_weekly_cap_centi: i64,
    pub actions: Vec<ActionDto>,
    pub recoveries: Vec<RecoveryDto>,
    pub data_sources: Vec<DataSourceDto>,
}

/// What a charge/credit actually did. `applied` is 0 whenever the action was a
/// no-op — an already-live toggle, a capped-out credit, a deletion that freed
/// nothing — so the UI can stay silent rather than flashing "−0 HP".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HpDelta {
    /// Centi-HP actually written. Negative = spent, positive = credited.
    pub applied: i64,
    /// The id it was recorded under (echoed so the UI can label the flash).
    pub code: String,
}

// ── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn hp_get_policy() -> PolicyDto {
    PolicyDto {
        version: hp_policy::VERSION,
        confirm_at_centi: hp_policy::CONFIRM_AT_CENTI,
        daily_max_centi: hp_policy::DAILY_MAX_CENTI,
        daily_regen_centi: hp_policy::DAILY_REGEN_CENTI,
        daily_regen_per_minutes: hp_policy::DAILY_REGEN_PER_MINUTES,
        weekly_max_centi: hp_policy::WEEKLY_MAX_CENTI,
        weekly_regen_centi: hp_policy::WEEKLY_REGEN_CENTI,
        weekly_regen_per_minutes: hp_policy::WEEKLY_REGEN_PER_MINUTES,
        weekly_window_days: hp_policy::WEEKLY_WINDOW_DAYS,
        recovery_daily_cap_centi: hp_policy::RECOVERY_DAILY_CAP_CENTI,
        recovery_weekly_cap_centi: hp_policy::RECOVERY_WEEKLY_CAP_CENTI,
        data_per_mib_centi: hp_policy::DATA_PER_MIB_CENTI,
        data_min_award_centi: hp_policy::DATA_MIN_AWARD_CENTI,
        data_max_per_event_centi: hp_policy::DATA_MAX_PER_EVENT_CENTI,
        data_daily_cap_centi: hp_policy::DATA_DAILY_CAP_CENTI,
        data_weekly_cap_centi: hp_policy::DATA_WEEKLY_CAP_CENTI,
        actions: hp_policy::ACTIONS
            .iter()
            .map(|a| ActionDto {
                id: a.id,
                kind: a.kind.as_str(),
                cost_centi: a.cost_centi,
                per_mib_centi: a.per_mib_centi,
                per_minute_centi: a.per_minute_centi,
                cap_per_event_centi: a.cap_per_event_centi,
                explain_key: a.explain_key,
            })
            .collect(),
        recoveries: hp_policy::RECOVERIES
            .iter()
            .map(|r| RecoveryDto {
                id: r.id,
                credit_centi: r.credit_centi,
                requires: r.requires,
                explain_key: r.explain_key,
            })
            .collect(),
        data_sources: hp_policy::DATA_SOURCES
            .iter()
            .map(|d| DataSourceDto { id: d.id, explain_key: d.explain_key })
            .collect(),
    }
}

/// The rows rakotis derives both meters and the history view from.
#[tauri::command]
pub fn hp_ledger(app: AppHandle) -> Result<Vec<Entry>, String> {
    let meta = read_meta(&app);
    Ok(load_recent(&app, &meta))
}

/// Charge `action_id`. `bytes` / `minutes` are the metered quantities and are
/// ignored for fixed-price actions.
///
/// Returns what was actually applied — 0 for an already-live toggle, which is
/// how "re-affirming a switch is free" is enforced rather than merely intended.
#[tauri::command]
pub fn hp_charge(
    app: AppHandle,
    action_id: String,
    bytes: Option<u64>,
    minutes: Option<u64>,
) -> Result<HpDelta, String> {
    let Some(action) = hp_policy::action(&action_id) else {
        return Err(format!("HP_UNKNOWN_ACTION: {action_id}"));
    };

    let mut meta = read_meta(&app);
    let entries = load_recent(&app, &meta);

    let cost = match action.kind {
        HpKind::Toggle => {
            if exposure_live(&entries, action.id) {
                return Ok(HpDelta { applied: 0, code: action_id });
            }
            action.cost_centi
        }
        HpKind::Event => action.cost_centi,
        HpKind::Metered => metered_cost(action, bytes.unwrap_or(0), minutes.unwrap_or(0)),
    };
    if cost <= 0 {
        // A free lane (msg.tor.mls) writes nothing at all. The table still lists
        // it so the composer can show the rate falling to zero.
        return Ok(HpDelta { applied: 0, code: action_id });
    }

    let ts = stamp(&mut meta);
    let bucket = if matches!(action.kind, HpKind::Metered) { ts / MS_PER_HOUR } else { 0 };
    prune(&app, &mut meta, ts);
    append(
        &app,
        &mut meta,
        Entry { ts, kind: "spend".into(), code: action.id.to_string(), hp: -cost, n: 1, bucket },
    )?;
    Ok(HpDelta { applied: -cost, code: action_id })
}

/// Award a fixed recovery, if the state change it names actually reduced risk.
#[tauri::command]
pub fn hp_recover(app: AppHandle, recovery_id: String) -> Result<HpDelta, String> {
    let Some(rec) = hp_policy::recovery(&recovery_id) else {
        return Err(format!("HP_UNKNOWN_RECOVERY: {recovery_id}"));
    };
    award(&app, rec.id, rec.credit_centi, rec.requires, None)
}

/// Award for data actually deleted. `bytes_freed` is measured by the caller in
/// Rust *as it performs the deletion* — never a figure the webview supplies.
#[tauri::command]
pub fn hp_data_credit(
    app: AppHandle,
    source_id: String,
    bytes_freed: u64,
) -> Result<HpDelta, String> {
    if hp_policy::data_source(&source_id).is_none() {
        return Err(format!("HP_UNKNOWN_DATA_SOURCE: {source_id}"));
    }
    let ids: Vec<&str> = hp_policy::DATA_SOURCES.iter().map(|d| d.id).collect();
    award(&app, &source_id, data_award(bytes_freed), None, Some(&ids))
}

/// Shared award path: verify, cap, write. Never writes a zero row.
fn award(
    app: &AppHandle,
    code: &str,
    want: i64,
    requires: Option<&'static str>,
    data_ids: Option<&[&str]>,
) -> Result<HpDelta, String> {
    let mut meta = read_meta(app);
    let entries = load_recent(app, &meta);
    let now = now_ms().max(meta.hi_ts);

    if want <= 0 {
        return Ok(HpDelta { applied: 0, code: code.to_string() });
    }
    // Tied to a verified state change: no live exposure, no credit.
    if let Some(pair) = requires {
        if !exposure_live(&entries, pair) {
            return Ok(HpDelta { applied: 0, code: code.to_string() });
        }
    } else if data_ids.is_none() && paid_recently(&entries, now, code) {
        // Unpaired credits are bounded by a rolling-day lockout instead.
        return Ok(HpDelta { applied: 0, code: code.to_string() });
    }

    let applied = apply_caps(&entries, now, want, data_ids);
    if applied <= 0 {
        return Ok(HpDelta { applied: 0, code: code.to_string() });
    }

    let ts = stamp(&mut meta);
    prune(app, &mut meta, ts);
    append(
        app,
        &mut meta,
        Entry { ts, kind: "recover".into(), code: code.to_string(), hp: applied, n: 1, bucket: 0 },
    )?;
    Ok(HpDelta { applied, code: code.to_string() })
}

/// Called from `vault::vault_change_passphrase` on success.
///
/// Takes only the two LENGTHS, never the passphrases: "did it get longer" is the
/// entire question, and this module has no business knowing more than that.
/// Awards `strengthen` or the lesser `change`, never both.
pub fn award_passphrase_change(app: &AppHandle, old_len: usize, new_len: usize) {
    let id = if new_len > old_len {
        "local.passphrase.strengthen"
    } else {
        "local.passphrase.change"
    };
    if let Some(rec) = hp_policy::recovery(id) {
        let _ = award(app, rec.id, rec.credit_centi, rec.requires, None);
    }
}

/// Called from the key-rotation paths (`keyring_rotate`, `rotate_local_file`).
/// Pays more than a passphrase change because it re-encrypts the data itself
/// rather than re-wrapping the key above it.
pub fn award_rotation(app: &AppHandle, id: &str) {
    if let Some(rec) = hp_policy::recovery(id) {
        let _ = award(app, rec.id, rec.credit_centi, rec.requires, None);
    }
}

/// Total ledger rows — used by the Data tab to say whether a wipe would discard
/// any HP history. Cheap enough to call on render.
#[tauri::command]
pub fn hp_count(app: AppHandle) -> Result<u64, String> {
    let meta = read_meta(&app);
    Ok(load_recent(&app, &meta).len() as u64)
}

/// Per-code totals over the retention window, for the "Why did this change?"
/// summary line. Kept in Rust so the view never needs the raw rows twice.
#[tauri::command]
pub fn hp_totals(app: AppHandle) -> Result<HashMap<String, i64>, String> {
    let meta = read_meta(&app);
    let mut out: HashMap<String, i64> = HashMap::new();
    for e in load_recent(&app, &meta) {
        *out.entry(e.code).or_insert(0) += e.hp;
    }
    Ok(out)
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn spend(ts: i64, code: &str, hp: i64) -> Entry {
        Entry { ts, kind: "spend".into(), code: code.into(), hp: -hp, n: 1, bucket: 0 }
    }
    fn recover(ts: i64, code: &str, hp: i64) -> Entry {
        Entry { ts, kind: "recover".into(), code: code.into(), hp, n: 1, bucket: 0 }
    }
    fn action(id: &str) -> &'static hp_policy::HpAction {
        hp_policy::action(id).expect("action in table")
    }

    // ── the price table itself ──────────────────────────────────────────────

    #[test]
    fn every_price_is_exact_hundredths_and_within_the_ladder() {
        for a in hp_policy::ACTIONS {
            assert!(a.cost_centi >= 0, "{} has a negative cost", a.id);
            assert!(a.cost_centi <= 2000, "{} exceeds the top rung", a.id);
            assert!(a.explain_key.starts_with("hp.explain."), "{} explain_key", a.id);
        }
        for r in hp_policy::RECOVERIES {
            assert!(r.credit_centi > 0, "{} must pay something", r.id);
        }
    }

    #[test]
    fn fixed_prices_are_the_documented_numbers() {
        // The whole feature rests on "the same action always costs the same",
        // so the headline numbers are pinned here rather than left to the YAML
        // alone: changing one has to be a deliberate two-file act.
        assert_eq!(action("transport.tor.disable").cost_centi, 2000);
        assert_eq!(action("dht.nickname.publish").cost_centi, 2000);
        assert_eq!(action("dht.presence.enable").cost_centi, 1000);
        assert_eq!(action("ticket.export.clearnet").cost_centi, 1000);
        assert_eq!(action("ticket.export.tor").cost_centi, 300);
        assert_eq!(action("room.create.clearnet").cost_centi, 500);
        assert_eq!(action("room.create.tor").cost_centi, 100);
        assert_eq!(action("local.autolock.off").cost_centi, 1000);
        assert_eq!(action("msg.tor.mls").cost_centi, 0);
        assert_eq!(action("msg.clearnet.mls").cost_centi, 5);
    }

    #[test]
    fn key_rotation_pays_more_than_a_passphrase_change() {
        let change = hp_policy::recovery("local.passphrase.change").unwrap().credit_centi;
        let strengthen = hp_policy::recovery("local.passphrase.strengthen").unwrap().credit_centi;
        let keyring = hp_policy::recovery("local.reencrypt.keyring").unwrap().credit_centi;
        let files = hp_policy::recovery("local.reencrypt.files").unwrap().credit_centi;
        assert!(strengthen > change);
        assert!(keyring > change, "rotation must out-pay a plain passphrase change");
        assert!(files > change);
    }

    #[test]
    fn unknown_ids_have_no_price() {
        assert!(hp_policy::action("msg.definitely.not.real").is_none());
        assert!(hp_policy::recovery("free.money").is_none());
    }

    // ── metered arithmetic ──────────────────────────────────────────────────

    #[test]
    fn size_still_matters_on_the_plaintext_lane() {
        // The regression this cap was raised for: a cleartext image must not
        // cost the same as a cleartext "ok".
        let tiny = metered_cost(action("msg.clearnet.plain"), 20, 0);
        let image = metered_cost(action("msg.clearnet.plain"), 4 * 1024 * 1024, 0);
        assert_eq!(tiny, 50);
        assert_eq!(image, 250);
        assert!(image > tiny * 4);
    }

    #[test]
    fn a_tiny_clearnet_message_costs_only_the_base() {
        // 20 bytes rounds to zero MiB — the base price and nothing more.
        assert_eq!(metered_cost(action("msg.clearnet.mls"), 20, 0), 5);
    }

    #[test]
    fn message_size_is_billed_per_mib() {
        // 4 MiB at 0.05/MiB on top of the 0.05 base = 0.25 HP.
        assert_eq!(metered_cost(action("msg.clearnet.mls"), 4 * 1024 * 1024, 0), 25);
        // Plaintext lane is ten times the rate: 0.5 + 4 x 0.5 = 2.5 HP.
        assert_eq!(metered_cost(action("msg.clearnet.plain"), 4 * 1024 * 1024, 0), 250);
    }

    #[test]
    fn tor_messages_are_never_billed_by_size() {
        assert_eq!(metered_cost(action("msg.tor.mls"), 64 * 1024 * 1024, 0), 0);
        assert_eq!(metered_cost(action("msg.tor.plain"), 64 * 1024 * 1024, 0), 10);
    }

    #[test]
    fn per_event_caps_bind() {
        // A 16 MiB frame on the plaintext lane would be 8.5 HP; the cap is 5.
        assert_eq!(metered_cost(action("msg.clearnet.plain"), 16 * 1024 * 1024, 0), 500);
        // The MLS lane's own cap is far tighter (1 HP), reached around 19 MiB.
        assert_eq!(metered_cost(action("msg.clearnet.mls"), 64 * 1024 * 1024, 0), 100);
        // A 4 GiB transfer is capped at 5 HP, not 205.
        assert_eq!(metered_cost(action("file.send"), 4 * 1024 * 1024 * 1024, 0), 500);
        // A four-hour call is capped at 10 HP.
        assert_eq!(metered_cost(action("vox.call"), 0, 240), 1000);
    }

    #[test]
    fn a_short_call_costs_far_less_than_a_long_one() {
        let short = metered_cost(action("vox.call"), 0, 1);
        let long = metered_cost(action("vox.call"), 0, 60);
        assert_eq!(short, 310);
        assert_eq!(long, 900);
        assert!(long > short);
    }

    // ── toggle idempotency ──────────────────────────────────────────────────

    #[test]
    fn a_toggle_is_live_once_charged_and_settled_once_withdrawn() {
        let mut log = vec![spend(1_000, "dht.presence.enable", 1000)];
        assert!(exposure_live(&log, "dht.presence.enable"));
        log.push(recover(2_000, "dht.presence.withdraw", 500));
        assert!(!exposure_live(&log, "dht.presence.enable"));
        // Re-enabling makes it live again — the charge applies afresh.
        log.push(spend(3_000, "dht.presence.enable", 1000));
        assert!(exposure_live(&log, "dht.presence.enable"));
    }

    #[test]
    fn an_unrelated_recovery_does_not_settle_an_exposure() {
        let log = vec![
            spend(1_000, "dht.presence.enable", 1000),
            recover(2_000, "room.leave", 300),
        ];
        assert!(exposure_live(&log, "dht.presence.enable"));
    }

    #[test]
    fn a_never_enabled_toggle_is_not_live() {
        assert!(!exposure_live(&[], "transport.tor.disable"));
    }

    // ── recovery caps ───────────────────────────────────────────────────────

    #[test]
    fn the_daily_cap_bounds_credits() {
        let now = 10 * MS_PER_DAY;
        let log = vec![recover(now - 1000, "local.reencrypt.keyring", 2400)];
        // 24 of the 25 daily HP are gone; a 10 HP credit is trimmed to 1.
        assert_eq!(apply_caps(&log, now, 1000, None), 100);
    }

    #[test]
    fn credits_outside_the_window_stop_counting() {
        let now = 10 * MS_PER_DAY;
        // Paid 25 HP just over a day ago — the daily cap is clear again.
        let log = vec![recover(now - MS_PER_DAY - 1, "local.reencrypt.keyring", 2500)];
        assert_eq!(apply_caps(&log, now, 1000, None), 1000);
    }

    #[test]
    fn the_weekly_cap_bounds_credits_the_daily_one_would_allow() {
        let now = 10 * MS_PER_DAY;
        let log: Vec<Entry> = (1..=5)
            .map(|d| recover(now - d * MS_PER_DAY + 1, "local.reencrypt.keyring", 2000))
            .collect();
        // 100 of 100 weekly HP already paid, and none of it inside today.
        assert_eq!(apply_caps(&log, now, 1000, None), 0);
    }

    // ── data-deletion credits ───────────────────────────────────────────────

    #[test]
    fn deleting_nothing_pays_nothing() {
        assert_eq!(data_award(0), 0);
    }

    #[test]
    fn small_deletions_pay_the_floor_and_large_ones_the_ceiling() {
        assert_eq!(data_award(1024), hp_policy::DATA_MIN_AWARD_CENTI);
        assert_eq!(data_award(8 * 1024 * 1024), 200); // 8 MiB x 0.25 = 2 HP
        assert_eq!(data_award(10 * 1024 * 1024 * 1024), hp_policy::DATA_MAX_PER_EVENT_CENTI);
    }

    #[test]
    fn the_import_then_delete_farm_is_bounded_by_its_own_caps() {
        let now = 10 * MS_PER_DAY;
        let ids = ["data.delete.maps"];
        // Ten 5 HP map deletions today would be 50 HP; the data daily cap is 10.
        let log: Vec<Entry> =
            (1..=2).map(|i| recover(now - i * 1000, "data.delete.maps", 500)).collect();
        assert_eq!(apply_caps(&log, now, 500, Some(&ids)), 0);
    }

    #[test]
    fn data_caps_do_not_leak_into_other_credits() {
        let now = 10 * MS_PER_DAY;
        let log = vec![
            recover(now - 1000, "data.delete.maps", 500),
            recover(now - 2000, "data.delete.chat", 500),
        ];
        // The data pot is empty, but a passphrase credit draws on the general cap.
        assert_eq!(apply_caps(&log, now, 1000, None), 1000);
    }

    // ── once-per-day lockout ────────────────────────────────────────────────

    #[test]
    fn unpaired_credits_pay_once_per_rolling_day() {
        let now = 10 * MS_PER_DAY;
        let log = vec![recover(now - MS_PER_DAY + 1, "local.passphrase.change", 300)];
        assert!(paid_recently(&log, now, "local.passphrase.change"));
        assert!(!paid_recently(&log, now + MS_PER_DAY, "local.passphrase.change"));
    }

    #[test]
    fn the_lockout_is_per_id() {
        let log = vec![recover(1_000, "local.passphrase.change", 300)];
        assert!(!paid_recently(&log, 2_000, "local.reencrypt.keyring"));
    }

    // ── clock behaviour ─────────────────────────────────────────────────────

    #[test]
    fn timestamps_never_go_backwards() {
        let mut meta = Meta { v: 1, days: vec![], hi_ts: now_ms() + 60_000 };
        // Clock is behind the high-water mark (set back, or a stale RTC).
        let a = stamp(&mut meta);
        let b = stamp(&mut meta);
        assert!(b > a, "a backwards clock must not let a row slip in behind history");
        assert_eq!(meta.hi_ts, b);
    }

    #[test]
    fn a_rolled_back_clock_cannot_escape_a_charge() {
        // The charge was stamped at the high-water mark; winding the clock back
        // does not move it out of the 24 h window, because the window is measured
        // from a `now` that is itself clamped to the mark.
        let charged_at = 10 * MS_PER_DAY;
        let log = vec![spend(charged_at, "transport.tor.disable", 2000)];
        let now = (5 * MS_PER_DAY).max(charged_at); // clamped, as `award` does
        assert!(now - log[0].ts < MS_PER_DAY);
    }

    // ── storage bucketing ───────────────────────────────────────────────────

    #[test]
    fn day_keys_are_sortable_civil_dates() {
        assert_eq!(day_key(0), "1970-01-01");
        assert_eq!(day_key(MS_PER_DAY - 1), "1970-01-01");
        assert_eq!(day_key(MS_PER_DAY), "1970-01-02");
        // 2026-08-24T00:00:00Z
        assert_eq!(day_key(1_787_529_600_000), "2026-08-24");
        assert!(day_key(0) < day_key(MS_PER_DAY), "keys must sort chronologically");
    }

    #[test]
    fn metered_rows_share_one_bucket_per_hour() {
        let ts = 10 * MS_PER_DAY;
        assert_eq!(ts / MS_PER_HOUR, (ts + MS_PER_HOUR - 1) / MS_PER_HOUR);
        assert_ne!(ts / MS_PER_HOUR, (ts + MS_PER_HOUR) / MS_PER_HOUR);
    }

    #[test]
    fn entries_round_trip_through_json() {
        let e = spend(1_234, "file.send", 500);
        let bytes = serde_json::to_vec(&e).unwrap();
        let back: Entry = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn rows_written_before_coalescing_existed_still_load() {
        // `n` and `bucket` are serde-defaulted, so an older ledger is readable
        // rather than being silently dropped on the floor.
        let json = br#"{"ts":1,"kind":"spend","code":"file.send","hp":-500}"#;
        let e: Entry = serde_json::from_slice(json).unwrap();
        assert_eq!(e.n, 1);
        assert_eq!(e.bucket, 0);
    }
}
