// Unified local key/value store backed by SQLite.
//
// In the Tauri runtime (desktop + Android/iOS) this uses the official SQL plugin
// (`@tauri-apps/plugin-sql`). In a plain browser (Vite dev / web build) and under
// vitest (jsdom) the plugin is unavailable, so we fall back to `localStorage`
// with the same API — mirroring the `_isTauri()` pattern in `appStorage.ts`.
//
// It is the single local backing store for:
//   - the offline response cache (api.ts), namespace "cache"
//   - the Notes snapshot + mutation queue (notesOffline.ts), namespaces
//     "notes:snapshot" / "notes:queue"
//
// Rows are keyed by (namespace, scope, key) so different backends (scope =
// server URL) never share data.

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

const DB_URL = "sqlite:enigma.db";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS kv (
  ns TEXT NOT NULL,
  scope TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, scope, k)
)`;

// Cached connection promise — the table is ensured exactly once per process.
let _dbPromise: Promise<any> | null = null;

async function _db(): Promise<any> {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const { default: Database } = await import("@tauri-apps/plugin-sql");
      const db = await Database.load(DB_URL);
      await db.execute(CREATE_TABLE);
      return db;
    })();
  }
  return _dbPromise;
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
  if (_isTauri()) {
    const db = await _db();
    const rows = (await db.select(
      "SELECT v FROM kv WHERE ns = $1 AND scope = $2 AND k = $3",
      [ns, scope, k],
    )) as { v: string }[];
    return rows.length ? rows[0].v : null;
  }
  return localStorage.getItem(_lsKey(ns, scope, k));
}

export async function kvPut(ns: string, scope: string, k: string, v: string): Promise<void> {
  if (_isTauri()) {
    const db = await _db();
    await db.execute(
      `INSERT INTO kv (ns, scope, k, v, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(ns, scope, k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
      [ns, scope, k, v, new Date().toISOString()],
    );
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
    const db = await _db();
    await db.execute("DELETE FROM kv WHERE ns = $1 AND scope = $2 AND k = $3", [ns, scope, k]);
    return;
  }
  localStorage.removeItem(_lsKey(ns, scope, k));
}

export async function kvClearNamespace(ns: string, scope?: string): Promise<void> {
  if (_isTauri()) {
    const db = await _db();
    if (scope === undefined) {
      await db.execute("DELETE FROM kv WHERE ns = $1", [ns]);
    } else {
      await db.execute("DELETE FROM kv WHERE ns = $1 AND scope = $2", [ns, scope]);
    }
    return;
  }
  _lsKeysWithPrefix(_lsPrefix(ns, scope)).forEach((key) => localStorage.removeItem(key));
}

export async function kvCount(ns: string, scope?: string): Promise<number> {
  if (_isTauri()) {
    const db = await _db();
    const rows = (
      scope === undefined
        ? await db.select("SELECT COUNT(*) AS n FROM kv WHERE ns = $1", [ns])
        : await db.select("SELECT COUNT(*) AS n FROM kv WHERE ns = $1 AND scope = $2", [ns, scope])
    ) as { n: number }[];
    return rows.length ? Number(rows[0].n) : 0;
  }
  return _lsKeysWithPrefix(_lsPrefix(ns, scope)).length;
}
