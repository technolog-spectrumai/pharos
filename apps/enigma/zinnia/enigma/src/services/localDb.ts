// Unified local key/value store.
//
// In the Tauri runtime (desktop + Android/iOS) this goes through Rust via
// invoke() to a fjall-backed store (see src-tauri/src/kv.rs) — pure Rust, no
// libsqlite3-sys, so it doesn't collide with the sqlite arti links in for Tor.
// In a plain browser (Vite dev / web build) and under vitest (jsdom) invoke is
// unavailable, so we fall back to `localStorage` with the same API — mirroring
// the `_isTauri()` pattern in `appStorage.ts`.
//
// It is the single local backing store for:
//   - the offline response cache (api.ts), namespace "cache"
//   - the Notes snapshot + mutation queue (notesOffline.ts), namespaces
//     "notes:snapshot" / "notes:queue"
//
// Entries are keyed by (namespace, scope, key) so different backends (scope =
// server URL) never share data.

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

// Lazy import so vite doesn't blow up during tree-shaking when Tauri is absent.
async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ── localStorage fallback helpers ────────────────────────────────────────────

function _lsKey(ns: string, scope: string, k: string): string {
  return `enigma:db:${ns}:${scope}:${k}`;
}

function _lsPrefix(ns: string, scope?: string): string {
  return scope === undefined ? `enigma:db:${ns}:` : `enigma:db:${ns}:${scope}:`;
}

function _lsKeysWithPrefix(prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) out.push(key);
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function kvGet(ns: string, scope: string, k: string): Promise<string | null> {
  if (_isTauri()) return _invoke<string | null>("kv_get", { ns, scope, k });
  return localStorage.getItem(_lsKey(ns, scope, k));
}

export async function kvPut(ns: string, scope: string, k: string, v: string): Promise<void> {
  if (_isTauri()) {
    await _invoke("kv_put", { ns, scope, k, v });
    return;
  }
  try {
    localStorage.setItem(_lsKey(ns, scope, k), v);
  } catch {
    /* storage full / unavailable — stay in-memory */
  }
}

export async function kvDelete(ns: string, scope: string, k: string): Promise<void> {
  if (_isTauri()) {
    await _invoke("kv_delete", { ns, scope, k });
    return;
  }
  localStorage.removeItem(_lsKey(ns, scope, k));
}

export async function kvClearNamespace(ns: string, scope?: string): Promise<void> {
  if (_isTauri()) {
    await _invoke("kv_clear_namespace", { ns, scope });
    return;
  }
  _lsKeysWithPrefix(_lsPrefix(ns, scope)).forEach((key) => localStorage.removeItem(key));
}

export async function kvCount(ns: string, scope?: string): Promise<number> {
  if (_isTauri()) return _invoke<number>("kv_count", { ns, scope });
  return _lsKeysWithPrefix(_lsPrefix(ns, scope)).length;
}
