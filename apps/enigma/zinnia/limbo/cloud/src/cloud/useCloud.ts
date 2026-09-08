// The cloud session, as the UI sees it.
//
// A module-level ref rather than a Pinia store, matching useSystemColors: there
// is exactly one session, and nothing here wants actions, getters or a devtools
// timeline. The pure load/save lives in ./cloudSettings so it is testable
// without a component.
//
// This module holds NO token. Every call that needs one goes to Rust, which
// reads it from the OS secret store and attaches it there. `signedIn` and
// `username` are what Rust reported back — a mirror, not a second source.
import { computed, ref } from "vue";
import { load, save, type CloudSettings } from "./cloudSettings";

export type TlsState = "trusted" | "untrusted" | "unknown";
export type Storage = "keychain" | "memory";

export interface Probe {
  reachable: boolean;
  tls: TlsState;
  fingerprint: string | null;
  reason: string | null;
}

interface SessionInfo {
  signed_in: boolean;
  username: string | null;
  server: string;
  storage: Storage | null;
}

const settings = ref<CloudSettings>(load());
const signedIn = ref(false);
const username = ref("");
const storage = ref<Storage | null>(null);
const busy = ref(false);
const error = ref("");
/** The certificate a probe found but the user has not accepted yet. Distinct
 *  from `settings.fingerprint`, which is one they DID accept — conflating the
 *  two would make "I have seen this" mean "I trust this". */
const pending = ref<Probe | null>(null);

/** Checked per call, not captured at module load: this module is imported
 *  before the webview finishes installing its bridge, so a constant computed at
 *  import time can be false in a window that is perfectly capable. */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("desktop_only: signing in needs the desktop app");
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(cmd, args);
}

function applySession(info: SessionInfo) {
  signedIn.value = info.signed_in;
  username.value = info.username ?? "";
  storage.value = info.storage;
}

export function useCloud() {
  /** The fingerprint to present on the wire: only one the user accepted FOR
   *  THIS server. Changing the address abandons the old pin rather than
   *  carrying it to a host it was never shown for. */
  const pinFor = (server: string) =>
    server === settings.value.server && settings.value.fingerprint
      ? settings.value.fingerprint
      : null;

  /** True when the server's certificate is untrusted and unaccepted — the one
   *  state where the sign-in form must not be offered yet. */
  const needsTrust = computed(
    () => pending.value?.tls === "untrusted" && !settings.value.fingerprint,
  );

  /** Ask what is at an address, without committing anything to it. */
  async function probe(serverUrl: string): Promise<void> {
    busy.value = true;
    error.value = "";
    pending.value = null;
    try {
      pending.value = await invoke<Probe>("cloud_probe", { serverUrl });
      if (pending.value.tls === "trusted") {
        // A server that verifies normally needs no pin, and keeping a stale one
        // would leave a weaker rule in place than the situation calls for.
        setSettings({ server: serverUrl, fingerprint: "" });
      }
    } catch (err) {
      error.value = messageOf(err);
    } finally {
      busy.value = false;
    }
  }

  /** Record the certificate the user just looked at and accepted. */
  function trust(serverUrl: string): void {
    const fingerprint = pending.value?.fingerprint;
    if (!fingerprint) return;
    setSettings({ server: serverUrl, fingerprint });
  }

  async function signIn(serverUrl: string, user: string, password: string): Promise<boolean> {
    busy.value = true;
    error.value = "";
    try {
      const info = await invoke<SessionInfo>("cloud_login", {
        serverUrl,
        username: user,
        password,
        fingerprint: pinFor(serverUrl),
      });
      applySession(info);
      // Rust normalised the address; store what it returned, never our own
      // version of it — that string is the key the token is filed under.
      setSettings({ server: info.server, fingerprint: settings.value.fingerprint });
      return true;
    } catch (err) {
      error.value = messageOf(err);
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function signOut(): Promise<void> {
    busy.value = true;
    try {
      await invoke("cloud_logout", {
        serverUrl: settings.value.server,
        fingerprint: pinFor(settings.value.server),
      });
    } catch {
      // Rust clears the local session even when the server call fails, so
      // there is nothing to report and nothing left behind.
    } finally {
      signedIn.value = false;
      username.value = "";
      storage.value = null;
      error.value = "";
      busy.value = false;
    }
  }

  /** Local only — no network. Safe to call on every mount. */
  async function refresh(): Promise<void> {
    if (!settings.value.server || !isTauri()) return;
    try {
      applySession(await invoke<SessionInfo>("cloud_status", { serverUrl: settings.value.server }));
    } catch {
      signedIn.value = false;
    }
  }

  function setSettings(next: CloudSettings) {
    settings.value = next;
    save(next);
  }

  return {
    settings, signedIn, username, storage, busy, error, pending,
    needsTrust, isTauri,
    probe, trust, signIn, signOut, refresh, setSettings,
  };
}

/** Tauri rejects with a plain string; anything else may be an Error. */
function messageOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}
