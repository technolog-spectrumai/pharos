// Enigma Cloud — account-backed file storage on the user's own server (the
// toto Vault HTTP API), bridged through the `cloud_*` Tauri commands.
// Desktop-only: every invoke is gated by isTauri(). The session token lives in
// the encrypted kv store (ns "cloud:auth", scoped by the normalized server
// URL) and is only ever read by Rust — the frontend just mirrors login state.
//
// Wire conventions (mirroring file_xfer.rs / file://progress):
//   invoke args    → camelCase (Tauri v2 maps serverUrl → server_url)
//   invoke results → snake_case fields (logged_in, transfer_id, …)
//   event payloads → camelCase keys (transferId, transferred, total, …)
// Any Err string starting with "unauthorized" means the stored session died —
// we flip to logged-out locally. Rust clears the kv token on every 401 (and the
// "not logged in" preflight means there was none), so kv is always already clean.

import { computed, reactive, ref } from "vue";
import { defineStore } from "pinia";
import {
  isTauri,
  invoke,
  getBuildConfig,
  getCloudServerUrl,
  setCloudServerUrl as persistCloudServerUrl,
  getCloudEnabled,
  setCloudEnabled as persistCloudEnabled,
  getCloudForceTor,
  setCloudForceTor as persistCloudForceTor,
  getOffline,
  readCloudServers,
  setActiveCloudServer,
  addCloudServer,
  updateCloudServer,
  removeCloudServer,
  normalizeCloudServerUrl as normalizeUrl,
  type CloudServerEntry,
} from "rakotis";

/** Predicted transport for the configured server (from cloud_status). */
export type CloudTransport = "onion" | "tor" | "clearnet" | "loopback";

// fileDict — passthrough of the server's Vault API JSON.
export interface CloudFile {
  id: number;
  title: string;
  key: string;
  file_type: string;
  file_size_bytes: number;
  is_public: boolean;
  is_encrypted: boolean;
  uploaded_at: string;
  download_url: string;
  bucket_slug: string;
  directory_id: number | null;
  is_editable: boolean;
}

export interface CloudDirectory {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
}

export interface CloudBucket {
  id: number;
  slug: string;
  name: string;
  directories: CloudDirectory[];
}

export interface CloudTransfer {
  dir: "up" | "down";
  name: string;
  transferred: number;
  total: number; // 0 = unknown
  error?: string;
  /** Which saved connection this transfer belongs to. A switch does NOT abort
   *  transfers (they keep streaming to the server the user chose when they
   *  pressed Upload), so a row can outlive the connection being on screen —
   *  it must say whose work it is instead of looking like the current one's. */
  serverName?: string;
}

/** What the connected server offers, from `GET /api/apps/`.
 *
 *  Only an explicit `false` hides anything. A server that omits a key (one that
 *  predates the descriptor listing it) is UNKNOWN, not absent — and unknown
 *  renders exactly as today. That is what makes the server-side capability
 *  patch an enhancement rather than a dependency. */
export interface CloudCaps {
  vault: boolean;
  aster: boolean;
  beacon: boolean;
}

/** Missing key or non-boolean ⇒ present. See `CloudCaps`. */
export function normalizeCaps(apps: unknown): CloudCaps {
  const o = (apps ?? {}) as Record<string, unknown>;
  const b = (v: unknown) => (typeof v === "boolean" ? v : true);
  return { vault: b(o.vault), aster: b(o.aster), beacon: b(o.beacon) };
}

// How long a finished / failed transfer row lingers before it's dropped.
const DONE_LINGER_MS = 1500;
const ERROR_LINGER_MS = 6000;

export const useCloudStore = defineStore("cloud", () => {
  const serverUrl = ref("");
  const loggedIn = ref(false);
  const username = ref("");
  const checking = ref(false);
  const files = ref<CloudFile[]>([]);
  const buckets = ref<CloudBucket[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const transfers = reactive(new Map<string, CloudTransfer>());
  // Runtime master switch (Cloud tab knob). Rust enforces the same kv flag on
  // every command AND inside connect() — these refs just keep the UI honest.
  const enabled = ref(false);
  const forceTor = ref(false);
  const transport = ref<CloudTransport | null>(null);
  // Airplane mode MIRROR, not a subscription: Rust emits no event when the
  // switch flips (lib.rs app_set_offline just persists + tears transports down),
  // so this is refreshed at press-shaped moments — reinit, panel mount, retry.
  // Rust's ensure_online stays the real gate; worst case is one stale press.
  const offline = ref(false);
  // Did the server answer our last attempt? null = never tried, so a fresh app
  // never shows a warning it has not earned. Set ONLY from real network calls
  // (never from cloud_status, which is a local kv read) — see `call` below.
  const reachable = ref<boolean | null>(null);

  // ── Named connections ───────────────────────────────────────────────────────
  // Several saved servers, exactly one active. `serverUrl` above stays the
  // single derived value every other consumer already reads (beacon store,
  // Contacts, the invites panel, the recipient picker, LocalPanel), so they all
  // follow a switch with no edits. It remains a `ref`, not a computed, because
  // `reinit()` is its one writer and tests assign it directly.
  const servers = ref<CloudServerEntry[]>([]);
  const activeId = ref("");
  const activeServer = computed(() => servers.value.find((s) => s.id === activeId.value) ?? null);
  /** The registry could not be read (locked vault, unavailable store). NOT the
   *  same as "no connections": we must refuse to act rather than fall back to a
   *  default URL, which would point a login press at a server never chosen. */
  const registryUnreadable = ref(false);
  /** A switch is in flight — the UI disables the picker so two switches (or a
   *  switch during a login) cannot interleave. */
  const switching = ref(false);

  // ── Cross-connection guards ─────────────────────────────────────────────────
  /** Which connection produced the current `files`/`buckets`. Server-side ids
   *  (directory, zone, route, invite) are SEQUENTIAL INTEGERS, so id 7 exists on
   *  both servers: acting on a stale row after a switch would delete a real,
   *  unrelated folder on the other server. Every command carrying such an id
   *  checks this first. */
  const dataConnectionId = ref("");
  /** transferId → the connection that owns it. A switch does not abort
   *  transfers, so `cloud://done` / `cloud://error` must be routed by owner:
   *  otherwise server A's 201 fileDict lands in server B's listing, and an
   *  `unauthorized` from A logs the user out of B. */
  const transferOwner = new Map<string, string>();
  /** Monotonic; every async completion captures it on entry and drops its
   *  writes if it moved. Without it, a slow `cloud_status`/`login` resolving
   *  after a switch writes the wrong connection's session into the UI. */
  let switchSeq = 0;

  // ── Capabilities ────────────────────────────────────────────────────────────
  // What the ACTIVE connection offers. null = not learned yet ⇒ everything is
  // assumed present, which is exactly today's behavior. Session-lifetime only:
  // persisting a `false` would hide a feature on a since-upgraded server with no
  // discoverable way back, while being briefly optimistic costs one honest 404.
  const caps = ref<CloudCaps | null>(null);
  const capsById = new Map<string, CloudCaps>();
  const hasAster = computed(() => caps.value?.aster ?? true);
  const hasBeacon = computed(() => caps.value?.beacon ?? true);

  // A build with cloud.allow_connections: false behaves like the browser here:
  // every action no-ops locally (the UI is hidden anyway) and Rust rejects any
  // direct invoke with CLOUD_DISABLED — that remains the real boundary.
  const cloudAvailable = isTauri() && getBuildConfig().cloud_allow_connections;

  function asMessage(e: unknown): string {
    if (typeof e === "string") return e;
    return (e as Error)?.message ?? String(e);
  }

  /** Everything that belongs to ONE server's session, minus the transfers.
   *  Used by `switchTo`, where the running transfers must survive: they are
   *  still streaming to the connection the user chose, and `App.vue` holds the
   *  idle lock off `transfers.size` — Rust needs the vault unlocked to read the
   *  bearer token for a transfer in flight. */
  function clearListing() {
    loggedIn.value = false;
    username.value = "";
    files.value = [];
    buckets.value = [];
    dataConnectionId.value = "";
  }

  /** Local logged-out state (kv token is Rust's business — already cleared).
   *  Drops the transfers too: a logout, a knob-off or a dead session all mean
   *  the in-flight work is over. */
  function clearLocal() {
    clearListing();
    transfers.clear();
  }

  /** "unauthorized…" ⇒ session expired: flip to logged-out. Returns true if so. */
  function sessionExpired(msg: string): boolean {
    if (!msg.startsWith("unauthorized")) return false;
    clearLocal();
    return true;
  }

  /** "cloud_off…" ⇒ Rust's master switch refused the call while our mirror
   *  still said enabled (e.g. the vault locked, so the kv read fails closed):
   *  sync the knob mirror off — the tab falls back to its off state instead of
   *  surfacing the raw machine-prefixed string. Returns true if so. */
  function knobRefused(msg: string): boolean {
    if (!msg.startsWith("cloud_off")) return false;
    enabled.value = false;
    return true;
  }

  /** Re-read the airplane switch. Cheap (a local command), and it follows a
   *  press every time it is called, so it does not reintroduce background
   *  traffic (cloud.md D6). */
  async function syncOffline(): Promise<void> {
    offline.value = await getOffline().catch(() => false);
  }

  /** The server answered, or the user is explicitly re-attempting. */
  function clearUnreachable(): void {
    reachable.value = null;
  }

  /** Machine-classify a failed cloud command. Order matters.
   *
   *  `cloud_off` and airplane mode mean NO BYTE LEFT THE MACHINE, so they say
   *  nothing about the server — they must not touch `reachable`. An
   *  `unauthorized` likewise does not prove reachability: Rust produces
   *  "unauthorized: not logged in" as a preflight with no network at all
   *  (cloud.rs), and telling the two apart would mean sniffing the tail text.
   *  Anything we cannot classify re-reads the airplane switch, because that is
   *  the likeliest unclassified cause and the local truth beats string-matching
   *  across the language boundary.
   *
   *  Returns true only for the two conditions that own a dedicated surface (the
   *  knob-off state and the logged-out card). `unreachable` returns FALSE on
   *  purpose: the invites panel has a notice for it, but the Files browser does
   *  not — it renders `cloud.error` and nothing else, so swallowing here would
   *  make a dead server look like an empty bucket. */
  /** "no_feature: aster" ⇒ this server does not have that app at all (Rust tags
   *  a 404 on a feature's ROOT, which Django answers with HTML rather than a
   *  JSON `error`). Learned from a call the user already made — no probe. It is
   *  an ANSWER, so it must not touch `reachable`. Returns true if so. */
  function noteMissingFeature(msg: string): boolean {
    if (!msg.startsWith("no_feature")) return false;
    const which = msg.slice(msg.indexOf(":") + 1).trim();
    if (which !== "aster" && which !== "beacon") return true;
    const next: CloudCaps = { ...(caps.value ?? normalizeCaps(null)), [which]: false };
    caps.value = next;
    if (activeId.value) capsById.set(activeId.value, next);
    return true;
  }

  function classify(msg: string): boolean {
    if (knobRefused(msg)) return true;
    if (sessionExpired(msg)) return true;
    if (noteMissingFeature(msg)) return true;
    if (msg.startsWith("unreachable")) {
      reachable.value = false;
      return false;
    }
    void syncOffline();
    return false;
  }

  /** Commands that resolve BEFORE the server has answered, so their success
   *  proves nothing about reachability:
   *   - cloud_upload / cloud_download return a transfer id the moment Rust
   *     spawns the task; the real connect happens inside it and is reported
   *     later on the `cloud://error` event.
   *   - cloud_logout discards its own request error and always returns Ok.
   *  ADD ANY NEW spawn-and-return or best-effort command here, or it will
   *  silently vouch for a server it never reached. */
  const PROVES_NOTHING = new Set(["cloud_upload", "cloud_download", "cloud_logout"]);

  /** THE way to issue a networked cloud/beacon/aster command: one place learns
   *  whether the server is answering. Rethrows, so callers keep their own
   *  handling. Deliberately NOT for `cloud_status` — that is a local kv read
   *  and would falsely "prove" the server is up on every knob toggle. */
  async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      const out = await invoke<T>(cmd, args);
      if (!PROVES_NOTHING.has(cmd)) reachable.value = true;
      return out;
    } catch (e) {
      classify(asMessage(e));
      throw e;
    }
  }

  function upsertFile(f: CloudFile) {
    // Match on the stable DB id, not key: keys are unique per owner but id never
    // collides, so a re-fetched/moved file replaces the right row every time.
    const i = files.value.findIndex((x) => x.id === f.id);
    if (i >= 0) files.value.splice(i, 1, f);
    else files.value.push(f);
  }

  // ── backend transfer events (cloud://progress|done|error) ────────────────────
  // Registered once for the store's lifetime (same idempotence pattern as
  // useFileShare.ensureListeners).
  let listening = false;
  async function ensureListeners(): Promise<void> {
    if (listening || !cloudAvailable) return;
    listening = true;
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ transferId: string; dir: "up" | "down"; transferred: number; total: number }>(
      "cloud://progress",
      (e) => {
        const t = transfers.get(e.payload.transferId);
        if (t) {
          t.transferred = e.payload.transferred;
          if (e.payload.total) t.total = e.payload.total;
        } else {
          // Progress can race the invoke result — create a stub; the invoke
          // handler fills in the name without resetting progress.
          transfers.set(e.payload.transferId, {
            dir: e.payload.dir === "up" ? "up" : "down",
            name: "",
            transferred: e.payload.transferred,
            total: e.payload.total,
          });
        }
      },
    );
    await listen<{ transferId: string; dir: "up" | "down"; file: CloudFile | null }>(
      "cloud://done",
      (e) => {
        const t = transfers.get(e.payload.transferId);
        if (t && t.total) t.transferred = t.total;
        // Only the owning connection may touch the listing. A transfer started
        // against faros can finish after a switch to zenobia; splicing its
        // fileDict here would put faros ids in a list presented as zenobia's,
        // and the refresh fallback would fire a cloud_list at zenobia because
        // of a faros event.
        if (e.payload.dir === "up" && ownsTransfer(e.payload.transferId)) {
          // The 201 fileDict rides the event — splice it in; refresh as fallback.
          if (e.payload.file) upsertFile(e.payload.file);
          else void refresh();
        }
        dropSoon(e.payload.transferId, DONE_LINGER_MS);
      },
    );
    await listen<{ transferId: string; message: string }>("cloud://error", (e) => {
      const msg = e.payload.message || "Transfer failed.";
      const mine = ownsTransfer(e.payload.transferId);
      const t = transfers.get(e.payload.transferId);
      // A foreign connection's failure is reported on its own row and nowhere
      // else. In particular an "unauthorized" from server A must NOT run
      // clearLocal() — that would flip server B logged-out and wipe its state
      // while B's own token is perfectly good.
      if (!mine) {
        if (t) t.error = msg;
        dropSoon(e.payload.transferId, ERROR_LINGER_MS);
        return;
      }
      if (sessionExpired(msg)) {
        error.value = msg;
        return;
      }
      if (knobRefused(msg)) {
        dropSoon(e.payload.transferId, ERROR_LINGER_MS);
        return;
      }
      // Deliberately does NOT touch `reachable`: a download follows a 302 to the
      // MEDIA host, so a failure here can mean that host is down while the API
      // server answered the redirect perfectly. Transfers neither prove nor
      // disprove that your server is reachable.
      if (t) t.error = msg;
      // A quota/billing refusal (zenobia's 402/429) is not a blip: the row is
      // dropped after ERROR_LINGER_MS, so the message also goes to the
      // persistent slot or the user never gets to read it. The policy-change
      // cancellation is excluded — it is self-explanatory and expected.
      if (!t || !isPolicyCancellation(msg)) error.value = msg;
      dropSoon(e.payload.transferId, ERROR_LINGER_MS);
    });
  }

  /** Is this transfer the active connection's work? Unknown owner (a stub row
   *  created by a progress event racing the invoke result) counts as ours —
   *  the alternative would silently drop the user's own progress. */
  function ownsTransfer(id: string): boolean {
    const owner = transferOwner.get(id);
    return owner === undefined || owner === activeId.value;
  }

  /** Rust's CANCELLED_BY_POLICY text, which needs no persistent banner. */
  function isPolicyCancellation(msg: string): boolean {
    return msg.startsWith("transfer cancelled");
  }

  function dropSoon(id: string, ms: number) {
    setTimeout(() => {
      transfers.delete(id);
      transferOwner.delete(id);
    }, ms);
  }

  // ── session ───────────────────────────────────────────────────────────────────
  let initStarted = false;

  /** Load the configured server URL and mirror the stored login state
   *  (cloud_status is local kv only — no network). Idempotent. */
  async function init(): Promise<void> {
    if (initStarted) return;
    initStarted = true;
    await reinit();
  }

  async function reinit(): Promise<void> {
    const seq = switchSeq;
    checking.value = true;
    try {
      // The registry is the source of truth; `server_url` is only its mirror.
      // An unreadable registry must NOT resolve to a default URL — see
      // `registryUnreadable`.
      const state = await readCloudServers();
      if (seq !== switchSeq) return;
      registryUnreadable.value = state.state !== "loaded";
      if (state.state === "loaded") {
        servers.value = state.servers;
        activeId.value = state.activeId;
        serverUrl.value = state.servers.find((s) => s.id === state.activeId)?.url ?? "";
        caps.value = capsById.get(state.activeId) ?? null;
      } else {
        servers.value = [];
        activeId.value = "";
        serverUrl.value = await getCloudServerUrl();
      }
      // kv hydration works in browser/vitest too (localStorage kv fallback).
      enabled.value = await getCloudEnabled();
      forceTor.value = await getCloudForceTor();
      await syncOffline();
      if (seq !== switchSeq) return;
      if (!cloudAvailable) {
        clearLocal();
        return;
      }
      // Authoritative: Rust reads the same kv plus the profile's Tor-exclusive
      // flag, and predicts the transport for the badge. Local-only, knob-exempt.
      // Stays on the raw invoke ON PURPOSE — routing it through `call` would
      // "prove" the server is reachable on every knob toggle without a single
      // byte having left the machine.
      const st = await invoke<{
        logged_in: boolean;
        username: string | null;
        enabled: boolean;
        force_tor: boolean;
        transport: CloudTransport;
      }>("cloud_status", { serverUrl: serverUrl.value });
      // A switch that landed while this was in flight owns the state now — a
      // stale answer would show the other connection's session ("signed in as
      // alice" while pointed at zenobia).
      if (seq !== switchSeq) return;
      loggedIn.value = st.logged_in;
      username.value = st.username ?? "";
      enabled.value = st.enabled;
      forceTor.value = st.force_tor;
      transport.value = st.transport;
      if (loggedIn.value && enabled.value) void ensureListeners();
    } catch (e) {
      if (seq === switchSeq) error.value = asMessage(e);
    } finally {
      if (seq === switchSeq) checking.value = false;
    }
  }

  // ── connection switching ──────────────────────────────────────────────────────

  /** Make another saved connection the active one. Sends ZERO bytes: it writes
   *  kv and re-reads `cloud_status`, which is a local read — the new server's
   *  session is restored from its own `cloud:auth` scope with no network at all.
   *
   *  In-flight transfers are deliberately NOT aborted. `cloud_set_force_tor(true)`
   *  aborts because the ROUTE of a live stream changes under it (it must stop
   *  exposing the IP); a switch changes neither route nor policy — the bytes
   *  still go to the server the user chose when they pressed Upload, and the
   *  newly selected server sees nothing. Contamination is handled by ownership
   *  (`transferOwner`, `dataConnectionId`), not by destroying the user's work. */
  async function switchTo(id: string): Promise<void> {
    if (id === activeId.value || switching.value) return;
    switching.value = true;
    try {
      // Press-shaped moment: re-mirror airplane mode (Rust emits no event).
      await syncOffline();
      // Throws on a failed write — a switch the user cannot see would leave the
      // UI naming one server while every command targets another.
      const entry = await setActiveCloudServer(id);
      switchSeq += 1;
      activeId.value = entry.id;
      serverUrl.value = entry.url;
      // Drop everything that belonged to the old server, synchronously, before
      // anything can act on it. Transfers survive (see the doc comment).
      clearListing();
      error.value = null;
      transport.value = null;
      // `reachable` is per-server: inheriting a failed verdict from the previous
      // connection would slander this one before a byte has been sent.
      clearUnreachable();
      caps.value = capsById.get(entry.id) ?? null;
      // Cached pins/zones/routes are the other server's; without this they keep
      // rendering on the map and a delete would target the wrong server's share.
      const { useBeaconStore } = await import("./beacon");
      useBeaconStore().clear();
      initStarted = true;
      await reinit();
      // Only a connection that already has a session earns the capability
      // request — and only because switching is itself a press.
      if (loggedIn.value && enabled.value) void fetchCaps();
    } finally {
      switching.value = false;
    }
  }

  async function refreshServers(): Promise<void> {
    const state = await readCloudServers();
    registryUnreadable.value = state.state !== "loaded";
    if (state.state === "loaded") {
      servers.value = state.servers;
      activeId.value = state.activeId;
    }
  }

  /** Add a connection and make it active. Safe to auto-switch precisely because
   *  `switchTo` sends nothing and a session-less connection skips `fetchCaps`. */
  async function addServer(name: string, url: string): Promise<CloudServerEntry> {
    const entry = await addCloudServer(name, url);
    await refreshServers();
    await switchTo(entry.id);
    return entry;
  }

  async function editServer(id: string, patch: { name?: string; url?: string }): Promise<void> {
    const before = servers.value.find((s) => s.id === id)?.url;
    const urlMoves = patch.url !== undefined && before !== undefined && normalizeUrl(patch.url) !== before;
    // Clear the OLD address's saved session first, for the same reason removal
    // does: `cloud:auth` is scoped by URL, so once the entry no longer names
    // that address nothing can ever find the token again. Do it before the
    // registry write, so a failure leaves the connection (and its token)
    // reachable for a retry.
    if (urlMoves && isTauri()) await invoke("cloud_logout", { serverUrl: before });
    const entry = await updateCloudServer(id, patch);
    await refreshServers();
    if (patch.url !== undefined && before !== entry.url) {
      // A different address is a different `cloud:auth` scope, so the saved
      // session does not carry over — and its capabilities describe the old
      // server, not this one.
      capsById.delete(id);
      if (activeId.value === id) {
        caps.value = null;
        serverUrl.value = entry.url;
        clearListing();
        clearUnreachable();
        initStarted = true;
        await reinit();
      }
    }
  }

  /** Remove a connection. Clears its saved session FIRST: `cloud:auth` is scoped
   *  by URL and nothing can enumerate kv scopes, so dropping the entry first
   *  would orphan a live bearer token permanently — and a bearer-only
   *  `POST /api/logout/` does not revoke it server-side either, so the local
   *  clear is the only revocation the user gets. */
  async function removeServer(id: string): Promise<void> {
    const entry = servers.value.find((s) => s.id === id);
    if (!entry) return;
    // Captured before anything reloads the registry: `refreshServers` below
    // moves `activeId` to the neighbour, after which "was this the active one?"
    // can no longer be answered.
    const wasActive = activeId.value === id;
    if (isTauri()) {
      // Best-effort on the wire, but it ALWAYS clears the local kv token (and
      // works with the master switch off). If it throws, we keep the entry so
      // the token stays reachable for a later attempt.
      await invoke("cloud_logout", { serverUrl: entry.url });
    }
    const nextActive = await removeCloudServer(id);
    for (const [tid, owner] of transferOwner) if (owner === id) transferOwner.delete(tid);
    capsById.delete(id);
    await refreshServers();
    if (wasActive) {
      switchSeq += 1;
      activeId.value = nextActive.id;
      serverUrl.value = nextActive.url;
      clearListing();
      clearUnreachable();
      caps.value = capsById.get(nextActive.id) ?? null;
      initStarted = true;
      await reinit();
    }
  }

  /** `GET /api/apps/` — what this server offers. Goes through `call()` because
   *  it is a genuine round-trip that only resolves once the server has answered
   *  (it needs no auth, which is what lets it run before sign-in), so it may
   *  legitimately prove reachability.
   *
   *  TRIGGERS ARE DELIBERATELY NARROW (cloud.md D6 — no probe, no poll): a
   *  successful login, an explicit connection switch with a live session, and a
   *  re-check press. Never from init/reinit/knob toggles/app start — `reinit()`
   *  runs from six onMounted sites, so wiring it there would put a request
   *  behind opening the Local files tab or flipping route-through-Tor. */
  async function fetchCaps(): Promise<void> {
    if (!cloudAvailable || !enabled.value || !activeId.value) return;
    const seq = switchSeq;
    const id = activeId.value;
    try {
      const apps = await call<unknown>("cloud_apps", { serverUrl: serverUrl.value });
      const parsed = normalizeCaps(apps);
      capsById.set(id, parsed);
      if (seq === switchSeq && activeId.value === id) caps.value = parsed;
    } catch {
      // `call()` already classified it. Leave caps unknown ⇒ everything is
      // assumed present, which is exactly the pre-feature behavior.
    }
  }

  /** Flip the master switch. The conscious-enable confirm modal lives in the
   *  Cloud tab view — by the time this runs, the user already said yes. */
  async function setEnabled(on: boolean): Promise<void> {
    if (isTauri()) {
      // The command persists the kv flag and, on off, aborts in-flight transfers.
      await invoke("cloud_set_enabled", { enabled: on });
    } else {
      await persistCloudEnabled(on);
    }
    enabled.value = on;
    error.value = null;
    if (on) {
      initStarted = true;
      await reinit();
    } else {
      // Keep the kv session (disable ≠ logout) but drop everything volatile —
      // an empty transfers map also releases App.vue's idle-lock hold.
      files.value = [];
      buckets.value = [];
      transfers.clear();
    }
  }

  /** Flip "route through Tor" (clearnet hosts only — .onion always rides Tor,
   *  loopback never does). Refreshes the transport badge. */
  async function setForceTor(on: boolean): Promise<void> {
    if (isTauri()) {
      // On switch-on the command aborts ALL in-flight transfers (no route
      // filter — a direct one must not keep exposing the IP; the rest are
      // collateral and can be restarted).
      await invoke("cloud_set_force_tor", { on });
    } else {
      await persistCloudForceTor(on);
    }
    forceTor.value = on;
    initStarted = true;
    await reinit();
  }

  /** Persist a new server URL (normalized by rakotis) and re-check the login
   *  state for that server. Returns the stored (normalized) URL. */
  async function setServerUrl(url: string): Promise<string> {
    serverUrl.value = await persistCloudServerUrl(url);
    clearLocal();
    error.value = null;
    // A different address is a different server: its capabilities and any
    // "unreachable" verdict belonged to the old one.
    if (activeId.value) capsById.delete(activeId.value);
    caps.value = null;
    clearUnreachable();
    initStarted = true; // reinit below replaces any pending first init
    await reinit();
    return serverUrl.value;
  }

  async function login(user: string, password: string): Promise<void> {
    if (!isTauri()) throw new Error("Enigma Cloud is desktop-only.");
    if (!cloudAvailable) throw new Error("Enigma Cloud is disabled in this build.");
    if (!enabled.value) throw new Error("Enigma Cloud is switched off.");
    const seq = switchSeq;
    const res = await call<{ username: string }>("cloud_login", {
      serverUrl: serverUrl.value,
      username: user,
      password,
    });
    // The token was stored under the URL captured at submit time. If the active
    // connection moved while the request was in flight, saying "signed in" here
    // would name the wrong server — Rust's kv is correct either way, and the
    // next reinit will surface the session on the connection that owns it.
    if (seq !== switchSeq) return;
    loggedIn.value = true;
    username.value = res.username;
    error.value = null;
    void ensureListeners();
    // The round-trip is already paid for, so this is the cheapest honest moment
    // to learn what the server offers.
    void fetchCaps();
    await refresh();
  }

  /** Best-effort server logout; local state clears regardless (as does Rust's kv). */
  async function logout(): Promise<void> {
    if (isTauri()) {
      try {
        await call("cloud_logout", { serverUrl: serverUrl.value });
      } catch {
        /* token + username are cleared server-side/kv-side anyway */
      }
    }
    clearLocal();
    error.value = null;
  }

  // ── listing ───────────────────────────────────────────────────────────────────
  async function refresh(): Promise<void> {
    if (!cloudAvailable || !enabled.value || !loggedIn.value) return;
    const seq = switchSeq;
    const id = activeId.value;
    loading.value = true;
    try {
      const res = await call<{ files: CloudFile[]; buckets: CloudBucket[] }>("cloud_list", {
        serverUrl: serverUrl.value,
      });
      if (seq !== switchSeq) return;
      files.value = res.files ?? [];
      buckets.value = res.buckets ?? [];
      // Stamp whose listing this is — every command that sends a server-side id
      // checks it (see `ownsListing`).
      dataConnectionId.value = id;
      error.value = null;
    } catch (e) {
      if (seq !== switchSeq) return;
      const msg = asMessage(e);
      if (!classify(msg)) error.value = msg;
    } finally {
      if (seq === switchSeq) loading.value = false;
    }
  }

  /** Guard for every command carrying a SERVER-SIDE id (directory id, file key,
   *  zone/route id, invite id). Those ids are sequential integers, so id 7
   *  exists on both servers — acting on a row left over from the previous
   *  connection would delete a real, unrelated object on this one. */
  function ownsListing(): boolean {
    return !!dataConnectionId.value && dataConnectionId.value === activeId.value;
  }

  const STALE_LISTING = "That list belongs to another connection — refresh first.";

  /** Wrap a panel-driven action: flip to logged-out on "unauthorized…", then
   *  rethrow a normalized Error so the calling modal can show the message. */
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const msg = asMessage(e);
      classify(msg);
      throw new Error(msg);
    }
  }

  // ── transfers ─────────────────────────────────────────────────────────────────
  async function upload(
    path: string,
    opts: { bucketSlug?: string; directoryId?: number } = {},
  ): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    await ensureListeners();
    // Captured before the await: the transfer belongs to the connection that was
    // active when the user pressed Upload, whatever happens afterwards.
    const owner = activeId.value;
    const ownerName = activeServer.value?.name;
    try {
      const res = await call<{ transfer_id: string; name: string; size: number }>(
        "cloud_upload",
        {
          serverUrl: serverUrl.value,
          path,
          bucketSlug: opts.bucketSlug ?? null,
          directoryId: opts.directoryId ?? null,
        },
      );
      const existing = transfers.get(res.transfer_id);
      transferOwner.set(res.transfer_id, owner);
      transfers.set(res.transfer_id, {
        dir: "up",
        name: res.name,
        transferred: existing?.transferred ?? 0,
        total: res.size || existing?.total || 0,
        error: existing?.error,
        serverName: ownerName,
      });
    } catch (e) {
      const msg = asMessage(e);
      if (!classify(msg)) error.value = msg;
    }
  }

  async function download(key: string, dest: string): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    // The key comes from the rendered listing, so it must be this server's.
    if (!ownsListing()) throw new Error(STALE_LISTING);
    await ensureListeners();
    const owner = activeId.value;
    const ownerName = activeServer.value?.name;
    try {
      const res = await call<{ transfer_id: string }>("cloud_download", {
        serverUrl: serverUrl.value,
        key,
        dest,
      });
      const f = files.value.find((x) => x.key === key);
      const existing = transfers.get(res.transfer_id);
      transferOwner.set(res.transfer_id, owner);
      transfers.set(res.transfer_id, {
        dir: "down",
        name: f?.title || dest.split(/[\\/]/).pop() || key,
        transferred: existing?.transferred ?? 0,
        total: existing?.total || f?.file_size_bytes || 0,
        error: existing?.error,
        serverName: ownerName,
      });
    } catch (e) {
      const msg = asMessage(e);
      if (!classify(msg)) error.value = msg;
    }
  }

  // ── files & directories ───────────────────────────────────────────────────────
  async function remove(key: string): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    if (!ownsListing()) throw new Error(STALE_LISTING);
    return guarded(async () => {
      await call("cloud_delete", { serverUrl: serverUrl.value, key });
      files.value = files.value.filter((f) => f.key !== key);
    });
  }

  async function mkdir(
    name: string,
    opts: { bucketSlug?: string; parentId?: number } = {},
  ): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    // Both `bucketSlug` and `parentId` come from the rendered tree, so a stale
    // listing would create the folder under an unrelated directory.
    if (!ownsListing() && (opts.bucketSlug !== undefined || opts.parentId !== undefined)) {
      throw new Error(STALE_LISTING);
    }
    return guarded(async () => {
      const dir = await call<{
        id: number;
        name: string;
        parent_id: number | null;
        path: string;
        bucket_slug: string;
      }>("cloud_mkdir", {
        serverUrl: serverUrl.value,
        bucketSlug: opts.bucketSlug ?? null,
        name,
        parentId: opts.parentId ?? null,
      });
      const b = buckets.value.find((x) => x.slug === dir.bucket_slug);
      if (b) {
        b.directories.push({ id: dir.id, name: dir.name, parent_id: dir.parent_id, path: dir.path });
      } else {
        // Unknown bucket locally (e.g. the implicit default was just created).
        void refresh();
      }
    });
  }

  /** null directoryId = move to the bucket root (the command sends JSON null). */
  async function move(key: string, directoryId: number | null): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    if (!ownsListing()) throw new Error(STALE_LISTING);
    return guarded(async () => {
      const f = await call<CloudFile>("cloud_move", {
        serverUrl: serverUrl.value,
        key,
        directoryId,
      });
      upsertFile(f);
    });
  }

  async function rmdir(id: number): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    // The most destructive of the id-carrying commands: directory ids are
    // sequential, so a stale one deletes another server's folder AND its
    // contents.
    if (!ownsListing()) throw new Error(STALE_LISTING);
    return guarded(async () => {
      await call("cloud_rmdir", { serverUrl: serverUrl.value, directoryId: id });
      for (const b of buckets.value) {
        const i = b.directories.findIndex((d) => d.id === id);
        if (i >= 0) b.directories.splice(i, 1);
      }
    });
  }

  return {
    serverUrl,
    loggedIn,
    username,
    checking,
    files,
    buckets,
    loading,
    error,
    transfers,
    enabled,
    forceTor,
    transport,
    offline,
    reachable,
    // named connections
    servers,
    activeId,
    activeServer,
    registryUnreadable,
    switching,
    switchTo,
    addServer,
    editServer,
    removeServer,
    refreshServers,
    // capabilities
    caps,
    hasAster,
    hasBeacon,
    fetchCaps,
    syncOffline,
    clearUnreachable,
    classify,
    call,
    init,
    // Exported so the D6 regression guard can assert that re-hydrating issues
    // no networked command — it runs from six onMounted sites and both knobs.
    reinit,
    setServerUrl,
    setEnabled,
    setForceTor,
    login,
    logout,
    refresh,
    upload,
    download,
    remove,
    mkdir,
    move,
    rmdir,
  };
});
