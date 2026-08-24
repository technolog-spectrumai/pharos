// Privacy MANA — the policy layer: types, price lookup, meter derivation, copy.
//
// The split with Rust is deliberate and worth stating once. `src-tauri/privacy_mana.rs`
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
// One ambient input, named here so the paragraph above stays true: `formatMana` reads
// the active locale, because Polish writes the decimal point as a comma and the
// halved ladder made most prices fractional — "0,5 MANA", not "0.5 MANA". It is the only
// thing in this file that is not a function of its arguments, and it affects how a
// number is SPELLED, never what it is: every amount is an integer of centi-MANA right
// up to the moment it becomes text.
//
// ── the model in four sentences ──────────────────────────────────────────────
// Every exposing action has one fixed price, shown before the tap. Spending
// subtracts from two meters that differ only in ceiling, window length and
// regeneration rate. Each charge then heals on its own clock, so MANA returns
// without anything being written down. Nothing here blocks anything: a meter at
// zero still lets you act, it just says what the act costs.
//
// ── arithmetic ───────────────────────────────────────────────────────────────
// All amounts are CENTI-MANA (integer hundredths), matching Rust exactly. Floats
// are for display only. A ledger row's `mana` is signed: negative spent, positive
// credited.

// ── types (mirror src-tauri/privacy_mana.rs DTOs) ─────────────────────────────

import { formatNumber } from "./i18n/dateFormat";

export type ManaKind = "toggle" | "event" | "metered";
export type ManaSeverity = "negligible" | "low" | "moderate" | "high" | "severe";

export interface ManaAction {
  id: string;
  kind: ManaKind;
  costCenti: number;
  /** 0 = not billed by size. */
  perMibCenti: number;
  /** 0 = not billed by duration. */
  perMinuteCenti: number;
  /** 0 = uncapped. */
  capPerEventCenti: number;
  explainKey: string;
}

export interface ManaRecovery {
  id: string;
  creditCenti: number;
  /** Non-null = pays only while that action's exposure is live. */
  requires: string | null;
  explainKey: string;
}

export interface ManaDataSource {
  id: string;
  explainKey: string;
}

export interface ManaPolicy {
  version: number;
  confirmAtCenti: number;
  dailyMaxCenti: number;
  dailyRegenCenti: number;
  dailyRegenPerMinutes: number;
  /** The faster period while Tor is on (smaller = faster). */
  dailyTorRegenPerMinutes: number;
  /** Days the ledger chart spans. Not a meter — there is only one of those. */
  historyDays: number;
  recoveryDailyCapCenti: number;
  recoveryWindowCapCenti: number;
  dataPerMibCenti: number;
  dataMinAwardCenti: number;
  dataMaxPerEventCenti: number;
  dataDailyCapCenti: number;
  dataWindowCapCenti: number;
  actions: ManaAction[];
  recoveries: ManaRecovery[];
  dataSources: ManaDataSource[];
}

/** One row of the append-only ledger. Reason codes and numbers only — never a
 *  message, contact, room name, nickname, ticket or path. */
export interface ManaEntry {
  ts: number;
  /** `posture` rows carry no MANA; they mark where the regeneration rate changed. */
  kind: "spend" | "recover" | "posture";
  code: string;
  /** Centi-MANA, signed. */
  mana: number;
  /** Activations this row represents; > 1 only for coalesced metered buckets. */
  n: number;
  /** Hour-bucket id for metered coalescing; 0 otherwise. */
  bucket: number;
}

export interface ManaMeter {
  /** Centi-MANA currently available, clamped to [0, max]. */
  balanceCenti: number;
  maxCenti: number;
  /** What the window currently holds against you, after regeneration. */
  unhealedCenti: number;
  /** Credits inside the window. */
  creditedCenti: number;
  /** Centi-MANA returned per hour AT THE CURRENT POSTURE. */
  regenPerHourCenti: number;
  /** What the rate would be with Tor on — for the "you could be earning" hint. */
  torRegenPerHourCenti: number;
  /** Whether Tor is on right now, per the latest posture marker. */
  torActive: boolean;
  /** Milliseconds until the next whole MANA comes back; null when already full. */
  msToNextMana: number | null;
}

export interface ManaBalances {
  daily: ManaMeter;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MIB = 1024 * 1024;

// ── lookup ──────────────────────────────────────────────────────────────────

export function findAction(policy: ManaPolicy, id: string): ManaAction | null {
  return policy.actions.find((a) => a.id === id) ?? null;
}

export function findRecovery(policy: ManaPolicy, id: string): ManaRecovery | null {
  return policy.recoveries.find((r) => r.id === id) ?? null;
}

/**
 * What one activation costs, in centi-MANA (positive).
 *
 * Mirrors `privacy_mana::metered_cost` in Rust exactly — same integer division,
 * same rounding down, same per-event cap. It has to: this is the number printed
 * on the button, and Rust's is the number written to the ledger. If they ever
 * disagreed, the meter would stop matching what the UI promised.
 */
export function priceOf(action: ManaAction, bytes = 0, minutes = 0): number {
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


/**
 * Invitations — the variant axis is the kind of credential AND the transport.
 *
 * `personal` is sealed to one contact's key; `general` is a bearer code anyone
 * holding it can redeem. That difference dominates the price, and the transport
 * modifies it: both kinds carry an address, and on clearnet an address is an IP.
 */
export function inviteActionId(kind: "personal" | "general", tor: boolean): string {
  return `invite.${kind}.create.${tor ? "tor" : "clearnet"}`;
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

/**
 * The ladder, in centi-MANA. Mirrors `scale:` in privacy_mana.yaml, which `build.rs`
 * pins as literals — so these two must move together. `privacyMana.test.ts` asserts
 * they agree against the fetched policy rather than trusting the comment.
 */
export const HP_RUNGS = {
  negligible: 50,
  low: 150,
  moderate: 250,
  high: 500,
  severe: 1000,
} as const;

/** The ladder rung a price sits on. Drives the badge colour, nothing else. */
export function severityOf(centi: number): ManaSeverity {
  const mana = Math.abs(centi);
  if (mana >= HP_RUNGS.severe) return "severe";
  if (mana >= HP_RUNGS.high) return "high";
  if (mana >= HP_RUNGS.moderate) return "moderate";
  if (mana >= HP_RUNGS.low) return "low";
  return "negligible";
}

/**
 * Confirm high and severe costs, and anything spent from an empty meter.
 * Everything else stays one-tap — a budget that interrupts constantly is one
 * people learn to click through without reading.
 */
export function needsConfirm(policy: ManaPolicy, centi: number, balances?: ManaBalances): boolean {
  if (Math.abs(centi) >= policy.confirmAtCenti) return true;
  if (!balances || centi === 0) return false;
  return balances.daily.balanceCenti <= 0;
}

// ── derivation ──────────────────────────────────────────────────────────────

interface MeterSpec {
  maxCenti: number;
  windowMs: number;
  regenCenti: number;
  regenPerMinutes: number;
  torRegenPerMinutes: number;
}

/** A point where the transport posture changed. */
interface Posture {
  at: number;
  tor: boolean;
}

/**
 * The posture timeline, oldest first.
 *
 * Absent history means Tor off — the shipped default (`features.use_tor`). Rust
 * re-asserts the current posture at every boot, so a profile whose oldest rows
 * have been pruned still has a marker to stand on.
 */
function postures(entries: readonly ManaEntry[]): Posture[] {
  return entries
    .filter((e) => e.kind === "posture")
    .map((e) => ({ at: e.ts, tor: e.code === "transport.tor.on" }))
    .sort((a, b) => a.at - b.at);
}

/** Is Tor on right now? */
export function torActiveNow(entries: readonly ManaEntry[]): boolean {
  const list = postures(entries);
  return list.length > 0 ? list[list.length - 1].tor : false;
}

/** Centi-MANA returned per millisecond at a given posture. */
function ratePerMs(tor: boolean, spec: MeterSpec): number {
  const mins = tor ? spec.torRegenPerMinutes : spec.regenPerMinutes;
  return spec.regenCenti / (mins * MS_PER_MINUTE);
}

/**
 * How much of a charge has healed by `now`, integrated over the posture timeline.
 *
 * Hours spent with Tor on heal at the fast rate and hours without at the slow
 * one, each counted where it actually happened. That piecewise walk is the whole
 * reason posture markers exist: multiplying total elapsed time by whichever rate
 * is *current* would re-heal the past every time the switch moved, so flipping
 * Tor on would jump the meter up and flipping it off would drag it back down.
 * Nothing here moves a balance; it only changes how fast the next minute counts.
 *
 * Continuous rather than stepped, so the bar creeps rather than jumping on the
 * hour. A backwards clock heals nothing rather than un-healing what already had.
 */
function healedRaw(
  entryTs: number,
  now: number,
  spec: MeterSpec,
  timeline: readonly Posture[],
): number {
  if (now <= entryTs) return 0;

  // The posture in force when the charge was made.
  let tor = false;
  for (const p of timeline) {
    if (p.at > entryTs) break;
    tor = p.tor;
  }

  let healed = 0;
  let cursor = entryTs;
  for (const p of timeline) {
    if (p.at <= entryTs) continue;
    if (p.at >= now) break;
    healed += ratePerMs(tor, spec) * (p.at - cursor);
    cursor = p.at;
    tor = p.tor;
  }
  healed += ratePerMs(tor, spec) * (now - cursor);
  return healed;
}

/// Whole centi-MANA healed. The balance is integer, so it floors.
function healedCenti(
  entryTs: number,
  now: number,
  spec: MeterSpec,
  timeline: readonly Posture[],
): number {
  return Math.floor(healedRaw(entryTs, now, spec, timeline));
}

function deriveMeter(entries: readonly ManaEntry[], now: number, spec: MeterSpec): ManaMeter {
  let unhealed = 0;
  let credited = 0;
  // The soonest a whole MANA returns, across every charge still weighing.
  let nextManaAt: number | null = null;
  const timeline = postures(entries);
  const tor = timeline.length > 0 ? timeline[timeline.length - 1].tor : false;

  for (const e of entries) {
    if (now - e.ts >= spec.windowMs) continue; // outside the window entirely
    // Posture rows are timeline, not money: they must not count as spend or
    // credit, and their zero MANA must not dilute anything.
    if (e.kind === "posture") continue;
    if (e.kind === "recover") {
      credited += e.mana;
      continue;
    }
    const owed = Math.abs(e.mana);
    const raw = healedRaw(e.ts, now, spec, timeline);
    const healed = Math.floor(raw);
    const left = owed - healed;
    if (left <= 0) continue;
    unhealed += left;

    // When does this charge next give back a WHOLE MANA? Regeneration is
    // continuous, so something comes back every few seconds — but the UI
    // promises "+1 MANA", and counting down to a hundredth would be a countdown
    // to nothing the user can see. Rounded up to the next whole MANA of this
    // charge, or to the moment it finishes paying if that comes first.
    // Assumes the CURRENT posture holds from here on — the future is not
    // knowable, and a countdown that assumed otherwise would be fiction.
    const perCenti = 1 / ratePerMs(tor, spec);
    const nextWhole = Math.min(owed, (Math.floor(healed / 100) + 1) * 100);
    // From `raw`, not `healed`: the floored value discards up to a full centi of
    // progress already earned, which would show a countdown that never quite
    // reaches zero on time.
    const nextWholeAt = now + Math.ceil((nextWhole - raw) * perCenti);
    // Charges heal independently, so the meter's next visible tick is whichever
    // of them reaches its boundary first.
    if (nextManaAt === null || nextWholeAt < nextManaAt) nextManaAt = nextWholeAt;
  }

  const raw = spec.maxCenti - unhealed + credited;
  const balance = Math.max(0, Math.min(spec.maxCenti, raw));
  return {
    balanceCenti: balance,
    maxCenti: spec.maxCenti,
    unhealedCenti: unhealed,
    creditedCenti: credited,
    regenPerHourCenti: Math.floor(
      (spec.regenCenti * 60) / (tor ? spec.torRegenPerMinutes : spec.regenPerMinutes),
    ),
    torRegenPerHourCenti: Math.floor((spec.regenCenti * 60) / spec.torRegenPerMinutes),
    torActive: tor,
    msToNextMana: balance >= spec.maxCenti || nextManaAt === null ? null : Math.max(0, nextManaAt - now),
  };
}

/**
 * Both meters, from the ledger alone.
 *
 * Deterministic: the same rows plus the same `now` always give the same balance,
 * on any device, in any timezone, with nothing cached. The window ROLLS rather
 * than resetting at a calendar boundary — no midnight to double-collect across,
 * and no local-date arithmetic to disagree with Rust about.
 *
 * Being a pure function of (rows, now) is what makes the history chart possible:
 * `manaHistory` below simply calls this at a series of past instants. There is no
 * stored timeline to keep in step, and it works with no network.
 */
export function deriveBalances(
  policy: ManaPolicy,
  entries: readonly ManaEntry[],
  now: number,
): ManaBalances {
  return {
    daily: deriveMeter(entries, now, {
      maxCenti: policy.dailyMaxCenti,
      windowMs: MS_PER_DAY,
      regenCenti: policy.dailyRegenCenti,
      regenPerMinutes: policy.dailyRegenPerMinutes,
      torRegenPerMinutes: policy.dailyTorRegenPerMinutes,
    }),
  };
}

/** One sample on the history chart. */
export interface ManaSample {
  /** Epoch ms of the sample. */
  t: number;
  /** The daily meter's balance at that instant, in centi-MANA. */
  centi: number;
}

/** How finely the history is sampled. */
export type ManaTick = "hour" | "day";

/**
 * The daily meter's balance over the last `days`, as a series to draw.
 *
 * Reconstructed rather than recorded. `deriveBalances` is a pure function of
 * (rows, now), so the balance at any past instant is just that function called
 * with a past `now` — which means there is no timeline to persist, nothing to
 * keep in step with the ledger, and no way for the chart to disagree with the
 * number above it. It also means the whole thing works offline: the rows are
 * already on the device, and no clock but the local one is consulted.
 *
 * `tick` chooses the resolution. "hour" gives 169 points over a week — enough to
 * see a single afternoon's drain — and "day" gives 8, which is the shape of a
 * habit. Neither costs anything to switch between, since both are derived on
 * demand from the same rows.
 *
 * Samples before the ledger's retention window are still meaningful: rows that
 * fell out of the 24-hour meter window simply do not count towards them, which is
 * exactly what the meter itself did at that moment.
 */
export function manaHistory(
  policy: ManaPolicy,
  entries: readonly ManaEntry[],
  now: number,
  tick: ManaTick = "hour",
  days = policy.historyDays,
): ManaSample[] {
  const step = tick === "hour" ? MS_PER_HOUR : MS_PER_DAY;
  const span = days * MS_PER_DAY;
  const start = now - span;
  const out: ManaSample[] = [];
  // Walk forward from the oldest so the series reads left-to-right, and land the
  // LAST sample exactly on `now` — a chart whose final point is up to an hour
  // stale next to a live number is the kind of small lie that erodes trust in it.
  for (let t = start; t < now; t += step) {
    out.push({ t, centi: deriveBalances(policy, entries, t).daily.balanceCenti });
  }
  out.push({ t: now, centi: deriveBalances(policy, entries, now).daily.balanceCenti });
  return out;
}

/**
 * An SVG polyline `points` string for `samples`, fitted to a `w`×`h` box.
 *
 * Drawn by hand rather than by a chart library: the app ships offline, a
 * dependency for one polyline would be the largest thing in the bundle it is
 * used by, and the y-axis here is not data-driven — it is always 0..max, because
 * a chart that rescaled to the data would make a quiet week look like a crisis.
 */
export function manaSparkline(
  samples: readonly ManaSample[],
  maxCenti: number,
  w = 100,
  h = 32,
): string {
  if (samples.length === 0 || maxCenti <= 0) return "";
  if (samples.length === 1) return `0,${h} ${w},${h}`;
  const span = samples.length - 1;
  return samples
    .map((s, i) => {
      const x = (i / span) * w;
      // SVG y grows downward, so a full meter sits at the top.
      const y = h - Math.max(0, Math.min(1, s.centi / maxCenti)) * h;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/** One bar of the per-day chart, in the same 0..w / 0..h box as the polyline. */
export interface ManaBar {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Epoch ms of the day this bar covers, for the label and the title text. */
  t: number;
  centi: number;
}

/**
 * `samples` as bars rather than a line.
 *
 * The per-day view draws the SAME series the per-hour one does — the meter's
 * balance — so switching the dropdown changes how the history is drawn and never
 * what it measures. Bars suit the coarser view because eight of them read as
 * eight discrete days, where a line through eight points invites you to believe
 * in the slope between them, which is an artefact of sampling and not something
 * that happened.
 *
 * A zero balance still gets a hairline so the day is visibly present rather than
 * missing — "you were at zero" and "there is no data" must not look the same.
 */
export function manaBars(
  samples: readonly ManaSample[],
  maxCenti: number,
  w = 100,
  h = 32,
): ManaBar[] {
  if (samples.length === 0 || maxCenti <= 0) return [];
  const slot = w / samples.length;
  const barW = Math.max(1, slot * 0.7);
  const pad = (slot - barW) / 2;
  return samples.map((s, i) => {
    const frac = Math.max(0, Math.min(1, s.centi / maxCenti));
    const barH = Math.max(0.6, frac * h);
    return { x: i * slot + pad, y: h - barH, w: barW, h: barH, t: s.t, centi: s.centi };
  });
}

/** Is `actionId`'s exposure live — charged and not since withdrawn? Mirrors
 *  `privacy_mana::exposure_live`; the UI uses it to label a toggle "active". */
export function exposureLive(
  policy: ManaPolicy,
  entries: readonly ManaEntry[],
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

export interface ManaHistoryRow {
  ts: number;
  code: string;
  /** Signed centi-MANA. */
  mana: number;
  kind: "spend" | "recover";
  n: number;
  /** Centi-MANA of this charge that has already regenerated (0 for credits). */
  healedCenti: number;
  /** True once regeneration has fully paid this charge back. */
  settled: boolean;
}

/**
 * The "Why did this change?" view: newest first, with how much of each charge has
 * since healed — which is the actual answer to the question, since nothing is
 * written when MANA returns.
 */
export function historyRows(
  policy: ManaPolicy,
  entries: readonly ManaEntry[],
  now: number,
  limit = 100,
): ManaHistoryRow[] {
  const spec: MeterSpec = {
    maxCenti: policy.dailyMaxCenti,
    windowMs: MS_PER_DAY,
    regenCenti: policy.dailyRegenCenti,
    regenPerMinutes: policy.dailyRegenPerMinutes,
    torRegenPerMinutes: policy.dailyTorRegenPerMinutes,
  };
  const timeline = postures(entries);
  return [...entries]
    // Posture markers are not events the user "did"; they belong to the rate,
    // not to the list of what cost or earned MANA.
    .filter((e): e is ManaEntry & { kind: "spend" | "recover" } => e.kind !== "posture")
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((e) => {
      const owed = Math.abs(e.mana);
      const healed =
        e.kind === "spend" ? Math.min(owed, healedCenti(e.ts, now, spec, timeline)) : 0;
      return {
        ts: e.ts,
        code: e.code,
        mana: e.mana,
        kind: e.kind,
        n: e.n ?? 1,
        healedCenti: healed,
        settled: e.kind === "spend" && healed >= owed,
      };
    });
}

// ── display ─────────────────────────────────────────────────────────────────

/** Centi-MANA → a bare number with no trailing zeros: 300 → "3", 5 → "0.05". */
export function formatMana(centi: number): string {
  // `maximumFractionDigits: 2` also trims the trailing zeros that the old
  // `Number(mana.toFixed(2))` round-trip existed to remove.
  return formatNumber(Math.abs(centi) / 100, { maximumFractionDigits: 2 });
}

/**
 * The badge that goes on a button: "−3 MANA", "+0.5 MANA", "0 MANA".
 *
 * U+2212 MINUS SIGN, not a hyphen — it aligns with digits and does not wrap away
 * from its number.
 */
export function formatPrice(centi: number): string {
  if (centi === 0) return "0 MANA";
  return `${centi < 0 ? "−" : "+"}${formatMana(centi)} MANA`;
}

/** The per-message rate chip: "−0.05 MANA/msg", or "Free" on the safe lane. */
export function formatRate(centi: number, unitKey: string): string {
  return centi === 0 ? "" : `${formatPrice(-Math.abs(centi))}/${unitKey}`;
}

/** "87.25 / 100" for a meter label. */
export function formatMeter(meter: ManaMeter): string {
  return `${formatMana(meter.balanceCenti)} / ${formatMana(meter.maxCenti)}`;
}

/** 0–100, for a progress bar's width. */
export function meterPercent(meter: ManaMeter): number {
  if (meter.maxCenti <= 0) return 0;
  return Math.max(0, Math.min(100, (meter.balanceCenti / meter.maxCenti) * 100));
}

/** Regeneration rate as whole MANA per hour, for the "+4 MANA / hour" line. */
export function regenPerHour(meter: ManaMeter): string {
  return formatMana(meter.regenPerHourCenti);
}

/** Coarse band for colouring a meter. Thresholds are presentation only —
 *  nothing behaves differently at 25%. */
export function meterBand(meter: ManaMeter): "full" | "ok" | "low" | "empty" {
  const pct = meterPercent(meter);
  if (pct <= 0) return "empty";
  if (pct < 25) return "low";
  if (pct < 75) return "ok";
  return "full";
}

/** Round-trip helper for the tests and the drift check: MANA → centi-MANA. */
export function manaToCenti(mana: number): number {
  return Math.round(mana * 100);
}

export { MS_PER_DAY as HP_MS_PER_DAY, MS_PER_HOUR as HP_MS_PER_HOUR, MIB as HP_MIB };
