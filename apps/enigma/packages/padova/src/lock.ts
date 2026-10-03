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
//
// Nothing here imports from an app. That is what lets a second app get the
// sealing surface by depending on this package, and it is why `probeSealed`
// takes a plain path: it used to accept the workspace store's `Entry` too, an
// overload no caller had used since the store started injecting
// `setSealProbe((path) => probeSealed(path))`.

/** Every prefix the sealing chain can return, and nothing else. Pinned against
 *  the Rust by tests/unit/lockErrors.test.ts, which reads the crates. */
export const LOCK_ERRORS = [
  "no_passphrase",
  "wrong_password",
  "already_locked",
  "not_locked",
  "too_large",
  "legacy_format",
  "crypto",
  "changed_on_disk",
  "same_passphrase",
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

/** Where a remembered passphrase is being kept, if one is. */
export type SecretStore = "keychain" | "memory";

export interface SecretStatus {
  remembered: boolean;
  storage: SecretStore | null;
}

/** Encrypt a file in place. No salt: the frame carries its own.
 *
 *  `null` means "use the remembered passphrase", which Rust reads from the OS
 *  secret store itself. There is deliberately no way to fetch it up here — this
 *  app renders markup that arrived in a file. */
export function sealFile(path: string, password: string | null): Promise<SealedInfo> {
  return invoke<SealedInfo>("lock_file", { path, password });
}

/** Decrypt a file in place. A wrong password leaves it untouched. */
export function unsealFile(path: string, password: string | null): Promise<SealedInfo> {
  return invoke<SealedInfo>("unlock_file", { path, password });
}

/** Hand a passphrase to the OS secret store. Answers where it went. */
export function rememberPassphrase(passphrase: string): Promise<SecretStore> {
  return invoke<SecretStore>("secret_remember", { passphrase });
}

export function forgetPassphrase(): Promise<void> {
  return invoke<void>("secret_forget", {});
}

const NO_SECRET: SecretStatus = { remembered: false, storage: null };

/** Whether one is remembered and where — the only two facts that come back.
 *
 *  Normalised rather than trusted. It is a value arriving from outside this
 *  module, and a reply that is not the shape expected must read as "nothing is
 *  remembered" — the safe answer, and the one that keeps a render from throwing
 *  on `undefined.remembered`. */
export async function passphraseStatus(): Promise<SecretStatus> {
  if (!isTauri()) return { ...NO_SECRET };
  const reply = (await invoke<unknown>("secret_status", {})) as Partial<SecretStatus> | undefined;
  if (!reply || typeof reply.remembered !== "boolean") return { ...NO_SECRET };
  return {
    remembered: reply.remembered,
    storage: reply.storage === "keychain" || reply.storage === "memory" ? reply.storage : null,
  };
}

/** Whether a file on disk is sealed — the marker in its first bytes, no
 *  password involved. Answers false off the desktop, where there is no Rust.
 *
 *  This is the ONE function an app can register without offering sealing at
 *  all: `is_file_locked` is substrate's, needs no key material, and is what
 *  draws the padlock. An app that wires only this can badge a sealed file and
 *  refuse to hand it to an editor, while having no command that could open
 *  one. */
export function probeSealed(path: string): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  return invoke<boolean>("is_file_locked", { path });
}
