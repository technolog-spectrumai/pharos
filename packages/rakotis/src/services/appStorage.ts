// Profile / runtime storage abstraction for the serverless Vesper app.
//
// When running inside the Tauri desktop app, all storage goes through Rust via
// invoke(). In a plain browser (Vite dev server, vitest jsdom) we fall back to
// localStorage so the app remains functional without the desktop runtime.

import { isTauri, invoke } from "./tauri";
import { kvGet, kvPut } from "./localDb";

// ── localStorage keys used in browser-fallback mode ──────────────────────────
const LS_OFFLINE = "vesper:offline";

// ── Public types ──────────────────────────────────────────────────────────────

export interface OfflineProfile {
  display_name: string;
  email: string;
  phone: string;
  bio: string;
  date_of_birth: string;
  /** The user's picture as a small JPEG data URL ("" = none). Shared to room
   *  members over encrypted presence. Optional: profiles saved before this
   *  field existed load without it. */
  avatar?: string;
}

export interface AppProfileState {
  offline_profile: OfflineProfile;
  offline_profiles: OfflineProfileOption[];
  selected_offline_profile_id: string;
  offline?: boolean;
  use_tor?: boolean;
  stable_onion?: boolean;
}

/** Encryption-at-rest vault state (Tauri only). `exists` = a passphrase has been
 *  set; `unlocked` = the key is in memory this session. */
export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
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

// ── Build config (compile-time — src-tauri/build_config.yaml) ─────────────────
// Baked into the Rust binary by build.rs and fetched ONCE at boot via
// `app_get_build_config` (initBuildConfig below, awaited in main.ts before
// mount). In a plain browser there is no binary, so the fallback applies —
// the app may seed it from its own config via initBuildConfig(fallback).

/** One `{default, min, max}` triple of a user-tunable setting. The kv store
 *  keeps the runtime value; the build config only seeds and bounds it. */
export interface SettingClamp {
  default: number;
  min: number;
  max: number;
}

export interface BuildConfig {
  app_name: string;
  app_identifier: string;
  app_version: string;
  /** PIN unlock: a short in-session re-unlock after an idle lock. The passphrase
   *  still opens the vault at cold start — the PIN never protects data at rest. */
  pin_unlock: boolean;
  stable_onion_default: boolean;
  connect_timeout_secs: SettingClamp;
  chat_history_cap_msgs: SettingClamp;
  /** Auto-lock: minutes of inactivity before the vault re-locks. 0 = never. */
  idle_lock_mins: SettingClamp;
  /** Digits in the unlock PIN. */
  pin_digits: SettingClamp;
}

// Mirrors build_config.yaml (Enigma).
const FALLBACK_BUILD_CONFIG: BuildConfig = {
  app_name: "Enigma",
  app_identifier: "com.spectrumaipl.enigma",
  app_version: "0.1.0",
  pin_unlock: true,
  stable_onion_default: false,
  connect_timeout_secs: { default: 60, min: 5, max: 600 },
  chat_history_cap_msgs: { default: 500, min: 50, max: 5000 },
  idle_lock_mins: { default: 15, min: 0, max: 120 },
  pin_digits: { default: 6, min: 4, max: 12 },
};

let buildConfig: BuildConfig = FALLBACK_BUILD_CONFIG;

/** Fetch the build config once at boot (await before mounting the app). In the
 *  browser the optional `fallback` patch applies instead (e.g. the app's own
 *  shipped defaults); in Tauri the binary's values always win. */
export async function initBuildConfig(fallback?: Partial<BuildConfig>): Promise<BuildConfig> {
  if (fallback) buildConfig = { ...buildConfig, ...fallback };
  if (isTauri()) {
    try {
      buildConfig = await invoke<BuildConfig>("app_get_build_config");
    } catch {
      /* keep the fallback — browser-equivalent behavior */
    }
  }
  return buildConfig;
}

/** The build config as fetched at boot (fallback until initBuildConfig ran). */
export function getBuildConfig(): BuildConfig {
  return buildConfig;
}

// ── Offline / airplane mode (online / offline) ─────────────────────────────────
// On → block EVERY network connection (the app is serverless, so this means all
// P2P). Enforced by the Rust command gate.

export async function getOffline(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>("app_get_offline");
  return localStorage.getItem(LS_OFFLINE) === "on";
}

export async function setOffline(offline: boolean): Promise<void> {
  if (isTauri()) { await invoke("app_set_offline", { offline }); return; }
  localStorage.setItem(LS_OFFLINE, offline ? "on" : "off");
}

// ── Tor ─────────────────────────────────────────────────────────────────────
// Enigma (Pharos) has one transport: every room is hosted and dialled as an
// onion service. Kept as a function so call sites read the same as before.

export async function getUseTor(): Promise<boolean> {
  return true;
}

// ── Keep onion stable (persist the Tor .onion, encrypted at rest) ──────────────

export async function getStableOnion(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>("app_get_stable_onion");
  return localStorage.getItem("vesper:stableOnion") === "on";
}

export async function setStableOnion(stableOnion: boolean): Promise<void> {
  if (isTauri()) { await invoke("app_set_stable_onion", { stableOnion }); return; }
  localStorage.setItem("vesper:stableOnion", stableOnion ? "on" : "off");
}

// ── P2P connection timeout (room create + join give up after this many seconds) ─
// Tor onion publish + rendezvous routinely takes 30–90 s, so keep the default
// generous; the user can tune it in Settings. Stored in the encrypted kv store.
// Default + clamp bounds come from the build config; the legacy consts stay as
// the browser-mode mirror.

export const CONNECT_TIMEOUT_DEFAULT_SECS = 60;
export const CONNECT_TIMEOUT_MIN_SECS = 5;
export const CONNECT_TIMEOUT_MAX_SECS = 600;

export function clampConnectTimeoutSecs(secs: number): number {
  const c = getBuildConfig().connect_timeout_secs;
  if (!Number.isFinite(secs)) return c.default;
  return Math.min(c.max, Math.max(c.min, Math.round(secs)));
}

export async function getConnectTimeoutSecs(): Promise<number> {
  const c = getBuildConfig().connect_timeout_secs;
  try {
    const raw = await kvGet("p2p:settings", "default", "connect_timeout_secs");
    if (raw === null || raw === "") return c.default;
    return clampConnectTimeoutSecs(Number(raw));
  } catch {
    return c.default;
  }
}

export async function setConnectTimeoutSecs(secs: number): Promise<number> {
  const v = clampConnectTimeoutSecs(secs);
  await kvPut("p2p:settings", "default", "connect_timeout_secs", String(v)).catch(() => {});
  return v;
}

// ── Auto-lock (idle timeout) ─────────────────────────────────────────────────
// Minutes of user inactivity before the vault locks itself and the app returns
// to the passphrase gate; 0 = never. Device-local on purpose — deliberately NOT
// in DEVLINK_SYNC_KV, since a phone and a laptop want different values.

export function clampIdleLockMins(mins: number): number {
  const c = getBuildConfig().idle_lock_mins;
  if (!Number.isFinite(mins)) return c.default;
  return Math.min(c.max, Math.max(c.min, Math.round(mins)));
}

export async function getIdleLockMins(): Promise<number> {
  const c = getBuildConfig().idle_lock_mins;
  try {
    const raw = await kvGet("p2p:settings", "default", "idle_lock_mins");
    if (raw === null || raw === "") return c.default;
    return clampIdleLockMins(Number(raw));
  } catch {
    return c.default;
  }
}

export async function setIdleLockMins(mins: number): Promise<number> {
  const v = clampIdleLockMins(mins);
  await kvPut("p2p:settings", "default", "idle_lock_mins", String(v)).catch(() => {});
  return v;
}

// ── Lock-on-hide knob ────────────────────────────────────────────────────────
// When ON, minimizing/hiding the window locks the vault after a short grace
// (hardcoded in src/idleLock.ts — the grace is mechanics, not policy). Default
// off. Device-local like idle_lock_mins above: deliberately NOT in
// DEVLINK_SYNC_KV.

const KEY_LOCK_ON_HIDE = "lock_on_hide";

export async function getLockOnHide(): Promise<boolean> {
  try {
    return (await kvGet("p2p:settings", "default", KEY_LOCK_ON_HIDE)) === "1";
  } catch {
    return false;
  }
}

export async function setLockOnHide(on: boolean): Promise<void> {
  await kvPut("p2p:settings", "default", KEY_LOCK_ON_HIDE, on ? "1" : "0").catch(() => {});
}

// ── Hidden tabs (which tabs the app presents) ────────────────────────────────
// The user's own pick of which main tabs appear in the navigation (Settings →
// Tabs; the tab taxonomy itself lives in the app, apps/vesper/src/tabs.ts).
// Device-local like idle_lock_mins and lock_on_hide above — deliberately NOT in
// DEVLINK_SYNC_KV: a wide desktop nav bar and a phone's hamburger drawer want
// different sets, and the build gates this composes with are per-BINARY anyway,
// so a synced "show Map" would be meaningless on a device whose build has no Map.
//
// Stored as the HIDDEN list, in one JSON value (kv has no key enumeration, so a
// multi-valued setting is read-modify-write on a single key — the locked-files
// record below does the same). Hidden rather than visible so the default is
// "everything the build contains", and so a tab introduced by a later version
// shows up instead of silently staying off. Unknown ids are preserved on write
// by the caller: they belong to a newer build opening the same profile.

const KEY_HIDDEN_TABS = "hidden_tabs";

/** Tab ids the user has switched off. Empty (the default) = show everything. */
export async function getHiddenTabs(): Promise<string[]> {
  try {
    const raw = await kvGet("p2p:settings", "default", KEY_HIDDEN_TABS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export async function setHiddenTabs(ids: readonly string[]): Promise<void> {
  await kvPut("p2p:settings", "default", KEY_HIDDEN_TABS, JSON.stringify([...ids])).catch(() => {});
}


// ── Chat history cap (persisted per-room message log, in messages) ─────────────
// Bounds the sealed chat:log kv namespace per room; the oldest segment is
// pruned once the cap is exceeded. Device-local.

export function clampChatHistoryCapMsgs(cap: number): number {
  const c = getBuildConfig().chat_history_cap_msgs;
  if (!Number.isFinite(cap)) return c.default;
  return Math.min(c.max, Math.max(c.min, Math.round(cap)));
}

export async function getChatHistoryCapMsgs(): Promise<number> {
  const c = getBuildConfig().chat_history_cap_msgs;
  try {
    const raw = await kvGet("p2p:settings", "default", "chat_history_cap_msgs");
    if (raw === null || raw === "") return c.default;
    return clampChatHistoryCapMsgs(Number(raw));
  } catch {
    return c.default;
  }
}

export async function setChatHistoryCapMsgs(cap: number): Promise<number> {
  const v = clampChatHistoryCapMsgs(cap);
  await kvPut("p2p:settings", "default", "chat_history_cap_msgs", String(v)).catch(() => {});
  return v;
}

// ── Encryption-at-rest vault (Tauri only; browser fallback treats it unlocked) ─

export async function vaultStatus(): Promise<VaultStatus> {
  if (isTauri()) return invoke<VaultStatus>("vault_status");
  return { exists: true, unlocked: true };
}

export async function vaultSetup(passphrase: string): Promise<void> {
  if (isTauri()) await invoke("vault_setup", { passphrase });
}

export async function vaultUnlock(passphrase: string): Promise<void> {
  if (isTauri()) await invoke("vault_unlock", { passphrase });
}

export async function vaultLock(): Promise<void> {
  if (isTauri()) await invoke("vault_lock");
}

/** Throttled activity heartbeat for the Rust-side lock watchdog (vault.rs): lets
 *  Rust re-lock on its own if this webview dies or freezes. Browser: no-op. */
export async function vaultTouch(): Promise<void> {
  if (isTauri()) await invoke("vault_touch").catch(() => {});
}

export async function vaultChangePassphrase(current: string, next: string): Promise<void> {
  if (isTauri()) await invoke("vault_change_passphrase", { current, new: next });
}

/** PIN unlock status. Safe while the vault is LOCKED — the gate calls it to
 *  decide whether to draw a keypad or the passphrase field. */
export interface PinStatus {
  enrolled: boolean;
  digits: number;
  attemptsLeft: number;
}

export async function vaultPinStatus(): Promise<PinStatus> {
  if (!isTauri()) return { enrolled: false, digits: 6, attemptsLeft: 5 };
  return invoke<PinStatus>("vault_pin_status");
}

/** Enrol a PIN for THIS session. Needs the passphrase: the PIN seals a copy of
 *  it, so knowledge must be proven first. A panic PIN may be enrolled with it,
 *  and must differ from the PIN in at least two digits. */
export async function vaultPinEnroll(
  passphrase: string,
  pin: string,
  panicPin?: string,
  panicCode?: string,
): Promise<void> {
  if (!isTauri()) throw new Error("PIN unlock is only available in the desktop app.");
  await invoke("vault_pin_enroll", { passphrase, pin, panicPin, panicCode });
}

/** Re-open the session with the PIN. Exhausting the attempts drops the PIN and
 *  the passphrase is required again — nothing is wiped. */
export async function vaultPinUnlock(pin: string): Promise<void> {
  if (!isTauri()) throw new Error("PIN unlock is only available in the desktop app.");
  await invoke("vault_pin_unlock", { pin });
}

export async function vaultPinClear(): Promise<void> {
  if (!isTauri()) return;
  await invoke("vault_pin_clear");
}

export async function vaultWipe(): Promise<void> {
  if (isTauri()) await invoke("vault_wipe");
}

// ── Panic code (duress passphrase) ───────────────────────────────────────────
// A second passphrase for the unlock gate. Typing it there erases every profile
// on this device and opens a fresh empty vault keyed by that same code — the
// wipe is silent (vault_unlock returns exactly as it does for a normal unlock),
// so nothing on screen betrays what happened. Configured in Settings → Data.

/** Arm the panic code. `current` is the real passphrase (authorizes the change);
 *  the backend rejects a `code` equal to it. */
export async function vaultSetPanicCode(current: string, code: string): Promise<void> {
  if (isTauri()) await invoke("vault_set_panic_code", { current, code });
}

/** Disarm the panic code — it goes back to being an ordinary wrong passphrase. */
export async function vaultClearPanicCode(current: string): Promise<void> {
  if (isTauri()) await invoke("vault_clear_panic_code", { current });
}

/** Whether a panic code is armed. Read from inside the encrypted store, so the
 *  vault file on disk looks the same either way. Browser fallback: never. */
export async function vaultHasPanicCode(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>("vault_has_panic_code");
  return false;
}

export async function cleanTorKeystore(): Promise<void> {
  if (isTauri()) await invoke("tor_clean_keystore");
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
    offline_profile: { display_name: "", email: "", phone: "", bio: "", date_of_birth: "" },
    offline_profiles: [],
    selected_offline_profile_id: "",
    offline: await getOffline(),
    use_tor: await getUseTor(),
  };
}

export async function clearProfileState(): Promise<AppProfileState> {
  if (isTauri()) return invoke<AppProfileState>("app_clear_profile_state");
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
