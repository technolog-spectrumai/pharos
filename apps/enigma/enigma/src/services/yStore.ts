// Frontend gate to the Rust CRDT-backed local data store (y_store.rs).
//
// Server data (missions, notes, events, locations) is ingested into per-`doc` yrs
// documents persisted with fjall, then read back as a JSON projection — so it survives
// restarts and is viewable offline, and (for the synced domains) is the surface the p2p
// sync layer exchanges.
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

/**
 * Persist freshly fetched server records into a `doc`/`map` and return the canonical
 * projection. Outside Tauri (or on any failure) returns `records` unchanged so the UI
 * still renders the live payload.
 */
export async function persist<T>(doc: string, map: string, records: T[]): Promise<T[]> {
  if (!_isTauri()) return records;
  try {
    await _invoke<number>("y_store_ingest", { doc, map, records });
    return await _invoke<T[]>("y_store_snapshot", { doc, map });
  } catch {
    return records;
  }
}

/**
 * Authoritative mirror: make `doc`/`map` hold exactly `records` (upsert changed, remove
 * missing). Use for server-wins refresh and full-snapshot persistence. Returns the
 * projection; outside Tauri / on failure returns `records` unchanged.
 */
export async function replace<T>(doc: string, map: string, records: T[]): Promise<T[]> {
  if (!_isTauri()) return records;
  try {
    await _invoke<number>("y_store_replace", { doc, map, records });
    return await _invoke<T[]>("y_store_snapshot", { doc, map });
  } catch {
    return records;
  }
}

/**
 * Read the cached projection for a `doc`/`map` (e.g. when the network is down).
 * Returns `null` outside Tauri or when nothing is cached, so callers can decide on a
 * fallback.
 */
export async function cached<T>(doc: string, map: string): Promise<T[] | null> {
  if (!_isTauri()) return null;
  try {
    return await _invoke<T[]>("y_store_snapshot", { doc, map });
  } catch {
    return null;
  }
}
