// Frontend gate to the Rust CRDT-backed mission data layer (mission_store.rs).
//
// Missions fetched over HTTP are ingested into a per-project yrs document persisted
// with fjall, then read back as a JSON projection — so they survive restarts and are
// viewable offline. This is storage only: there is no editing or p2p sync yet.
//
// All commands are Tauri-only (no fjall in a plain browser / vitest). Every call is
// best-effort: outside Tauri, or if the store is unavailable, callers fall back to the
// raw HTTP payload — mirroring the `_isTauri()` guard used across the services layer.

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Logical record set within a project's document. */
export type MissionMap = "missions" | "details";

/**
 * Persist freshly fetched server records into the data layer and return the
 * canonical projection. Outside Tauri (or on any failure) returns `records`
 * unchanged so the UI still renders the live payload.
 */
export async function persist<T>(projectId: number, map: MissionMap, records: T[]): Promise<T[]> {
  if (!_isTauri()) return records;
  try {
    await _invoke<number>("mission_store_ingest", { projectId, map, records });
    return await _invoke<T[]>("mission_store_snapshot", { projectId, map });
  } catch {
    return records;
  }
}

/**
 * Read the cached projection for a project (e.g. when the network is down).
 * Returns `null` outside Tauri or when nothing is cached, so callers can decide
 * on a fallback.
 */
export async function cached<T>(projectId: number, map: MissionMap): Promise<T[] | null> {
  if (!_isTauri()) return null;
  try {
    return await _invoke<T[]>("mission_store_snapshot", { projectId, map });
  } catch {
    return null;
  }
}
