// The "who gets in" half of a cloud invite: a chips input over faros usernames.
//
// faros has no user directory an ordinary account can call (the profiles API is
// gated to the data_mesh group and exposes no username), so a username is
// validated one at a time against `aster_resolve`: a non-empty NodeId list means
// "this person has an account here AND has opened Enigma with Cloud on at least
// once", which is exactly the condition for a mailbox drop to land.
//
// Resolution fires on COMMIT (Enter / comma / blur), never per keystroke, so the
// endpoint is never hammered. The NodeIds kept here are advisory — Rust
// re-resolves at send time, which is what closes the gap between checking and
// sending.
import { computed, ref, type ComputedRef, type Ref } from "vue";
import { invoke } from "rakotis";

export type RecipientState = "resolving" | "ok" | "unknown" | "self" | "error";

export interface Recipient {
  /** As typed (trimmed). Chip identity; compared case-insensitively. */
  username: string;
  state: RecipientState;
  /** Resolved NodeIds minus our own — advisory only. */
  nodeIds: string[];
  /** Backend message when state === "error". */
  error: string;
}

export interface RecipientPicker {
  draft: Ref<string>;
  recipients: Ref<Recipient[]>;
  ready: ComputedRef<Recipient[]>;
  busy: ComputedRef<boolean>;
  canSend: ComputedRef<boolean>;
  atMax: ComputedRef<boolean>;
  max: number;
  commitDraft: () => void;
  add: (username: string) => void;
  remove: (username: string) => void;
  retry: (username: string) => void;
  clear: () => void;
  keepOnly: (usernames: string[]) => void;
}

/** Soft cap. faros counts 50 unacknowledged invites per SENDER across every
 *  recipient, and one person can have several devices, so a smaller list keeps
 *  a single fan-out clear of the quota. */
const DEFAULT_MAX = 20;

export function useRecipientPicker(opts: {
  serverUrl: () => string;
  myNodeId: () => string;
  canResolve: () => boolean;
  /** Why `canResolve` is false right now, for the chip's tooltip. The caller
   *  owns the wording — the reason differs (switched off / airplane / signed
   *  out / server unreachable) and only the caller knows which applies. */
  blockedReason?: () => string;
  max?: number;
}): RecipientPicker {
  const max = opts.max ?? DEFAULT_MAX;
  const draft = ref("");
  const recipients = ref<Recipient[]>([]);

  const ready = computed(() => recipients.value.filter((r) => r.state === "ok"));
  const busy = computed(() => recipients.value.some((r) => r.state === "resolving"));
  const canSend = computed(() => ready.value.length > 0 && !busy.value);
  const atMax = computed(() => recipients.value.length >= max);

  const find = (username: string) =>
    recipients.value.find((r) => r.username.toLowerCase() === username.toLowerCase());

  // Resolves run ONE AT A TIME. Committing a pasted "alice, bob" fires several
  // at once, and firing concurrent lookups through the lazily-imported invoke
  // bridge leaves the later ones hanging (proved by the picker unit tests) —
  // besides which, a queue is kinder to the server than a burst.
  let chain: Promise<void> = Promise.resolve();
  function queueResolve(username: string): void {
    chain = chain.then(() => resolve(username)).catch(() => undefined);
  }

  async function resolve(username: string): Promise<void> {
    const entry = find(username);
    if (!entry) return;
    entry.state = "resolving";
    entry.error = "";
    try {
      const ids = await invoke<string[]>("aster_resolve", {
        serverUrl: opts.serverUrl(),
        username,
      });
      // The chip may have been removed while the request was in flight.
      const live = find(username);
      if (!live) return;
      const others = (ids ?? []).filter((id) => id !== opts.myNodeId());
      live.nodeIds = others;
      live.state = (ids ?? []).length === 0 ? "unknown" : others.length === 0 ? "self" : "ok";
    } catch (e) {
      const live = find(username);
      if (!live) return;
      live.state = "error";
      live.error = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
    }
  }

  function add(username: string): void {
    const name = username.trim();
    if (!name || find(name) || atMax.value) return;
    recipients.value.push({ username: name, state: "resolving", nodeIds: [], error: "" });
    if (!opts.canResolve()) {
      const entry = find(name);
      if (entry) {
        entry.state = "error";
        entry.error = opts.blockedReason?.() ?? "";
      }
      return;
    }
    queueResolve(name);
  }

  /** Enter / comma / blur. One paste of "alice, bob" becomes two chips. */
  function commitDraft(): void {
    const parts = draft.value.split(/[,\s]+/).filter(Boolean);
    draft.value = "";
    for (const p of parts) add(p);
  }

  function remove(username: string): void {
    recipients.value = recipients.value.filter(
      (r) => r.username.toLowerCase() !== username.toLowerCase(),
    );
  }

  function retry(username: string): void {
    if (!opts.canResolve()) return;
    queueResolve(username);
  }

  function clear(): void {
    recipients.value = [];
    draft.value = "";
  }

  /** Used by "retry the ones that failed" — keeps order, drops the rest. */
  function keepOnly(usernames: string[]): void {
    const keep = usernames.map((u) => u.toLowerCase());
    recipients.value = recipients.value.filter((r) => keep.includes(r.username.toLowerCase()));
    for (const r of recipients.value) if (r.state !== "ok") retry(r.username);
  }

  return {
    draft, recipients, ready, busy, canSend, atMax, max,
    commitDraft, add, remove, retry, clear, keepOnly,
  };
}
