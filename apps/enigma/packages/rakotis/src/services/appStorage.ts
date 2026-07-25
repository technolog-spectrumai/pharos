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
  /** false = this build has no Enigma Cloud: cloud_* commands error, hide the UI. */
  cloud_allow_connections: boolean;
  /** false = no n0 relay / pkarr / Mainline DHT; DHT toggles are inert. */
  p2p_allow_hosted_relays: boolean;
  /** false = this build has no 1:1 voice calls: no Calls tab, /calls redirects,
   *  useVoxCall is never instantiated, the vox ALPN is not accepted, and every
   *  vox_* command errors with CALLS_DISABLED. (pland.md — Plus and up.) */
  calls_enabled: boolean;
  /** false = this build has no Contacts: no Contacts tab, /contacts redirects,
   *  useRoomInvites is never instantiated and the invite ALPN is not accepted.
   *  DHT room codes are unaffected. (pland.md — Plus and up.) */
  contacts_enabled: boolean;
  /** false = this build has no Calendar: no Calendar tab, /calendar redirects,
   *  useMeetings is never instantiated (no meetings, polls or reminder tick).
   *  (pland.md — Pro only.) */
  calendar_enabled: boolean;
  /** false = this build has no peer sync: the `enigma/plink/0` ALPN is not
   *  registered, usePeerSync is never instantiated, and every peer_* command
   *  errors with PEERS_DISABLED. (peer.md; pland.md — Pro only.) */
  peers_enabled: boolean;
  /** false = this build has no Kanban board: no Board tab, /board redirects,
   *  and stores/chat.ts never instantiates the sync composable. */
  kanban_enabled: boolean;
  /** false = promote/demote across columns only (no within-column drag-reorder). */
  kanban_allow_reorder: boolean;
  /** Columns a captain gets when first creating a board in a room. */
  kanban_default_columns: string[];
  /** Board/card caps enforced in the composable + card form (wire-size safety). */
  kanban_max_cards_per_board: number;
  kanban_max_card_title_len: number;
  kanban_max_card_description_len: number;
  /** false = this build has no sketch board: no Sketch tab and /sketch redirects.
   *  The board is local and standalone — nothing is shared with room members. */
  sketch_enabled: boolean;
  /** Board caps enforced in the composable + validators (memory / render cost). */
  sketch_max_shapes_per_board: number;
  sketch_max_text_len: number;
  /** false = this build has no Maps: no Map tab, /map redirects, map_* commands
   *  error. The app never fetches tiles — region packages come from the
   *  standalone tools/map_packager and are imported from the device. */
  maps_enabled: boolean;
  /** false = this build has no Mind tab: /mind redirects. The mind map and its
   *  dump inbox are local-only by construction: ns `mind` is deliberately
   *  absent from DEVLINK_SYNC_KV and PEER_SCOPE_KV. */
  mind_enabled: boolean;
  /** Mind caps enforced in the composable + validators (memory / render cost).
   *  max_title_len also caps edge labels. */
  mind_max_nodes: number;
  mind_max_edges: number;
  mind_max_title_len: number;
  mind_max_content_len: number;
  mind_max_dump_entries: number;
  mind_max_dump_entry_len: number;
  /** false = this build has no device linking: devlink_* commands error with
   *  DEVLINK_DISABLED and the Settings→Devices tab is hidden. */
  devices_allow_linking: boolean;
  use_tor_default: boolean;
  stable_onion_default: boolean;
  dht_discovery_default: boolean;
  dht_nick_publish_default: boolean;
  connect_timeout_secs: SettingClamp;
  dht_room_publish_secs: SettingClamp;
  max_file_size_mb: SettingClamp;
  map_storage_limit_mb: SettingClamp;
  devlink_pair_window_secs: SettingClamp;
  devlink_resync_secs: SettingClamp;
  chat_history_cap_msgs: SettingClamp;
  /** Auto-lock: minutes of inactivity before the vault re-locks. 0 = never. */
  idle_lock_mins: SettingClamp;
  /** Peer sync: seconds between a live link's hello + diff pull. */
  peer_resync_secs: SettingClamp;
}

// Mirrors the default build_config.yaml AND the exported *_DEFAULT/_MIN/_MAX
// consts below (literals here: the consts are declared later in the module).
const FALLBACK_BUILD_CONFIG: BuildConfig = {
  app_name: "Enigma",
  app_identifier: "com.spectrumaipl.enigma",
  app_version: "0.1.0",
  cloud_allow_connections: true,
  p2p_allow_hosted_relays: true,
  calls_enabled: true,
  contacts_enabled: true,
  calendar_enabled: true,
  peers_enabled: true,
  kanban_enabled: true,
  kanban_allow_reorder: true,
  kanban_default_columns: ["To Do", "In Progress", "Done"],
  kanban_max_cards_per_board: 500,
  kanban_max_card_title_len: 200,
  kanban_max_card_description_len: 4000,
  sketch_enabled: true,
  sketch_max_shapes_per_board: 1000,
  sketch_max_text_len: 200,
  maps_enabled: true,
  mind_enabled: true,
  mind_max_nodes: 500,
  mind_max_edges: 1000,
  mind_max_title_len: 200,
  mind_max_content_len: 4000,
  mind_max_dump_entries: 200,
  mind_max_dump_entry_len: 4000,
  devices_allow_linking: true,
  use_tor_default: false,
  stable_onion_default: false,
  dht_discovery_default: false,
  dht_nick_publish_default: false,
  connect_timeout_secs: { default: 60, min: 5, max: 600 },
  dht_room_publish_secs: { default: 600, min: 60, max: 3600 },
  max_file_size_mb: { default: 0, min: 0, max: 100 * 1024 },
  map_storage_limit_mb: { default: 512, min: 64, max: 65536 },
  devlink_pair_window_secs: { default: 600, min: 60, max: 3600 },
  devlink_resync_secs: { default: 300, min: 30, max: 3600 },
  chat_history_cap_msgs: { default: 500, min: 50, max: 5000 },
  idle_lock_mins: { default: 15, min: 0, max: 120 },
  peer_resync_secs: { default: 300, min: 30, max: 3600 },
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

// ── Device-link resync interval (linked-device catch-up cadence) ───────────────
// How often paired devices exchange dlink_hello and reconcile state/history
// while both are online. Stored in the encrypted kv store; device-local (each
// device may pace itself differently — deliberately NOT in the sync allow-list).

export function clampDevlinkResyncSecs(secs: number): number {
  const c = getBuildConfig().devlink_resync_secs;
  if (!Number.isFinite(secs)) return c.default;
  return Math.min(c.max, Math.max(c.min, Math.round(secs)));
}

export async function getDevlinkResyncSecs(): Promise<number> {
  const c = getBuildConfig().devlink_resync_secs;
  try {
    const raw = await kvGet("p2p:settings", "default", "devlink_resync_secs");
    if (raw === null || raw === "") return c.default;
    return clampDevlinkResyncSecs(Number(raw));
  } catch {
    return c.default;
  }
}

export async function setDevlinkResyncSecs(secs: number): Promise<number> {
  const v = clampDevlinkResyncSecs(secs);
  await kvPut("p2p:settings", "default", "devlink_resync_secs", String(v)).catch(() => {});
  return v;
}

// ── Peer-sync resync interval (peer.md) ───────────────────────────────────────
// How often a live peer link re-announces (plink_hello) and pulls the diff for
// its granted scopes. Device-local, like the devlink cadence above — never in
// any sync allow-list.

export function clampPeerResyncSecs(secs: number): number {
  const c = getBuildConfig().peer_resync_secs;
  if (!Number.isFinite(secs)) return c.default;
  return Math.min(c.max, Math.max(c.min, Math.round(secs)));
}

export async function getPeerResyncSecs(): Promise<number> {
  const c = getBuildConfig().peer_resync_secs;
  try {
    const raw = await kvGet("p2p:settings", "default", "peer_resync_secs");
    if (raw === null || raw === "") return c.default;
    return clampPeerResyncSecs(Number(raw));
  } catch {
    return c.default;
  }
}

export async function setPeerResyncSecs(secs: number): Promise<number> {
  const v = clampPeerResyncSecs(secs);
  await kvPut("p2p:settings", "default", "peer_resync_secs", String(v)).catch(() => {});
  return v;
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

// ── Enigma Cloud server URL ────────────────────────────────────────────────────
// The base URL of the user's own Enigma Cloud (faros/toto Vault API) server.
// Consumed by the `cloud_*` Tauri commands and the cloud Pinia store. Stored in
// the encrypted kv store; the normalized form (no trailing slash) also scopes
// the "cloud:auth" token namespace, so keep normalization in one place.

export const CLOUD_SERVER_URL_DEFAULT = "https://localhost:8443";

export function normalizeCloudServerUrl(url: string): string {
  let v = (url ?? "").trim();
  while (v.endsWith("/")) v = v.slice(0, -1);
  return v || CLOUD_SERVER_URL_DEFAULT;
}

export async function getCloudServerUrl(): Promise<string> {
  try {
    const raw = await kvGet("cloud:settings", "default", "server_url");
    if (raw === null || raw === "") return CLOUD_SERVER_URL_DEFAULT;
    return normalizeCloudServerUrl(raw);
  } catch {
    return CLOUD_SERVER_URL_DEFAULT;
  }
}

export async function setCloudServerUrl(url: string): Promise<string> {
  const v = normalizeCloudServerUrl(url);
  await kvPut("cloud:settings", "default", "server_url", v).catch(() => {});
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

// ── Maps (MapLibre + PMTiles — imported offline regions) ──────────────────────
// The app never fetches tiles; region packages are produced by the standalone
// tools/map_packager and imported from the device (map.md Part II).

// Total on-disk budget for imported map regions, enforced in Rust before every
// region import.

export const MAP_STORAGE_LIMIT_DEFAULT_MB = 512;
export const MAP_STORAGE_LIMIT_MIN_MB = 64;
export const MAP_STORAGE_LIMIT_MAX_MB = 64 * 1024;

export function clampMapStorageLimitMb(mb: number): number {
  const c = getBuildConfig().map_storage_limit_mb;
  if (!Number.isFinite(mb)) return c.default;
  return Math.min(c.max, Math.max(c.min, Math.round(mb)));
}

export async function getMapStorageLimitMb(): Promise<number> {
  const c = getBuildConfig().map_storage_limit_mb;
  try {
    const raw = await kvGet("p2p:settings", "default", "map_storage_limit_mb");
    if (raw === null || raw === "") return c.default;
    return clampMapStorageLimitMb(Number(raw));
  } catch {
    return c.default;
  }
}

export async function setMapStorageLimitMb(mb: number): Promise<number> {
  const v = clampMapStorageLimitMb(mb);
  await kvPut("p2p:settings", "default", "map_storage_limit_mb", String(v)).catch(() => {});
  return v;
}

/** The active (priority) region for tile resolution: checked FIRST, with every
 *  other imported region still filling the gaps it doesn't cover. "" = none.
 *  Rust reads the same key directly (maps.rs KEY_ACTIVE_REGION) for tile
 *  ordering and clears it when the region is removed. Device-local by design —
 *  deliberately NOT in DEVLINK_SYNC_KV: each device imports its own region
 *  packages, so a synced id would usually dangle on the other device. */
export async function getMapActiveRegion(): Promise<string> {
  try {
    return (await kvGet("p2p:settings", "default", "map_active_region")) ?? "";
  } catch {
    return "";
  }
}

export async function setMapActiveRegion(id: string): Promise<void> {
  await kvPut("p2p:settings", "default", "map_active_region", id).catch(() => {});
}

// ── DHT discovery (Mainline/Kademlia rendezvous + presence — see technology.md §12) ───────
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

export async function vaultChangePassphrase(current: string, next: string): Promise<void> {
  if (isTauri()) await invoke("vault_change_passphrase", { current, new: next });
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

// ── Passphrase-protected local files ("lock a file") ──────────────────────────
// Encrypt a user-chosen file in place with a per-file passphrase (reuses the
// gervasius at-rest primitives in Rust; see src-tauri/src/local_lock.rs). The
// passphrase is never stored — we only keep a record of *which* files are locked
// so the UI can list them. The record lives in the encrypted kv store as one JSON
// array (kv has no key-enumeration, so we read-modify-write a single value).

/** Info returned by the Rust lock/unlock commands. */
export interface LockedFileResult {
  name: string;
  size: number;
}

/** A remembered locked file (no secrets — just enough to show + act on a row). */
export interface LockedFileRecord {
  path: string;
  name: string;
  /** Plaintext size at lock time, bytes. */
  size: number;
  /** Epoch millis when it was locked. */
  lockedAt: number;
  /** Epoch millis of the last key rotation; absent ⇒ never rotated (use lockedAt). */
  rotatedAt?: number;
}

const NS_LOCAL_FILES = "files:local";
const LOCAL_FILES_KEY = "index";

/** Encrypt `path` in place under `passphrase`. Tauri-only. */
export async function lockLocalFile(path: string, passphrase: string): Promise<LockedFileResult> {
  if (!isTauri()) throw new Error("Local file locking is only available in the desktop app.");
  return invoke<LockedFileResult>("local_lock_file", { path, passphrase });
}

/** Decrypt a locked `path` in place under `passphrase`; fails closed on a wrong
 *  passphrase (the file is left untouched). Tauri-only. */
export async function unlockLocalFile(path: string, passphrase: string): Promise<LockedFileResult> {
  if (!isTauri()) throw new Error("Local file locking is only available in the desktop app.");
  return invoke<LockedFileResult>("local_unlock_file", { path, passphrase });
}

/** Rotate a locked file's key: re-key under a fresh random DEK + salt. Pass
 *  `next === current` to keep the same passphrase while still rolling the key, or a
 *  different `next` to also change the passphrase. Fails closed on a wrong `current`
 *  (the file is left untouched). Tauri-only. */
export async function rotateLocalFile(
  path: string,
  current: string,
  next: string,
): Promise<LockedFileResult> {
  if (!isTauri()) throw new Error("Local file locking is only available in the desktop app.");
  return invoke<LockedFileResult>("local_rotate_file", { path, current, new: next });
}

/** True if the file on disk currently begins with the lock magic. */
export async function isLocalFileLocked(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("local_is_locked", { path });
}

export async function getLockedFiles(): Promise<LockedFileRecord[]> {
  try {
    const raw = await kvGet(NS_LOCAL_FILES, "default", LOCAL_FILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LockedFileRecord[]) : [];
  } catch {
    return [];
  }
}

async function saveLockedFiles(list: LockedFileRecord[]): Promise<void> {
  await kvPut(NS_LOCAL_FILES, "default", LOCAL_FILES_KEY, JSON.stringify(list)).catch(() => {});
}

/** Add (or replace, by path) a locked-file record. */
export async function addLockedFile(rec: LockedFileRecord): Promise<void> {
  const list = (await getLockedFiles()).filter((r) => r.path !== rec.path);
  list.push(rec);
  await saveLockedFiles(list);
}

/** Forget a locked-file record (does not touch the file on disk). */
export async function removeLockedFile(path: string): Promise<void> {
  const list = (await getLockedFiles()).filter((r) => r.path !== path);
  await saveLockedFiles(list);
}

// ── Local notes (editing local text files) ────────────────────────────────────
// The editor opens plain files directly and locked ones after a passphrase prompt;
// a locked file is decrypted in memory only and re-sealed on save, so its plaintext
// never reaches disk (see src-tauri/src/local_lock.rs). The passphrase lives in the
// editor's memory while the file is open and is never persisted here — we only
// remember which files were edited, in the same encrypted kv namespace as the
// locked-file index but under its own key, since these records carry none of the
// lock/rotate/upload semantics that one does.

/** A file's text plus how it is stored on disk. */
export interface LocalNoteContent {
  name: string;
  content: string;
  /** True if the bytes on disk are a locked frame (saves must supply the passphrase). */
  locked: boolean;
  /** Plaintext size, bytes. */
  size: number;
}

/** Disk reality for a remembered note. */
export interface LocalNoteStat {
  exists: boolean;
  locked: boolean;
  size: number;
}

/** A recently edited file, plain or locked. Newest first. */
export interface NoteRecentRecord {
  path: string;
  name: string;
  size: number;
  locked: boolean;
  /** Epoch millis it was last opened or saved. */
  openedAt: number;
}

const NOTE_RECENTS_KEY = "notes";
export const NOTE_RECENTS_MAX = 20;

/** Read a text file for the editor. Locked files need `passphrase` and are decrypted
 *  in memory only — reading never rewrites the file. Tauri-only. */
export async function readLocalNote(path: string, passphrase?: string): Promise<LocalNoteContent> {
  if (!isTauri()) throw new Error("Local notes are only available in the desktop app.");
  return invoke<LocalNoteContent>("local_note_read", { path, passphrase: passphrase ?? null });
}

/** Save an edited buffer. With a passphrase the file is written as a locked frame;
 *  without one it is written as plaintext, which is refused if the file on disk is
 *  currently locked. Tauri-only. */
export async function writeLocalNote(
  path: string,
  content: string,
  passphrase?: string,
): Promise<LockedFileResult> {
  if (!isTauri()) throw new Error("Local notes are only available in the desktop app.");
  return invoke<LockedFileResult>("local_note_write", { path, content, passphrase: passphrase ?? null });
}

/** Existence + lock state + size in one call, for reconciling the recents list. */
export async function statLocalNote(path: string): Promise<LocalNoteStat> {
  if (!isTauri()) return { exists: false, locked: false, size: 0 };
  return invoke<LocalNoteStat>("local_note_stat", { path });
}

export async function getNoteRecents(): Promise<NoteRecentRecord[]> {
  try {
    const raw = await kvGet(NS_LOCAL_FILES, "default", NOTE_RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NoteRecentRecord[]) : [];
  } catch {
    return [];
  }
}

async function saveNoteRecents(list: NoteRecentRecord[]): Promise<void> {
  await kvPut(NS_LOCAL_FILES, "default", NOTE_RECENTS_KEY, JSON.stringify(list)).catch(() => {});
}

/** Record a file as most-recently edited, dropping the oldest past the cap. */
export async function addNoteRecent(rec: NoteRecentRecord): Promise<void> {
  const list = (await getNoteRecents()).filter((r) => r.path !== rec.path);
  list.unshift(rec);
  await saveNoteRecents(list.slice(0, NOTE_RECENTS_MAX));
}

/** Drop a note from the recents list (does not touch the file on disk). */
export async function removeNoteRecent(path: string): Promise<void> {
  await saveNoteRecents((await getNoteRecents()).filter((r) => r.path !== path));
}

/** Write a UTF-8 text file to a path the user picked in the native save dialog
 *  (`fs_local::fs_write_text_file`). Plain export path — unlike `writeLocalNote`
 *  it carries no locked-file or notes-recents semantics. Tauri-only. */
export async function writeTextFileToDisk(path: string, contents: string): Promise<void> {
  if (!isTauri()) throw new Error("Saving to disk is only available in the desktop app.");
  await invoke("fs_write_text_file", { path, contents });
}

/** Write binary content, supplied as base64, to a user-chosen path
 *  (`fs_local::fs_write_base64_file`). Base64 because the callers are canvas data
 *  URLs, which already carry their payload that way. Tauri-only. */
export async function writeBase64FileToDisk(path: string, b64: string): Promise<void> {
  if (!isTauri()) throw new Error("Saving to disk is only available in the desktop app.");
  await invoke("fs_write_base64_file", { path, b64 });
}

// ── Local-file key-rotation reminder interval ─────────────────────────────────
// How many days a locked file's key may age before the Local tab flags it
// "rotation due". 0 = off. This is a REMINDER only — rotation always needs the
// passphrase (nothing is stored/cached), so nothing rotates in the background.
// Stored in the encrypted kv store, days. Mirrors the meeting-reminder setting.

export const FILE_KEY_ROTATION_DEFAULT_DAYS = 0; // 0 = off
export const FILE_KEY_ROTATION_MIN_DAYS = 0;
export const FILE_KEY_ROTATION_MAX_DAYS = 3650; // ~10 years

export function clampFileKeyRotationDays(days: number): number {
  if (!Number.isFinite(days)) return FILE_KEY_ROTATION_DEFAULT_DAYS;
  return Math.min(FILE_KEY_ROTATION_MAX_DAYS, Math.max(FILE_KEY_ROTATION_MIN_DAYS, Math.round(days)));
}

export async function getFileKeyRotationDays(): Promise<number> {
  try {
    const raw = await kvGet("p2p:settings", "default", "file_key_rotation_days");
    if (raw === null || raw === "") return FILE_KEY_ROTATION_DEFAULT_DAYS;
    return clampFileKeyRotationDays(Number(raw));
  } catch {
    return FILE_KEY_ROTATION_DEFAULT_DAYS;
  }
}

export async function setFileKeyRotationDays(days: number): Promise<number> {
  const v = clampFileKeyRotationDays(days);
  await kvPut("p2p:settings", "default", "file_key_rotation_days", String(v)).catch(() => {});
  return v;
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
