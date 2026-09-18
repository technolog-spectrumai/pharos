// Security Mana, as the page reaches src-tauri/src/mana.rs.
//
// The page never sends an amount: it names an action and a count, Rust looks
// the price up. What lives here is the ask-before, charge-after rhythm and
// the one confirmation dialog every Mana-charging action goes through when no
// other dialog is already on screen for it.
//
// ADVISORY ONLY. An exhausted budget is shown as a warning and the action
// still runs; a failed or cancelled action is never charged; and if charging
// itself fails (a damaged metadata file) the action is not undone for it.
import { invoke, isTauri } from "../ipc";
import { ref } from "vue";

export type ManaAction = "unlock_temp" | "decrypt_file" | "decrypt_folder" | "export_plain" | "tag_sealed";
export type ManaEvent = "encrypt_file" | "encrypt_folder";

export interface ManaStatus {
  dailyMax: number;
  weeklyMax: number;
  dailyLeft: number;
  weeklyLeft: number;
  exhausted: boolean;
}

export interface ManaQuote {
  action: ManaAction;
  count: number;
  cost: number;
  dailyMax: number;
  weeklyMax: number;
  dailyLeft: number;
  weeklyLeft: number;
  dailyAfter: number;
  weeklyAfter: number;
  exhausted: boolean;
}

export interface LedgerRow {
  ts: number;
  action: string;
  path?: string;
  cost: number;
  note: string;
}


/** The current meters, shared by everything that shows them. */
export const manaStatus = ref<ManaStatus | null>(null);

export async function refreshMana(): Promise<void> {
  if (!isTauri()) return;
  try {
    manaStatus.value = await invoke<ManaStatus>("mana_status");
  } catch {
    manaStatus.value = null;
  }
}

/** What `action` would cost now. Null off the desktop or without a workspace:
 *  then there is nothing to show and nothing to charge. */
export async function manaQuote(action: ManaAction, count = 1): Promise<ManaQuote | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<ManaQuote>("mana_quote", { action, count });
  } catch {
    return null;
  }
}

/** Pay for an action that SUCCEEDED. Never throws: the budget is advisory,
 *  and an action that happened must not be reported as failed because its
 *  bookkeeping could not be written. */
export async function manaCharge(action: ManaAction, count: number, path: string | null): Promise<void> {
  if (!isTauri() || count < 1) return;
  try {
    manaStatus.value = await invoke<ManaStatus>("mana_charge", { action, count, path });
  } catch {
    /* advisory; see above */
  }
}

/** Note a zero-cost security event in the history. Never throws. */
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
// One dialog, mounted once by the app (ManaConfirm.vue). `askMana` opens it
// with a quote and resolves with the user's answer. Without a quote — no
// workspace, or off the desktop — there is nothing to confirm and it answers
// yes at once.
export interface ManaAsk {
  quote: ManaQuote;
  /** A catalogue key: what the action does to the file, in words. */
  consequenceKey: string;
  /** The file or folder, for the dialog's subtitle. */
  name: string;
}

export const manaAsk = ref<ManaAsk | null>(null);
let settle: ((ok: boolean) => void) | null = null;

export async function askMana(action: ManaAction, count: number, name: string, consequenceKey: string): Promise<boolean> {
  const quote = await manaQuote(action, count);
  if (!quote) return true;
  // Two asks at once cannot happen through the UI; if one did, the first is
  // answered no rather than left hanging.
  settle?.(false);
  manaAsk.value = { quote, consequenceKey, name };
  return new Promise<boolean>((resolve) => { settle = resolve; });
}

export function answerMana(ok: boolean): void {
  manaAsk.value = null;
  const done = settle;
  settle = null;
  done?.(ok);
}
