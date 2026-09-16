// The `CacheStore` the offline logic asks for, backed by the Rust commands.
//
// A thin adapter and nothing else: every rule about what is cached, what may
// be pushed and what counts as a conflict lives in `totoapi/api/offline`,
// which knows nothing about Tauri and is tested against a Map. This file is
// the four `invoke` calls that give it a disk.
//
// FAILURE IS A CACHE MISS, NEVER AN EXCEPTION. If the store could not be
// opened — a read-only home, a full disk — Rust answers with an error and this
// turns it into "nothing cached". The editor then behaves exactly as it did
// before offline editing existed: online-only, working. Degrading is the
// correct direction; an editor that will not start because its cache is
// unavailable would be a worse app than the one this replaces.
import { invoke } from "@tauri-apps/api/core";
import type { CacheStore } from "totoapi";

/** Whether the store is usable at all. Read once, so a broken cache does not
 *  mean four failed IPC calls per file. */
let usable: boolean | null = null;

async function attempt<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  if (usable === false) return fallback;
  try {
    const result = await work();
    usable = true;
    return result;
  } catch (err) {
    // Logged rather than swallowed silently: "offline editing is off" is
    // something a person filing a bug needs to be able to discover.
    if (usable === null) console.warn("offline cache unavailable:", err);
    usable = false;
    return fallback;
  }
}

export const cacheStore: CacheStore = {
  async get(key) {
    return attempt(
      async () => (await invoke<string | null>("cache_get", { key })) ?? null,
      null,
    );
  },
  async set(key, value) {
    await attempt(async () => { await invoke("cache_set", { key, value }); }, undefined);
  },
  async remove(key) {
    await attempt(async () => { await invoke("cache_remove", { key }); }, undefined);
  },
  async keys() {
    return attempt(async () => await invoke<string[]>("cache_keys"), []);
  },
};

/** Whether the cache has answered at least once. `null` before the first
 *  call — the UI shows nothing rather than promising either way. */
export function cacheUsable(): boolean | null {
  return usable;
}

/** Test seam: forget what we learned about the store. */
export function __resetCacheProbeForTests(): void {
  usable = null;
}
