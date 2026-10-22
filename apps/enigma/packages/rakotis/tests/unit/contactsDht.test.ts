// Contacts' DHT lookups inside the Tauri app.
//
// Both are best-effort by contract: presence and the nickname directory need the
// DHT toggle on and a bootstrapped Mainline node, and the Contacts tab polls them
// on a timer. An error must read as "nobody found", never as a thrown poll that
// stops the timer or a red banner over an ordinary offline state.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));

import { dhtFindNick, dhtPresence } from "../../src/services/contacts";

const NODE = "a".repeat(64);

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("presence", () => {
  it("asks Rust about exactly the contacts given", async () => {
    invoke.mockResolvedValueOnce([{ node_id: NODE, online: true }]);
    expect(await dhtPresence([NODE])).toEqual([{ node_id: NODE, online: true }]);
    expect(invoke).toHaveBeenCalledWith("dht_presence", { nodeIds: [NODE] });
  });

  it("does not ask at all for an empty list", async () => {
    expect(await dhtPresence([])).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads a failed lookup as nobody online", async () => {
    invoke.mockRejectedValueOnce(new Error("DHT_DISABLED"));
    expect(await dhtPresence([NODE])).toEqual([]);
  });
});

describe("the nickname directory", () => {
  it("searches for the nickname as typed and returns the claims", async () => {
    const claims = [{ node_id: NODE, name: "Alice", ts: 1 }];
    invoke.mockResolvedValueOnce(claims);
    expect(await dhtFindNick("Alice")).toEqual(claims);
    expect(invoke).toHaveBeenCalledWith("dht_find_nick", { nick: "Alice" });
  });

  it("does not search for a blank nickname", async () => {
    expect(await dhtFindNick("   ")).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads a failed search as no claims", async () => {
    invoke.mockRejectedValueOnce(new Error("not bootstrapped"));
    expect(await dhtFindNick("Alice")).toEqual([]);
  });

  it("returns nothing in a browser, without asking", async () => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    expect(await dhtFindNick("Alice")).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
