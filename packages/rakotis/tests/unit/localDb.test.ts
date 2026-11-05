import { describe, it, expect, beforeEach, vi } from "vitest";
import { kvGet, kvPut, kvDelete, kvClearNamespace, kvCount } from "../../src/services/localDb";

// In jsdom there is no Tauri runtime, so localDb uses its localStorage backend —
// which is exactly what the browser build and offline cache rely on.
beforeEach(() => localStorage.clear());

describe("localDb (localStorage backend)", () => {
  it("round-trips a value and returns null for a miss", async () => {
    expect(await kvGet("cache", "s", "k")).toBeNull();
    await kvPut("cache", "s", "k", "v1");
    expect(await kvGet("cache", "s", "k")).toBe("v1");
  });

  it("upserts (overwrites) an existing key", async () => {
    await kvPut("cache", "s", "k", "v1");
    await kvPut("cache", "s", "k", "v2");
    expect(await kvGet("cache", "s", "k")).toBe("v2");
    expect(await kvCount("cache", "s")).toBe(1);
  });

  it("isolates by namespace and scope", async () => {
    await kvPut("cache", "a", "k", "1");
    await kvPut("cache", "b", "k", "2");
    await kvPut("notes:queue", "a", "", "3");
    expect(await kvGet("cache", "a", "k")).toBe("1");
    expect(await kvGet("cache", "b", "k")).toBe("2");
    expect(await kvCount("cache", "a")).toBe(1);
    expect(await kvCount("cache")).toBe(2); // both scopes, same namespace
  });

  it("deletes a single key", async () => {
    await kvPut("cache", "s", "k", "v");
    await kvDelete("cache", "s", "k");
    expect(await kvGet("cache", "s", "k")).toBeNull();
  });

  it("clears a whole namespace for a scope without touching others", async () => {
    await kvPut("cache", "s", "a", "1");
    await kvPut("cache", "s", "b", "2");
    await kvPut("notes:snapshot", "s", "", "keep");
    await kvClearNamespace("cache", "s");
    expect(await kvCount("cache", "s")).toBe(0);
    expect(await kvGet("notes:snapshot", "s", "")).toBe("keep");
  });
});

describe("localDb (localStorage backend) when storage is full", () => {
  it("drops the write quietly instead of failing the caller", async () => {
    // A full or disabled localStorage is an ordinary browser state; the app
    // keeps working in memory rather than erroring on every settings change.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    try {
      await expect(kvPut("cache", "s", "k", "v")).resolves.toBeUndefined();
      expect(await kvGet("cache", "s", "k")).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });
});
