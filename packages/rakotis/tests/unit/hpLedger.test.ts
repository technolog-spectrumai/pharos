// Privacy HP — the bridge to Rust, and the browser-mode ledger that stands in
// for it.
//
// The bridge's contract is that callers name an action and never an amount, and
// that nothing the HP layer does can break the UI path that triggered it: an
// unknown id, an older binary that lacks the command, or an answer in the wrong
// shape all come back as a zero delta rather than a throw.
//
// The browser ledger is what the dev server and every unit test run against, so
// it has to keep the same rules Rust does: a live toggle is not charged twice, a
// paired recovery pays only against a live exposure, and metered spends coalesce
// into one row per hour rather than one per message.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));

import {
  FALLBACK_HP_POLICY,
  getHpPolicy,
  hpBalances,
  hpCharge,
  hpDataCredit,
  hpLedger,
  hpRecover,
  hpSetTorPosture,
  initHpPolicy,
  resetHpLedgerForTest,
  setHpPolicyForTest,
} from "../../src/services/hp";
import type { HpPolicy } from "../../src/privacyHp";

const HOUR = 3_600_000;
const MIB = 1024 * 1024;
const T0 = Date.parse("2026-03-01T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  resetHpLedgerForTest();
  setHpPolicyForTest(FALLBACK_HP_POLICY);
  invoke.mockReset();
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.useRealTimers();
});

// ── browser mode ────────────────────────────────────────────────────────────

describe("the browser ledger", () => {
  it("charges a fixed event at its table price and records the spend", async () => {
    expect(await hpCharge("room.create.clearnet")).toEqual({ applied: -250, code: "room.create.clearnet" });
    expect(await hpLedger()).toEqual([
      { ts: T0, kind: "spend", code: "room.create.clearnet", hp: -250, n: 1, bucket: 0 },
    ]);
  });

  it("treats an id it does not know as a no-op, not an error", async () => {
    // A caller names an id, never an amount — a wrong id is the worst it can do.
    expect(await hpCharge("made.up.action")).toEqual({ applied: 0, code: "made.up.action" });
    expect(await hpRecover("made.up.recovery")).toEqual({ applied: 0, code: "made.up.recovery" });
    expect(await hpLedger()).toEqual([]);
  });

  it("returns a copy, so a caller cannot rewrite history", async () => {
    await hpCharge("room.create.clearnet");
    const rows = await hpLedger();
    rows.length = 0;
    expect(await hpLedger()).toHaveLength(1);
  });

  it("stamps rows strictly in order even when the clock stands still", async () => {
    // Exposure pairing compares timestamps; two rows sharing one would make
    // "recovered after the charge" ambiguous.
    await hpCharge("room.create.clearnet");
    await hpCharge("room.join.clearnet");
    expect((await hpLedger()).map((e) => e.ts)).toEqual([T0, T0 + 1]);
  });

  it("does not charge a toggle that is already on, until it has been withdrawn", async () => {
    expect((await hpCharge("dht.presence.enable")).applied).toBe(-500);
    expect((await hpCharge("dht.presence.enable")).applied).toBe(0);
    expect((await hpRecover("dht.presence.withdraw")).applied).toBe(250);
    // Flipping it back on is a fresh exposure — and a net loss, by design.
    expect((await hpCharge("dht.presence.enable")).applied).toBe(-500);
    expect((await hpLedger()).filter((e) => e.kind === "spend")).toHaveLength(2);
  });

  it("pays a paired recovery only against a live exposure, and only once", async () => {
    expect((await hpRecover("dht.nickname.withdraw")).applied).toBe(0);
    await hpCharge("dht.nickname.publish");
    expect((await hpRecover("dht.nickname.withdraw")).applied).toBe(500);
    expect((await hpRecover("dht.nickname.withdraw")).applied).toBe(0);
  });

  it("pays an unpaired recovery each time it happens", async () => {
    expect((await hpRecover("room.leave")).applied).toBe(150);
    expect((await hpRecover("room.leave")).applied).toBe(150);
  });

  it("coalesces metered spends into one row per hour", async () => {
    await hpCharge("msg.clearnet.mls", { bytes: 20 });
    vi.setSystemTime(T0 + 10 * 60_000);
    await hpCharge("msg.clearnet.mls", { bytes: 4 * MIB });
    const bucket = Math.floor(T0 / HOUR);
    expect(await hpLedger()).toEqual([
      { ts: T0, kind: "spend", code: "msg.clearnet.mls", hp: -12, n: 2, bucket },
    ]);

    vi.setSystemTime(T0 + HOUR);
    await hpCharge("msg.clearnet.mls", { bytes: 20 });
    expect((await hpLedger()).map((e) => [e.bucket, e.n, e.hp])).toEqual([
      [bucket, 2, -12],
      [bucket + 1, 1, -2],
    ]);
  });

  it("prices a call by its minutes", async () => {
    expect((await hpCharge("vox.call", { minutes: 10 })).applied).toBe(-200);
    expect((await hpCharge("vox.call", { minutes: 600 })).applied).toBe(-500); // capped per event
  });

  it("writes nothing for the free lane", async () => {
    expect(await hpCharge("msg.tor.mls", { bytes: 64 * MIB })).toEqual({ applied: 0, code: "msg.tor.mls" });
    expect(await hpLedger()).toEqual([]);
  });

  it("records the Tor posture once per change, starting from off", async () => {
    expect(await hpSetTorPosture(false)).toBe(false); // absent history already means off
    expect(await hpSetTorPosture(true)).toBe(true);
    expect(await hpSetTorPosture(true)).toBe(false);
    expect(await hpSetTorPosture(false)).toBe(true);
    expect((await hpLedger()).map((e) => [e.kind, e.code, e.hp])).toEqual([
      ["posture", "transport.tor.on", 0],
      ["posture", "transport.tor.off", 0],
    ]);
  });

  it("credits deleted data by size, between the minimum award and the per-event cap", async () => {
    expect((await hpDataCredit("data.delete.chat", 0)).applied).toBe(0);
    expect((await hpDataCredit("data.delete.chat", 1)).applied).toBe(25);
    expect((await hpDataCredit("data.delete.chat", 5 * MIB)).applied).toBe(60);
    expect((await hpDataCredit("data.delete.files", 100 * MIB)).applied).toBe(250);
    expect((await hpLedger()).map((e) => e.code)).toEqual([
      "data.delete.chat", "data.delete.chat", "data.delete.files",
    ]);
  });

  it("derives balances from the ledger at the moment asked", async () => {
    await hpCharge("room.create.clearnet");
    expect((await hpBalances(T0)).daily.balanceCenti).toBe(10_000 - 250);
    // Regeneration is 1 HP per 15 minutes off Tor: half an hour later, 2 HP back…
    expect((await hpBalances(T0 + HOUR / 2)).daily.balanceCenti).toBe(10_000 - 250 + 200);
    // …and by the hour the 2.5 HP charge has healed completely, never past the cap.
    expect((await hpBalances(T0 + HOUR)).daily.balanceCenti).toBe(10_000);
  });

  it("charges from whatever table is installed", async () => {
    const tiny: HpPolicy = {
      ...FALLBACK_HP_POLICY,
      actions: [{ id: "x", kind: "event", costCenti: 7, perMibCenti: 0, perMinuteCenti: 0, capPerEventCenti: 0, explainKey: "hp.explain.x" }],
      recoveries: [],
    };
    setHpPolicyForTest(tiny);
    expect(getHpPolicy()).toBe(tiny);
    expect((await hpCharge("x")).applied).toBe(-7);
    expect((await hpCharge("room.create.clearnet")).applied).toBe(0);
  });

  it("keeps the mirror as the table when there is no binary to ask", async () => {
    expect(await initHpPolicy()).toBe(FALLBACK_HP_POLICY);
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ── Tauri mode ──────────────────────────────────────────────────────────────

describe("the bridge to Rust", () => {
  beforeEach(() => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  it("adopts the binary's table at boot", async () => {
    const fetched = { ...FALLBACK_HP_POLICY, version: 2 };
    invoke.mockResolvedValueOnce(fetched);
    expect(await initHpPolicy()).toEqual(fetched);
    expect(getHpPolicy().version).toBe(2);
    expect(invoke).toHaveBeenCalledWith("hp_get_policy", undefined);
  });

  it("keeps the mirror rather than adopt a table with no actions, or none at all", async () => {
    // Every price in the app would silently read zero.
    invoke.mockResolvedValueOnce({ ...FALLBACK_HP_POLICY, actions: [] });
    expect(await initHpPolicy()).toBe(FALLBACK_HP_POLICY);
    invoke.mockResolvedValueOnce(null);
    expect(await initHpPolicy()).toBe(FALLBACK_HP_POLICY);
    invoke.mockRejectedValueOnce(new Error("unknown command hp_get_policy"));
    expect(await initHpPolicy()).toBe(FALLBACK_HP_POLICY);
  });

  it("reads the ledger from the vault, degrading to no history", async () => {
    const rows = [{ ts: 1, kind: "spend", code: "x", hp: -1, n: 1, bucket: 0 }];
    invoke.mockResolvedValueOnce(rows);
    expect(await hpLedger()).toEqual(rows);
    expect(invoke).toHaveBeenCalledWith("hp_ledger", undefined);
    invoke.mockResolvedValueOnce({ not: "an array" });
    expect(await hpLedger()).toEqual([]);
    invoke.mockRejectedValueOnce("vault locked");
    expect(await hpLedger()).toEqual([]);
  });

  it("sends a charge as an id and quantities, never an amount", async () => {
    invoke.mockResolvedValueOnce({ applied: -2, code: "msg.clearnet.mls" });
    expect(await hpCharge("msg.clearnet.mls", { bytes: 20 })).toEqual({ applied: -2, code: "msg.clearnet.mls" });
    expect(invoke).toHaveBeenCalledWith("hp_charge", { actionId: "msg.clearnet.mls", bytes: 20, minutes: null });

    invoke.mockResolvedValueOnce({ applied: -150, code: "vox.call" });
    await hpCharge("vox.call", { minutes: 1 });
    expect(invoke).toHaveBeenLastCalledWith("hp_charge", { actionId: "vox.call", bytes: null, minutes: 1 });
  });

  it("turns an unusable answer into a no-op delta", async () => {
    invoke.mockResolvedValueOnce(undefined);
    expect(await hpCharge("room.join.tor")).toEqual({ applied: 0, code: "room.join.tor" });
    invoke.mockResolvedValueOnce({ applied: Number.NaN, code: "" });
    expect(await hpCharge("room.join.tor")).toEqual({ applied: 0, code: "room.join.tor" });
    invoke.mockResolvedValueOnce({ applied: "-50", code: 7 });
    expect(await hpCharge("room.join.tor")).toEqual({ applied: 0, code: "room.join.tor" });
    invoke.mockRejectedValueOnce(new Error("unknown command"));
    expect(await hpCharge("room.join.tor")).toEqual({ applied: 0, code: "room.join.tor" });
  });

  it("asks Rust for recoveries and data credits, which it alone measures", async () => {
    invoke.mockResolvedValueOnce({ applied: 150, code: "room.leave" });
    expect(await hpRecover("room.leave")).toEqual({ applied: 150, code: "room.leave" });
    expect(invoke).toHaveBeenLastCalledWith("hp_recover", { recoveryId: "room.leave" });

    // The byte count is a hint; Rust weighs what it actually removed.
    invoke.mockResolvedValueOnce({ applied: 25, code: "data.delete.chat" });
    expect(await hpDataCredit("data.delete.chat", 999)).toEqual({ applied: 25, code: "data.delete.chat" });
    expect(invoke).toHaveBeenLastCalledWith("hp_data_credit", { sourceId: "data.delete.chat", bytesFreed: 999 });

    invoke.mockRejectedValue(new Error("unknown command"));
    expect(await hpRecover("room.leave")).toEqual({ applied: 0, code: "room.leave" });
    expect(await hpDataCredit("data.delete.chat", 1)).toEqual({ applied: 0, code: "data.delete.chat" });
  });

  it("records the posture through Rust, reading a failure as nothing written", async () => {
    invoke.mockResolvedValueOnce(true);
    expect(await hpSetTorPosture(true)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("hp_set_tor_posture", { on: true });
    invoke.mockRejectedValueOnce("vault locked");
    expect(await hpSetTorPosture(false)).toBe(false);
  });
});
