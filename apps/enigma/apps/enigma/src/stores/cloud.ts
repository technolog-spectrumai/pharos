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

import { reactive, ref } from "vue";
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

  // A build with cloud.allow_connections: false behaves like the browser here:
  // every action no-ops locally (the UI is hidden anyway) and Rust rejects any
  // direct invoke with CLOUD_DISABLED — that remains the real boundary.
  const cloudAvailable = isTauri() && getBuildConfig().cloud_allow_connections;

  function asMessage(e: unknown): string {
    if (typeof e === "string") return e;
    return (e as Error)?.message ?? String(e);
  }

  /** Local logged-out state (kv token is Rust's business — already cleared). */
  function clearLocal() {
    loggedIn.value = false;
    username.value = "";
    files.value = [];
    buckets.value = [];
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
        if (e.payload.dir === "up") {
          // The 201 fileDict rides the event — splice it in; refresh as fallback.
          if (e.payload.file) upsertFile(e.payload.file);
          else void refresh();
        }
        dropSoon(e.payload.transferId, DONE_LINGER_MS);
      },
    );
    await listen<{ transferId: string; message: string }>("cloud://error", (e) => {
      const msg = e.payload.message || "Transfer failed.";
      if (sessionExpired(msg)) {
        error.value = msg;
        return;
      }
      if (knobRefused(msg)) {
        dropSoon(e.payload.transferId, ERROR_LINGER_MS);
        return;
      }
      const t = transfers.get(e.payload.transferId);
      if (t) t.error = msg;
      else error.value = msg;
      dropSoon(e.payload.transferId, ERROR_LINGER_MS);
    });
  }

  function dropSoon(id: string, ms: number) {
    setTimeout(() => transfers.delete(id), ms);
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
    checking.value = true;
    try {
      serverUrl.value = await getCloudServerUrl();
      // kv hydration works in browser/vitest too (localStorage kv fallback).
      enabled.value = await getCloudEnabled();
      forceTor.value = await getCloudForceTor();
      if (!cloudAvailable) {
        clearLocal();
        return;
      }
      // Authoritative: Rust reads the same kv plus the profile's Tor-exclusive
      // flag, and predicts the transport for the badge. Local-only, knob-exempt.
      const st = await invoke<{
        logged_in: boolean;
        username: string | null;
        enabled: boolean;
        force_tor: boolean;
        transport: CloudTransport;
      }>("cloud_status", { serverUrl: serverUrl.value });
      loggedIn.value = st.logged_in;
      username.value = st.username ?? "";
      enabled.value = st.enabled;
      forceTor.value = st.force_tor;
      transport.value = st.transport;
      if (loggedIn.value && enabled.value) void ensureListeners();
    } catch (e) {
      error.value = asMessage(e);
    } finally {
      checking.value = false;
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
    initStarted = true; // reinit below replaces any pending first init
    await reinit();
    return serverUrl.value;
  }

  async function login(user: string, password: string): Promise<void> {
    if (!isTauri()) throw new Error("Enigma Cloud is desktop-only.");
    if (!cloudAvailable) throw new Error("Enigma Cloud is disabled in this build.");
    if (!enabled.value) throw new Error("Enigma Cloud is switched off.");
    const res = await invoke<{ username: string }>("cloud_login", {
      serverUrl: serverUrl.value,
      username: user,
      password,
    });
    loggedIn.value = true;
    username.value = res.username;
    error.value = null;
    void ensureListeners();
    await refresh();
  }

  /** Best-effort server logout; local state clears regardless (as does Rust's kv). */
  async function logout(): Promise<void> {
    if (isTauri()) {
      try {
        await invoke("cloud_logout", { serverUrl: serverUrl.value });
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
    loading.value = true;
    try {
      const res = await invoke<{ files: CloudFile[]; buckets: CloudBucket[] }>("cloud_list", {
        serverUrl: serverUrl.value,
      });
      files.value = res.files ?? [];
      buckets.value = res.buckets ?? [];
      error.value = null;
    } catch (e) {
      const msg = asMessage(e);
      if (!sessionExpired(msg) && !knobRefused(msg)) error.value = msg;
    } finally {
      loading.value = false;
    }
  }

  /** Wrap a panel-driven action: flip to logged-out on "unauthorized…", then
   *  rethrow a normalized Error so the calling modal can show the message. */
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const msg = asMessage(e);
      sessionExpired(msg);
      knobRefused(msg);
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
    try {
      const res = await invoke<{ transfer_id: string; name: string; size: number }>(
        "cloud_upload",
        {
          serverUrl: serverUrl.value,
          path,
          bucketSlug: opts.bucketSlug ?? null,
          directoryId: opts.directoryId ?? null,
        },
      );
      const existing = transfers.get(res.transfer_id);
      transfers.set(res.transfer_id, {
        dir: "up",
        name: res.name,
        transferred: existing?.transferred ?? 0,
        total: res.size || existing?.total || 0,
        error: existing?.error,
      });
    } catch (e) {
      const msg = asMessage(e);
      if (!sessionExpired(msg) && !knobRefused(msg)) error.value = msg;
    }
  }

  async function download(key: string, dest: string): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    await ensureListeners();
    try {
      const res = await invoke<{ transfer_id: string }>("cloud_download", {
        serverUrl: serverUrl.value,
        key,
        dest,
      });
      const f = files.value.find((x) => x.key === key);
      const existing = transfers.get(res.transfer_id);
      transfers.set(res.transfer_id, {
        dir: "down",
        name: f?.title || dest.split(/[\\/]/).pop() || key,
        transferred: existing?.transferred ?? 0,
        total: existing?.total || f?.file_size_bytes || 0,
        error: existing?.error,
      });
    } catch (e) {
      const msg = asMessage(e);
      if (!sessionExpired(msg) && !knobRefused(msg)) error.value = msg;
    }
  }

  // ── files & directories ───────────────────────────────────────────────────────
  async function remove(key: string): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    return guarded(async () => {
      await invoke("cloud_delete", { serverUrl: serverUrl.value, key });
      files.value = files.value.filter((f) => f.key !== key);
    });
  }

  async function mkdir(
    name: string,
    opts: { bucketSlug?: string; parentId?: number } = {},
  ): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    return guarded(async () => {
      const dir = await invoke<{
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
    return guarded(async () => {
      const f = await invoke<CloudFile>("cloud_move", {
        serverUrl: serverUrl.value,
        key,
        directoryId,
      });
      upsertFile(f);
    });
  }

  async function rmdir(id: number): Promise<void> {
    if (!cloudAvailable || !enabled.value) return;
    return guarded(async () => {
      await invoke("cloud_rmdir", { serverUrl: serverUrl.value, directoryId: id });
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
    init,
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
