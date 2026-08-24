// Privacy HP — the policy layer: types, price lookup, meter derivation, copy.
//
// The split with Rust is deliberate and worth stating once. `src-tauri/privacy_hp.rs`
// owns TRUST: it holds the append-only ledger inside the encrypted profile store,
// stamps rows monotonically, and looks every price up in the compile-time table so
// the webview can never name an amount. This file owns POLICY: which variant of an
// action applies right now, what a number looks like on a button, whether something
// needs confirming, and how the rows add up to two meters.
//
// Everything here is PURE. No invoke, no storage, no clock of its own — `now` is
// always passed in. That is what makes the whole model directly testable, and it is
// why the same functions can serve the Tauri app and a plain browser unchanged.
//
// ── the model in four sentences ──────────────────────────────────────────────
// Every exposing action has one fixed price, shown before the tap. Spending
// subtracts from two meters that differ only in ceiling, window length and
// regeneration rate. Each charge then heals on its own clock, so HP returns
// without anything being written down. Nothing here blocks anything: a meter at
// zero still lets you act, it just says what the act costs.
//
// ── arithmetic ───────────────────────────────────────────────────────────────
// All amounts are CENTI-HP (integer hundredths), matching Rust exactly. Floats
// are for display only. A ledger row's `hp` is signed: negative spent, positive
// credited.

// ── types (mirror src-tauri/privacy_hp.rs DTOs) ─────────────────────────────

export type HpKind = "toggle" | "event" | "metered";
export type HpSeverity = "negligible" | "low" | "moderate" | "high" | "severe";

export interface HpAction {
  id: string;
  kind: HpKind;
  costCenti: number;
  /** 0 = not billed by size. */
  perMibCenti: number;
  /** 0 = not billed by duration. */
  perMinuteCenti: number;
  /** 0 = uncapped. */
  capPerEventCenti: number;
  explainKey: string;
}

export interface HpRecovery {
  id: string;
  creditCenti: number;
  /** Non-null = pays only while that action's exposure is live. */
  requires: string | null;
  explainKey: string;
}

export interface HpDataSource {
  id: string;
  explainKey: string;
}

export interface HpPolicy {
  version: number;
  confirmAtCenti: number;
  dailyMaxCenti: number;
  dailyRegenCenti: number;
  dailyRegenPerMinutes: number;
  weeklyMaxCenti: number;
  weeklyRegenCenti: number;
  weeklyRegenPerMinutes: number;
  weeklyWindowDays: number;
  recoveryDailyCapCenti: number;
  recoveryWeeklyCapCenti: number;
  dataPerMibCenti: number;
  dataMinAwardCenti: number;
  dataMaxPerEventCenti: number;
  dataDailyCapCenti: number;
  dataWeeklyCapCenti: number;
  actions: HpAction[];
  recoveries: HpRecovery[];
  dataSources: HpDataSource[];
}

/** One row of the append-only ledger. Reason codes and numbers only — never a
 *  message, contact, room name, nickname, ticket or path. */
export interface HpEntry {
  ts: number;
  kind: "spend" | "recover";
  code: string;
  /** Centi-HP, signed. */
  hp: number;
  /** Activations this row represents; > 1 only for coalesced metered buckets. */
  n: number;
  /** Hour-bucket id for metered coalescing; 0 otherwise. */
  bucket: number;
}

export interface HpMeter {
  /** Centi-HP currently available, clamped to [0, max]. */
  balanceCenti: number;
  maxCenti: number;
  /** What the window currently holds against you, after regeneration. */
  unhealedCenti: number;
  /** Credits inside the window. */
  creditedCenti: number;
  /** Centi-HP returned per hour. */
  regenPerHourCenti: number;
  /** Milliseconds until the next whole HP comes back; null when already full. */
  msToNextHp: number | null;
}

export interface HpBalances {
  daily: HpMeter;
  weekly: HpMeter;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MIB = 1024 * 1024;

// ── lookup ──────────────────────────────────────────────────────────────────

export function findAction(policy: HpPolicy, id: string): HpAction | null {
  return policy.actions.find((a) => a.id === id) ?? null;
}

export function findRecovery(policy: HpPolicy, id: string): HpRecovery | null {
  return policy.recoveries.find((r) => r.id === id) ?? null;
}

/**
 * What one activation costs, in centi-HP (positive).
 *
 * Mirrors `privacy_hp::metered_cost` in Rust exactly — same integer division,
 * same rounding down, same per-event cap. It has to: this is the number printed
 * on the button, and Rust's is the number written to the ledger. If they ever
 * disagreed, the meter would stop matching what the UI promised.
 */
export function priceOf(action: HpAction, bytes = 0, minutes = 0): number {
  let c = action.costCenti;
  if (action.perMibCenti > 0) c += Math.floor((bytes * action.perMibCenti) / MIB);
  if (action.perMinuteCenti > 0) c += minutes * action.perMinuteCenti;
  if (action.capPerEventCenti > 0) c = Math.min(c, action.capPerEventCenti);
  return Math.max(0, c);
}

// ── variant selection ───────────────────────────────────────────────────────
// "If Tor or another state changes risk, define a fixed variant." These pick the
// variant; they never compute a price, so a variant can only ever resolve to a
// number that is already in the table.

/**
 * Which message lane a send is on right now.
 *
 * The four combinations are exactly the app's real states: chat re-homes onto the
 * onion transport when Tor is on, and before MLS reports ready `sendMessage`
 * falls back to a cleartext frame (technology.md §9.5). Priced as its own lane
 * rather than folded into an average, so the composer's rate chip drops to zero
 * the moment the lock badge goes green.
 */
export function messageActionId(opts: { tor: boolean; mlsReady: boolean }): string {
  const transport = opts.tor ? "tor" : "clearnet";
  const lane = opts.mlsReady ? "mls" : "plain";
  return `msg.${transport}.${lane}`;
}

/** Room and ticket surfaces, which do have a Tor variant (chat rides the onion). */
export function roomActionId(what: "create" | "join", tor: boolean): string {
  return `room.${what}.${tor ? "tor" : "clearnet"}`;
}

export function ticketActionId(tor: boolean): string {
  return `ticket.export.${tor ? "tor" : "clearnet"}`;
}

/**
 * Calendar traffic — meeting invites, RSVPs, poll snapshots and ballots.
 *
 * Only a transport axis, deliberately: these ride `sendSync`, which encrypts or
 * throws, and `canSendTo` gates every send on MLS being ready. There is no
 * plaintext lane for them to fall onto, so unlike `messageActionId` this takes
 * no `mlsReady` — a `.plain` variant would be a price for a state that cannot
 * occur.
 */
export function calendarActionId(tor: boolean): string {
  return `calendar.share.${tor ? "tor" : "clearnet"}`;
}

// ── severity and confirmation ───────────────────────────────────────────────

/** The ladder rung a price sits on. Drives the badge colour, nothing else. */
export function severityOf(centi: number): HpSeverity {
  const hp = Math.abs(centi);
  if (hp >= 2000) return "severe";
  if (hp >= 1000) return "high";
  if (hp >= 500) return "moderate";
  if (hp >= 300) return "low";
  return "negligible";
}

/**
 * Confirm high and severe costs, and anything spent from an empty meter.
 * Everything else stays one-tap — a budget that interrupts constantly is one
 * people learn to click through without reading.
 */
export function needsConfirm(policy: HpPolicy, centi: number, balances?: HpBalances): boolean {
  if (Math.abs(centi) >= policy.confirmAtCenti) return true;
  if (!balances || centi === 0) return false;
  return balances.daily.balanceCenti <= 0 || balances.weekly.balanceCenti <= 0;
}

// ── derivation ──────────────────────────────────────────────────────────────

interface MeterSpec {
  maxCenti: number;
  windowMs: number;
  regenCenti: number;
  regenPerMinutes: number;
}

/**
 * How much of a charge has healed by `now`.
 *
 * Continuous rather than stepped, so the bar creeps rather than jumping on the
 * hour — and integer throughout, so it never drifts. A backwards clock heals
 * nothing (`elapsed` floors at zero) rather than un-healing what already had.
 */
function healedCenti(entryTs: number, now: number, spec: MeterSpec): number {
  const elapsed = Math.max(0, now - entryTs);
  return Math.floor((elapsed * spec.regenCenti) / (spec.regenPerMinutes * MS_PER_MINUTE));
}

function deriveMeter(entries: readonly HpEntry[], now: number, spec: MeterSpec): HpMeter {
  let unhealed = 0;
  let credited = 0;
  // The soonest a whole HP returns, across every charge still weighing.
  let nextHpAt: number | null = null;

  for (const e of entries) {
    if (now - e.ts >= spec.windowMs) continue; // outside the window entirely
    if (e.kind === "recover") {
      credited += e.hp;
      continue;
    }
    const owed = Math.abs(e.hp);
    const healed = healedCenti(e.ts, now, spec);
    const left = owed - healed;
    if (left <= 0) continue;
    unhealed += left;

    // When does this charge next give back a WHOLE HP? Regeneration is
    // continuous, so something comes back every few seconds — but the UI
    // promises "+1 HP", and counting down to a hundredth would be a countdown
    // to nothing the user can see. Rounded up to the next whole HP of this
    // charge, or to the moment it finishes paying if that comes first.
    const perCenti = (spec.regenPerMinutes * MS_PER_MINUTE) / spec.regenCenti;
    const nextWhole = Math.min(owed, (Math.floor(healed / 100) + 1) * 100);
    const nextWholeAt = e.ts + Math.ceil(nextWhole * perCenti);
    // Charges heal independently, so the meter's next visible tick is whichever
    // of them reaches its boundary first.
    if (nextHpAt === null || nextWholeAt < nextHpAt) nextHpAt = nextWholeAt;
  }

  const raw = spec.maxCenti - unhealed + credited;
  const balance = Math.max(0, Math.min(spec.maxCenti, raw));
  return {
    balanceCenti: balance,
    maxCenti: spec.maxCenti,
    unhealedCenti: unhealed,
    creditedCenti: credited,
    regenPerHourCenti: Math.floor((spec.regenCenti * 60) / spec.regenPerMinutes),
    msToNextHp: balance >= spec.maxCenti || nextHpAt === null ? null : Math.max(0, nextHpAt - now),
  };
}

/**
 * Both meters, from the ledger alone.
 *
 * Deterministic: same rows plus same `now` always give the same pair, on any
 * device, in any timezone, with nothing cached. Both windows ROLL rather than
 * resetting at a calendar boundary — no midnight to double-collect across, and
 * no local-date arithmetic to disagree with Rust about.
 */
export function deriveBalances(
  policy: HpPolicy,
  entries: readonly HpEntry[],
  now: number,
): HpBalances {
  return {
    daily: deriveMeter(entries, now, {
      maxCenti: policy.dailyMaxCenti,
      windowMs: MS_PER_DAY,
      regenCenti: policy.dailyRegenCenti,
      regenPerMinutes: policy.dailyRegenPerMinutes,
    }),
    weekly: deriveMeter(entries, now, {
      maxCenti: policy.weeklyMaxCenti,
      windowMs: MS_PER_DAY * policy.weeklyWindowDays,
      regenCenti: policy.weeklyRegenCenti,
      regenPerMinutes: policy.weeklyRegenPerMinutes,
    }),
  };
}

/** Is `actionId`'s exposure live — charged and not since withdrawn? Mirrors
 *  `privacy_hp::exposure_live`; the UI uses it to label a toggle "active". */
export function exposureLive(
  policy: HpPolicy,
  entries: readonly HpEntry[],
  actionId: string,
): boolean {
  let chargedAt: number | null = null;
  for (const e of entries) {
    if (e.kind === "spend" && e.code === actionId && (chargedAt === null || e.ts > chargedAt)) {
      chargedAt = e.ts;
    }
  }
  if (chargedAt === null) return false;
  const at = chargedAt;
  return !entries.some(
    (e) =>
      e.kind === "recover" &&
      e.ts >= at &&
      findRecovery(policy, e.code)?.requires === actionId,
  );
}

// ── history ─────────────────────────────────────────────────────────────────

export interface HpHistoryRow {
  ts: number;
  code: string;
  /** Signed centi-HP. */
  hp: number;
  kind: "spend" | "recover";
  n: number;
  /** Centi-HP of this charge that has already regenerated (0 for credits). */
  healedCenti: number;
  /** True once regeneration has fully paid this charge back. */
  settled: boolean;
}

/**
 * The "Why did this change?" view: newest first, with how much of each charge has
 * since healed — which is the actual answer to the question, since nothing is
 * written when HP returns.
 */
export function historyRows(
  policy: HpPolicy,
  entries: readonly HpEntry[],
  now: number,
  limit = 100,
): HpHistoryRow[] {
  const spec: MeterSpec = {
    maxCenti: policy.dailyMaxCenti,
    windowMs: MS_PER_DAY,
    regenCenti: policy.dailyRegenCenti,
    regenPerMinutes: policy.dailyRegenPerMinutes,
  };
  return [...entries]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((e) => {
      const owed = Math.abs(e.hp);
      const healed = e.kind === "spend" ? Math.min(owed, healedCenti(e.ts, now, spec)) : 0;
      return {
        ts: e.ts,
        code: e.code,
        hp: e.hp,
        kind: e.kind,
        n: e.n ?? 1,
        healedCenti: healed,
        settled: e.kind === "spend" && healed >= owed,
      };
    });
}

// ── display ─────────────────────────────────────────────────────────────────

/** Centi-HP → a bare number with no trailing zeros: 300 → "3", 5 → "0.05". */
export function formatHp(centi: number): string {
  const hp = Math.abs(centi) / 100;
  return Number.isInteger(hp) ? String(hp) : String(Number(hp.toFixed(2)));
}

/**
 * The badge that goes on a button: "−3 HP", "+0.5 HP", "0 HP".
 *
 * U+2212 MINUS SIGN, not a hyphen — it aligns with digits and does not wrap away
 * from its number.
 */
export function formatPrice(centi: number): string {
  if (centi === 0) return "0 HP";
  return `${centi < 0 ? "−" : "+"}${formatHp(centi)} HP`;
}

/** The per-message rate chip: "−0.05 HP/msg", or "Free" on the safe lane. */
export function formatRate(centi: number, unitKey: string): string {
  return centi === 0 ? "" : `${formatPrice(-Math.abs(centi))}/${unitKey}`;
}

/** "87.25 / 100" for a meter label. */
export function formatMeter(meter: HpMeter): string {
  return `${formatHp(meter.balanceCenti)} / ${formatHp(meter.maxCenti)}`;
}

/** 0–100, for a progress bar's width. */
export function meterPercent(meter: HpMeter): number {
  if (meter.maxCenti <= 0) return 0;
  return Math.max(0, Math.min(100, (meter.balanceCenti / meter.maxCenti) * 100));
}

/** Regeneration rate as whole HP per hour, for the "+4 HP / hour" line. */
export function regenPerHour(meter: HpMeter): string {
  return formatHp(meter.regenPerHourCenti);
}

/** Coarse band for colouring a meter. Thresholds are presentation only —
 *  nothing behaves differently at 25%. */
export function meterBand(meter: HpMeter): "full" | "ok" | "low" | "empty" {
  const pct = meterPercent(meter);
  if (pct <= 0) return "empty";
  if (pct < 25) return "low";
  if (pct < 75) return "ok";
  return "full";
}

/** Round-trip helper for the tests and the drift check: HP → centi-HP. */
export function hpToCenti(hp: number): number {
  return Math.round(hp * 100);
}

export { MS_PER_DAY as HP_MS_PER_DAY, MS_PER_HOUR as HP_MS_PER_HOUR, MIB as HP_MIB };
