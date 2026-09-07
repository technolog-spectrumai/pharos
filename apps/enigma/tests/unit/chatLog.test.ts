import { describe, it, expect, vi, afterEach } from "vitest";
import {
  appendMessages, createLogAppender, loadLog, logMeta, mergeIntoLog,
  messagesSince, wipeLog,
} from "../../src/services/chatLog";
import { CHAT_LOG_SEG_MAX_MSGS, type PersistedMessage } from "../../src/chatHistoryModel";

function msg(id: string, ts: number): PersistedMessage {
  return { id, type: "mls_app", user: "alice", content: `m-${id}`, encrypted: true, ts };
}

function batch(from: number, to: number): PersistedMessage[] {
  return Array.from({ length: to - from }, (_, i) => msg(`m${from + i}`, from + i));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chatLog", () => {
  it("appends, loads, and reports meta", async () => {
    await appendMessages("room-a", batch(0, 3), 500);
    expect((await loadLog("room-a")).map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(await logMeta("room-a")).toEqual({ count: 3, latestTs: 2 });
    expect((await messagesSince("room-a", 0)).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("rolls segments past the segment cap and prunes whole oldest segments", async () => {
    await appendMessages("room-b", batch(0, CHAT_LOG_SEG_MAX_MSGS + 10), 500);
    expect((await loadLog("room-b")).length).toBe(CHAT_LOG_SEG_MAX_MSGS + 10);
    // Pruning drops whole oldest segments but never below the cap: with a tiny
    // cap the full first segment goes, the newer partial segment stays.
    await appendMessages("room-b", batch(1000, 1001), 10);
    const left = await loadLog("room-b");
    expect(left.length).toBe(11);
    expect(left.some((m) => m.id === "m0")).toBe(false); // oldest segment gone
    expect(left.some((m) => m.id === "m1000")).toBe(true);
  });

  it("mergeIntoLog dedupes by id and reorders by ts", async () => {
    await appendMessages("room-c", [msg("a", 100), msg("c", 300)], 500);
    const added = await mergeIntoLog("room-c", [msg("b", 200), msg("c", 999)], 500);
    expect(added).toBe(1);
    expect((await loadLog("room-c")).map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(await mergeIntoLog("room-c", [msg("b", 200)], 500)).toBe(0);
  });

  it("wipes a room's log completely", async () => {
    await appendMessages("room-d", batch(0, 5), 500);
    await wipeLog("room-d");
    expect(await loadLog("room-d")).toEqual([]);
    expect(await logMeta("room-d")).toEqual({ count: 0, latestTs: 0 });
  });

  it("appender batches by time and flushes on demand", async () => {
    vi.useFakeTimers();
    const appender = createLogAppender(() => 500);
    appender.push("room-e", msg("x", 1));
    appender.push("room-e", msg("y", 2));
    expect(await loadLog("room-e")).toEqual([]); // not flushed yet
    await vi.advanceTimersByTimeAsync(1100);
    expect((await loadLog("room-e")).map((m) => m.id)).toEqual(["x", "y"]);
    appender.push("room-e", msg("z", 3));
    await appender.flushNow();
    expect((await loadLog("room-e")).map((m) => m.id)).toEqual(["x", "y", "z"]);
  });
});
