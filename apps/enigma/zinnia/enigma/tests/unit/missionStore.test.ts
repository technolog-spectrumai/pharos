import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri bridge so we can exercise the mission_store data-layer gateway
// without a real Tauri runtime / fjall.
const invoke = vi.fn(async () => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => (invoke as any)(...a) }));

describe("missionStore — CRDT data-layer gateway", () => {
  let store: typeof import("../../src/services/missionStore");

  beforeEach(async () => {
    invoke.mockReset();
    vi.resetModules();
    store = await import("../../src/services/missionStore");
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  describe("in Tauri", () => {
    beforeEach(() => {
      (window as any).__TAURI_INTERNALS__ = {};
    });

    it("persist ingests the records then returns the snapshot projection", async () => {
      const records = [{ id: 1, title: "Alpha" }];
      const projection = [{ id: 1, title: "Alpha (stored)" }];
      invoke.mockImplementation(async (cmd: string) =>
        cmd === "mission_store_snapshot" ? projection : 1,
      );

      const out = await store.persist(7, "missions", records);

      expect(invoke).toHaveBeenCalledWith("mission_store_ingest", {
        projectId: 7,
        map: "missions",
        records,
      });
      expect(invoke).toHaveBeenCalledWith("mission_store_snapshot", { projectId: 7, map: "missions" });
      expect(out).toBe(projection);
    });

    it("persist falls back to the raw records if the store errors", async () => {
      const records = [{ id: 1, title: "Alpha" }];
      invoke.mockRejectedValue(new Error("fjall down"));

      const out = await store.persist(7, "missions", records);
      expect(out).toBe(records);
    });

    it("cached returns the snapshot projection", async () => {
      const projection = [{ id: 2, title: "Cached" }];
      invoke.mockResolvedValue(projection);

      const out = await store.cached(7, "missions");
      expect(invoke).toHaveBeenCalledWith("mission_store_snapshot", { projectId: 7, map: "missions" });
      expect(out).toBe(projection);
    });

    it("cached returns null when nothing is stored / store errors", async () => {
      invoke.mockRejectedValue(new Error("empty"));
      expect(await store.cached(7, "missions")).toBeNull();
    });
  });

  describe("outside Tauri (browser / vitest)", () => {
    it("persist returns the records unchanged without invoking", async () => {
      const records = [{ id: 1, title: "Alpha" }];
      const out = await store.persist(7, "missions", records);
      expect(out).toBe(records);
      expect(invoke).not.toHaveBeenCalled();
    });

    it("cached returns null without invoking", async () => {
      expect(await store.cached(7, "missions")).toBeNull();
      expect(invoke).not.toHaveBeenCalled();
    });
  });
});
