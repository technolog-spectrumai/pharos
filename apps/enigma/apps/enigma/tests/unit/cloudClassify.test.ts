import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// The cloud store's error-classification machinery — the seam where a Rust
// error string becomes UI state. Three machine prefixes are load-bearing:
//
//   unauthorized:  the session died      → flip to logged-out (Rust already
//                                          cleared the kv token)
//   cloud_off:     the master switch     → sync the knob mirror off
//   unreachable:   a transport failure   → the server did not answer
//
// Getting this wrong is not cosmetic: a missed "unauthorized" leaves the UI
// claiming a dead session is live, and a mis-tagged "unreachable" either hides
// a real auth problem or locks the user out of a working server. What follows
// pins the contract in both directions — what each prefix DOES, and what it
// must deliberately NOT touch.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { useCloudStore } from "../../src/stores/cloud";

// Mirrors cloud.rs: CLOUD_OFF, status_err's 401 branch, connect()'s tagged exit,
// and file_xfer.rs's OFFLINE_BLOCKED (which deliberately has NO prefix).
const CLOUD_OFF = "cloud_off: Enigma Cloud is switched off (enable it in the Cloud tab).";
const UNAUTHORIZED = "unauthorized: session expired (HTTP 401)";
const NOT_LOGGED_IN = "unauthorized: not logged in";
const UNREACHABLE_TCP = "unreachable: connect to h:443 failed: Connection refused (os error 111)";
const UNREACHABLE_TIMEOUT = "unreachable: connect to h:443 timed out after 60s";
const OFFLINE_BLOCKED = "Offline — all network connections are blocked.";

function fakeTauri() {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  setActivePinia(createPinia());
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("classify — what each machine prefix does", () => {
  it("'unauthorized' flips to logged-out and drops volatile state", () => {
    const cloud = useCloudStore();
    cloud.loggedIn = true;
    cloud.username = "alice";
    cloud.files = [{ id: 1 } as never];
    cloud.buckets = [{ id: 1 } as never];

    expect(cloud.classify(UNAUTHORIZED)).toBe(true);
    expect(cloud.loggedIn).toBe(false);
    expect(cloud.username).toBe("");
    expect(cloud.files).toEqual([]);
    expect(cloud.buckets).toEqual([]);
  });

  it("'cloud_off' syncs the knob mirror off without touching the session", () => {
    const cloud = useCloudStore();
    cloud.enabled = true;
    cloud.loggedIn = true;

    expect(cloud.classify(CLOUD_OFF)).toBe(true);
    expect(cloud.enabled).toBe(false);
    // Disable ≠ logout: the token is still valid, the switch is just off.
    expect(cloud.loggedIn).toBe(true);
  });

  it("'unreachable' marks the server unreachable and nothing else", () => {
    const cloud = useCloudStore();
    cloud.enabled = true;
    cloud.loggedIn = true;

    expect(cloud.classify(UNREACHABLE_TCP)).toBe(true);
    expect(cloud.reachable).toBe(false);
    // A dead socket says nothing about the switch or the session.
    expect(cloud.enabled).toBe(true);
    expect(cloud.loggedIn).toBe(true);
  });

  it("every shape connect() can emit is recognised", () => {
    for (const msg of [UNREACHABLE_TCP, UNREACHABLE_TIMEOUT, "unreachable: TLS handshake to h failed: x"]) {
      setActivePinia(createPinia());
      const cloud = useCloudStore();
      expect(cloud.classify(msg)).toBe(true);
      expect(cloud.reachable).toBe(false);
    }
  });

  it("an unrecognised message is NOT swallowed — the caller still shows it", () => {
    const cloud = useCloudStore();
    // OFFLINE_BLOCKED carries no prefix on purpose (it is shared with ~20
    // non-cloud call sites), so it must fall through to the raw-message path.
    expect(cloud.classify(OFFLINE_BLOCKED)).toBe(false);
    expect(cloud.classify("server error (HTTP 500)")).toBe(false);
    // …and it must not have been mistaken for a dead server.
    expect(cloud.reachable).toBeNull();
  });

  it("airplane mode never marks the server unreachable — no byte left the machine", () => {
    const cloud = useCloudStore();
    cloud.classify(OFFLINE_BLOCKED);
    expect(cloud.reachable).toBeNull();
    cloud.classify(CLOUD_OFF);
    expect(cloud.reachable).toBeNull();
  });

  it("classify never marks the server REACHABLE — only a real answer does that", () => {
    const cloud = useCloudStore();
    for (const msg of [UNAUTHORIZED, CLOUD_OFF, UNREACHABLE_TCP, OFFLINE_BLOCKED]) {
      cloud.classify(msg);
      expect(cloud.reachable).not.toBe(true);
    }
  });

  it("'unauthorized: not logged in' is a preflight, so it proves nothing about the server", () => {
    const cloud = useCloudStore();
    // Rust emits this with zero network I/O (cloud.rs's token preflight).
    // Treating it as an answer would clear a genuine unreachable verdict.
    cloud.reachable = false;
    cloud.classify(NOT_LOGGED_IN);
    expect(cloud.reachable).toBe(false);
  });

  it("the three prefixes cannot be confused with one another", () => {
    const cloud = useCloudStore();
    cloud.enabled = true;
    cloud.loggedIn = true;
    // cloud_off is checked first and must win outright.
    cloud.classify(CLOUD_OFF);
    expect(cloud.enabled).toBe(false);
    expect(cloud.loggedIn).toBe(true);
    expect(cloud.reachable).toBeNull();
  });
});

describe("call — the funnel that learns whether the server answers", () => {
  it("a success proves the server is there", async () => {
    fakeTauri();
    const cloud = useCloudStore();
    invokeMock.mockResolvedValueOnce(["ok"]);

    await expect(cloud.call<string[]>("rdv_invite_fetch", { serverUrl: "u" })).resolves.toEqual(["ok"]);
    expect(cloud.reachable).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("rdv_invite_fetch", { serverUrl: "u" });
  });

  it("a transport failure marks it unreachable AND rethrows", async () => {
    fakeTauri();
    const cloud = useCloudStore();
    invokeMock.mockRejectedValueOnce(UNREACHABLE_TCP);

    await expect(cloud.call("rdv_register", {})).rejects.toBeDefined();
    expect(cloud.reachable).toBe(false);
  });

  it("rethrows so existing callers keep their own error handling", async () => {
    fakeTauri();
    const cloud = useCloudStore();
    invokeMock.mockRejectedValueOnce("server error (HTTP 500)");

    await expect(cloud.call("rdv_invite_broadcast", {})).rejects.toBeDefined();
  });

  it("a later success clears an earlier unreachable — never latches", async () => {
    fakeTauri();
    const cloud = useCloudStore();
    invokeMock.mockRejectedValueOnce(UNREACHABLE_TIMEOUT);
    await expect(cloud.call("rdv_register", {})).rejects.toBeDefined();
    expect(cloud.reachable).toBe(false);

    invokeMock.mockResolvedValueOnce("node-id");
    await cloud.call("rdv_register", {});
    expect(cloud.reachable).toBe(true);
  });

  it("a 401 through the funnel logs out without claiming reachability", async () => {
    fakeTauri();
    const cloud = useCloudStore();
    cloud.loggedIn = true;
    invokeMock.mockRejectedValueOnce(UNAUTHORIZED);

    await expect(cloud.call("cloud_list", {})).rejects.toBeDefined();
    expect(cloud.loggedIn).toBe(false);
    expect(cloud.reachable).not.toBe(true);
  });

  it("unwraps an Error instance as well as a bare string", async () => {
    fakeTauri();
    const cloud = useCloudStore();
    invokeMock.mockRejectedValueOnce(new Error(UNREACHABLE_TCP));

    await expect(cloud.call("rdv_register", {})).rejects.toBeDefined();
    expect(cloud.reachable).toBe(false);
  });
});

describe("clearUnreachable — the retry escape hatch", () => {
  it("returns to 'never tried' so the UI shows neither verdict", () => {
    const cloud = useCloudStore();
    cloud.classify(UNREACHABLE_TCP);
    expect(cloud.reachable).toBe(false);

    cloud.clearUnreachable();
    expect(cloud.reachable).toBeNull();
  });
});

describe("reachability is only ever learned from real requests", () => {
  it("starts null — a fresh app has earned no verdict", () => {
    expect(useCloudStore().reachable).toBeNull();
  });

  it("cloud_status must NOT prove the server is up: it is a local kv read", async () => {
    fakeTauri();
    const cloud = useCloudStore();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "cloud_status") {
        return Promise.resolve({
          logged_in: true,
          username: "alice",
          enabled: true,
          force_tor: false,
          transport: "clearnet",
        });
      }
      return Promise.resolve(undefined);
    });

    await cloud.init();

    expect(cloud.loggedIn).toBe(true); // it did hydrate…
    expect(cloud.reachable).toBeNull(); // …without touching the network
  });

  it("a knob toggle does not prove the server is up either", async () => {
    fakeTauri();
    const cloud = useCloudStore();
    invokeMock.mockResolvedValue(undefined);

    await cloud.setEnabled(true);

    expect(cloud.reachable).toBeNull();
  });
});

describe("syncOffline — the airplane mirror", () => {
  it("mirrors the stored switch", async () => {
    const cloud = useCloudStore();
    expect(cloud.offline).toBe(false);

    localStorage.setItem("enigma:offline", "on");
    await cloud.syncOffline();
    expect(cloud.offline).toBe(true);

    localStorage.setItem("enigma:offline", "off");
    await cloud.syncOffline();
    expect(cloud.offline).toBe(false);
  });

  it("hydrates on init, so the tab knows before the first press", async () => {
    localStorage.setItem("enigma:offline", "on");
    const cloud = useCloudStore();
    await cloud.init();
    expect(cloud.offline).toBe(true);
  });
});
