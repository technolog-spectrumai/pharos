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
  /** Which saved connection this name was validated against. A username is
   *  server-relative — alice@faros and alice@zenobia are different people — and
   *  a room ticket is a BEARER credential that MLS auto-admits, so sealing one
   *  to a chip resolved on another server would hand the room to a stranger.
   *  `ready` therefore refuses any chip whose connection is no longer active. */
  connectionId: string;
}

export interface RecipientPicker {
  draft: Ref<string>;
  recipients: Ref<Recipient[]>;
  ready: ComputedRef<Recipient[]>;
  /** Chips validated against a connection that is no longer active. */
  stale: ComputedRef<Recipient[]>;
  busy: ComputedRef<boolean>;
  canSend: ComputedRef<boolean>;
  atMax: ComputedRef<boolean>;
  max: number;
  commitDraft: () => void;
  add: (username: string) => void;
  remove: (username: string) => void;
  retry: (username: string) => void;
  retryErrored: () => void;
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
  /** The active saved connection. Chips are stamped with it and stop counting
   *  as sendable if it changes — see `Recipient.connectionId`. Optional so the
   *  hook still works standalone in unit tests. */
  connectionId?: () => string;
  /** Why `canResolve` is false right now, for the chip's tooltip. The caller
   *  owns the wording — the reason differs (switched off / airplane / signed
   *  out / server unreachable) and only the caller knows which applies. */
  blockedReason?: () => string;
  /** Feed a failed lookup back to the caller's error classifier. This is the
   *  one networked control the user actually drives, so its failures are the
   *  freshest signal there is — without this hook the picker would learn the
   *  server is down and tell nobody. Returning true means the caller rendered a
   *  proper reason, so the chip shows that instead of the raw machine string. */
  onResolveError?: (message: string) => boolean;
  max?: number;
}): RecipientPicker {
  const max = opts.max ?? DEFAULT_MAX;
  const draft = ref("");
  const recipients = ref<Recipient[]>([]);

  const conn = () => opts.connectionId?.() ?? "";
  /** The hard guarantee: a chip validated against another connection can never
   *  be sent, even if a caller forgets to clear the picker on a switch. */
  const ready = computed(() =>
    recipients.value.filter((r) => r.state === "ok" && r.connectionId === conn()),
  );
  /** Chips left over from a different connection — the panel shows a notice and
   *  offers to re-check them rather than silently dropping what was typed. */
  const stale = computed(() => recipients.value.filter((r) => r.connectionId !== conn()));
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
    // Which connection this answer will describe. If the user switches while it
    // is in flight, the result is about a different server and must not be
    // credited to the new one.
    const at = conn();
    try {
      const ids = await invoke<string[]>("aster_resolve", {
        serverUrl: opts.serverUrl(),
        username,
      });
      // The chip may have been removed while the request was in flight.
      const live = find(username);
      if (!live || conn() !== at) return;
      const others = (ids ?? []).filter((id) => id !== opts.myNodeId());
      live.nodeIds = others;
      live.state = (ids ?? []).length === 0 ? "unknown" : others.length === 0 ? "self" : "ok";
      // A successful re-check re-homes the chip to the connection it was
      // validated against, so Retry is the way back from `stale`.
      live.connectionId = at;
    } catch (e) {
      const live = find(username);
      if (!live || conn() !== at) return;
      live.state = "error";
      const message = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
      // This is the one networked control the user actually drives, so its
      // failures are the freshest reachability signal there is — hand it to the
      // caller's classifier rather than dropping it into a tooltip.
      const handled = opts.onResolveError?.(message) ?? false;
      live.error = handled ? (opts.blockedReason?.() ?? message) : message;
    }
  }

  function add(username: string): void {
    const name = username.trim();
    if (!name || find(name) || atMax.value) return;
    recipients.value.push({
      username: name,
      state: "resolving",
      nodeIds: [],
      error: "",
      connectionId: conn(),
    });
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

  /** Re-resolve every chip that failed OR was validated against another
   *  connection. Chips added while the cloud was unusable are all `error`, and
   *  `canSend` needs at least one `ok` — without this the user would have to
   *  press Retry on each chip individually after the connection came back. */
  function retryErrored(): void {
    if (!opts.canResolve()) return;
    const current = conn();
    for (const r of recipients.value) {
      if (r.state === "error" || r.connectionId !== current) queueResolve(r.username);
    }
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
    draft, recipients, ready, stale, busy, canSend, atMax, max,
    commitDraft, add, remove, retry, retryErrored, clear, keepOnly,
  };
}
