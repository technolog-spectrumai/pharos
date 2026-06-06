// When running inside the Tauri desktop app, all storage goes through Rust via
// invoke(). In a plain browser (Vite dev server, web build) we fall back to
// localStorage so the app remains functional without the desktop runtime.

const _isTauri = (): boolean =>
  typeof window !== "undefined" &&
  !!(window as any).__TAURI_INTERNALS__;

// Lazy import so vite doesn't blow up during tree-shaking when Tauri is absent.
async function _invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ── localStorage keys used in browser-fallback mode ──────────────────────────
const LS_SERVER_URL  = "enigma:server_url";
const LS_AUTH_TOKEN  = "enigma:auth_token";
const LS_SILENT_MODE = "enigma:silent_mode";
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

// ── Core auth / server URL (used by api.ts — must work in both runtimes) ─────

export async function getServerUrl(): Promise<string> {
  if (_isTauri()) return _invoke<string>("app_get_server_url");
  return localStorage.getItem(LS_SERVER_URL) ?? DEFAULT_SERVER;
}

export async function setServerUrl(serverUrl: string): Promise<void> {
  if (_isTauri()) { await _invoke("app_set_server_url", { serverUrl }); return; }
  localStorage.setItem(LS_SERVER_URL, serverUrl);
}

export async function getAuthToken(): Promise<string | null> {
  if (_isTauri()) return _invoke<string | null>("app_get_auth_token");
  return localStorage.getItem(LS_AUTH_TOKEN);
}

export async function setAuthToken(authToken: string): Promise<void> {
  if (_isTauri()) { await _invoke("app_set_auth_token", { authToken }); return; }
  localStorage.setItem(LS_AUTH_TOKEN, authToken);
}

export async function clearAuthToken(): Promise<void> {
  if (_isTauri()) { await _invoke("app_clear_auth_token"); return; }
  localStorage.removeItem(LS_AUTH_TOKEN);
}

// ── Silent mode ───────────────────────────────────────────────────────────────
// A purely client-side network gate: when on, Enigma refuses to open any
// connection to the server (REST, uploads, WebSocket). It is stored in
// localStorage in both runtimes — the Rust side never needs this value, so no
// dedicated Tauri command is required (the desktop webview has localStorage).

export async function getSilentMode(): Promise<boolean> {
  if (_isTauri()) return _invoke<boolean>("app_get_silent_mode");
  return localStorage.getItem(LS_SILENT_MODE) === "1";
}

export async function setSilentMode(silent: boolean): Promise<void> {
  if (_isTauri()) { await _invoke("app_set_silent_mode", { silent }); return; }
  if (silent) localStorage.setItem(LS_SILENT_MODE, "1");
  else localStorage.removeItem(LS_SILENT_MODE);
}

// ── Tauri-only functions (degrade gracefully in browser) ──────────────────────

export async function getRuntimeConfig(): Promise<AppRuntimeConfig> {
  if (_isTauri()) return _invoke<AppRuntimeConfig>("app_get_runtime_config");
  return { profile: "browser", identity: "browser", profile_state_path: "" };
}

export async function setActiveProfile(
  profile: string,
  identity?: string,
): Promise<AppRuntimeConfig> {
  if (_isTauri()) return _invoke<AppRuntimeConfig>("app_set_active_profile", { profile, identity });
  return { profile, identity: identity ?? profile, profile_state_path: "" };
}

export async function getProfileState(): Promise<AppProfileState> {
  if (_isTauri()) return _invoke<AppProfileState>("app_get_profile_state");
  return {
    server_url: await getServerUrl(),
    auth_token: await getAuthToken(),
    offline_profile: { display_name: "", email: "", phone: "", bio: "", date_of_birth: "" },
    offline_profiles: [],
    selected_offline_profile_id: "",
  };
}

export async function clearProfileState(): Promise<AppProfileState> {
  if (_isTauri()) return _invoke<AppProfileState>("app_clear_profile_state");
  await clearAuthToken();
  return getProfileState();
}

export async function getOfflineProfile(): Promise<OfflineProfile> {
  if (_isTauri()) return _invoke<OfflineProfile>("app_get_offline_profile");
  return { display_name: "", email: "", phone: "", bio: "", date_of_birth: "" };
}

export async function setOfflineProfile(offlineProfile: OfflineProfile): Promise<void> {
  if (_isTauri()) { await _invoke("app_set_offline_profile", { offlineProfile }); return; }
}

export async function clearOfflineProfile(): Promise<AppProfileState> {
  if (_isTauri()) return _invoke<AppProfileState>("app_clear_offline_profile");
  return getProfileState();
}

export async function setSelectedOfflineProfile(
  selectedOfflineProfileId: string,
): Promise<AppProfileState> {
  if (_isTauri()) return _invoke<AppProfileState>("app_set_selected_offline_profile", { selectedOfflineProfileId });
  return getProfileState();
}

export async function loadOfflineProfile(label: string): Promise<AppProfileState> {
  if (_isTauri()) return _invoke<AppProfileState>("app_load_offline_profile", { label });
  return getProfileState();
}

export async function upsertOfflineProfile(
  offlineProfileId: string,
  label: string,
  offlineProfile: OfflineProfile,
): Promise<AppProfileState> {
  if (_isTauri()) {
    return _invoke<AppProfileState>("app_upsert_offline_profile", {
      offlineProfileId, label, offlineProfile,
    });
  }
  return getProfileState();
}
