import { describe, it, expect, beforeEach } from "vitest";
import {
  makeTempId,
  isTempId,
  isNetworkError,
  remapQueueId,
  summarizeQueue,
  loadSnapshot,
  saveSnapshot,
  loadQueue,
  saveQueue,
  clearOffline,
  opId,
  type QueueOp,
} from "../../src/services/notesOffline";

beforeEach(() => localStorage.clear());

describe("makeTempId / isTempId", () => {
  it("returns -1 for an empty set", () => {
    expect(makeTempId([])).toBe(-1);
  });
  it("decrements below the smallest existing (temp) id", () => {
    expect(makeTempId([{ id: 5 }, { id: 2 }])).toBe(-1);
    expect(makeTempId([{ id: -1 }, { id: 3 }])).toBe(-2);
    expect(makeTempId([{ id: -4 }])).toBe(-5);
  });
  it("isTempId is true only for negatives", () => {
    expect(isTempId(-1)).toBe(true);
    expect(isTempId(0)).toBe(false);
    expect(isTempId(7)).toBe(false);
  });
});

describe("opId", () => {
  it("produces unique ids", () => {
    const a = opId();
    const b = opId();
    expect(a).not.toBe(b);
  });
});

describe("isNetworkError", () => {
  it("treats TypeErrors (fetch rejection) as offline", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
  });
  it("treats a non-status error message as offline", () => {
    expect(isNetworkError(new Error("Network error"))).toBe(true);
  });
  it("treats an HTTP status error as NOT offline", () => {
    expect(isNetworkError(new Error("404: Not Found"))).toBe(false);
    expect(isNetworkError(new Error("500: boom"))).toBe(false);
  });
});

describe("remapQueueId", () => {
  it("rewrites box ids in update/delete/createLink ops only", () => {
    const queue: QueueOp[] = [
      { id: "1", kind: "createBox", tempId: -1, data: { label: "A", properties: {} } },
      { id: "2", kind: "updateBox", boxId: -1, data: { label: "A2" } },
      { id: "3", kind: "deleteBox", boxId: -1 },
      { id: "4", kind: "createLink", tempId: -2, from_box: -1, to_box: 5, label: "x" },
      { id: "5", kind: "deleteLink", linkId: -2 },
    ];
    const out = remapQueueId(queue, -1, 99);
    expect((out[0] as any).tempId).toBe(-1); // createBox.tempId untouched
    expect((out[1] as any).boxId).toBe(99);
    expect((out[2] as any).boxId).toBe(99);
    expect((out[3] as any).from_box).toBe(99);
    expect((out[3] as any).to_box).toBe(5);
    expect((out[4] as any).linkId).toBe(-2); // link namespace untouched
  });
});

describe("summarizeQueue", () => {
  it("counts ops by kind", () => {
    const queue: QueueOp[] = [
      { id: "1", kind: "createBox", tempId: -1, data: { label: "A", properties: {} } },
      { id: "2", kind: "createBox", tempId: -2, data: { label: "B", properties: {} } },
      { id: "3", kind: "deleteLink", linkId: 5 },
    ];
    expect(summarizeQueue(queue)).toEqual({ createBox: 2, deleteLink: 1 });
  });
});

describe("snapshot + queue persistence", () => {
  const snap = {
    boxes: [{ id: 1, label: "A", is_locked: false, category_id: null, category_name: null, properties: {}, created_at: "", updated_at: "" }],
    categories: [],
    links: [],
    references: [],
    lastSyncedAt: "2026-06-06T00:00:00Z",
  };

  it("round-trips a snapshot, namespaced by scope", () => {
    saveSnapshot("http://a", snap as any);
    expect(loadSnapshot("http://a")?.boxes[0].label).toBe("A");
    expect(loadSnapshot("http://b")).toBeNull(); // different scope, isolated
  });

  it("round-trips a queue", () => {
    const queue: QueueOp[] = [{ id: "1", kind: "deleteBox", boxId: 3 }];
    saveQueue("s", queue);
    expect(loadQueue("s")).toEqual(queue);
    expect(loadQueue("other")).toEqual([]);
  });

  it("clearOffline removes both snapshot and queue for a scope", () => {
    saveSnapshot("s", snap as any);
    saveQueue("s", [{ id: "1", kind: "deleteBox", boxId: 3 }]);
    clearOffline("s");
    expect(loadSnapshot("s")).toBeNull();
    expect(loadQueue("s")).toEqual([]);
  });

  it("tolerates corrupt JSON in storage", () => {
    localStorage.setItem("enigma:notes:snapshot:s", "{not json");
    expect(loadSnapshot("s")).toBeNull();
  });
});
