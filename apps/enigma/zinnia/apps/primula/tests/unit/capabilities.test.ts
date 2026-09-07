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
// Primula opens workbooks, which are JSON someone else may have written, so
// its surface is asserted for the same reason Sketch's is.

const LIB = join(__dirname, "../../src-tauri/src/lib.rs");

function registered(): string[] {
  const rust = readFileSync(LIB, "utf8");
  const block = rust.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!block) throw new Error("no generate_handler! in lib.rs — the surface moved");
  return [...block[1].matchAll(/(\w+)::(\w+)/g)].map((m) => m[2]);
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
