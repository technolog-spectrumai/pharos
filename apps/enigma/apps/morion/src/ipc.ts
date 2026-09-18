// The one way this app calls Rust.
//
// The Tauri bridge, imported ONCE and shared. Not an optimisation: several
// callers fire at the same moment when the app mounts (the workspace opens,
// the tags load, the Mana status is read), and concurrent `await import()` of
// the same specifier can race — one caller gets the module and another gets a
// half-built one, which surfaces as "__TAURI_INTERNALS__.invoke is not a
// function" for every call but the first. padova's lock.ts met this and fixed
// it the same way; every wrapper in this app goes through here.
let bridge: Promise<typeof import("@tauri-apps/api/core")> | null = null;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  bridge ??= import("@tauri-apps/api/core");
  const { invoke: call } = await bridge;
  return call<T>(cmd, args);
}
