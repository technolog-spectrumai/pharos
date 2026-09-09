import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// What this app puts on its IPC surface, asserted against the Rust.
//
// The split's security argument rests on one sentence: **the code is shared,
// the registration is not.** Padova's crate can seal and unseal, and every app
// links it — but a command only exists for the webview if this app's
// `generate_handler!` names it. That list is the whole capability boundary, and
// it is one line of Rust away from silently widening.
//
// Sketch is the app that matters most here. It opens `.svg` files, which are
// markup that arrived from somewhere else, and it is the only app whose editor
// renders a document the user did not write. So its surface is asserted, not
// assumed.

const LIB = join(__dirname, "../../src-tauri/src/lib.rs");

/** Every `module::command` inside `generate_handler![ ... ]`.
 *
 *  Three things this must survive, each found the hard way:
 *  * The block ends at the macro's `])`, NOT at the first `]`. A lazy match
 *    stopped at the `]` of an `#[cfg(feature = "…")]` attribute INSIDE the
 *    block and silently dropped that command and every one after it — the
 *    guard got weaker without failing.
 *  * Attributes and comments are stripped before scanning, so `#[cfg(...)]`
 *    cannot contribute a false name and `// padova::recall is never …` cannot
 *    trip the forbidden-name test.
 *  * A floor on the count, because an empty list passes every "nothing
 *    unexpected" assertion vacuously. */
export function registeredIn(rust: string): string[] {
  const block = rust.match(/generate_handler!\[([\s\S]*?)\]\s*\)/);
  if (!block) throw new Error("no generate_handler! in lib.rs — the surface moved");
  const body = block[1]
    .replace(/#\[[^\]]*\]/g, " ")   // attributes: #[cfg(...)], #[allow(...)]
    .replace(/\/\/[^\n]*/g, " ");    // line comments
  return [...body.matchAll(/(\w+)::(\w+)/g)].map((m) => m[2]);
}

function registered(): string[] {
  const names = registeredIn(readFileSync(LIB, "utf8"));
  // The six sealing commands are the floor every app has; fewer means the
  // parser broke, not that the surface shrank.
  if (names.length < 6) throw new Error(`only ${names.length} commands parsed — the scanner is broken`);
  return names;
}

describe("this app's IPC surface", () => {
  it("registers the detection command, because the padlock needs it", () => {
    // `is_file_locked` is substrate's: it reads the first bytes of a file and
    // needs no key material at all. Every app has it, and having it is what
    // lets the file tree badge a sealed file and refuse to hand ciphertext to
    // an editor.
    expect(registered()).toContain("is_file_locked");
  });

  it("names every command exactly once", () => {
    const names = registered();
    expect(new Set(names).size, names.join(", ")).toBe(names.length);
  });

  it("registers nothing outside the known sealing surface", () => {
    // The guard that matters: a NEW command appearing here should be a
    // deliberate act, not something that arrives with a merge. If this fails,
    // decide whether the command belongs on this app's surface — do not just
    // widen the list.
    const ALLOWED = new Set([
      "lock_file", "unlock_file", "is_file_locked",
      "secret_remember", "secret_forget", "secret_status",
      // Collaboration, behind the `collab` Cargo feature (off by default). The
      // scanner sees past the `#[cfg]` on each entry, so they are listed here
      // whether or not a given build compiles them. Five shims over
      // crates/collab; none of them returns anything but a ticket string, a
      // six-digit auth string, or a status — the document itself only ever
      // moves as frames the session's admission gate has passed.
      "collab_host", "collab_join", "collab_send", "collab_close", "collab_status",
      // Persistence, behind the `persist` Cargo feature (off by default). Three
      // shims over crates/hoard. None of them reads or writes anything but a
      // board: `board_save` takes an id and opaque document bytes, so this
      // surface cannot put a key, a ticket or a peer id on disk even by
      // accident — which is what keeps the collaboration layer's "no group key
      // persisted, no stable identity" decisions true.
      "board_save", "board_load", "board_forget",
      // The document, behind the `document` Cargo feature (off by default).
      // Thirteen shims over crates/board, the yrs CRDT that replaced a
      // hand-rolled one in the frontend. Every one of them moves SHAPES: a
      // shape body as JSON in, the merged board out, and yrs update bytes for
      // the peer. None takes a key, a passphrase or a path, and the crate
      // behind them does not know what a rectangle is — so this surface can
      // no more leak key material than `board_save` can.
      "doc_reset", "doc_put", "doc_put_many", "doc_remove", "doc_clear",
      "doc_set_background", "doc_set_size", "doc_read", "doc_apply",
      "doc_snapshot", "doc_state_vector", "doc_diff", "doc_compact",
    ]);
    const unexpected = registered().filter((n) => !ALLOWED.has(n));
    expect(unexpected).toEqual([]);
  });

  it("never registers a command that hands the passphrase back", () => {
    // Padova's `recall` is pub(crate) and pinned by a compile_fail doctest, so
    // no shim COULD return it today. This is the second lock on that door: a
    // command whose name says it reads the secret out must never appear here,
    // whatever the Rust side allows.
    const forbidden = registered().filter((n) => /recall|reveal|get_pass|read_secret/i.test(n));
    expect(forbidden).toEqual([]);
  });
});

describe("the surface scanner itself", () => {
  // The scanner is what every assertion above rests on, so its own failure
  // modes are pinned against a fixture rather than trusted.
  const FIXTURE = `
    .invoke_handler(tauri::generate_handler![
        lock::lock_file,
        // padova::recall is never registered — a comment, not a command
        #[cfg(feature = "collab")]
        collab::collab_host,
        #[cfg(feature = "collab")]
        collab::collab_join,
        secrets::secret_status,
    ])
    .setup(|app| {`;

  it("sees past a #[cfg] attribute to the commands after it", () => {
    expect(registeredIn(FIXTURE)).toEqual([
      "lock_file", "collab_host", "collab_join", "secret_status",
    ]);
  });

  it("does not read a comment as a registration", () => {
    expect(registeredIn(FIXTURE)).not.toContain("recall");
  });

  it("does not read an attribute's own text as a command", () => {
    expect(registeredIn(FIXTURE).every((n) => !n.includes("cfg"))).toBe(true);
  });
});
