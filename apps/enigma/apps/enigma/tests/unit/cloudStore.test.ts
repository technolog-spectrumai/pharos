import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// The Cloud tab's runtime master switch (cloud.md): default OFF, Rust enforces
// the same kv flag on every command — here we verify the frontend half: the
// rakotis accessors' fail-closed defaults, the store's setter side effects
// (kv write, shutdown-owning Tauri commands, volatile-state clearing), and
// that actions no-op while the switch is off.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import {
  getCloudEnabled,
  setCloudEnabled,
  getCloudForceTor,
  setCloudForceTor,
} from "rakotis";
import { useCloudStore } from "../../src/stores/cloud";

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  setActivePinia(createPinia());
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("cloud master switch kv accessors", () => {
  it("defaults to off (fail closed)", async () => {
    expect(await getCloudEnabled()).toBe(false);
    expect(await getCloudForceTor()).toBe(false);
  });

  it("round-trips through the kv fallback", async () => {
    await setCloudEnabled(true);
    expect(await getCloudEnabled()).toBe(true);
    await setCloudEnabled(false);
    expect(await getCloudEnabled()).toBe(false);
    await setCloudForceTor(true);
    expect(await getCloudForceTor()).toBe(true);
  });
});

describe("cloud store — master switch", () => {
  it("hydrates enabled=false by default in browser mode", async () => {
    const cloud = useCloudStore();
    await cloud.init();
    expect(cloud.enabled).toBe(false);
    expect(cloud.forceTor).toBe(false);
  });

  it("setEnabled writes kv in browser mode without any invoke", async () => {
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    expect(cloud.enabled).toBe(true);
    expect(await getCloudEnabled()).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("setEnabled routes through the Rust command in Tauri (it owns the shutdown)", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cloud_status")
        return { logged_in: false, username: null, enabled: true, force_tor: false, transport: "loopback" };
      return undefined;
    });
    const cloud = useCloudStore();
    await cloud.setEnabled(true);
    expect(invokeMock).toHaveBeenCalledWith("cloud_set_enabled", { enabled: true });
    expect(cloud.enabled).toBe(true);
    expect(cloud.transport).toBe("loopback");
  });

  it("setEnabled(false) drops volatile state but keeps the login mirror (disable ≠ logout)", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(undefined);
    const cloud = useCloudStore();
    cloud.enabled = true;
    cloud.loggedIn = true;
    cloud.username = "alice";
    cloud.files = [{ id: 1 } as never];
    cloud.transfers.set("t1", { dir: "up", name: "x", transferred: 0, total: 10 });
    await cloud.setEnabled(false);
    expect(invokeMock).toHaveBeenCalledWith("cloud_set_enabled", { enabled: false });
    expect(cloud.enabled).toBe(false);
    // Transfers cleared — releases App.vue's idle-lock hold; files dropped.
    expect(cloud.transfers.size).toBe(0);
    expect(cloud.files).toHaveLength(0);
    // The kv session is Rust's business and survives the flip.
    expect(cloud.loggedIn).toBe(true);
    expect(cloud.username).toBe("alice");
  });

  it("setForceTor routes through the Rust command and refreshes the badge", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "cloud_status")
        return { logged_in: false, username: null, enabled: true, force_tor: true, transport: "tor" };
      return undefined;
    });
    const cloud = useCloudStore();
    await cloud.setForceTor(true);
    expect(invokeMock).toHaveBeenCalledWith("cloud_set_force_tor", { on: true });
    expect(cloud.forceTor).toBe(true);
    expect(cloud.transport).toBe("tor");
  });

  it("actions no-op while the switch is off, even when logged in", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const cloud = useCloudStore();
    cloud.enabled = false;
    cloud.loggedIn = true;
    cloud.serverUrl = "https://localhost:8443";
    await cloud.refresh();
    await cloud.upload("/tmp/x");
    await cloud.remove("key");
    expect(invokeMock).not.toHaveBeenCalledWith("cloud_list", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("cloud_upload", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("cloud_delete", expect.anything());
    await expect(cloud.login("alice", "pw")).rejects.toThrow("switched off");
  });
});
