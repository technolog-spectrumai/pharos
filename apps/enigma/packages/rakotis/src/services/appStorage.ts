// Profile / runtime storage abstraction for the serverless Enigma26 app.
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
  /** false = no n0 relay / pkarr / Mainline DHT; DHT toggles are inert. */
  p2p_allow_hosted_relays: boolean;
  /** false = this build has no Mainline DHT: no ticketless join-by-room-code,
   *  no nickname directory, no presence. getDhtDiscovery/getDhtNickPublish read
   *  false regardless of the stored setting, the Settings→Connections DHT card
   *  and the Contacts nickname/find surfaces are hidden, and dht_presence /
   *  dht_publish_nick / dht_find_nick / dht_apply error with DHT_DISABLED.
   *  Pairing falls back to QR/ticket. (technology.md §20 — Pro only.) */
  dht_enabled: boolean;
  /** false = this build has no 1:1 voice calls: no Vox tab, /vox redirects,
   *  useVoxCall is never instantiated, the vox ALPN is not accepted, and every
   *  vox_* command errors with CALLS_DISABLED. (technology.md §20 — Plus and up.) */
  calls_enabled: boolean;
  /** false = this build has no Contacts: no Contacts tab, /contacts redirects,
   *  useRoomInvites is never instantiated and the invite ALPN is not accepted.
   *  (technology.md §20 — Pro only.) */
  contacts_enabled: boolean;
  /** false = this build has no Calendar: no Calendar tab, /calendar redirects,
   *  useMeetings is never instantiated (no meetings, polls or reminder tick).
   *  (technology.md §20 — Pro only.) */
  calendar_enabled: boolean;
  /** false = this build has no peer sync: the `enigma/plink/0` ALPN is not
   *  registered, usePeerSync is never instantiated, and every peer_* command
   *  errors with PEERS_DISABLED. (peer.md; technology.md §20 — Pro only.) */
  /** PIN unlock: a short in-session re-unlock after an idle lock. The passphrase
   *  still opens the vault at cold start — the PIN never protects data at rest. */
  pin_unlock: boolean;
  /** false = this build has no linked-device sync channel. The old Files→Devices
   *  UI is removed regardless of this flag. */
  use_tor_default: boolean;
  stable_onion_default: boolean;
  dht_discovery_default: boolean;
  dht_nick_publish_default: boolean;
  connect_timeout_secs: SettingClamp;
  dht_room_publish_secs: SettingClamp;
  max_file_size_mb: SettingClamp;
  chat_history_cap_msgs: SettingClamp;
  /** Auto-lock: minutes of inactivity before the vault re-locks. 0 = never. */
  idle_lock_mins: SettingClamp;
  /** Peer sync: seconds between a live link's hello + diff pull. */
  /** P2P transfer chunk, KiB — the "file chunk size" setting's bounds. */
  file_chunk_kib: SettingClamp;
  /** Digits in the unlock PIN. */
  pin_digits: SettingClamp;
  /** Seed for the per-chunk integrity check toggle on a new profile. */
  file_integrity_default: boolean;
}

// Mirrors the default build_config.yaml AND the exported *_DEFAULT/_MIN/_MAX
// consts below (literals here: the consts are declared later in the module).
const FALLBACK_BUILD_CONFIG: BuildConfig = {
  app_name: "Enigma26",
  app_identifier: "com.spectrumaipl.enigma26",
  app_version: "0.1.0",
  p2p_allow_hosted_relays: true,
  dht_enabled: true,
  calls_enabled: true,
  contacts_enabled: true,
  calendar_enabled: true,
  pin_unlock: true,
  use_tor_default: false,
  stable_onion_default: false,
  dht_discovery_default: false,
  dht_nick_publish_default: false,
  connect_timeout_secs: { default: 60, min: 5, max: 600 },
  dht_room_publish_secs: { default: 600, min: 60, max: 3600 },
  max_file_size_mb: { default: 0, min: 0, max: 100 * 1024 },
  chat_history_cap_msgs: { default: 500, min: 50, max: 5000 },
  idle_lock_mins: { default: 15, min: 0, max: 120 },
  file_chunk_kib: { default: 256, min: 16, max: 4096 },
  pin_digits: { default: 6, min: 4, max: 12 },
  file_integrity_default: true,
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
// Tabs; the tab taxonomy itself lives in the app, apps/enigma/src/tabs.ts).
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

// ── Max file-transfer size (0 = unlimited) ────────────────────────────────────
// A local guard on P2P file sharing, enforced by `useFileShare` on both sides:
// offering a larger file is blocked, and an incoming offer over the limit is
// auto-declined. Stored in the encrypted kv store, in MB. The app's build config
// (`policy.fileShare.defaultMaxFileSizeMb`) owns the shipped default and passes it
// in — rakotis only knows the generic fallback.

export const MAX_FILE_SIZE_DEFAULT_MB = 0; // generic fallback: 0 = unlimited
export const MAX_FILE_SIZE_MIN_MB = 0;
export const MAX_FILE_SIZE_MAX_MB = 100 * 1024; // 100 GB

export function clampMaxFileSizeMb(mb: number, fallback?: number): number {
  const c = getBuildConfig().max_file_size_mb;
  if (!Number.isFinite(mb)) return fallback ?? c.default;
  return Math.min(c.max, Math.max(c.min, Math.round(mb)));
}

export async function getMaxFileSizeMb(defaultMb?: number): Promise<number> {
  const fallback = defaultMb ?? getBuildConfig().max_file_size_mb.default;
  try {
    const raw = await kvGet("p2p:settings", "default", "max_file_size_mb");
    if (raw === null || raw === "") return fallback;
    return clampMaxFileSizeMb(Number(raw), fallback);
  } catch {
    return fallback;
  }
}

export async function setMaxFileSizeMb(mb: number, defaultMb?: number): Promise<number> {
  const v = clampMaxFileSizeMb(mb, defaultMb ?? getBuildConfig().max_file_size_mb.default);
  await kvPut("p2p:settings", "default", "max_file_size_mb", String(v)).catch(() => {});
  return v;
}

// ── Meeting reminder lead time (0 = reminders off) ────────────────────────────
// How many minutes before a meeting starts the app fires a local OS notification.
// Enforced by `useMeetings` in the app (its reminder tick re-reads this every
// round, so Settings changes apply live). Stored in the encrypted kv store.

export const MEETING_REMINDER_DEFAULT_MINS = 15;
export const MEETING_REMINDER_MIN_MINS = 0; // 0 = off
export const MEETING_REMINDER_MAX_MINS = 24 * 60;

export function clampMeetingReminderMins(mins: number): number {
  if (!Number.isFinite(mins)) return MEETING_REMINDER_DEFAULT_MINS;
  return Math.min(MEETING_REMINDER_MAX_MINS, Math.max(MEETING_REMINDER_MIN_MINS, Math.round(mins)));
}

export async function getMeetingReminderMins(): Promise<number> {
  try {
    const raw = await kvGet("p2p:settings", "default", "meeting_reminder_mins");
    if (raw === null || raw === "") return MEETING_REMINDER_DEFAULT_MINS;
    return clampMeetingReminderMins(Number(raw));
  } catch {
    return MEETING_REMINDER_DEFAULT_MINS;
  }
}

export async function setMeetingReminderMins(mins: number): Promise<number> {
  const v = clampMeetingReminderMins(mins);
  await kvPut("p2p:settings", "default", "meeting_reminder_mins", String(v)).catch(() => {});
  return v;
}

// ── DHT discovery (Mainline/Kademlia rendezvous + presence — see technology.md §12) ───────
// Opt-in, default off. On → the iroh endpoint additionally publishes/resolves
// addresses on the public BitTorrent DHT (server-free), rooms get a ticketless
// join code, and Contacts presence works. Rust reads the same kv keys directly.

export async function getDhtDiscovery(): Promise<boolean> {
  // Build gate FIRST, exactly as Rust's p2p_dht::discovery_enabled orders it:
  // a profile carrying "on" from a DHT-capable build must read as off here too.
  // The key is deliberately NOT rewritten — reopening the same profile with a
  // Pro build restores the user's choice.
  if (!getBuildConfig().dht_enabled) return false;
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
  /** The iroh node is up with a DHT handle. False = blocked from starting
   *  (offline / Tor mode) or the Mainline UDP bind failed. */
  running: boolean;
  bootstrapped: boolean;
}

/** Status probe for Settings/Contacts. May lazily start the node (like any
 *  room command) — never in airplane or Tor mode. A fresh Mainline node takes
 *  a few seconds to bootstrap, so callers should retry before declaring the
 *  DHT unreachable. */
export async function getDhtStatus(): Promise<DhtStatus> {
  if (!getBuildConfig().dht_enabled) return { enabled: false, running: false, bootstrapped: false };
  if (isTauri()) {
    try {
      return await invoke<DhtStatus>("dht_status");
    } catch {
      /* fall through */
    }
  }
  return { enabled: false, running: false, bootstrapped: false };
}

// ── Nickname directory ("findable as ‹nick›" — technology.md §12) ────────────────────────
// Opt-in claim on the DHT nickname directory. Rust re-reads both keys every
// announce round, so renames/toggles apply live; `dht_apply` forces an
// immediate first publish. Findable only while the app runs with DHT on.

export const DHT_NICKNAME_MAX_LEN = 64;

export function clampDhtNickname(nick: string): string {
  const trimmed = nick.trim();
  return trimmed.length > DHT_NICKNAME_MAX_LEN ? trimmed.slice(0, DHT_NICKNAME_MAX_LEN) : trimmed;
}

export async function getDhtNickPublish(): Promise<boolean> {
  // Build gate first — mirrors Rust's p2p_dht::nick_publish_enabled.
  if (!getBuildConfig().dht_enabled) return false;
  try {
    return (await kvGet("p2p:settings", "default", "dht_nick_publish")) === "on";
  } catch {
    return false;
  }
}

export async function setDhtNickPublish(on: boolean): Promise<void> {
  await kvPut("p2p:settings", "default", "dht_nick_publish", on ? "on" : "off").catch(() => {});
}

export async function getDhtNickname(): Promise<string> {
  try {
    return clampDhtNickname((await kvGet("p2p:settings", "default", "dht_nickname")) ?? "");
  } catch {
    return "";
  }
}

export async function setDhtNickname(nick: string): Promise<string> {
  const v = clampDhtNickname(nick);
  await kvPut("p2p:settings", "default", "dht_nickname", v).catch(() => {});
  return v;
}

// How often an open room's rendezvous record is re-published (Rust re-reads this
// every round) — lower finds code-joiners faster, higher saves battery/traffic.
export const DHT_ROOM_PUBLISH_DEFAULT_SECS = 600;
export const DHT_ROOM_PUBLISH_MIN_SECS = 60;
export const DHT_ROOM_PUBLISH_MAX_SECS = 3600;

export function clampDhtRoomPublishSecs(secs: number): number {
  const c = getBuildConfig().dht_room_publish_secs;
  if (!Number.isFinite(secs)) return c.default;
  return Math.min(c.max, Math.max(c.min, Math.round(secs)));
}

export async function getDhtRoomPublishSecs(): Promise<number> {
  const c = getBuildConfig().dht_room_publish_secs;
  try {
    const raw = await kvGet("p2p:settings", "default", "dht_room_publish_secs");
    if (raw === null || raw === "") return c.default;
    return clampDhtRoomPublishSecs(Number(raw));
  } catch {
    return c.default;
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

// ── File transfer: chunk size + integrity check ───────────────────────────────
// Both are DEVICE-LOCAL tuning knobs, deliberately absent from DEVLINK_SYNC_KV
// (the connect-timeout / idle-lock category). The sending device's values
// govern a transfer; the receiver learns the chunk size from the wire header.

function clampFileChunkKib(v: number): number {
  const c = getBuildConfig().file_chunk_kib;
  if (!Number.isFinite(v)) return c.default;
  return Math.min(c.max, Math.max(c.min, Math.round(v)));
}

export async function getFileChunkKib(): Promise<number> {
  const raw = await kvGet("p2p:settings", "default", "file_chunk_kib");
  if (raw === null || raw === "") return getBuildConfig().file_chunk_kib.default;
  return clampFileChunkKib(Number(raw));
}

export async function setFileChunkKib(kib: number): Promise<number> {
  const v = clampFileChunkKib(kib);
  await kvPut("p2p:settings", "default", "file_chunk_kib", String(v)).catch(() => {});
  return v;
}

/** Per-chunk hash-chain verification. Either side enabling it enforces it. */
export async function getFileIntegrity(): Promise<boolean> {
  const raw = await kvGet("p2p:settings", "default", "file_integrity");
  if (raw === "on") return true;
  if (raw === "off") return false;
  return getBuildConfig().file_integrity_default;
}

export async function setFileIntegrity(on: boolean): Promise<void> {
  await kvPut("p2p:settings", "default", "file_integrity", on ? "on" : "off").catch(() => {});
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
