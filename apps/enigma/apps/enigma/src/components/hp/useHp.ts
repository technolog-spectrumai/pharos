// Privacy HP — the app-side orchestration: live meters, the confirm gate, the
// post-activation flash, and the one place a call site talks to.
//
// The state is module-level (a ref, not a store) for the same reasons `tabs.ts`
// gives: App.vue mounts once for the app's whole lifetime, so anything sampled at
// setup would never update, and the header chip, the welcome page and the Privacy
// tab must all read the *same* numbers rather than three independent copies.
//
// ── the shape of a call site ────────────────────────────────────────────────
// Confirm first, act, then charge — in that order, and never collapsed:
//
//   if (!(await confirmHp("ticket.export.clearnet"))) return;
//   await doTheRiskyThing();
//   await chargeHp("ticket.export.clearnet");
//
// Charging AFTER the action is deliberate. The meter is supposed to record
// exposure that actually happened; billing up-front would charge for a transfer
// that failed to connect or a room that was never created. It also matches what
// the brief asks the UI to do — show the price on the control, and the "−3 HP ·
// DHT presence enabled" flash only once it is enabled.
//
// Nothing here can block an action. `confirmHp` asks; a user who says yes at zero
// HP proceeds exactly as they would at a hundred.

import { computed, ref } from "vue";
import {
  deriveBalances,
  findAction,
  findRecovery,
  formatPrice,
  getHpPolicy,
  hpCharge,
  hpDataCredit,
  hpLedger,
  hpRecover,
  needsConfirm,
  priceOf,
  type HpBalances,
  type HpEntry,
} from "rakotis";

const EMPTY: HpEntry[] = [];

/** The ledger as last read from Rust. Every meter derives from this. */
const ledger = ref<HpEntry[]>(EMPTY);
/** Bumped on a tick so the meters recompute as time passes (regeneration is a
 *  function of `now`, so nothing else changes — this is the whole clock). */
const clock = ref(Date.now());
const loaded = ref(false);

export const hpBalances = computed<HpBalances>(() =>
  deriveBalances(getHpPolicy(), ledger.value, clock.value),
);

export const hpLoaded = computed(() => loaded.value);
export const hpEntries = computed<readonly HpEntry[]>(() => ledger.value);

// ── the flash ───────────────────────────────────────────────────────────────

export interface HpFlashState {
  centi: number;
  /** Already-translated action name, e.g. "DHT presence enabled". */
  label: string;
  /** Distinguishes consecutive identical flashes so the toast re-animates. */
  seq: number;
}

const flash = ref<HpFlashState | null>(null);
let flashSeq = 0;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

export const hpFlash = computed(() => flash.value);

/** Show "−3 HP · DHT presence enabled" for a moment. Silent for a no-op — a
 *  re-affirmed toggle or a free Tor lane must not flash "−0 HP". */
function showFlash(centi: number, code: string): void {
  if (centi === 0) return;
  flash.value = { centi, label: labelFor(code), seq: ++flashSeq };
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash.value = null;
    flashTimer = null;
  }, 2600);
}

export function dismissHpFlash(): void {
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = null;
  flash.value = null;
}

// ── the confirm gate ────────────────────────────────────────────────────────

export interface HpConfirmState {
  centi: number;
  label: string;
  explain: string;
  /** True when the meter is empty rather than the price being high. */
  exhausted: boolean;
}

const confirmState = ref<HpConfirmState | null>(null);
let confirmResolve: ((ok: boolean) => void) | null = null;

export const hpConfirm = computed(() => confirmState.value);

export function resolveHpConfirm(ok: boolean): void {
  confirmState.value = null;
  const fn = confirmResolve;
  confirmResolve = null;
  fn?.(ok);
}

// ── i18n helpers ────────────────────────────────────────────────────────────

// The translator is INJECTED at boot (main.ts) rather than imported.
//
// Importing the app's i18n instance here would make every module that merely
// wants to charge HP — the composer, the file-share composable, the vox
// composable — pull in the whole message catalog and, through it, rakotis'
// i18n factory. That is a real cost in the app and a needless coupling in tests,
// where charging HP has nothing to do with which language the UI is in.
//
// Unregistered, labels fall back to the raw action id. That is the correct
// degradation: a ledger row reading "vox.call" is still true.
type HpTranslator = { t: (key: string) => string; has: (key: string) => boolean };

let translator: HpTranslator | null = null;

/** Wire the app's i18n into the HP labels. Called once from main.ts. */
export function setHpTranslator(next: HpTranslator | null): void {
  translator = next;
}

const t = (key: string, fallback = ""): string => {
  if (!translator) return fallback;
  try {
    return translator.has(key) ? String(translator.t(key)) : fallback;
  } catch {
    return fallback;
  }
};

/** The human name of an action or recovery: `hp.action.<camelId>`. */
export function labelFor(code: string): string {
  return t(`hp.action.${camel(code)}`, code);
}

/** The one-sentence explanation the info dot reveals. */
export function explainFor(code: string): string {
  const entry = findAction(getHpPolicy(), code) ?? findRecovery(getHpPolicy(), code);
  const key = entry?.explainKey ?? `hp.explain.${camel(code)}`;
  return t(key, "");
}

/** "transport.tor.disable" → "transportTorDisable" (the i18n leaf convention). */
function camel(id: string): string {
  return id
    .split(/[._]/)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

// ── prices ──────────────────────────────────────────────────────────────────

/** What `actionId` costs right now, in centi-HP (negative). 0 if this build has
 *  no such action — a surface gated out at compile time simply has no price. */
export function priceFor(actionId: string, opts: { bytes?: number; minutes?: number } = {}): number {
  const action = findAction(getHpPolicy(), actionId);
  if (!action) return 0;
  return -priceOf(action, opts.bytes ?? 0, opts.minutes ?? 0);
}

/** The credit a recovery would pay if it is owed, in centi-HP (positive). */
export function creditFor(recoveryId: string): number {
  return findRecovery(getHpPolicy(), recoveryId)?.creditCenti ?? 0;
}

// ── the three verbs ─────────────────────────────────────────────────────────

/**
 * Ask, if asking is warranted. Resolves true when the caller should proceed.
 *
 * Only high and severe prices, or an already-empty meter, raise a dialog —
 * everything cheaper stays one-tap by design.
 */
export function confirmHp(
  actionId: string,
  opts: { bytes?: number; minutes?: number } = {},
): Promise<boolean> {
  const centi = priceFor(actionId, opts);
  const policy = getHpPolicy();
  if (centi === 0) return Promise.resolve(true);
  if (!needsConfirm(policy, centi, hpBalances.value)) return Promise.resolve(true);

  const exhausted = Math.abs(centi) < policy.confirmAtCenti;
  confirmState.value = {
    centi,
    label: labelFor(actionId),
    explain: explainFor(actionId),
    exhausted,
  };
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve;
  });
}

/** Record the charge and flash the result. Call AFTER the action succeeded. */
export async function chargeHp(
  actionId: string,
  opts: { bytes?: number; minutes?: number } = {},
): Promise<void> {
  const delta = await hpCharge(actionId, opts);
  await refreshHp();
  showFlash(delta.applied, delta.code);
}

/** Confirm, run, charge — for the many call sites that need nothing else. */
export async function withHp<T>(
  actionId: string,
  run: () => Promise<T>,
  opts: { bytes?: number; minutes?: number } = {},
): Promise<T | null> {
  if (!(await confirmHp(actionId, opts))) return null;
  const result = await run();
  await chargeHp(actionId, opts);
  return result;
}

/** Award a recovery. Rust decides whether it is owed; a credit that is not owed
 *  returns 0 and shows nothing. */
export async function recoverHp(recoveryId: string): Promise<void> {
  const delta = await hpRecover(recoveryId);
  await refreshHp();
  showFlash(delta.applied, delta.code);
}

/** Award for data actually deleted. `bytes` is a hint; Rust measures its own. */
export async function dataCreditHp(sourceId: string, bytes: number): Promise<void> {
  const delta = await hpDataCredit(sourceId, bytes);
  await refreshHp();
  showFlash(delta.applied, delta.code);
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/** Re-read the ledger. Cheap: a handful of sealed day blobs. */
export async function refreshHp(): Promise<void> {
  ledger.value = await hpLedger();
  clock.value = Date.now();
  loaded.value = true;
}

let tick: ReturnType<typeof setInterval> | null = null;

/**
 * Start the meters. Called from App.vue's post-unlock loaders — the ledger lives
 * in the vault, so there is nothing to read before then.
 *
 * The interval only advances `clock`; it never touches storage. Regeneration is
 * derived from timestamps, so moving `now` forward is the entire update, and a
 * suspended machine catches up on its first tick rather than drifting.
 */
export async function startHp(): Promise<void> {
  await refreshHp();
  if (tick) return;
  tick = setInterval(() => {
    clock.value = Date.now();
  }, 30_000);
}

/** Drop everything on lock or profile switch: the next profile's ledger is not
 *  this one's, and a stale meter on the gate would leak one profile's shape. */
export function stopHp(): void {
  if (tick) clearInterval(tick);
  tick = null;
  ledger.value = EMPTY;
  loaded.value = false;
  dismissHpFlash();
  resolveHpConfirm(false);
}

/** Test seam: advance the derived clock without waiting for the interval. */
export function setHpClockForTest(now: number): void {
  clock.value = now;
}

export { formatPrice };
