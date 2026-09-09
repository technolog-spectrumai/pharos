// The board on disk, as the frontend sees it.
//
// Three commands over `crates/hoard`, and the one place their error prefixes
// are named — the same shape `transport.ts` gives the collaboration commands
// and `padova`'s `lock.ts` gives the sealing ones.
//
// Behind the `persist` Cargo feature, off by default. A build without it has
// no `board_load` command, the call rejects, and `boardStore()` answers null
// rather than leaving a save button that silently does nothing.

/** Every prefix the persistence chain can return, and nothing else. Pinned
 *  against the Rust by tests/unit/persistErrors.test.ts. */
export const PERSIST_ERRORS = ["store_failed", "board_damaged"] as const;

/** The catalogue key for a Rust error, or null when the message says more as
 *  it came — a filesystem message names the actual problem. */
export function persistErrorKey(message: string): string | null {
  const prefix = message.split(":")[0];
  return (PERSIST_ERRORS as readonly string[]).includes(prefix)
    ? `persist.errors.${prefix}`
    : null;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The bridge, imported ONCE — padova/lock.ts documents the race a per-call
 *  `await import()` of the same specifier can lose. */
let bridge: Promise<typeof import("@tauri-apps/api/core")> | null = null;

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  bridge ??= import("@tauri-apps/api/core");
  const { invoke: call } = await bridge;
  return call<T>(cmd, args);
}

export interface BoardStore {
  save(board: string, snapshot: string): Promise<void>;
  load(board: string): Promise<string | null>;
  forget(board: string): Promise<void>;
}

export function tauriBoardStore(): BoardStore {
  return {
    save: (board, snapshot) => invoke<void>("board_save", { board, snapshot }),
    load: (board) => invoke<string | null>("board_load", { board }),
    forget: (board) => invoke<void>("board_forget", { board }),
  };
}

/** Whether this build can persist at all.
 *
 *  The Rust side is behind a Cargo feature that is off by default, and a build
 *  without it has no `board_load` command: the call rejects and the session
 *  simply does not autosave. Off the desktop there is no Rust at all, so the
 *  answer is no without asking. */
export async function persistAvailable(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    // A board nobody has drawn: answers null on a build that has the command,
    // rejects on one that does not. Reading is the safe probe — a write would
    // create a store to answer a question.
    await tauriBoardStore().load("__probe__");
    return true;
  } catch {
    return false;
  }
}
