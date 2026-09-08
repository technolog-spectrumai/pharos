// The collaboration transport, as the frontend sees it.
//
// Rust holds the endpoint, the topic and the admission gate (crates/collab,
// registered by src-tauri/src/collab.rs); this module is the bridge to those
// five commands and the ONE place their wire shapes and error prefixes are
// named. The session composable takes a `CollabTransport`, never `invoke` —
// so a test can hand it an in-memory bus and drive two sessions against each
// other with no Tauri and no network, which is how convergence is proven
// (tests/unit/collabSession.test.ts).
//
// Nothing here knows what a shape is. The frames carry bytes; what the bytes
// mean is the session's business, and one day another app's.

/** Must match `collab::frame::PROTO_V`. A peer on another version is refused
 *  by the host's gate before its nonce is even looked at. */
export const PROTO_V = 1;

/** A frame as serde writes `collab::Frame`: externally tagged, so a struct
 *  variant is `{ Op: { … } }` and a unit variant is the bare string. `bytes`
 *  cross the IPC as a JSON array of numbers — small for an op or a stroke, a
 *  known cost for a snapshot, and revisited with a raw channel if it shows. */
export type WireFrame =
  | { Hello: { proto: number; nonce: number[] } }
  | { Welcome: { proto: number; width: number; height: number } }
  | { Op: { seq: number; bytes: number[] } }
  | { Snapshot: { seq: number; width: number; height: number; bytes: number[] } }
  | { Live: { bytes: number[] } }
  | { Cursor: { x: number; y: number } }
  | "Resync"
  | "Bye";

/** `collab::Event`, tagged by `kind`. `admitted` and `refused` reach the host
 *  only; `frame` arrives only from a peer the gate has let through. */
export type CollabEvent =
  | { kind: "peer_up"; peer: string }
  | { kind: "peer_down"; peer: string }
  | { kind: "admitted"; peer: string; sas: string }
  | { kind: "refused"; peer: string; reason: string }
  | { kind: "frame"; from: string; frame: WireFrame }
  | { kind: "lagged" }
  | { kind: "closed" };

export interface CollabStatus {
  active: boolean;
  endpoint_id: string | null;
}

export interface CollabTransport {
  /** Start hosting. Resolves to the ticket text — what the QR encodes. */
  host(onEvent: (e: CollabEvent) => void): Promise<string>;
  /** Join from a ticket. Resolves to the six digits this side shows. */
  join(ticket: string, onEvent: (e: CollabEvent) => void): Promise<{ sas: string }>;
  send(frame: WireFrame): Promise<void>;
  close(): Promise<void>;
  status(): Promise<CollabStatus>;
}

/** Every prefix the collaboration chain can return, and nothing else. Pinned
 *  against the Rust by tests/unit/collabErrors.test.ts, which reads the crate
 *  and the shim — the same guard padova's `LOCK_ERRORS` has. */
export const COLLAB_ERRORS = [
  "bad_ticket",
  "ticket_expired",
  "ticket_spent",
  "bad_nonce",
  "bad_version",
  "bind_failed",
  "subscribe_failed",
  "send_failed",
  "bad_addr",
  "bad_frame",
  "no_session",
  "not_joined",
  // The group key (crates/collab/src/mls.rs), behind the `collab-mls` build.
  // All eight are grouped as one message to the user: the distinction between
  // a failed key package and a failed commit is a log-level detail, and what
  // they can DO about any of them is the same — start the pairing again.
  "mls_init",
  "mls_create",
  "mls_key_package",
  "mls_add_member",
  "mls_join",
  "mls_encrypt",
  "mls_decrypt",
  "mls_missing",
] as const;

/** The catalogue key for a Rust error, or null when the message is more
 *  useful as it came. */
export function collabErrorKey(message: string): string | null {
  const prefix = message.split(":")[0];
  return (COLLAB_ERRORS as readonly string[]).includes(prefix)
    ? `collab.errors.${prefix}`
    : null;
}

export function toBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

export function fromBytes(bytes: number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The Tauri bridge, imported ONCE — padova/lock.ts explains the race that a
 *  per-call `await import()` of the same specifier can lose. */
let bridge: Promise<typeof import("@tauri-apps/api/core")> | null = null;

async function core() {
  bridge ??= import("@tauri-apps/api/core");
  return bridge;
}

/** The real thing: five `invoke`s and a `Channel` for events.
 *
 *  A channel, not `listen`: it is handed to one command and reaches one
 *  window, so nothing filters events by session id on this side and a second
 *  window can never see another session's frames. The argument name `onEvent`
 *  is what tauri derives from the Rust parameter `on_event`. */
export function tauriTransport(): CollabTransport {
  async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    const { invoke: call } = await core();
    return call<T>(cmd, args);
  }
  async function channel(onEvent: (e: CollabEvent) => void) {
    const { Channel } = await core();
    const ch = new Channel<CollabEvent>();
    ch.onmessage = onEvent;
    return ch;
  }
  return {
    async host(onEvent) {
      return invoke<string>("collab_host", { onEvent: await channel(onEvent) });
    },
    async join(ticket, onEvent) {
      return invoke<{ sas: string }>("collab_join", { ticket, onEvent: await channel(onEvent) });
    },
    send: (frame) => invoke<void>("collab_send", { frame }),
    close: () => invoke<void>("collab_close", {}),
    status: () => invoke<CollabStatus>("collab_status", {}),
  };
}

/** Whether this build can collaborate at all.
 *
 *  The Rust side is behind a Cargo feature that is off by default, and a
 *  build without it has no `collab_status` command: the call rejects and the
 *  Collab tab hides itself. Without this probe a default build would ship a
 *  tab whose every button fails — the gap the plan's review flagged. Off the
 *  desktop there is no Rust at all, so the answer is no without asking. */
export async function collabAvailable(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const status = await tauriTransport().status();
    return typeof status?.active === "boolean";
  } catch {
    return false;
  }
}
