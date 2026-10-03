// Security Mana, as the page reaches src-tauri/src/mana.rs.
//
// Plain files drain it by the kilobyte-hour, it comes back slowly, and a
// passphrase change earns some. All of that is Rust's: the page asks where the
// bar stands (`refreshMana`), reads the constants once (`loadManaPrices`) to put
// a rate beside each row, and never sends an amount. What lives here besides
// is two dialogs' state — the confirmation before a permanent decrypt or a
// plaintext export, and the prompt that asks for some encryption when the bar
// is empty.
//
// ADVISORY ONLY. At zero the page asks; it never refuses. If the bookkeeping
// fails (a damaged metadata file) the action it describes is not undone.
import { invoke, isTauri } from "../ipc";
import { ref } from "vue";

/** History rows the page may write. A passphrase change is recorded by Rust,
 *  with what it earned. */
export type ManaEvent = "encrypt_file" | "encrypt_folder" | "decrypt_file" | "decrypt_folder";

export interface PlainFile {
  relPath: string;
  path: string;
  bytes: number;
  perHour: number;
}

export interface ManaStatus {
  max: number;
  level: number;
  drainPerHour: number;
  regenPerHour: number;
  /** Regeneration less drain: negative while the bar falls. */
  netPerHour: number;
  plainFiles: number;
  plainBytes: number;
  exhausted: boolean;
  /** The costliest plain files, most expensive first. */
  top: PlainFile[];
  /** The file cap stopped the count. */
  truncated: boolean;
  /** Folders below the depth limit were not counted. */
  deep: boolean;
  /** False in a folder that cannot be written: Mana is then held only while
   *  Morion runs. */
  kept: boolean;
}

export interface ManaPrices {
  max: number;
  perKbHour: number;
  regenPerHour: number;
  rekeyReward: number;
  rekeyCooldownHours: number;
  rekeyDailyCap: number;
}

/** What a file or folder costs plain now, and would cost decrypted. */
export interface ManaRate {
  plainFiles: number;
  plainBytes: number;
  plainPerHour: number;
  sealedFiles: number;
  sealedBytes: number;
  sealedPerHour: number;
}

export interface LedgerRow {
  ts: number;
  action: string;
  path?: string;
  /** Spent — only rows from the earlier price-per-action budget. */
  cost: number;
  /** Earned by a passphrase change. */
  gain?: number;
  note: string;
}

/** Where the bar stands, shared by everything that shows it. */
export const manaStatus = ref<ManaStatus | null>(null);

export async function refreshMana(): Promise<void> {
  if (!isTauri()) return;
  try {
    manaStatus.value = await invoke<ManaStatus>("mana_status");
  } catch {
    manaStatus.value = null;
  }
}

/** The constants, read once: they are compiled into Rust. */
export const manaPrices = ref<ManaPrices | null>(null);
let pricesLoading: Promise<ManaPrices | null> | null = null;

export function loadManaPrices(): Promise<ManaPrices | null> {
  if (!isTauri()) return Promise.resolve(null);
  pricesLoading ??= invoke<unknown>("mana_prices")
    .then((reply) => {
      // Kept only when it is the shape expected; anything else is asked
      // again next time rather than remembered as a price.
      const p = reply as Partial<ManaPrices> | null;
      if (!p || typeof p.perKbHour !== "number") throw new Error("mana_prices: unexpected reply");
      return (manaPrices.value = p as ManaPrices);
    })
    .catch(() => {
      pricesLoading = null;
      return null;
    });
  return pricesLoading;
}

/** Mana an hour for `bytes` of plaintext — `mana::per_hour`, with the price
 *  Rust gave. Null until the price is known. */
export function perHour(bytes: number, prices: ManaPrices | null = manaPrices.value): number | null {
  if (!prices) return null;
  return (bytes / 1024) * prices.perKbHour;
}

/** A rate or a level, short: two decimals under 10, one under 100, whole
 *  above; anything above zero but under a hundredth says so rather than
 *  rounding to a misleading 0. */
export function formatMana(n: number): string {
  const a = Math.abs(n);
  if (a === 0) return "0";
  if (a < 0.01) return n < 0 ? "−<0.01" : "<0.01";
  const digits = a < 10 ? 2 : a < 100 ? 1 : 0;
  const text = String(Number(a.toFixed(digits)));
  return n < 0 ? `−${text}` : text;
}

/** What encrypting or decrypting `path` would change. Null off the desktop
 *  or when Rust cannot say — then the dialogs simply say nothing about Mana. */
export async function manaRate(path: string): Promise<ManaRate | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<ManaRate>("mana_rate", { path });
  } catch {
    return null;
  }
}

/** Note a security event in the history. Never throws. */
export async function manaRecord(event: ManaEvent, path: string | null): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("mana_record", { event, path });
  } catch {
    /* advisory */
  }
}

export async function manaLedger(): Promise<LedgerRow[]> {
  if (!isTauri()) return [];
  return invoke<LedgerRow[]>("mana_ledger");
}

// ── the confirmation ────────────────────────────────────────────────────────
// One dialog, mounted once by the app (ManaConfirm.vue), for an act that
// writes plaintext and has no other dialog of its own: a permanent decrypt
// with a remembered passphrase, an export of an encrypted file. It says what
// the act does and what the plain result will cost an hour.
export interface ManaAsk {
  /** The file or folder, for the dialog's subtitle. */
  name: string;
  /** A catalogue key: what the action does to the file, in words. */
  consequenceKey: string;
  /** Mana an hour the plaintext will cost, when known. */
  adds: number | null;
}

export const manaAsk = ref<ManaAsk | null>(null);
let settle: ((ok: boolean) => void) | null = null;

export function askMana(name: string, consequenceKey: string, adds: number | null): Promise<boolean> {
  // Two asks at once cannot happen through the UI; if one did, the first is
  // answered no rather than left hanging.
  settle?.(false);
  manaAsk.value = { name, consequenceKey, adds };
  return new Promise<boolean>((resolve) => { settle = resolve; });
}

export function answerMana(ok: boolean): void {
  manaAsk.value = null;
  const done = settle;
  settle = null;
  done?.(ok);
}

// ── the prompt ──────────────────────────────────────────────────────────────
// When the bar is empty the app asks the user to encrypt some files
// (ManaPrompt.vue). "empty" is that ask; "asked" is the same dialog opened on
// purpose, from workspace security.
export const manaPrompt = ref<"empty" | "asked" | null>(null);

export function openManaPrompt(reason: "empty" | "asked" = "asked"): void {
  manaPrompt.value = reason;
}
