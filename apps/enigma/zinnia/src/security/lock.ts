// The three sealing commands, and the one place their error prefixes are named.
//
// Rust answers `prefix: prose`. The prefix is the contract and the prose is for
// a log — so a prefix with no `lock.errors.*` key renders as raw Rust in the
// dialog, which is how a real error reads as a crash. That list used to live
// inline in LockModal.vue where nothing could test it against either the
// catalogues or lock.rs; it lives here so both can be asserted.
//
// These commands take a PATH and Rust opens it with `std::fs`, so the fs
// plugin's scope does not gate them — they will seal anything they are handed.
// The only caller offers rows from the folder the user picked. Do not add a
// free-text path field.
import type { Entry } from "../files/useWorkspace";

/** Every prefix src-tauri/src/lock.rs can return, and nothing else. */
export const LOCK_ERRORS = [
  "wrong_password",
  "already_locked",
  "not_locked",
  "too_large",
  "legacy_format",
  "crypto",
] as const;

/** The catalogue key for a Rust error, or null when the message is more useful
 *  as it came (a filesystem message has no key and says more verbatim than
 *  "something failed" would). */
export function lockErrorKey(message: string): string | null {
  const prefix = message.split(":")[0];
  return (LOCK_ERRORS as readonly string[]).includes(prefix)
    ? `lock.errors.${prefix}`
    : null;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The Tauri bridge, imported ONCE.
 *
 *  Cached rather than imported per call, and not as an optimisation: probing a
 *  folder fires one call per file at the same moment, and concurrent
 *  `await import()` of the same specifier can race — one caller gets the module
 *  and another gets a half-built one, which surfaces as
 *  "__TAURI_INTERNALS__.invoke is not a function" for every call but the first.
 *  The parked cloud transport hit this and fixed it the same way. */
let bridge: Promise<typeof import("@tauri-apps/api/core")> | null = null;

/** Argon2id runs inside two of these, so they are slow by design — around a
 *  second. Rust marks both `#[tauri::command(async)]` so the window keeps
 *  painting while it happens. */
async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  bridge ??= import("@tauri-apps/api/core");
  const { invoke: call } = await bridge;
  return call<T>(cmd, args);
}

export interface SealedInfo {
  name: string;
  size: number;
}

/** Encrypt a file in place. No salt: the frame carries its own. */
export function sealFile(path: string, password: string): Promise<SealedInfo> {
  return invoke<SealedInfo>("lock_file", { path, password });
}

/** Decrypt a file in place. A wrong password leaves it untouched. */
export function unsealFile(path: string, password: string): Promise<SealedInfo> {
  return invoke<SealedInfo>("unlock_file", { path, password });
}

/** Whether a file on disk is sealed — the marker in its first bytes, no
 *  password involved. Answers false off the desktop, where there is no Rust. */
export function probeSealed(entry: Entry | string): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  const path = typeof entry === "string" ? entry : entry.path;
  return invoke<boolean>("is_file_locked", { path });
}
