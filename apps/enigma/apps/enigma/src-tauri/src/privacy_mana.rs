// Privacy MANA — the ledger, the clock and the price enforcement.
//
// WHAT THIS IS. A safety budget the user can read: every exposing action in the
// app has one fixed price, the price is shown before the tap, and spending it
// moves two meters. It is gamification layered *on top of* the real privacy
// machinery, and it is deliberately inert — nothing here gates, blocks, delays
// or weakens MLS, Tor, iroh, the vault or the passphrase. If this whole module
// were deleted the app would behave identically, minus the numbers.
//
// WHERE THE PRICES COME FROM. `crate::mana_policy`, generated at compile time from
// src-tauri/privacy_mana.yaml by build.rs. The webview never sends an MANA amount —
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
// weighs `max(0, N - T x rate)`. Nothing is written when MANA comes back, which is
// why offline use, restarts, crashes and app-closed time need no reconciliation:
// there is no counter to reconcile. Balances are derived in rakotis
// (`privacyMana.ts`) from the rows this module hands out — policy there,
// persistence here.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::mana_policy::{self, ManaKind};
use crate::invites;
use crate::vault;

/// The on-disk namespace. Still "hp": this feature was called Privacy HP when the
/// first ledgers were written, and renaming the namespace would orphan every one
/// of them — a cosmetic rename is not worth losing a user's history over. Nothing
/// outside this constant carries the old name.
const NS: &str = "hp";
const META_KEY: &str = "meta";
const META_VERSION: u32 = 1;

/// Storage buckets older than this are pruned. The meters only ever look back
/// the meter's 24 h; the surplus exists so the history chart and the "Why did
/// this change?" view
/// has some history to show and so a clock that jumped cannot orphan a bucket
/// the very next launch.
const RETAIN_DAYS: i64 = 30;

const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;
const MIB: i64 = 1024 * 1024;

// ── ledger types ────────────────────────────────────────────────────────────

/// `spend` is stored as a negative `mana`, `recover` as positive, so summing a
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
    /// Centi-MANA. Negative for a spend, positive for a credit.
    /// Written as "mana"; ALSO read from "hp", which is what rows minted before
    /// the rename carry. An alias is cheaper and safer than a migration pass that
    /// could fail halfway through somebody's history, and it costs one attribute.
    #[serde(alias = "hp")]
    pub mana: i64,
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

/// What one activation of a metered action costs, in centi-MANA (positive).
///
/// Rounded DOWN, so the meter never charges more than the arithmetic says, and
/// capped per event so a single 16 MiB frame or a four-hour call cannot empty a
/// meter in one go.
pub fn metered_cost(a: &mana_policy::ManaAction, bytes: u64, minutes: u64) -> i64 {
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
            && mana_policy::recovery(&e.code).and_then(|r| r.requires) == Some(action_id)
    });
    !withdrawn
}

/// Credits paid inside the last `window_ms`, in centi-MANA.
fn credits_since(entries: &[Entry], now: i64, window_ms: i64, only: Option<&[&str]>) -> i64 {
    entries
        .iter()
        .filter(|e| e.kind == "recover" && now - e.ts < window_ms)
        .filter(|e| only.is_none_or(|ids| ids.contains(&e.code.as_str())))
        .map(|e| e.mana)
        .sum()
}

/// How much of `want` the caps will actually let through.
///
/// Every cap is a rolling window for the same reason the meters are: no midnight
/// to collect twice across.
fn apply_caps(entries: &[Entry], now: i64, want: i64, data_ids: Option<&[&str]>) -> i64 {
    let mut allowed = want;

    let spent_day = credits_since(entries, now, MS_PER_DAY, None);
    allowed = allowed.min(mana_policy::RECOVERY_DAILY_CAP_CENTI - spent_day);

    let window = MS_PER_DAY * mana_policy::CREDIT_WINDOW_DAYS;
    let spent_window = credits_since(entries, now, window, None);
    allowed = allowed.min(mana_policy::RECOVERY_WINDOW_CAP_CENTI - spent_window);

    // Data-deletion credits carry their own, tighter pair of caps on top — the
    // declared bound on the known import-then-delete farm.
    if let Some(ids) = data_ids {
        let d_day = credits_since(entries, now, MS_PER_DAY, Some(ids));
        allowed = allowed.min(mana_policy::DATA_DAILY_CAP_CENTI - d_day);
        let d_window = credits_since(entries, now, window, Some(ids));
        allowed = allowed.min(mana_policy::DATA_WINDOW_CAP_CENTI - d_window);
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
    let raw = (bytes as i64).saturating_mul(mana_policy::DATA_PER_MIB_CENTI) / MIB;
    raw.max(mana_policy::DATA_MIN_AWARD_CENTI)
        .min(mana_policy::DATA_MAX_PER_EVENT_CENTI)
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
            slot.mana += entry.mana;
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
    pub daily_tor_regen_per_minutes: i64,
    pub recovery_daily_cap_centi: i64,
    pub recovery_window_cap_centi: i64,
    /// Days the ledger chart spans. Not a meter — the history window.
    pub history_days: i64,
    pub data_per_mib_centi: i64,
    pub data_min_award_centi: i64,
    pub data_max_per_event_centi: i64,
    pub data_daily_cap_centi: i64,
    pub data_window_cap_centi: i64,
    pub actions: Vec<ActionDto>,
    pub recoveries: Vec<RecoveryDto>,
    pub data_sources: Vec<DataSourceDto>,
}

/// What a charge/credit actually did. `applied` is 0 whenever the action was a
/// no-op — an already-live toggle, a capped-out credit, a deletion that freed
/// nothing — so the UI can stay silent rather than flashing "−0 MANA".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManaDelta {
    /// Centi-MANA actually written. Negative = spent, positive = credited.
    pub applied: i64,
    /// The id it was recorded under (echoed so the UI can label the flash).
    pub code: String,
}

// ── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn mana_get_policy() -> PolicyDto {
    PolicyDto {
        version: mana_policy::VERSION,
        confirm_at_centi: mana_policy::CONFIRM_AT_CENTI,
        daily_max_centi: mana_policy::DAILY_MAX_CENTI,
        daily_regen_centi: mana_policy::DAILY_REGEN_CENTI,
        daily_regen_per_minutes: mana_policy::DAILY_REGEN_PER_MINUTES,
        daily_tor_regen_per_minutes: mana_policy::DAILY_TOR_REGEN_PER_MINUTES,
        recovery_daily_cap_centi: mana_policy::RECOVERY_DAILY_CAP_CENTI,
        recovery_window_cap_centi: mana_policy::RECOVERY_WINDOW_CAP_CENTI,
        history_days: 7,
        data_per_mib_centi: mana_policy::DATA_PER_MIB_CENTI,
        data_min_award_centi: mana_policy::DATA_MIN_AWARD_CENTI,
        data_max_per_event_centi: mana_policy::DATA_MAX_PER_EVENT_CENTI,
        data_daily_cap_centi: mana_policy::DATA_DAILY_CAP_CENTI,
        data_window_cap_centi: mana_policy::DATA_WINDOW_CAP_CENTI,
        actions: mana_policy::ACTIONS
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
        recoveries: mana_policy::RECOVERIES
            .iter()
            .map(|r| RecoveryDto {
                id: r.id,
                credit_centi: r.credit_centi,
                requires: r.requires,
                explain_key: r.explain_key,
            })
            .collect(),
        data_sources: mana_policy::DATA_SOURCES
            .iter()
            .map(|d| DataSourceDto { id: d.id, explain_key: d.explain_key })
            .collect(),
    }
}

/// Record which transport posture this profile is running in.
///
/// A **zero-MANA row**, not a charge. Turning Tor on or off costs and earns
/// nothing; what it changes is how fast MANA comes back (privacy_mana.yaml, the
/// meters note). These markers are what let that be integrated *piecewise* —
/// hours with Tor on heal at the fast rate, hours without at the slow one — so a
/// balance never jumps because a switch moved.
///
/// Idempotent: re-asserting the posture already recorded writes nothing, so this
/// is safe to call on every boot. Calling it at boot is in fact the point — it
/// re-establishes the marker after a profile's oldest rows have been pruned, and
/// catches a toggle that happened while the ledger was unreachable.
#[tauri::command]
pub fn mana_set_tor_posture(app: AppHandle, on: bool) -> Result<bool, String> {
    let code = if on { "transport.tor.on" } else { "transport.tor.off" };
    let mut meta = read_meta(&app);
    let entries = load_recent(&app, &meta);

    let current = entries
        .iter()
        .filter(|e| e.kind == "posture")
        .max_by_key(|e| e.ts)
        .map(|e| e.code.as_str());
    // Absent means "off" — the shipped default (build_config `features.use_tor`).
    if current.unwrap_or("transport.tor.off") == code {
        return Ok(false);
    }

    let ts = stamp(&mut meta);
    prune(&app, &mut meta, ts);
    append(
        &app,
        &mut meta,
        Entry { ts, kind: "posture".into(), code: code.to_string(), mana: 0, n: 1, bucket: 0 },
    )?;
    Ok(true)
}

/// The rows rakotis derives both meters and the history view from.
#[tauri::command]
pub fn mana_ledger(app: AppHandle) -> Result<Vec<Entry>, String> {
    let meta = read_meta(&app);
    Ok(load_recent(&app, &meta))
}

/// Charge `action_id`. `bytes` / `minutes` are the metered quantities and are
/// ignored for fixed-price actions.
///
/// Returns what was actually applied — 0 for an already-live toggle, which is
/// how "re-affirming a switch is free" is enforced rather than merely intended.
#[tauri::command]
pub fn mana_charge(
    app: AppHandle,
    action_id: String,
    bytes: Option<u64>,
    minutes: Option<u64>,
) -> Result<ManaDelta, String> {
    let Some(action) = mana_policy::action(&action_id) else {
        return Err(format!("HP_UNKNOWN_ACTION: {action_id}"));
    };

    let mut meta = read_meta(&app);
    let entries = load_recent(&app, &meta);

    let cost = match action.kind {
        ManaKind::Toggle => {
            if exposure_live(&entries, action.id) {
                return Ok(ManaDelta { applied: 0, code: action_id });
            }
            action.cost_centi
        }
        ManaKind::Event => action.cost_centi,
        ManaKind::Metered => metered_cost(action, bytes.unwrap_or(0), minutes.unwrap_or(0)),
    };
    if cost <= 0 {
        // A free lane (msg.tor.mls) writes nothing at all. The table still lists
        // it so the composer can show the rate falling to zero.
        return Ok(ManaDelta { applied: 0, code: action_id });
    }

    let ts = stamp(&mut meta);
    let bucket = if matches!(action.kind, ManaKind::Metered) { ts / MS_PER_HOUR } else { 0 };
    prune(&app, &mut meta, ts);
    append(
        &app,
        &mut meta,
        Entry { ts, kind: "spend".into(), code: action.id.to_string(), mana: -cost, n: 1, bucket },
    )?;
    Ok(ManaDelta { applied: -cost, code: action_id })
}

// ── persistent Tor exposure ─────────────────────────────────────────────────
//
// The one charge in this file that is for TIME rather than for an act.
//
// A never-expiring invitation is offered over Tor alone, and it is only worth
// anything while the `.onion` it names still resolves — so the exposure is not the
// QR, it is the address staying reachable. Anyone who has it can keep knocking for
// as long as that is true, which is why this accrues by the hour instead of being
// charged once at mint time.
//
// WHAT IS CHARGED. One accrual per room whose onion service is up AND which has a
// live never-expiring invitation outstanding. Additive: two standing doors cost
// twice as much. Nothing else about the room matters.
//
// WHEN IT STOPS. The room closing, Tor being switched off and the onion being
// rotated all reduce to the same observable — the room is no longer in
// `p2p_tor::hosted_rooms` — so one check covers all three rather than three
// bookkeeping paths that can disagree.
//
// WHY IT IS PERSISTED. The mark is a wall-clock instant per room, kept in the
// vault. Without it, closing and reopening the app would restart every room's
// clock and the drain would be free to anyone willing to relaunch. With it, the
// time already billed is on disk, so a restart resumes rather than resets — and
// cannot bill the same minutes twice either, because the mark advances by exactly
// what was charged.
//
// A room that was NOT hosted at the last tick starts fresh rather than being
// back-charged: while the app was closed arti was not running, the address
// answered nobody, and billing for that would be billing for an exposure that did
// not exist.

/// Per-room mark: the instant this room's exposure has been billed up to.
type ExposureMarks = HashMap<String, i64>;

const EXPOSURE_KEY: &str = "tor_exposure";

fn read_marks(app: &AppHandle) -> ExposureMarks {
    vault::get(app, NS, EXPOSURE_KEY)
        .ok()
        .flatten()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_marks(app: &AppHandle, marks: &ExposureMarks) -> Result<(), String> {
    let bytes = serde_json::to_vec(marks).map_err(|e| e.to_string())?;
    vault::put(app, NS, EXPOSURE_KEY, &bytes).map_err(|e| e.to_string())
}

/// What one tick of the exposure meter did, and what the caller must do about it.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TorExposureReport {
    /// Centi-MANA charged by this tick across all rooms. Negative, or zero.
    pub charged_centi: i64,
    /// Rooms currently accruing — what the UI counts and names.
    pub rooms: Vec<String>,
    /// Centi-MANA per hour these rooms are costing, for the drain-rate readout.
    pub drain_per_hour_centi: i64,
}

/// Bill every persistent Tor room for the time since it was last billed.
///
/// `hosted` is the set of rooms whose onion is up right now; `persistent` those
/// holding a never-expiring invitation. A room must be in both: a Tor room with no
/// standing invitation exposes nothing that outlives the session, and a standing
/// invitation whose room is down names an address that answers nobody.
///
/// Rooms outside `hosted` are dropped from the marks, which is how closing a room,
/// disabling Tor and rotating an address all stop the charge through one path.
pub fn accrue_tor_exposure(
    app: &AppHandle,
    hosted: &[String],
    persistent: &[String],
    now: i64,
) -> Result<TorExposureReport, String> {
    let Some(action) = mana_policy::action("tor.persistent.hold") else {
        return Ok(TorExposureReport::default());
    };
    let live: Vec<String> = hosted.iter().filter(|r| persistent.contains(r)).cloned().collect();

    let mut marks = read_marks(app);
    marks.retain(|room, _| live.contains(room));

    let mut meta = read_meta(app);
    let mut charged = 0i64;
    for room in &live {
        let since = *marks.get(room).unwrap_or(&now);
        // A clock dragged backwards must not mint free time or a negative charge.
        let minutes = (now - since).max(0) / 60_000;
        if minutes > 0 {
            let cost = metered_cost(action, 0, minutes as u64);
            if cost > 0 {
                let ts = stamp(&mut meta);
                prune(app, &mut meta, ts);
                append(
                    app,
                    &mut meta,
                    Entry {
                        ts,
                        kind: "spend".into(),
                        code: action.id.to_string(),
                        mana: -cost,
                        n: 1,
                        bucket: ts / MS_PER_HOUR,
                    },
                )?;
                charged -= cost;
            }
            // Advance by the whole minutes billed, not to `now`: the remainder is
            // carried, so ticking every 30 s bills correctly instead of never.
            marks.insert(room.clone(), since + minutes * 60_000);
        } else {
            marks.entry(room.clone()).or_insert(now);
        }
    }
    write_marks(app, &marks)?;

    Ok(TorExposureReport {
        charged_centi: charged,
        drain_per_hour_centi: action.per_minute_centi * 60 * live.len() as i64,
        rooms: live,
    })
}

// ── the persistent-Tor exposure tick ────────────────────────────────────────
//
// One command the frontend calls on a timer. It bills the time since the last
// call, and — when the day's budget is gone — says which rooms have to close.
//
// Everything it needs to decide is on this side: which onions are up
// (`p2p_tor::hosted_rooms`), which rooms hold a standing invitation
// (`invites::list`), and what the ledger says. The webview supplies no numbers
// and no room list, so a compromised frontend can decline to tick — costing the
// user nothing — but cannot fabricate a charge, dodge one, or nominate somebody
// else's room for shutdown.

/// Rooms with a live never-expiring invitation.
fn rooms_with_standing_invite(app: &AppHandle) -> Vec<String> {
    let now = invites::now_ms();
    let mut out: Vec<String> = invites::list(app)
        .into_iter()
        .filter(|r| {
            invites::never_expires(r)
                && matches!(
                    invites::effective_state(r, now),
                    invites::EffectiveState::Active | invites::EffectiveState::InFlight
                )
        })
        .map(|r| r.room_slug)
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Bill persistent Tor exposure for the time since the last tick.
///
/// Called on a timer and once at startup. Safe to call as often as you like: the
/// mark advances only by whole minutes billed, so an extra tick charges nothing
/// rather than charging twice.
///
/// It does NOT decide whether the budget has run out. Balances are derived in
/// rakotis from the rows this module hands back — policy there, persistence here
/// — and a second derivation on this side is exactly how the two would come to
/// disagree about a number the user can see. So this reports what it billed and
/// what is accruing; the caller compares that against the meter it already has
/// and calls `mana_tor_shutdown` if it must.
#[tauri::command]
pub async fn mana_tor_tick(
    app: AppHandle,
    tor: State<'_, crate::p2p_tor::TorP2pState>,
) -> Result<TorExposureReport, String> {
    let hosted = crate::p2p_tor::hosted_rooms(&tor).await;
    let standing = rooms_with_standing_invite(&app);
    accrue_tor_exposure(&app, &hosted, &standing, now_ms())
}

/// Revoke the standing invitations for `rooms`, because the budget ran out.
///
/// Called by the frontend when the daily meter has emptied and these are the
/// rooms accruing against it. Revoking is done here rather than there because it
/// is a write to trusted state; closing the rooms afterwards is the caller's,
/// since it owns the transport and the UI that has to say what happened.
///
/// Revoking BEFORE the close matters: the address is about to stop answering, and
/// an invitation left redeemable would be a promise the app has already broken.
#[tauri::command]
pub fn mana_tor_shutdown(app: AppHandle, rooms: Vec<String>) -> Result<u32, String> {
    let mut revoked = 0u32;
    for rec in invites::list(&app) {
        if invites::never_expires(&rec) && rooms.contains(&rec.room_slug) {
            if invites::revoke(&app, &rec.id).unwrap_or(false) {
                revoked += 1;
            }
        }
    }
    // The rooms are about to go down; drop their marks so a re-host starts clean
    // rather than being back-charged for the seconds in between.
    let mut marks = read_marks(&app);
    marks.retain(|room, _| !rooms.contains(room));
    write_marks(&app, &marks)?;
    Ok(revoked)
}

/// Retire a room's `.onion` and mint a new one, revoking every invitation that
/// named the old address.
///
/// This is the way OUT of the drain that is not "close the room": the exposure
/// was the address remaining reachable, so replacing it ends the exposure while
/// keeping the room. It is destructive on purpose — anyone holding the old QR is
/// left holding nothing, which is exactly what rotation has to mean.
#[tauri::command]
pub async fn mana_tor_rotate(
    app: AppHandle,
    tor: State<'_, crate::p2p_tor::TorP2pState>,
    room: String,
    name: String,
) -> Result<(), String> {
    for rec in invites::list(&app) {
        if rec.room_slug == room {
            let _ = invites::revoke(&app, &rec.id);
        }
    }
    crate::p2p_tor::rotate_onion(&app, &tor, name).await.map_err(|e| e.to_string())?;
    // The room is down and its mark is stale; the next tick drops it.
    let mut marks = read_marks(&app);
    marks.remove(&room);
    write_marks(&app, &marks)?;
    Ok(())
}

/// Award a fixed recovery, if the state change it names actually reduced risk.
#[tauri::command]
pub fn mana_recover(app: AppHandle, recovery_id: String) -> Result<ManaDelta, String> {
    let Some(rec) = mana_policy::recovery(&recovery_id) else {
        return Err(format!("HP_UNKNOWN_RECOVERY: {recovery_id}"));
    };
    award(&app, rec.id, rec.credit_centi, rec.requires, None)
}

/// Award for data deleted, scaled by how much actually went away.
///
/// WHO MEASURES, precisely — because this is the one credit whose size is not
/// fixed, and it should not be oversold:
///
/// * `data.delete.maps` is measured HERE. `maps::map_region_remove` deletes the
///   blob itself and calls `award_data` with the size it saw on disk, so the
///   webview is not consulted at all.
/// * `data.delete.chat` and `data.delete.files` are reported by the caller,
///   because the deletion happens frontend-side (kv scope wipes and the locked
///   files index). A dishonest webview could inflate `bytes_freed` — and the
///   ceiling below is what makes that pointless: `max_per_event` caps a single
///   claim at 5 MANA and the two data caps bound the day and the week regardless
///   of what is claimed.
///
/// Idempotent in all three cases for the same structural reason: a byte can only
/// be deleted once, and deleting nothing pays nothing.
#[tauri::command]
pub fn mana_data_credit(
    app: AppHandle,
    source_id: String,
    bytes_freed: u64,
) -> Result<ManaDelta, String> {
    if mana_policy::data_source(&source_id).is_none() {
        return Err(format!("HP_UNKNOWN_DATA_SOURCE: {source_id}"));
    }
    Ok(award_data(&app, &source_id, bytes_freed))
}

/// Award path for Rust-side deletions (see `mana_data_credit`). Swallows its own
/// errors: a credit is never worth failing a deletion the user asked for.
pub fn award_data(app: &AppHandle, source_id: &str, bytes_freed: u64) -> ManaDelta {
    let ids: Vec<&str> = mana_policy::DATA_SOURCES.iter().map(|d| d.id).collect();
    award(app, source_id, data_award(bytes_freed), None, Some(&ids))
        .unwrap_or(ManaDelta { applied: 0, code: source_id.to_string() })
}

/// Shared award path: verify, cap, write. Never writes a zero row.
fn award(
    app: &AppHandle,
    code: &str,
    want: i64,
    requires: Option<&'static str>,
    data_ids: Option<&[&str]>,
) -> Result<ManaDelta, String> {
    let mut meta = read_meta(app);
    let entries = load_recent(app, &meta);
    let now = now_ms().max(meta.hi_ts);

    if want <= 0 {
        return Ok(ManaDelta { applied: 0, code: code.to_string() });
    }
    // Tied to a verified state change: no live exposure, no credit.
    if let Some(pair) = requires {
        if !exposure_live(&entries, pair) {
            return Ok(ManaDelta { applied: 0, code: code.to_string() });
        }
    } else if data_ids.is_none() && paid_recently(&entries, now, code) {
        // Unpaired credits are bounded by a rolling-day lockout instead.
        return Ok(ManaDelta { applied: 0, code: code.to_string() });
    }

    let applied = apply_caps(&entries, now, want, data_ids);
    if applied <= 0 {
        return Ok(ManaDelta { applied: 0, code: code.to_string() });
    }

    let ts = stamp(&mut meta);
    prune(app, &mut meta, ts);
    append(
        app,
        &mut meta,
        Entry { ts, kind: "recover".into(), code: code.to_string(), mana: applied, n: 1, bucket: 0 },
    )?;
    Ok(ManaDelta { applied, code: code.to_string() })
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
    if let Some(rec) = mana_policy::recovery(id) {
        let _ = award(app, rec.id, rec.credit_centi, rec.requires, None);
    }
}

/// Called from the key-rotation paths (`keyring_rotate`, `rotate_local_file`).
/// Pays more than a passphrase change because it re-encrypts the data itself
/// rather than re-wrapping the key above it.
pub fn award_rotation(app: &AppHandle, id: &str) {
    if let Some(rec) = mana_policy::recovery(id) {
        let _ = award(app, rec.id, rec.credit_centi, rec.requires, None);
    }
}

/// Total ledger rows — used by the Data tab to say whether a wipe would discard
/// any MANA history. Cheap enough to call on render.
#[tauri::command]
pub fn mana_count(app: AppHandle) -> Result<u64, String> {
    let meta = read_meta(&app);
    Ok(load_recent(&app, &meta).len() as u64)
}

/// Per-code totals over the retention window, for the "Why did this change?"
/// summary line. Kept in Rust so the view never needs the raw rows twice.
#[tauri::command]
pub fn mana_totals(app: AppHandle) -> Result<HashMap<String, i64>, String> {
    let meta = read_meta(&app);
    let mut out: HashMap<String, i64> = HashMap::new();
    for e in load_recent(&app, &meta) {
        *out.entry(e.code).or_insert(0) += e.mana;
    }
    Ok(out)
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn spend(ts: i64, code: &str, mana: i64) -> Entry {
        Entry { ts, kind: "spend".into(), code: code.into(), mana: -mana, n: 1, bucket: 0 }
    }
    fn recover(ts: i64, code: &str, mana: i64) -> Entry {
        Entry { ts, kind: "recover".into(), code: code.into(), mana, n: 1, bucket: 0 }
    }
    fn action(id: &str) -> &'static mana_policy::ManaAction {
        mana_policy::action(id).expect("action in table")
    }

    // ── the price table itself ──────────────────────────────────────────────

    #[test]
    fn a_posture_row_carries_no_hp() {
        // The mechanic in one assertion: posture is a rate change, never a
        // charge and never a credit.
        let row = Entry {
            ts: 1,
            kind: "posture".into(),
            code: "transport.tor.on".into(),
            mana: 0,
            n: 1,
            bucket: 0,
        };
        assert_eq!(row.mana, 0);
        assert_ne!(row.kind, "spend");
        assert_ne!(row.kind, "recover");
    }

    #[test]
    fn turning_tor_on_and_off_has_no_price_in_the_table() {
        // Pinned so the old one-time charge cannot creep back: it punished the
        // transition while ignoring the posture, which is backwards.
        assert!(mana_policy::action("transport.tor.disable").is_none());
        assert!(mana_policy::action("transport.tor.enable").is_none());
        assert!(mana_policy::recovery("transport.tor.enable").is_none());
    }

    // ── persistent Tor exposure ─────────────────────────────────────────────
    //
    // The vault is not reachable from a unit test, so these exercise the pricing
    // arithmetic and the mark bookkeeping the accrual is built on rather than the
    // whole command. The parts that touch disk are covered by the app-side tests.

    #[test]
    fn an_hour_of_a_standing_onion_costs_the_documented_rate() {
        // 0.08 MANA/minute = 4.8 MANA/hour. Pinned here because the whole mechanic is
        // calibrated against the daily meter's Tor regeneration (12 MANA/hour): one
        // room is comfortably sustainable, three are not.
        let a = action("tor.persistent.hold");
        assert_eq!(a.per_minute_centi, 8);
        assert_eq!(metered_cost(a, 0, 60), 480);
        assert_eq!(metered_cost(a, 0, 60) * 3, 1440, "three rooms out-drain Tor regen");
    }

    #[test]
    fn one_accrual_cannot_dump_a_whole_sleep_onto_the_meter() {
        // A suspended laptop leaves a long gap between ticks, during which the
        // onion answered nobody. The cap is what stops waking up to a 40 MANA charge
        // for exposure that was not live.
        let a = action("tor.persistent.hold");
        assert_eq!(a.cap_per_event_centi, 500);
        assert_eq!(metered_cost(a, 0, 10_000), 500);
    }

    #[test]
    fn a_short_tick_bills_nothing_and_loses_nothing() {
        // Ticking every 30 s must not bill zero for ever. The accrual advances its
        // mark by the whole minutes it billed, so the remainder carries — this
        // asserts the arithmetic that relies on.
        let a = action("tor.persistent.hold");
        assert_eq!(metered_cost(a, 0, 0), 0);
        // Two half-minutes later the caller has still moved nothing, and the third
        // tick bills the whole minute rather than three roundings of zero.
        assert_eq!(metered_cost(a, 0, 1), 8);
    }

    #[test]
    fn a_never_expiring_invitation_is_marked_by_a_zero_deadline() {
        // Zero rather than u64::MAX so a record deserializing without the field
        // cannot silently inherit "never" — and every read goes through the helper.
        let mut rec = invites::InviteRecord {
            id: "a".into(),
            kind: "general".into(),
            capability: [0u8; 32],
            recipient: None,
            room_slug: "r".into(),
            room_name: "R".into(),
            created_at: 1,
            expires_at: 0,
            tor: true,
            state: invites::InviteState::Active,
        };
        assert!(invites::never_expires(&rec));
        // …and it does not expire, however far the clock is pushed.
        assert!(matches!(
            invites::effective_state(&rec, i64::MAX as u64),
            invites::EffectiveState::Active
        ));
        rec.expires_at = 10;
        assert!(!invites::never_expires(&rec));
        assert!(matches!(
            invites::effective_state(&rec, 11),
            invites::EffectiveState::Expired
        ));
    }

    #[test]
    fn tor_always_regenerates_at_least_as_fast() {
        // A smaller period is a higher rate. build.rs rejects the inverse, but
        // the invariant is worth asserting where a reader will meet it.
        assert!(mana_policy::DAILY_TOR_REGEN_PER_MINUTES < mana_policy::DAILY_REGEN_PER_MINUTES);
        // And the documented 3x.
        assert_eq!(mana_policy::DAILY_REGEN_PER_MINUTES, 3 * mana_policy::DAILY_TOR_REGEN_PER_MINUTES);
    }

    #[test]
    fn every_price_is_exact_hundredths_and_within_the_ladder() {
        for a in mana_policy::ACTIONS {
            assert!(a.cost_centi >= 0, "{} has a negative cost", a.id);
            assert!(a.cost_centi <= 1000, "{} exceeds the top rung", a.id);
            assert!(a.explain_key.starts_with("mana.explain."), "{} explain_key", a.id);
        }
        for r in mana_policy::RECOVERIES {
            assert!(r.credit_centi > 0, "{} must pay something", r.id);
        }
    }

    #[test]
    fn fixed_prices_are_the_documented_numbers() {
        // The whole feature rests on "the same action always costs the same",
        // so the headline numbers are pinned here rather than left to the YAML
        // alone: changing one has to be a deliberate two-file act.
        assert_eq!(action("dht.nickname.publish").cost_centi, 1000);
        assert_eq!(action("dht.presence.enable").cost_centi, 500);
        assert_eq!(action("invite.general.create.clearnet").cost_centi, 500);
        assert_eq!(action("invite.personal.create.clearnet").cost_centi, 150);
        assert_eq!(action("room.create.clearnet").cost_centi, 250);
        assert_eq!(action("room.create.tor").cost_centi, 50);
        assert_eq!(action("local.autolock.off").cost_centi, 500);
        assert_eq!(action("msg.tor.mls").cost_centi, 0);
        assert_eq!(action("msg.clearnet.mls").cost_centi, 2);
    }

    #[test]
    fn the_retired_credentials_have_no_price() {
        // Room tickets and DHT room codes were removed: a room is entered only by
        // redeeming an invitation. A price left in the table would let a stale
        // call site charge for something the app can no longer do — and, worse,
        // would read as though it still could.
        for id in ["ticket.export.clearnet", "ticket.export.tor", "dht.room_code.publish"] {
            assert!(mana_policy::action(id).is_none(), "{id} must not be priced");
        }
        assert!(mana_policy::recovery("room.inviteonly.enable").is_none());
    }

    #[test]
    fn key_rotation_pays_more_than_a_passphrase_change() {
        let change = mana_policy::recovery("local.passphrase.change").unwrap().credit_centi;
        let strengthen = mana_policy::recovery("local.passphrase.strengthen").unwrap().credit_centi;
        let keyring = mana_policy::recovery("local.reencrypt.keyring").unwrap().credit_centi;
        let files = mana_policy::recovery("local.reencrypt.files").unwrap().credit_centi;
        assert!(strengthen > change);
        assert!(keyring > change, "rotation must out-pay a plain passphrase change");
        assert!(files > change);
    }

    #[test]
    fn unknown_ids_have_no_price() {
        assert!(mana_policy::action("msg.definitely.not.real").is_none());
        assert!(mana_policy::recovery("free.money").is_none());
    }

    // ── metered arithmetic ──────────────────────────────────────────────────

    #[test]
    fn size_still_matters_on_the_plaintext_lane() {
        // The regression this cap was raised for: a cleartext image must not
        // cost the same as a cleartext "ok".
        let tiny = metered_cost(action("msg.clearnet.plain"), 20, 0);
        let image = metered_cost(action("msg.clearnet.plain"), 4 * 1024 * 1024, 0);
        assert_eq!(tiny, 25);
        assert_eq!(image, 125);
        assert!(image > tiny * 4);
    }

    #[test]
    fn a_tiny_clearnet_message_costs_only_the_base() {
        // 20 bytes rounds to zero MiB — the base price and nothing more.
        assert_eq!(metered_cost(action("msg.clearnet.mls"), 20, 0), 2);
    }

    #[test]
    fn message_size_is_billed_per_mib() {
        // 4 MiB at 0.05/MiB on top of the 0.05 base = 0.25 MANA.
        assert_eq!(metered_cost(action("msg.clearnet.mls"), 4 * 1024 * 1024, 0), 10);
        // Plaintext lane is ten times the rate: 0.5 + 4 x 0.5 = 2.5 MANA.
        assert_eq!(metered_cost(action("msg.clearnet.plain"), 4 * 1024 * 1024, 0), 125);
    }

    #[test]
    fn tor_messages_are_never_billed_by_size() {
        assert_eq!(metered_cost(action("msg.tor.mls"), 64 * 1024 * 1024, 0), 0);
        assert_eq!(metered_cost(action("msg.tor.plain"), 64 * 1024 * 1024, 0), 5);
    }

    #[test]
    fn per_event_caps_bind() {
        // A 16 MiB frame on the plaintext lane would be 8.5 MANA; the cap is 5.
        assert_eq!(metered_cost(action("msg.clearnet.plain"), 16 * 1024 * 1024, 0), 250);
        // The MLS lane's own cap is far tighter (1 MANA), reached around 19 MiB.
        assert_eq!(metered_cost(action("msg.clearnet.mls"), 64 * 1024 * 1024, 0), 50);
        // A 4 GiB transfer is capped at 5 MANA, not 205.
        assert_eq!(metered_cost(action("file.send"), 4 * 1024 * 1024 * 1024, 0), 250);
        // A four-hour call is capped at 10 MANA.
        assert_eq!(metered_cost(action("vox.call"), 0, 240), 500);
    }

    #[test]
    fn a_short_call_costs_far_less_than_a_long_one() {
        let short = metered_cost(action("vox.call"), 0, 1);
        let long = metered_cost(action("vox.call"), 0, 60);
        assert_eq!(short, 155);
        assert_eq!(long, 450);
        assert!(long > short);
    }

    // ── toggle idempotency ──────────────────────────────────────────────────

    #[test]
    fn a_toggle_is_live_once_charged_and_settled_once_withdrawn() {
        let mut log = vec![spend(1_000, "dht.presence.enable", 500)];
        assert!(exposure_live(&log, "dht.presence.enable"));
        log.push(recover(2_000, "dht.presence.withdraw", 250));
        assert!(!exposure_live(&log, "dht.presence.enable"));
        // Re-enabling makes it live again — the charge applies afresh.
        log.push(spend(3_000, "dht.presence.enable", 500));
        assert!(exposure_live(&log, "dht.presence.enable"));
    }

    #[test]
    fn an_unrelated_recovery_does_not_settle_an_exposure() {
        let log = vec![
            spend(1_000, "dht.presence.enable", 500),
            recover(2_000, "room.leave", 150),
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
        let log = vec![recover(now - 1000, "local.reencrypt.keyring", 1200)];
        // 12 of the 12.5 daily MANA are gone; a 5 MANA credit is trimmed to 0.5.
        assert_eq!(apply_caps(&log, now, 500, None), 50);
    }

    #[test]
    fn credits_outside_the_window_stop_counting() {
        let now = 10 * MS_PER_DAY;
        // Paid 25 MANA just over a day ago — the daily cap is clear again.
        let log = vec![recover(now - MS_PER_DAY - 1, "local.reencrypt.keyring", 1250)];
        assert_eq!(apply_caps(&log, now, 500, None), 500);
    }

    #[test]
    fn the_weekly_cap_bounds_credits_the_daily_one_would_allow() {
        let now = 10 * MS_PER_DAY;
        let log: Vec<Entry> = (1..=5)
            .map(|d| recover(now - d * MS_PER_DAY + 1, "local.reencrypt.keyring", 1000))
            .collect();
        // 50 of 50 weekly MANA already paid, and none of it inside today.
        assert_eq!(apply_caps(&log, now, 500, None), 0);
    }

    // ── data-deletion credits ───────────────────────────────────────────────

    #[test]
    fn deleting_nothing_pays_nothing() {
        assert_eq!(data_award(0), 0);
    }

    #[test]
    fn small_deletions_pay_the_floor_and_large_ones_the_ceiling() {
        assert_eq!(data_award(1024), mana_policy::DATA_MIN_AWARD_CENTI);
        assert_eq!(data_award(8 * 1024 * 1024), 96); // 8 MiB x 0.12 = 0.96 MANA
        assert_eq!(data_award(10 * 1024 * 1024 * 1024), mana_policy::DATA_MAX_PER_EVENT_CENTI);
    }

    #[test]
    fn the_import_then_delete_farm_is_bounded_by_its_own_caps() {
        let now = 10 * MS_PER_DAY;
        let ids = ["data.delete.maps"];
        // Ten 5 MANA map deletions today would be 50 MANA; the data daily cap is 10.
        let log: Vec<Entry> =
            (1..=2).map(|i| recover(now - i * 1000, "data.delete.maps", 250)).collect();
        assert_eq!(apply_caps(&log, now, 250, Some(&ids)), 0);
    }

    #[test]
    fn data_caps_do_not_leak_into_other_credits() {
        let now = 10 * MS_PER_DAY;
        let log = vec![
            recover(now - 1000, "data.delete.maps", 250),
            recover(now - 2000, "data.delete.chat", 250),
        ];
        // The data pot is empty, but a passphrase credit draws on the general cap.
        assert_eq!(apply_caps(&log, now, 500, None), 500);
    }

    // ── once-per-day lockout ────────────────────────────────────────────────

    #[test]
    fn unpaired_credits_pay_once_per_rolling_day() {
        let now = 10 * MS_PER_DAY;
        let log = vec![recover(now - MS_PER_DAY + 1, "local.passphrase.change", 150)];
        assert!(paid_recently(&log, now, "local.passphrase.change"));
        assert!(!paid_recently(&log, now + MS_PER_DAY, "local.passphrase.change"));
    }

    #[test]
    fn the_lockout_is_per_id() {
        let log = vec![recover(1_000, "local.passphrase.change", 150)];
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
        let log = vec![spend(charged_at, "transport.onion_stable.enable", 150)];
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
        let e = spend(1_234, "file.send", 250);
        let bytes = serde_json::to_vec(&e).unwrap();
        let back: Entry = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn rows_written_before_the_rename_still_load() {
        // The ledger called this field "hp" until the feature was renamed to MANA.
        // A serde alias reads those rows; without it every history older than the
        // rename would deserialize to zero and the chart would show a cliff that
        // never happened.
        let json = br#"{"ts":1,"kind":"spend","code":"file.send","hp":-250}"#;
        let back: Entry = serde_json::from_slice(json).unwrap();
        assert_eq!(back.mana, -250);
        // …and new rows are written under the new name.
        let fresh = serde_json::to_string(&spend(1, "file.send", 250)).unwrap();
        assert!(fresh.contains("\"mana\""), "{fresh}");
    }

    #[test]
    fn rows_written_before_coalescing_existed_still_load() {
        // `n` and `bucket` are serde-defaulted, so an older ledger is readable
        // rather than being silently dropped on the floor.
        let json = br#"{"ts":1,"kind":"spend","code":"file.send","mana":-250}"#;
        let e: Entry = serde_json::from_slice(json).unwrap();
        assert_eq!(e.n, 1);
        assert_eq!(e.bucket, 0);
    }
}
