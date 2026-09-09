// The board, as the frontend sees it.
//
// Commands over `crates/board`, and the one place their error prefixes are
// named — the same shape `persist.ts` gives the store and `transport.ts` gives
// the collaboration commands.
//
// Behind the `document` Cargo feature, off by default. A build without it has
// no `doc_read` command, the call rejects, and `documentAvailable()` answers
// false so the session keeps its in-memory board rather than leaving an editor
// whose every stroke silently fails.
//
// # Why the document lives in Rust
//
// It replaces a hand-rolled LWW-element-set that ran here, in TypeScript. The
// CRDT and the store now sit on the same side of the boundary, so `hoard`
// writes the yrs update bytes straight through with no re-encoding, and there
// is one implementation of the merge rather than one per language.
//
// What crosses is shapes as JSON strings — the same bodies this code already
// had. The SVG codec, the geometry and the validation stay here; Rust never
// parses one.

import type { Shape } from "wisteria/sketchModel";

/** Every prefix the document chain can return, and nothing else. Pinned
 *  against the Rust by tests/unit/documentErrors.test.ts. */
export const DOCUMENT_ERRORS = ["document_failed", "bad_update"] as const;

export function documentErrorKey(message: string): string | null {
  const prefix = message.split(":")[0];
  return (DOCUMENT_ERRORS as readonly string[]).includes(prefix)
    ? `document.errors.${prefix}`
    : null;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The bridge, imported ONCE — padova/lock.ts documents the race a per-call
 *  `await import()` of the same specifier can lose. */
let bridge: Promise<typeof import("@tauri-apps/api/core")> | null = null;

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  bridge ??= import("@tauri-apps/api/core");
  const { invoke: call } = await bridge;
  return call<T>(cmd, args);
}

/** What every mutating call answers with: the merged board, and the bytes to
 *  broadcast. `update` is null when nothing actually changed. */
export interface Committed {
  shapes: Shape[];
  update: number[] | null;
}

export interface DocView {
  shapes: Shape[];
  background: string | null;
  width: number;
  height: number;
}

/** The document, as the session uses it.
 *
 *  Shapes cross the boundary as JSON strings and are parsed HERE, so callers
 *  see `Shape` objects throughout and no part of the session deals in strings.
 */
export interface BoardDoc {
  reset(): Promise<void>;
  put(shape: Shape): Promise<Committed>;
  putMany(shapes: Shape[]): Promise<Committed>;
  remove(ids: string[]): Promise<Committed>;
  clear(): Promise<Committed>;
  setBackground(color: string | null): Promise<Committed>;
  setSize(width: number, height: number): Promise<Committed>;
  read(): Promise<DocView>;
  apply(update: number[]): Promise<Committed>;
  snapshot(): Promise<number[]>;
  stateVector(): Promise<number[]>;
  diff(have: number[]): Promise<number[]>;
  compact(): Promise<Committed>;
}

/** Rust answers with `{shapes: string[]}`; the session wants `Shape[]`. */
function parse(raw: { shapes: string[]; update: number[] | null }): Committed {
  return { shapes: raw.shapes.map((s) => JSON.parse(s) as Shape), update: raw.update };
}

export function tauriBoardDoc(): BoardDoc {
  const commit = (cmd: string, args: Record<string, unknown> = {}) =>
    invoke<{ shapes: string[]; update: number[] | null }>(cmd, args).then(parse);
  return {
    reset: () => invoke<void>("doc_reset"),
    put: (shape) => commit("doc_put", { id: shape.id, shape: JSON.stringify(shape) }),
    putMany: (shapes) =>
      commit("doc_put_many", { shapes: shapes.map((s) => [s.id, JSON.stringify(s)]) }),
    remove: (ids) => commit("doc_remove", { ids }),
    clear: () => commit("doc_clear"),
    setBackground: (color) => commit("doc_set_background", { color }),
    setSize: (width, height) => commit("doc_set_size", { width, height }),
    read: () =>
      invoke<{ shapes: string[]; background: string | null; width: number; height: number }>(
        "doc_read",
      ).then((v) => ({ ...v, shapes: v.shapes.map((s) => JSON.parse(s) as Shape) })),
    apply: (update) => commit("doc_apply", { update }),
    snapshot: () => invoke<number[]>("doc_snapshot"),
    stateVector: () => invoke<number[]>("doc_state_vector"),
    diff: (have) => invoke<number[]>("doc_diff", { have }),
    compact: () => commit("doc_compact"),
  };
}

/** Whether this build has the document commands at all.
 *
 *  Reading is the safe probe: it changes nothing and answers on a build that
 *  has the feature, rejects on one that does not. Off the desktop there is no
 *  Rust, so the answer is no without asking. */
export async function documentAvailable(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await tauriBoardDoc().read();
    return true;
  } catch {
    return false;
  }
}
