// Privacy MANA — the app-side orchestration: live meters, the confirm gate, the
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
//   if (!(await confirmMana("ticket.export.clearnet"))) return;
//   await doTheRiskyThing();
//   await chargeMana("ticket.export.clearnet");
//
// Charging AFTER the action is deliberate. The meter is supposed to record
// exposure that actually happened; billing up-front would charge for a transfer
// that failed to connect or a room that was never created. It also matches what
// the brief asks the UI to do — show the price on the control, and the "−3 MANA ·
// DHT presence enabled" flash only once it is enabled.
//
// Nothing here can block an action. `confirmMana` asks; a user who says yes at zero
// MANA proceeds exactly as they would at a hundred.

import { computed, ref } from "vue";
import {
  deriveBalances,
  findAction,
  findRecovery,
  formatPrice,
  getManaPolicy,
  getUseTor,
  manaCharge,
  manaDataCredit,
  manaLedger,
  manaRecover,
  manaSetTorPosture,
  needsConfirm,
  priceOf,
  type ManaBalances,
  type ManaEntry,
} from "rakotis";

const EMPTY: ManaEntry[] = [];

/** The ledger as last read from Rust. Every meter derives from this. */
const ledger = ref<ManaEntry[]>(EMPTY);
/** Bumped on a tick so the meters recompute as time passes (regeneration is a
 *  function of `now`, so nothing else changes — this is the whole clock). */
const clock = ref(Date.now());
const loaded = ref(false);

export const manaBalances = computed<ManaBalances>(() =>
  deriveBalances(getManaPolicy(), ledger.value, clock.value),
);

export const manaLoaded = computed(() => loaded.value);
export const manaEntries = computed<readonly ManaEntry[]>(() => ledger.value);

// ── the flash ───────────────────────────────────────────────────────────────

export interface ManaFlashState {
  centi: number;
  /** Already-translated action name, e.g. "DHT presence enabled". */
  label: string;
  /** Distinguishes consecutive identical flashes so the toast re-animates. */
  seq: number;
}

const flash = ref<ManaFlashState | null>(null);
let flashSeq = 0;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

export const manaFlash = computed(() => flash.value);

/** Show "−3 MANA · DHT presence enabled" for a moment. Silent for a no-op — a
 *  re-affirmed toggle or a free Tor lane must not flash "−0 MANA". */
function showFlash(centi: number, code: string): void {
  if (centi === 0) return;
  flash.value = { centi, label: labelFor(code), seq: ++flashSeq };
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flash.value = null;
    flashTimer = null;
  }, 2600);
}

export function dismissManaFlash(): void {
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = null;
  flash.value = null;
}

// ── the confirm gate ────────────────────────────────────────────────────────

export interface ManaConfirmState {
  centi: number;
  label: string;
  explain: string;
  /** True when the meter is empty rather than the price being high. */
  exhausted: boolean;
}

const confirmState = ref<ManaConfirmState | null>(null);
let confirmResolve: ((ok: boolean) => void) | null = null;

export const manaConfirm = computed(() => confirmState.value);

export function resolveManaConfirm(ok: boolean): void {
  confirmState.value = null;
  const fn = confirmResolve;
  confirmResolve = null;
  fn?.(ok);
}

// ── i18n helpers ────────────────────────────────────────────────────────────

// The translator is INJECTED at boot (main.ts) rather than imported.
//
// Importing the app's i18n instance here would make every module that merely
// wants to charge MANA — the composer, the file-share composable, the vox
// composable — pull in the whole message catalog and, through it, rakotis'
// i18n factory. That is a real cost in the app and a needless coupling in tests,
// where charging MANA has nothing to do with which language the UI is in.
//
// Unregistered, labels fall back to the raw action id. That is the correct
// degradation: a ledger row reading "vox.call" is still true.
type ManaTranslator = { t: (key: string) => string; has: (key: string) => boolean };

let translator: ManaTranslator | null = null;

/** Wire the app's i18n into the MANA labels. Called once from main.ts. */
export function setManaTranslator(next: ManaTranslator | null): void {
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

/** The human name of an action or recovery: `mana.action.<camelId>`. */
export function labelFor(code: string): string {
  return t(`mana.action.${camel(code)}`, code);
}

/** The one-sentence explanation the info dot reveals. */
export function explainFor(code: string): string {
  const entry = findAction(getManaPolicy(), code) ?? findRecovery(getManaPolicy(), code);
  const key = entry?.explainKey ?? `mana.explain.${camel(code)}`;
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

/** What `actionId` costs right now, in centi-MANA (negative). 0 if this build has
 *  no such action — a surface gated out at compile time simply has no price. */
export function priceFor(actionId: string, opts: { bytes?: number; minutes?: number } = {}): number {
  const action = findAction(getManaPolicy(), actionId);
  if (!action) return 0;
  return -priceOf(action, opts.bytes ?? 0, opts.minutes ?? 0);
}

/** The credit a recovery would pay if it is owed, in centi-MANA (positive). */
export function creditFor(recoveryId: string): number {
  return findRecovery(getManaPolicy(), recoveryId)?.creditCenti ?? 0;
}

// ── the three verbs ─────────────────────────────────────────────────────────

/**
 * Ask, if asking is warranted. Resolves true when the caller should proceed.
 *
 * Only high and severe prices, or an already-empty meter, raise a dialog —
 * everything cheaper stays one-tap by design.
 */
export function confirmMana(
  actionId: string,
  opts: { bytes?: number; minutes?: number } = {},
): Promise<boolean> {
  const centi = priceFor(actionId, opts);
  const policy = getManaPolicy();
  if (centi === 0) return Promise.resolve(true);
  if (!needsConfirm(policy, centi, manaBalances.value)) return Promise.resolve(true);

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
export async function chargeMana(
  actionId: string,
  opts: { bytes?: number; minutes?: number } = {},
): Promise<void> {
  const delta = await manaCharge(actionId, opts);
  await refreshMana();
  showFlash(delta.applied, delta.code);
}

/** Confirm, run, charge — for the many call sites that need nothing else. */
export async function withMana<T>(
  actionId: string,
  run: () => Promise<T>,
  opts: { bytes?: number; minutes?: number } = {},
): Promise<T | null> {
  if (!(await confirmMana(actionId, opts))) return null;
  const result = await run();
  await chargeMana(actionId, opts);
  return result;
}

/** Award a recovery. Rust decides whether it is owed; a credit that is not owed
 *  returns 0 and shows nothing. */
export async function recoverMana(recoveryId: string): Promise<void> {
  const delta = await manaRecover(recoveryId);
  await refreshMana();
  showFlash(delta.applied, delta.code);
}

/**
 * Tell the ledger which transport posture this profile is running in.
 *
 * Not a charge and not a credit: Tor changes how fast MANA comes back, and this
 * marks where that rate changed so the past is never re-scored. Silent by
 * design — there is no flash, because nothing was spent or earned.
 */
export async function recordTorPosture(on: boolean): Promise<void> {
  if (await manaSetTorPosture(on)) await refreshMana();
}

/** Award for data actually deleted. `bytes` is a hint; Rust measures its own. */
export async function dataCreditMana(sourceId: string, bytes: number): Promise<void> {
  const delta = await manaDataCredit(sourceId, bytes);
  await refreshMana();
  showFlash(delta.applied, delta.code);
}

// ── lifecycle ───────────────────────────────────────────────────────────────

/** Re-read the ledger. Cheap: a handful of sealed day blobs. */
export async function refreshMana(): Promise<void> {
  ledger.value = await manaLedger();
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
export async function startMana(): Promise<void> {
  // Re-assert the posture first: it decides the regeneration rate every meter
  // below is about, and re-asserting is what recovers the marker for a profile
  // whose oldest rows have been pruned. Read from storage rather than taken as
  // an argument, so no caller can start the meters on a stale idea of it.
  await manaSetTorPosture(await getUseTor().catch(() => false)).catch(() => false);
  await refreshMana();
  if (tick) return;
  tick = setInterval(() => {
    clock.value = Date.now();
  }, 30_000);
}

/** Drop everything on lock or profile switch: the next profile's ledger is not
 *  this one's, and a stale meter on the gate would leak one profile's shape. */
export function stopMana(): void {
  if (tick) clearInterval(tick);
  tick = null;
  ledger.value = EMPTY;
  loaded.value = false;
  dismissManaFlash();
  resolveManaConfirm(false);
}

/** Test seam: advance the derived clock without waiting for the interval. */
export function setManaClockForTest(now: number): void {
  clock.value = now;
}

export { formatPrice };
