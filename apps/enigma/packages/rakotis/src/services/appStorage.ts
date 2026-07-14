// Profile / runtime storage abstraction for the serverless Enigma app.
//
// When running inside the Tauri desktop app, all storage goes through Rust via
// invoke(). In a plain browser (Vite dev server, vitest jsdom) we fall back to
// localStorage so the app remains functional without the desktop runtime.

import { isTauri, invoke } from "./tauri";
import { kvGet, kvPut } from "./localDb";

// ── localStorage keys used in browser-fallback mode ──────────────────────────
const LS_OFFLINE = "enigma:offline";
const LS_USE_TOR = "enigma:useTor";

// ── Public types ──────────────────────────────────────────────────────────────

export interface OfflineProfile {
  display_name: string;
  email: string;
  phone: string;
  bio: string;
  date_of_birth: string;
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

// ── Use Tor (route rendezvous + chat over peer-hosted onion services) ──────────
// On → the app hosts an onion service, the room QR carries a `.onion`, and all
// chat rides Tor; iroh is not used. Exclusive; enforced by the Rust command.

export async function getUseTor(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>("app_get_use_tor");
  return localStorage.getItem(LS_USE_TOR) === "on";
}

export async function setUseTor(useTor: boolean): Promise<void> {
  if (isTauri()) { await invoke("app_set_use_tor", { useTor }); return; }
  localStorage.setItem(LS_USE_TOR, useTor ? "on" : "off");
}

// ── Keep onion stable (persist the Tor .onion, encrypted at rest) ──────────────

export async function getStableOnion(): Promise<boolean> {
  if (isTauri()) return invoke<boolean>("app_get_stable_onion");
  return localStorage.getItem("enigma:stableOnion") === "on";
}

export async function setStableOnion(stableOnion: boolean): Promise<void> {
  if (isTauri()) { await invoke("app_set_stable_onion", { stableOnion }); return; }
  localStorage.setItem("enigma:stableOnion", stableOnion ? "on" : "off");
}

// ── P2P connection timeout (room create + join give up after this many seconds) ─
// Tor onion publish + rendezvous routinely takes 30–90 s, so keep the default
// generous; the user can tune it in Settings. Stored in the encrypted kv store.

export const CONNECT_TIMEOUT_DEFAULT_SECS = 60;
export const CONNECT_TIMEOUT_MIN_SECS = 5;
export const CONNECT_TIMEOUT_MAX_SECS = 600;

export function clampConnectTimeoutSecs(secs: number): number {
  if (!Number.isFinite(secs)) return CONNECT_TIMEOUT_DEFAULT_SECS;
  return Math.min(CONNECT_TIMEOUT_MAX_SECS, Math.max(CONNECT_TIMEOUT_MIN_SECS, Math.round(secs)));
}

export async function getConnectTimeoutSecs(): Promise<number> {
  try {
    const raw = await kvGet("p2p:settings", "default", "connect_timeout_secs");
    if (raw === null || raw === "") return CONNECT_TIMEOUT_DEFAULT_SECS;
    return clampConnectTimeoutSecs(Number(raw));
  } catch {
    return CONNECT_TIMEOUT_DEFAULT_SECS;
  }
}

export async function setConnectTimeoutSecs(secs: number): Promise<number> {
  const v = clampConnectTimeoutSecs(secs);
  await kvPut("p2p:settings", "default", "connect_timeout_secs", String(v)).catch(() => {});
  return v;
}

// ── Max file-transfer size (0 = unlimited) ────────────────────────────────────
// A local guard on P2P file sharing, enforced by `useFileShare` on both sides:
// offering a larger file is blocked, and an incoming offer over the limit is
// auto-declined. Stored in the encrypted kv store, in MB. The app's build config
// (`policy.fileShare.defaultMaxFileSizeMb`) owns the shipped default and passes it
// in — rakotis only knows the generic fallback.

export const MAX_FILE_SIZE_DEFAULT_MB = 0; // generic fallback: 0 = unlimited
export const MAX_FILE_SIZE_MIN_MB = 0;
export const MAX_FILE_SIZE_MAX_MB = 100 * 1024; // 100 GB

export function clampMaxFileSizeMb(mb: number, fallback: number = MAX_FILE_SIZE_DEFAULT_MB): number {
  if (!Number.isFinite(mb)) return fallback;
  return Math.min(MAX_FILE_SIZE_MAX_MB, Math.max(MAX_FILE_SIZE_MIN_MB, Math.round(mb)));
}

export async function getMaxFileSizeMb(defaultMb: number = MAX_FILE_SIZE_DEFAULT_MB): Promise<number> {
  try {
    const raw = await kvGet("p2p:settings", "default", "max_file_size_mb");
    if (raw === null || raw === "") return defaultMb;
    return clampMaxFileSizeMb(Number(raw), defaultMb);
  } catch {
    return defaultMb;
  }
}

export async function setMaxFileSizeMb(mb: number, defaultMb: number = MAX_FILE_SIZE_DEFAULT_MB): Promise<number> {
  const v = clampMaxFileSizeMb(mb, defaultMb);
  await kvPut("p2p:settings", "default", "max_file_size_mb", String(v)).catch(() => {});
  return v;
}

// ── DHT discovery (Mainline/Kademlia rendezvous + presence — see dht.md) ───────
// Opt-in, default off. On → the iroh endpoint additionally publishes/resolves
// addresses on the public BitTorrent DHT (server-free), rooms get a ticketless
// join code, and Contacts presence works. Rust reads the same kv keys directly.

export async function getDhtDiscovery(): Promise<boolean> {
  try {
    return (await kvGet("p2p:settings", "default", "dht_discovery")) === "on";
  } catch {
    return false;
  }
}

export async function setDhtDiscovery(on: boolean): Promise<void> {
  await kvPut("p2p:settings", "default", "dht_discovery", on ? "on" : "off").catch(() => {});
}

/** Apply a flipped DHT toggle: tears the iroh node down in Rust; the next room
 *  command lazily re-binds with the new setting. */
export async function applyDhtDiscovery(): Promise<void> {
  if (isTauri()) await invoke("dht_apply").catch(() => {});
}

export interface DhtStatus {
  enabled: boolean;
  bootstrapped: boolean;
}

/** Status line for Settings/Contacts. `bootstrapped` needs the node started —
 *  before the first room command it reads false even with the toggle on. */
export async function getDhtStatus(): Promise<DhtStatus> {
  if (isTauri()) {
    try {
      return await invoke<DhtStatus>("dht_status");
    } catch {
      /* fall through */
    }
  }
  return { enabled: false, bootstrapped: false };
}

// How often an open room's rendezvous record is re-published (Rust re-reads this
// every round) — lower finds code-joiners faster, higher saves battery/traffic.
export const DHT_ROOM_PUBLISH_DEFAULT_SECS = 600;
export const DHT_ROOM_PUBLISH_MIN_SECS = 60;
export const DHT_ROOM_PUBLISH_MAX_SECS = 3600;

export function clampDhtRoomPublishSecs(secs: number): number {
  if (!Number.isFinite(secs)) return DHT_ROOM_PUBLISH_DEFAULT_SECS;
  return Math.min(DHT_ROOM_PUBLISH_MAX_SECS, Math.max(DHT_ROOM_PUBLISH_MIN_SECS, Math.round(secs)));
}

export async function getDhtRoomPublishSecs(): Promise<number> {
  try {
    const raw = await kvGet("p2p:settings", "default", "dht_room_publish_secs");
    if (raw === null || raw === "") return DHT_ROOM_PUBLISH_DEFAULT_SECS;
    return clampDhtRoomPublishSecs(Number(raw));
  } catch {
    return DHT_ROOM_PUBLISH_DEFAULT_SECS;
  }
}

export async function setDhtRoomPublishSecs(secs: number): Promise<number> {
  const v = clampDhtRoomPublishSecs(secs);
  await kvPut("p2p:settings", "default", "dht_room_publish_secs", String(v)).catch(() => {});
  return v;
}

// How often the Contacts view polls presence. Purely frontend-driven
// (setInterval), so it suspends with the webview — battery-safe on Android.
export const DHT_PRESENCE_POLL_DEFAULT_SECS = 300;
export const DHT_PRESENCE_POLL_MIN_SECS = 60;
export const DHT_PRESENCE_POLL_MAX_SECS = 3600;

export function clampDhtPresencePollSecs(secs: number): number {
  if (!Number.isFinite(secs)) return DHT_PRESENCE_POLL_DEFAULT_SECS;
  return Math.min(DHT_PRESENCE_POLL_MAX_SECS, Math.max(DHT_PRESENCE_POLL_MIN_SECS, Math.round(secs)));
}

export async function getDhtPresencePollSecs(): Promise<number> {
  try {
    const raw = await kvGet("p2p:settings", "default", "dht_presence_poll_secs");
    if (raw === null || raw === "") return DHT_PRESENCE_POLL_DEFAULT_SECS;
    return clampDhtPresencePollSecs(Number(raw));
  } catch {
    return DHT_PRESENCE_POLL_DEFAULT_SECS;
  }
}

export async function setDhtPresencePollSecs(secs: number): Promise<number> {
  const v = clampDhtPresencePollSecs(secs);
  await kvPut("p2p:settings", "default", "dht_presence_poll_secs", String(v)).catch(() => {});
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

export async function vaultChangePassphrase(current: string, next: string): Promise<void> {
  if (isTauri()) await invoke("vault_change_passphrase", { current, new: next });
}

export async function vaultWipe(): Promise<void> {
  if (isTauri()) await invoke("vault_wipe");
}

/// Reset the Tor onion keystore (identity) — clears stale locks; next Tor room mints
/// a fresh .onion. Wired into "Clear selected data".
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
