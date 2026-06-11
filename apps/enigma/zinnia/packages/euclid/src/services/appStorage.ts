// Auth / server / profile storage abstraction shared by Enigma and Aurora.
//
// When running inside the Tauri desktop app, all storage goes through Rust via
// invoke(). In a plain browser (Vite dev server, web build) we fall back to
// localStorage so the app remains functional without the desktop runtime.

import { isTauri, invoke } from "./tauri";

// ── localStorage keys used in browser-fallback mode ──────────────────────────
const LS_SERVER_URL     = "enigma:server_url";
const LS_AUTH_TOKEN     = "enigma:auth_token";
const LS_SERVER_DATA    = "enigma:server_data";
const LS_SERVER_ONION   = "enigma:server_is_onion";
const LS_OFFLINE        = "enigma:offline";
const DEFAULT_SERVER = "http://localhost:8000";

// ── Public types ──────────────────────────────────────────────────────────────

export interface OfflineProfile {
  display_name: string;
  email: string;
  phone: string;
  bio: string;
  date_of_birth: string;
}

export interface AppProfileState {
  server_url: string;
  auth_token: string | null;
  server_is_onion: boolean;
  offline_profile: OfflineProfile;
  offline_profiles: OfflineProfileOption[];
  selected_offline_profile_id: string;
}

export interface OfflineProfileOption {
  id: string;
  label: string;
  profile: OfflineProfile;
}

export interface AppRuntimeConfig {
  profile: string;
  identity: string;
  profile_state_path: string;
}

// ── Core auth / server URL (used by apiBase — must work in both runtimes) ─────

export async function getServerUrl(): Promise<string> {
  if (isTauri()) return invoke<string>("app_get_server_url");
  return localStorage.getItem(LS_SERVER_URL) ?? DEFAULT_SERVER;
}

export async function setServerUrl(serverUrl: string): Promise<void> {
  if (isTauri()) { await invoke("app_set_server_url", { serverUrl }); return; }
  localStorage.setItem(LS_SERVER_URL, serverUrl);
}

export async function getAuthToken(): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("app_get_auth_token");
  return localStorage.getItem(LS_AUTH_TOKEN);
}

export async function setAuthToken(authToken: string): Promise<void> {
  if (isTauri()) { await invoke("app_set_auth_token", { authToken }); return; }
  localStorage.setItem(LS_AUTH_TOKEN, authToken);
}

export async function clearAuthToken(): Promise<void> {
  if (isTauri()) { await invoke("app_clear_auth_token"); return; }
  localStorage.removeItem(LS_AUTH_TOKEN);
}

// ── Server data (on / off) ────────────────────────────────────────────────────
// On (default) → use the server for the data layer (REST/uploads). Off → don't
// touch the server for data; reads come from the local cache. Does not affect chat.

export async function getServerData(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>("app_get_server_data");
  return localStorage.getItem(LS_SERVER_DATA) !== "off";
}

export async function setServerData(on: boolean): Promise<void> {
  if (isTauri()) { await invoke("app_set_server_data", { on }); return; }
  localStorage.setItem(LS_SERVER_DATA, on ? "on" : "off");
}

// ── Server is onion (Tor) ─────────────────────────────────────────────────────
// On → the server address is a .onion; route HTTP + WS through the embedded Tor
// client instead of connecting directly. Default off.

export async function getServerIsOnion(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>("app_get_server_is_onion");
  return localStorage.getItem(LS_SERVER_ONION) === "on";
}

export async function setServerIsOnion(on: boolean): Promise<void> {
  if (isTauri()) { await invoke("app_set_server_is_onion", { on }); return; }
  localStorage.setItem(LS_SERVER_ONION, on ? "on" : "off");
}

// ── Offline / airplane mode (online / offline) ─────────────────────────────────
// On → block EVERY network connection: server HTTP, relay WS, and P2P (iroh).

export async function getOffline(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>("app_get_offline");
  return localStorage.getItem(LS_OFFLINE) === "on";
}

export async function setOffline(offline: boolean): Promise<void> {
  if (isTauri()) { await invoke("app_set_offline", { offline }); return; }
  localStorage.setItem(LS_OFFLINE, offline ? "on" : "off");
}

// The data layer is blocked when offline, or when server data is switched off.
export async function isServerDataBlocked(): Promise<boolean> {
  return (await getOffline()) || !(await getServerData());
}

// ── Tauri-only functions (degrade gracefully in browser) ──────────────────────

export async function getRuntimeConfig(): Promise<AppRuntimeConfig> {
  if (isTauri()) return invoke<AppRuntimeConfig>("app_get_runtime_config");
  return { profile: "browser", identity: "browser", profile_state_path: "" };
}

export async function setActiveProfile(
  profile: string,
  identity?: string,
): Promise<AppRuntimeConfig> {
  if (isTauri()) return invoke<AppRuntimeConfig>("app_set_active_profile", { profile, identity });
  return { profile, identity: identity ?? profile, profile_state_path: "" };
}

export async function getProfileState(): Promise<AppProfileState> {
  if (isTauri()) return invoke<AppProfileState>("app_get_profile_state");
  return {
    server_url: await getServerUrl(),
    auth_token: await getAuthToken(),
    server_is_onion: await getServerIsOnion(),
    offline_profile: { display_name: "", email: "", phone: "", bio: "", date_of_birth: "" },
    offline_profiles: [],
    selected_offline_profile_id: "",
  };
}

export async function clearProfileState(): Promise<AppProfileState> {
  if (isTauri()) return invoke<AppProfileState>("app_clear_profile_state");
  await clearAuthToken();
  return getProfileState();
}

export async function getOfflineProfile(): Promise<OfflineProfile> {
  if (isTauri()) return invoke<OfflineProfile>("app_get_offline_profile");
  return { display_name: "", email: "", phone: "", bio: "", date_of_birth: "" };
}

export async function setOfflineProfile(offlineProfile: OfflineProfile): Promise<void> {
  if (isTauri()) { await invoke("app_set_offline_profile", { offlineProfile }); return; }
}

export async function clearOfflineProfile(): Promise<AppProfileState> {
  if (isTauri()) return invoke<AppProfileState>("app_clear_offline_profile");
  return getProfileState();
}

export async function setSelectedOfflineProfile(
  selectedOfflineProfileId: string,
): Promise<AppProfileState> {
  if (isTauri()) return invoke<AppProfileState>("app_set_selected_offline_profile", { selectedOfflineProfileId });
  return getProfileState();
}

export async function loadOfflineProfile(label: string): Promise<AppProfileState> {
  if (isTauri()) return invoke<AppProfileState>("app_load_offline_profile", { label });
  return getProfileState();
}

export async function upsertOfflineProfile(
  offlineProfileId: string,
  label: string,
  offlineProfile: OfflineProfile,
): Promise<AppProfileState> {
  if (isTauri()) {
    return invoke<AppProfileState>("app_upsert_offline_profile", {
      offlineProfileId, label, offlineProfile,
    });
  }
  return getProfileState();
}
