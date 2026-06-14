// Shared HTTP API foundation for Enigma and Aurora.
//
// In the Tauri app, all I/O is owned by the Rust data gateway — the frontend just
// calls commands and never touches the network/cache directly. In a plain browser
// (Vite dev / web build) there is no Rust, so we fall back to fetch + the JS
// silent-mode/cache logic below. Each app subclasses `ApiBase` and adds its own
// domain endpoints; the transport, cache, auth and identity calls live here.

import {
  getAuthToken,
  getServerUrl,
  isServerDataBlocked,
  setAuthToken,
  clearAuthToken,
} from "./appStorage";
import { kvGet, kvPut, kvCount, kvClearNamespace } from "./localDb";
import { isTauri, invoke } from "./tauri";
import type { Participant } from "./types";

// In Tauri, file/image uploads go through the Rust data gateway (Tor-aware) rather
// than a raw XHR — so they work over a .onion. Returns the server's JSON response text.
export async function uploadViaRust(
  path: string,
  field: string,
  file: File,
  extra?: Record<string, string>,
): Promise<string> {
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return invoke<string>("data_upload", {
    path,
    field,
    filename: file.name,
    bytes,
    extra: extra ?? null,
  });
}

// Thrown by egress points when the data layer is off (offline or server-data off).
export const SERVER_OFF_ERROR = "Server data is off — enable it (or go online) in Settings.";

// Thrown when a read is requested with the server off but no local copy exists.
export const SILENT_NO_CACHE = "No offline copy of this data — connect once to download it.";

// Thrown when no server address is set, so requests would otherwise hit the
// local app origin and get HTML back ("Unexpected token '<'" JSON errors).
export const NO_SERVER_ERROR = "No server configured — set a server address in Settings.";

export async function assertServerReachable(): Promise<void> {
  if (await isServerDataBlocked()) throw new Error(SERVER_OFF_ERROR);
}

// ── Offline response cache (kv via localDb) ───────────────────────────────────
// Every successful GET is written through to local storage keyed by
// (server URL, request path); in silent mode reads are served from it so the
// previously-loaded data stays browsable with no network.

const CACHE_NS = "cache";

function cacheScope(serverUrl: string): string {
  return serverUrl.replace(/\/$/, "") || "default";
}

async function cacheGet(scope: string, path: string): Promise<string | null> {
  try {
    return await kvGet(CACHE_NS, scope, path);
  } catch {
    return null;
  }
}

async function cachePut(scope: string, path: string, body: string): Promise<void> {
  try {
    await kvPut(CACHE_NS, scope, path, body);
  } catch {
    /* cache write is best-effort */
  }
}

/** Number of cached responses for a server (shown in Settings). */
export async function countResponseCache(serverUrl: string): Promise<number> {
  if (isTauri()) return invoke<number>("data_cache_count", { serverUrl });
  return kvCount(CACHE_NS, cacheScope(serverUrl));
}

/** Drop all cached responses for a server (Settings → clear local cache). */
export async function clearResponseCache(serverUrl: string): Promise<void> {
  if (isTauri()) {
    await invoke("data_cache_clear", { serverUrl });
    return;
  }
  await kvClearNamespace(CACHE_NS, cacheScope(serverUrl));
}

// ── Shared server response types ──────────────────────────────────────────────

export interface Room {
  id: number;
  name: string;
  slug: string;
  participant_count: number;
  created_at: string;
  is_participant?: boolean;
  participants?: Participant[];
}

export interface Me {
  id: number;
  username: string;
  full_name: string;
  avatar_url: string | null;
  profile_url: string | null;
  language: string;
}

export interface Health {
  ok: boolean;
  service: string;
}

export async function serverBase(): Promise<string> {
  return (await getServerUrl()).replace(/\/$/, "");
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Turn an HTTP status + response body into a human-readable message. Prefers the
 *  server's `{error|detail}` field over the raw body. */
export function httpErrorMessage(status: number, bodyText: string): string {
  const text = (bodyText ?? "").trim();
  try {
    const j = JSON.parse(text);
    if (j && typeof j.error === "string" && j.error) return j.error;
    if (j && typeof j.detail === "string" && j.detail) return j.detail;
  } catch {
    /* not JSON */
  }
  if (status === 401 || status === 403) return text || "Not authorized.";
  return text ? `${status}: ${text}` : `Request failed (HTTP ${status}).`;
}

/** Normalize anything thrown by the Tauri gateway (which rejects with a raw `Err`
 *  string like "401: {...}") or by fetch into a real Error with a useful `.message`,
 *  so every caller and the UI can rely on `.message`. */
export function normalizeApiError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (e == null) return new Error("Request failed.");
  const raw = typeof e === "string" ? e : String((e as { message?: string }).message ?? e);
  const m = /^(\d{3}): ([\s\S]*)$/.exec(raw); // gateway format: "<status>: <body>"
  return new Error(m ? httpErrorMessage(Number(m[1]), m[2]) : raw || "Request failed.");
}

export class ApiBase {
  protected async request<T>(
    path: string,
    init?: RequestInit,
    includeAuth = true,
  ): Promise<T> {
    const method = (init?.method ?? "GET").toUpperCase();

    // Tauri: hand the whole request to the Rust gateway (it owns server URL,
    // auth, silent mode, the cache, and the actual transport).
    if (isTauri()) {
      const body = typeof init?.body === "string" ? init.body : undefined;
      let text: string;
      try {
        text = await invoke<string>("data_http", { method, path, body, includeAuth });
      } catch (e) {
        // Tauri rejects with the command's raw Err string, not an Error — normalize so
        // callers (and the login/join error banners) always get a usable `.message`.
        throw normalizeApiError(e);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    }

    // ── Browser fallback (fetch + JS silent-mode/cache) ──────────────────────
    const base = await serverBase();
    const scope = cacheScope(base);
    const isGet = method === "GET";

    // Server data off (or offline): serve reads from cache, block writes.
    if (await isServerDataBlocked()) {
      if (!isGet) throw new Error(SERVER_OFF_ERROR);
      const cached = await cacheGet(scope, path);
      if (cached !== null) return JSON.parse(cached) as T;
      throw new Error(SILENT_NO_CACHE);
    }

    // No server set → don't fall back to a relative URL (which returns the app's
    // own HTML and yields a cryptic "Unexpected token '<'" JSON error).
    if (!base) throw new Error(NO_SERVER_ERROR);

    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...(includeAuth ? await authHeaders() : {}),
    };

    const res = await fetch(url, {
      credentials: "include",
      headers,
      ...init,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(httpErrorMessage(res.status, text));
    }

    const text = await res.text();
    if (!text) return undefined as T; // e.g. 204 No Content on a delete
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      // HTML/login page instead of JSON — usually a wrong server address.
      throw new Error(
        `Server returned a non-JSON response (HTTP ${res.status}). Check the server address in Settings.`,
      );
    }
    // Write successful reads through to the local store for offline browsing.
    if (isGet) await cachePut(scope, path, text);
    return body;
  }

  // ── Auth / identity (shared by both apps) ──────────────────────────────────

  async login(username: string, password: string): Promise<void> {
    const result = await this.request<{ ok?: boolean; token?: string; error?: string }>(
      "/telegraph/api/login/",
      { method: "POST", body: JSON.stringify({ username, password }) },
    );
    // Defensive: a 2xx without a token (misconfigured server) must not silently "succeed".
    if (!result?.token) {
      throw new Error(result?.error || "Login failed — no session token returned.");
    }
    await setAuthToken(result.token);
  }

  async logout(): Promise<void> {
    await this.request<{ ok: boolean }>("/telegraph/api/logout/", { method: "POST" }).catch(() => {});
    await clearAuthToken();
  }

  getMe(): Promise<Me> {
    return this.request<Me>("/telegraph/api/me/");
  }

  setLanguage(language: string): Promise<{ ok: boolean; language: string; stored: boolean }> {
    return this.request("/telegraph/api/me/", {
      method: "PATCH",
      body: JSON.stringify({ language }),
    });
  }

  health(): Promise<Health> {
    return this.request<Health>("/telegraph/api/health/", {}, false);
  }

  /** Capability descriptor: which feature apps the connected server has installed, so the
   *  client only shows what the backend can serve (portal = all; faros = no graph, etc.). */
  getApps(): Promise<{ apps: Record<string, boolean> }> {
    return this.request<{ apps: Record<string, boolean> }>("/telegraph/api/apps/", {}, false);
  }

  // ── Telegraph rooms (relay chat — shared by both apps' chat) ────────────────

  getRooms(): Promise<{ channels: Room[] }> {
    return this.request<{ channels: Room[] }>("/telegraph/api/channels/");
  }

  getRoom(slug: string): Promise<Room> {
    return this.request<Room>(`/telegraph/api/channels/${slug}/`);
  }

  joinRoom(slug: string): Promise<{ ok: boolean; joined: boolean }> {
    return this.request(`/telegraph/api/channels/${slug}/join/`, { method: "POST" });
  }

  leaveRoom(slug: string): Promise<{ ok: boolean }> {
    return this.request(`/telegraph/api/channels/${slug}/leave/`, { method: "POST" });
  }

  leaveAllRooms(): Promise<{ ok: boolean; left: number }> {
    return this.request("/telegraph/api/channels/leave-all/", { method: "POST" });
  }
}
