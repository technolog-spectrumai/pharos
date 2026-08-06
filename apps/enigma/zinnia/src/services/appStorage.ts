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
  /** false = this build has no Mainline DHT: no ticketless join-by-room-code,
   *  no nickname directory, no presence. getDhtDiscovery/getDhtNickPublish read
   *  false regardless of the stored setting, the Settings→Connections DHT card
   *  and the Contacts nickname/find surfaces are hidden, and dht_presence /
   *  dht_publish_nick / dht_find_nick / dht_apply error with DHT_DISABLED.
   *  Pairing falls back to QR/ticket. (pland.md — Pro only.) */
  dht_enabled: boolean;
  /** false = this build has no 1:1 voice calls: no Vox tab, /vox redirects,
   *  useVoxCall is never instantiated, the vox ALPN is not accepted, and every
   *  vox_* command errors with CALLS_DISABLED. (pland.md — Plus and up.) */
  calls_enabled: boolean;
  /** false = this build has no Contacts: no Contacts tab, /contacts redirects,
   *  useRoomInvites is never instantiated and the invite ALPN is not accepted.
   *  (pland.md — Pro only.) */
  contacts_enabled: boolean;
  /** false = this build has no Calendar: no Calendar tab, /calendar redirects,
   *  useMeetings is never instantiated (no meetings, polls or reminder tick).
   *  (pland.md — Pro only.) */
  calendar_enabled: boolean;
  /** false = this build has no peer sync: the `enigma/plink/0` ALPN is not
   *  registered, usePeerSync is never instantiated, and every peer_* command
   *  errors with PEERS_DISABLED. (peer.md; pland.md — Pro only.) */
  peers_enabled: boolean;
  /** false = this build has no Maps: no Map tab, /map redirects, map_* commands
   *  error. The app never fetches tiles — region packages come from the
   *  standalone tools/map_packager and are imported from the device. */
  maps_enabled: boolean;
  /** false = this build has no key ring (one passphrase locking MANY local
   *  files): keyring_* commands error with KEYRING_DISABLED and the UI hides
   *  the key-ring surface. Per-file locking (local_lock) is always in. */
  keyring_enabled: boolean;
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
  dht_enabled: true,
  calls_enabled: true,
  contacts_enabled: true,
  calendar_enabled: true,
  peers_enabled: true,
  maps_enabled: true,
  keyring_enabled: true,
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

// ── Enigma Cloud connections ──────────────────────────────────────────────────
// Named servers: several saved connections (faros, zenobia, an onion, …) with
// exactly ONE active at a time. Each keeps its own saved session for free —
// Rust scopes the "cloud:auth" namespace by the normalized URL, so tokens for N
// servers already coexist without any change to the auth layer.
//
// The registry is ONE JSON blob under a fixed key, deliberately:
//   * protasius has no "list keys in a namespace" primitive, so per-connection
//     scopes would still need an index key — strictly worse than one blob; and
//   * kv KEYS go to disk in PLAINTEXT (only values are sealed, protasius
//     `enc_kv`), so a scope per connection would write every server address and
//     every user-chosen name in the clear. Inside a blob they are an encrypted
//     value. Rule: no user-controlled string ever becomes a kv `ns` or `scope`.
//
// `server_url` is kept as a MIRROR of the active entry's URL rather than
// retired, so `getCloudServerUrl()` and every existing reader keep working.
// One private helper writes it, which makes divergence structurally impossible.

const NS_CLOUD = "cloud:settings";
const CLOUD_SCOPE = "default";
const CLOUD_SERVERS_KEY = "servers";
const CLOUD_ACTIVE_KEY = "active_server";
const CLOUD_URL_KEY = "server_url";

export const CLOUD_SERVER_URL_DEFAULT = "https://localhost:8443";

export interface CloudServerEntry {
  id: string;
  name: string;
  url: string;
}

/** Thrown by the mutators so the UI can render the reason inline (the
 *  `toggleForceTor` precedent) instead of escalating to the fatal overlay. */
export class CloudServerError extends Error {}

/** NORMALIZATION IS FROZEN: trim + strip trailing slashes, nothing else.
 *
 *  It must stay byte-identical to `cloud.rs::normalize_scope`, because that is
 *  what keys `cloud:auth`. Two traps make "improving" it a bad trade:
 *   * stripping default ports / lowercasing would make every already-stored
 *     `cloud:auth/<old-form>/token` unreadable — a silent logout for everyone,
 *     unrecoverable because nothing can enumerate kv scopes; and
 *   * any drift between this and the Rust twin is invisible in review and
 *     produces a permanent "unauthorized: not logged in" with the token sitting
 *     right there.
 *  So `https://localhost:443` and `https://localhost` remain DIFFERENT scopes
 *  even though they are the same socket. `sameCloudServer` exists to warn about
 *  that pair in the UI; it must never be used to build a storage key. */
export function normalizeCloudServerUrl(url: string): string {
  let v = (url ?? "").trim();
  while (v.endsWith("/")) v = v.slice(0, -1);
  return v || CLOUD_SERVER_URL_DEFAULT;
}

/** Split a URL into (scheme, host, effective port, path prefix) for display-only
 *  comparison. Effective port fills in 443/80 from the scheme, which is exactly
 *  what `tor.rs::host_port` does on the wire. */
function urlParts(url: string): { scheme: string; host: string; port: string; path: string } {
  const trimmed = normalizeCloudServerUrl(url);
  const split = trimmed.split("://");
  const scheme = (split.length > 1 ? split[0] : "http").toLowerCase();
  const rest = split.length > 1 ? split.slice(1).join("://") : trimmed;
  const slash = rest.indexOf("/");
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const path = slash >= 0 ? rest.slice(slash) : "";
  // Strip userinfo, then split off the port (IPv6 literals keep their brackets).
  const hostPort = authority.includes("@") ? authority.slice(authority.indexOf("@") + 1) : authority;
  const colon = hostPort.lastIndexOf(":");
  const bracket = hostPort.lastIndexOf("]");
  const hasPort = colon > bracket;
  const host = (hasPort ? hostPort.slice(0, colon) : hostPort).toLowerCase();
  const explicit = hasPort ? hostPort.slice(colon + 1) : "";
  const port = explicit || (scheme === "https" || scheme === "wss" ? "443" : "80");
  return { scheme, host, port, path };
}

/** DISPLAY ONLY: do two addresses reach the same server? Used to warn that two
 *  connections will share one saved sign-in. Never a storage key — see the
 *  frozen-normalization note above. */
export function sameCloudServer(a: string, b: string): boolean {
  const x = urlParts(a);
  const y = urlParts(b);
  return x.scheme === y.scheme && x.host === y.host && x.port === y.port && x.path === y.path;
}

/** A human default name for a new connection: the host, plus the port when it
 *  is not the scheme's default. Never blank. */
export function cloudServerDefaultName(url: string): string {
  const { host, port, scheme } = urlParts(url);
  if (!host) return "server";
  const bare = scheme === "https" || scheme === "wss" ? "443" : "80";
  return port === bare ? host : `${host}:${port}`;
}

function newCloudServerId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return c?.randomUUID?.() ?? `srv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function parseEntries(raw: string | null): CloudServerEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is CloudServerEntry =>
          !!e && typeof e.id === "string" && !!e.id && typeof e.url === "string" && !!e.url,
      )
      .map((e) => ({
        id: e.id,
        url: normalizeCloudServerUrl(e.url),
        name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : cloudServerDefaultName(e.url),
      }));
  } catch {
    return [];
  }
}

/** Registry read outcome.
 *
 *  `unreadable` is NOT "empty". A locked vault (or an unavailable store) must
 *  NOT fall back to `CLOUD_SERVER_URL_DEFAULT` — that is faros' address, so a
 *  fail-open here would point the UI, and a login press, at a server the user
 *  never chose, and at seed time would persist a connection they never made.
 *  Callers must refuse to act on `unreadable` rather than guess. */
export type CloudServersState =
  | { state: "loaded"; servers: CloudServerEntry[]; activeId: string }
  | { state: "unreadable" };

/** Read the registry, seeding it on genuine first run from the legacy
 *  single-URL key so nobody loses their existing setup. Idempotent, and
 *  self-healing if the blob is ever lost or garbled — but only when the READ
 *  itself succeeded (see `CloudServersState`). */
export async function readCloudServers(): Promise<CloudServersState> {
  let rawServers: string | null;
  let rawActive: string | null;
  let rawUrl: string | null;
  try {
    rawServers = await kvGet(NS_CLOUD, CLOUD_SCOPE, CLOUD_SERVERS_KEY);
    rawActive = await kvGet(NS_CLOUD, CLOUD_SCOPE, CLOUD_ACTIVE_KEY);
    rawUrl = await kvGet(NS_CLOUD, CLOUD_SCOPE, CLOUD_URL_KEY);
  } catch {
    return { state: "unreadable" };
  }
  const servers = parseEntries(rawServers);
  if (servers.length > 0) {
    // An active id naming no entry falls back to the first, never to nothing.
    const activeId = servers.some((s) => s.id === rawActive) ? (rawActive as string) : servers[0].id;
    if (activeId !== rawActive) await writeActive(servers, activeId);
    return { state: "loaded", servers, activeId };
  }
  // First run (or a garbled blob): the legacy key becomes connection #1. The
  // read succeeded, so `rawUrl === null` genuinely means "never configured" and
  // the default is a seed, not a guess.
  const url = normalizeCloudServerUrl(rawUrl ?? "");
  const seeded: CloudServerEntry[] = [{ id: newCloudServerId(), name: cloudServerDefaultName(url), url }];
  await writeServers(seeded);
  await writeActive(seeded, seeded[0].id);
  return { state: "loaded", servers: seeded, activeId: seeded[0].id };
}

async function writeServers(list: CloudServerEntry[]): Promise<void> {
  await kvPut(NS_CLOUD, CLOUD_SCOPE, CLOUD_SERVERS_KEY, JSON.stringify(list));
}

/** The single writer of both the active id and the `server_url` mirror, so the
 *  two can never disagree. */
async function writeActive(list: CloudServerEntry[], id: string): Promise<void> {
  const entry = list.find((s) => s.id === id) ?? list[0];
  await kvPut(NS_CLOUD, CLOUD_SCOPE, CLOUD_ACTIVE_KEY, entry?.id ?? "");
  await kvPut(NS_CLOUD, CLOUD_SCOPE, CLOUD_URL_KEY, entry?.url ?? CLOUD_SERVER_URL_DEFAULT);
}

async function loadedOrThrow(): Promise<{ servers: CloudServerEntry[]; activeId: string }> {
  const state = await readCloudServers();
  if (state.state === "unreadable") {
    throw new CloudServerError("Could not read your saved connections.");
  }
  return { servers: state.servers, activeId: state.activeId };
}

export async function listCloudServers(): Promise<CloudServerEntry[]> {
  const state = await readCloudServers();
  return state.state === "loaded" ? state.servers : [];
}

export async function getActiveCloudServer(): Promise<CloudServerEntry | null> {
  const state = await readCloudServers();
  if (state.state !== "loaded") return null;
  return state.servers.find((s) => s.id === state.activeId) ?? null;
}

/** Activate a connection. Deliberately does NOT swallow its write error: a
 *  failed switch must be visible, or the UI would show one server while every
 *  command targets another. */
export async function setActiveCloudServer(id: string): Promise<CloudServerEntry> {
  const { servers } = await loadedOrThrow();
  const entry = servers.find((s) => s.id === id);
  if (!entry) throw new CloudServerError("That connection no longer exists.");
  await writeActive(servers, entry.id);
  return entry;
}

/** Reject a URL that another entry already uses: they would share one
 *  `cloud:auth` scope, so signing out of one would silently sign out the other
 *  and two accounts on one server would be impossible. */
function assertUniqueUrl(servers: CloudServerEntry[], url: string, exceptId?: string): void {
  const clash = servers.find((s) => s.id !== exceptId && s.url === url);
  if (clash) throw new CloudServerError(`That address is already saved as “${clash.name}”.`);
}

export async function addCloudServer(name: string, url: string): Promise<CloudServerEntry> {
  const { servers } = await loadedOrThrow();
  const v = normalizeCloudServerUrl(url);
  assertUniqueUrl(servers, v);
  const entry: CloudServerEntry = { id: newCloudServerId(), name: name.trim() || cloudServerDefaultName(v), url: v };
  const next = [...servers, entry];
  await writeServers(next);
  return entry;
}

export async function updateCloudServer(
  id: string,
  patch: { name?: string; url?: string },
): Promise<CloudServerEntry> {
  const { servers, activeId } = await loadedOrThrow();
  const i = servers.findIndex((s) => s.id === id);
  if (i < 0) throw new CloudServerError("That connection no longer exists.");
  const url = patch.url === undefined ? servers[i].url : normalizeCloudServerUrl(patch.url);
  if (patch.url !== undefined) assertUniqueUrl(servers, url, id);
  const name = patch.name === undefined ? servers[i].name : patch.name.trim() || cloudServerDefaultName(url);
  const next = servers.slice();
  next[i] = { id, name, url };
  await writeServers(next);
  // Editing the active entry's address moves the mirror with it.
  if (activeId === id) await writeActive(next, id);
  return next[i];
}

/** Remove a connection and return the one now active (never null in practice —
 *  the last entry cannot be removed). The CALLER must clear that connection's
 *  saved session FIRST (via `cloud_logout`): `cloud:auth` is scoped by URL and
 *  nothing can enumerate kv scopes, so removing the entry first would orphan a
 *  live bearer token permanently. */
export async function removeCloudServer(id: string): Promise<CloudServerEntry> {
  const { servers, activeId } = await loadedOrThrow();
  if (!servers.some((s) => s.id === id)) throw new CloudServerError("That connection no longer exists.");
  if (servers.length <= 1) throw new CloudServerError("This is your only connection.");
  const removedIndex = servers.findIndex((s) => s.id === id);
  const next = servers.filter((s) => s.id !== id);
  await writeServers(next);
  // Removing the active one hands over to its neighbour (the following entry,
  // or the preceding one when it was last).
  const nextActive = activeId === id ? next[Math.min(removedIndex, next.length - 1)] : next.find((s) => s.id === activeId)!;
  await writeActive(next, nextActive.id);
  return nextActive;
}

/** The active connection's URL. Unchanged signature — every existing reader
 *  keeps working; only the source moved from a lone key to the registry (with
 *  `server_url` still mirrored, so the two agree either way). */
export async function getCloudServerUrl(): Promise<string> {
  try {
    const active = await getActiveCloudServer();
    if (active) return active.url;
    const raw = await kvGet(NS_CLOUD, CLOUD_SCOPE, CLOUD_URL_KEY);
    if (raw === null || raw === "") return CLOUD_SERVER_URL_DEFAULT;
    return normalizeCloudServerUrl(raw);
  } catch {
    return CLOUD_SERVER_URL_DEFAULT;
  }
}

/** Edit the ACTIVE connection's address. Implemented over `updateCloudServer`
 *  rather than a bare `kvPut`, so the blob and the `server_url` mirror cannot
 *  drift apart. */
export async function setCloudServerUrl(url: string): Promise<string> {
  const v = normalizeCloudServerUrl(url);
  try {
    const state = await readCloudServers();
    if (state.state === "loaded") {
      const entry = await updateCloudServer(state.activeId, { url: v });
      return entry.url;
    }
  } catch {
    /* fall through to the legacy single-key write below */
  }
  await kvPut(NS_CLOUD, CLOUD_SCOPE, CLOUD_URL_KEY, v).catch(() => {});
  return v;
}

/** The Cloud tab's runtime master switch. Default OFF: with it off, Rust reads
 *  the same key and refuses every cloud/beacon/aster request — zero bytes to
 *  the server app-wide. In Tauri the sanctioned WRITE path is the
 *  `cloud_set_enabled` command (it also aborts in-flight transfers on off);
 *  the setter here is the browser/vitest fallback. */
export async function getCloudEnabled(): Promise<boolean> {
  try {
    return (await kvGet("cloud:settings", "default", "enabled")) === "on";
  } catch {
    return false;
  }
}

export async function setCloudEnabled(on: boolean): Promise<void> {
  await kvPut("cloud:settings", "default", "enabled", on ? "on" : "off").catch(() => {});
}

/** The Cloud tab's "route through Tor" knob: clearnet server hosts ride the
 *  embedded Tor client (`.onion` always does, loopback never does). In Tauri
 *  write via the `cloud_set_force_tor` command (it aborts in-flight direct
 *  transfers on switch-on); the setter here is the browser/vitest fallback. */
export async function getCloudForceTor(): Promise<boolean> {
  try {
    return (await kvGet("cloud:settings", "default", "force_tor")) === "on";
  } catch {
    return false;
  }
}

export async function setCloudForceTor(on: boolean): Promise<void> {
  await kvPut("cloud:settings", "default", "force_tor", on ? "on" : "off").catch(() => {});
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

// ── Delete-marked-files-on-panic knob ─────────────────────────────────────────
// When ON, a panic (typing the panic code at the gate) also deletes every file in
// the Files → Local locked-files index from disk. The path list can't live in the
// encrypted store (the panic path has no key for it), so Rust keeps it in a sidecar
// sealed under the panic code and re-seals it whenever the list or this knob
// changes — hence the `resyncPanicTargets()` calls below. Device-local (never
// synced to other devices), default off.

const KEY_DELETE_FILES_ON_PANIC = "delete_files_on_panic";

export async function getDeleteFilesOnPanic(): Promise<boolean> {
  try {
    return (await kvGet("p2p:settings", "default", KEY_DELETE_FILES_ON_PANIC)) === "1";
  } catch {
    return false;
  }
}

export async function setDeleteFilesOnPanic(on: boolean): Promise<void> {
  await kvPut("p2p:settings", "default", KEY_DELETE_FILES_ON_PANIC, on ? "1" : "0").catch(() => {});
  await resyncPanicTargets();
}

/** Ask Rust to re-seal the panic-targets sidecar from the current knob + index.
 *  Tauri-only; a no-op in the browser (there is no panic path there). */
export async function resyncPanicTargets(): Promise<void> {
  if (isTauri()) await invoke("panic_targets_resync").catch(() => {});
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
  /** Locked via the key ring (path is the .enigr copy): unlock goes through the
   *  ring's one passphrase, per-file rotate/edit don't apply. */
  ring?: boolean;
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
  // Keep the panic-targets sidecar current (no-op unless the knob + a panic code
  // are both armed).
  await resyncPanicTargets();
}

/** Forget a locked-file record (does not touch the file on disk). */
export async function removeLockedFile(path: string): Promise<void> {
  const list = (await getLockedFiles()).filter((r) => r.path !== path);
  await saveLockedFiles(list);
  await resyncPanicTargets();
}

// ── Key ring (one passphrase, many locked files) ──────────────────────────────
// Thin wrappers over the Rust keyring_* commands (src-tauri/src/keyring.rs):
// one per-profile ring file whose single passphrase covers every file added to
// it. Each file is sealed under its own random DEK kept in the ring's sealed
// entry table — the ring is the ONLY record (paths included), nothing is stored
// here. Device-local by design: never synced. Compile-time gated by
// `keyring_enabled` (KEYRING_DISABLED); Tauri-only, like local file locking.

/** Ring existence + how many files it currently covers. */
export interface KeyringStatus {
  exists: boolean;
  /** Advisory count from the ring header (readable without the passphrase). */
  entryCount: number;
}

/** One per-file outcome of a keyring lock/unlock. */
export interface KeyringFileOutcome {
  path: string;
  /** "locked" | "already-locked" | "unlocked" | "failed". */
  status: string;
  /** On success: the `.enigr` path after a lock, the restored path after an unlock. */
  newPath?: string;
  /** Set when status === "failed". */
  error?: string;
}

/** One remembered file, decrypted out of the ring for the UI list. */
export interface KeyringEntry {
  /** The original path (without `.enigr`). */
  path: string;
  name: string;
  /** Plaintext size at lock time, bytes. */
  size: number;
  /** Epoch millis when it was locked. */
  lockedAt: number;
  /** Whether the locked `.enigr` file is still on disk. */
  present: boolean;
}

/** Ring existence + entry count (no passphrase needed). Tauri-only; a plain
 *  browser has no ring, so report "none". */
export async function getKeyringStatus(): Promise<KeyringStatus> {
  if (!isTauri()) return { exists: false, entryCount: 0 };
  return invoke<KeyringStatus>("keyring_status");
}

/** Create the ring under `passphrase`. Errors if one already exists. Tauri-only. */
export async function keyringInit(passphrase: string): Promise<void> {
  if (!isTauri()) throw new Error("The key ring is only available in the desktop app.");
  await invoke("keyring_init", { passphrase });
}

/** Lock `paths` under the ring passphrase: each file becomes `<path>.enigr` and
 *  the original is removed. Fails closed on a wrong passphrase. Tauri-only. */
export async function keyringLock(passphrase: string, paths: string[]): Promise<KeyringFileOutcome[]> {
  if (!isTauri()) throw new Error("The key ring is only available in the desktop app.");
  return invoke<KeyringFileOutcome[]>("keyring_lock", { passphrase, paths });
}

/** Unlock locked `.enigr` `paths`: restores each original filename and drops its
 *  ring entry. Fails closed on a wrong passphrase. Tauri-only. */
export async function keyringUnlock(passphrase: string, paths: string[]): Promise<KeyringFileOutcome[]> {
  if (!isTauri()) throw new Error("The key ring is only available in the desktop app.");
  return invoke<KeyringFileOutcome[]>("keyring_unlock", { passphrase, paths });
}

/** Unlock every ring entry whose locked file is still on disk. Tauri-only. */
export async function keyringUnlockAll(passphrase: string): Promise<KeyringFileOutcome[]> {
  if (!isTauri()) throw new Error("The key ring is only available in the desktop app.");
  return invoke<KeyringFileOutcome[]>("keyring_unlock_all", { passphrase });
}

/** List the ring's entries (needs the passphrase — the table is sealed). Tauri-only. */
export async function keyringEntries(passphrase: string): Promise<KeyringEntry[]> {
  if (!isTauri()) throw new Error("The key ring is only available in the desktop app.");
  return invoke<KeyringEntry[]>("keyring_entries", { passphrase });
}

/** Change the ring passphrase (re-wraps the ring key; no file is re-encrypted).
 *  Fails closed on a wrong `old`. Tauri-only. */
export async function keyringChangePassphrase(old: string, next: string): Promise<void> {
  if (!isTauri()) throw new Error("The key ring is only available in the desktop app.");
  await invoke("keyring_change_passphrase", { old, new: next });
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

/** Write binary content, supplied as base64, to a path the user picked in the
 *  native save dialog (`fs_local::fs_write_base64_file`). Base64 because the
 *  caller is a canvas data URL, which already carries its payload that way.
 *
 *  This is the ONLY unsealed write path in the app, and it exists for one thing:
 *  exporting a rasterized PNG, which `writeLocalNote` cannot carry (it is UTF-8
 *  text). The drawing itself always saves through the sealed path. Tauri-only. */
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
