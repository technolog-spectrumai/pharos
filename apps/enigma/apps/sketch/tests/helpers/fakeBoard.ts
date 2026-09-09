// A `BoardDoc` for tests, backed by the SAME yrs the app uses.
//
// Not a JS reimplementation of the CRDT: that would test a second
// implementation and prove nothing about the one that ships. This drives the
// real `crates/board` through a tiny Rust helper binary, so a test that says
// "two peers converge" is a statement about the code in production.
//
// The helper is spawned once per document and speaks one JSON request per
// line, which keeps it far cheaper than a process per call.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { resolve } from "node:path";
import type { BoardDoc, Committed, DocView } from "../../src/collab/document";
import type { Shape } from "wisteria/sketchModel";

// Resolved from the test process's cwd (which vitest sets to this app) rather
// than from `import.meta.url`, which Vite rewrites into a `/@fs/...` URL that
// is not a filesystem path.
const BIN = resolve(process.cwd(), "../../target/debug/examples/boardio");

interface Wire {
  shapes: string[];
  update: number[] | null;
  background?: string | null;
  width?: number;
  height?: number;
  bytes?: number[];
  error?: string;
}

/** One board, as a live process. Call `close()` when done. */
export function fakeBoardDoc(): BoardDoc & { close(): void } {
  let child: ChildProcessWithoutNullStreams | null = null;
  let lines: Interface | null = null;
  const pending: Array<(v: Wire) => void> = [];

  function start() {
    if (child) return;
    child = spawn(BIN, [], { stdio: ["pipe", "pipe", "inherit"] });
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const resolve = pending.shift();
      if (resolve) resolve(JSON.parse(line) as Wire);
    });
  }

  function call(op: string, args: Record<string, unknown> = {}): Promise<Wire> {
    start();
    return new Promise<Wire>((resolve, reject) => {
      pending.push((v) => (v.error ? reject(new Error(v.error)) : resolve(v)));
      child!.stdin.write(`${JSON.stringify({ op, ...args })}\n`);
    });
  }

  const parse = (w: Wire): Committed => ({
    shapes: w.shapes.map((s) => JSON.parse(s) as Shape),
    update: w.update,
    background: w.background ?? null,
    width: w.width ?? 0,
    height: w.height ?? 0,
  });
  const commit = (op: string, args?: Record<string, unknown>) => call(op, args).then(parse);

  return {
    reset: () => call("reset").then(() => undefined),
    put: (shape) => commit("put", { id: shape.id, shape: JSON.stringify(shape) }),
    putMany: (shapes) =>
      commit("put_many", { shapes: shapes.map((s) => [s.id, JSON.stringify(s)]) }),
    remove: (ids) => commit("remove", { ids }),
    clear: () => commit("clear"),
    setBackground: (color) => commit("set_background", { color }),
    setSize: (width, height) => commit("set_size", { width, height }),
    read: () =>
      call("read").then(
        (w): DocView => ({
          shapes: w.shapes.map((s) => JSON.parse(s) as Shape),
          background: w.background ?? null,
          width: w.width ?? 0,
          height: w.height ?? 0,
        }),
      ),
    apply: (update) => commit("apply", { update }),
    snapshot: () => call("snapshot").then((w) => w.bytes ?? []),
    stateVector: () => call("state_vector").then((w) => w.bytes ?? []),
    diff: (have) => call("diff", { have }).then((w) => w.bytes ?? []),
    compact: () => commit("compact"),
    close: () => {
      lines?.close();
      child?.kill();
      child = null;
      lines = null;
    },
  };
}
