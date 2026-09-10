// The connection to a platform server, as the UI sees it.
//
// A module-level store, not a Pinia store: there is exactly one connection per
// window and its lifetime is the app's. What is NOT here is the token — it
// lives in the OS keyring and is only ever read inside Rust, so nothing on this
// side can leak it or accidentally log it.
import { reactive, readonly } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  createClient, tauriFetch, load, save, EMPTY,
  type ApiClient, type PlatformSettings,
} from "totoapi";

/** This app's own localStorage key. Per app by decision — tex_editor and
 *  tex_editor may point at different servers, and one shared key would make
 *  connecting one silently move the other. */
const SETTINGS_KEY = "tex_editor:platform";

export interface SessionState {
  /** "" until connected. The normalised URL Rust returned — never recomputed
   *  here, because that string keys the stored credential. */
  server: string;
  username: string;
  /** The token's own label, as the person typed it when minting it. Two
   *  machines on one account are otherwise indistinguishable. */
  label: string;
  connected: boolean;
  /** `keychain` or `memory`. A session that will not survive a restart should
   *  say so rather than look permanent. */
  storage: string;
  /** The fingerprint the user accepted for this server, if any. */
  fingerprint: string;
  busy: boolean;
  error: string;
}

const state = reactive<SessionState>({
  server: "", username: "", label: "", connected: false,
  storage: "", fingerprint: "", busy: false, error: "",
});

export const session = readonly(state);

function settings(): PlatformSettings {
  return { server: state.server, fingerprint: state.fingerprint };
}

/** The API client, bound to whatever the session currently points at.
 *
 *  A getter rather than a module constant: the base URL changes when somebody
 *  connects, and a client captured at import time would keep calling the old
 *  one. `getToken` returns null because the token never reaches JavaScript —
 *  `tauriFetch` routes through Rust, which attaches it. */
export function client(): ApiClient {
  return createClient({
    baseUrl: state.server || "https://unconfigured.invalid",
    getToken: () => null,
    fetchImpl: tauriFetch(settings),
  });
}

/** What this app remembers between launches. Non-secret by construction. */
export function restore(): void {
  const stored = load(SETTINGS_KEY);
  state.server = stored.server;
  state.fingerprint = stored.fingerprint;
}

/** Ask the OS store whether this machine already holds a token for that server.
 *
 *  Local only — it runs on every launch and must not depend on the server being
 *  reachable to answer a question about local state. */
export async function refresh(): Promise<void> {
  if (!state.server) return;
  try {
    const info = await invoke<{
      signed_in: boolean; username: string | null; label: string | null;
      server: string; storage: string | null;
    }>("platform_status", { serverUrl: state.server });
    state.connected = info.signed_in;
    state.username = info.username ?? "";
    state.label = info.label ?? "";
    state.storage = info.storage ?? "";
  } catch {
    // A store this app cannot read is "not connected", not an error state on
    // launch.
    state.connected = false;
  }
}

/** Look at a server before asking for a token. */
export async function probe(serverUrl: string) {
  return invoke<{
    reachable: boolean; tls: string; fingerprint: string | null;
    reason: string | null;
  }>("platform_probe", { serverUrl });
}

/** Verify a pasted token and remember it.
 *
 *  The token is a parameter and nothing else: it goes straight to Rust, which
 *  writes it to the OS store. The caller clears its own field as soon as this
 *  returns. */
export async function connect(
  serverUrl: string, token: string, fingerprint = "",
): Promise<void> {
  state.busy = true;
  state.error = "";
  try {
    const info = await invoke<{
      username: string | null; label: string | null;
      server: string; storage: string | null;
    }>("platform_connect", {
      serverUrl, token, fingerprint: fingerprint || null,
    });
    // Rust's normalised form, stored verbatim — see totoapi's frozen URL rule.
    state.server = info.server;
    state.username = info.username ?? "";
    state.label = info.label ?? "";
    state.storage = info.storage ?? "";
    state.fingerprint = fingerprint;
    state.connected = true;
    save(SETTINGS_KEY, settings());
  } catch (err) {
    state.connected = false;
    state.error = String(err);
    throw err;
  } finally {
    state.busy = false;
  }
}

/** Forget the token on THIS machine.
 *
 *  NOT revocation, and the UI must not call it that: the token stays valid
 *  until somebody revokes it on the server's Compute Capsules desk. */
export async function forget(): Promise<void> {
  if (state.server) await invoke("platform_forget", { serverUrl: state.server });
  state.connected = false;
  state.username = "";
  state.label = "";
  state.storage = "";
}

/** Test seam. Not exported from the app's own barrel — component tests need to
 *  put the store into a connected state without a Tauri bridge. */
export function __setStateForTests(patch: Partial<SessionState>): void {
  Object.assign(state, patch);
}

export function __resetForTests(): void {
  Object.assign(state, {
    server: "", username: "", label: "", connected: false,
    storage: "", fingerprint: "", busy: false, error: "",
  });
  try { localStorage.removeItem(SETTINGS_KEY); } catch { /* no store in node */ }
}

export { EMPTY, SETTINGS_KEY };
