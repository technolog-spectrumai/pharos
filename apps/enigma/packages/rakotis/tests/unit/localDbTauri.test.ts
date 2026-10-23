// The kv store inside the Tauri app: every operation is a Rust command against
// the encrypted fjall store, keyed by (namespace, scope, key) exactly as the
// browser fallback keys localStorage. These pin the command names and argument
// shapes — the IPC contract with src-tauri/src/kv.rs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));

import { kvClearNamespace, kvCount, kvDelete, kvGet, kvPut } from "../../src/services/localDb";

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("localDb (Rust backend)", () => {
  it("reads a value, and a miss as null", async () => {
    invoke.mockResolvedValueOnce("v1").mockResolvedValueOnce(null);
    expect(await kvGet("cache", "s", "k")).toBe("v1");
    expect(await kvGet("cache", "s", "missing")).toBeNull();
    expect(invoke.mock.calls).toEqual([
      ["kv_get", { ns: "cache", scope: "s", k: "k" }],
      ["kv_get", { ns: "cache", scope: "s", k: "missing" }],
    ]);
  });

  it("writes and deletes single keys", async () => {
    await kvPut("cache", "s", "k", "v");
    await kvDelete("cache", "s", "k");
    expect(invoke.mock.calls).toEqual([
      ["kv_put", { ns: "cache", scope: "s", k: "k", v: "v" }],
      ["kv_delete", { ns: "cache", scope: "s", k: "k" }],
    ]);
  });

  it("clears and counts a namespace, for one scope or all of them", async () => {
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(3);
    await kvClearNamespace("chat:log", "room-1");
    await kvClearNamespace("chat:log");
    expect(await kvCount("chat:log")).toBe(3);
    expect(invoke.mock.calls).toEqual([
      ["kv_clear_namespace", { ns: "chat:log", scope: "room-1" }],
      ["kv_clear_namespace", { ns: "chat:log", scope: undefined }],
      ["kv_count", { ns: "chat:log", scope: undefined }],
    ]);
  });

  it("lets a store failure reach the caller, unlike the browser fallback", async () => {
    // Callers decide what a locked vault means for them; the kv does not guess.
    invoke.mockRejectedValueOnce(new Error("vault locked"));
    await expect(kvPut("cache", "s", "k", "v")).rejects.toThrow("vault locked");
    expect(localStorage.length).toBe(0);
  });
});
