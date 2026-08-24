// Privacy HP — the app-side orchestration: what actually gets charged, when a
// confirmation is raised, what the flash says, and what must stay silent.
//
// These run in browser mode (no Tauri), so `services/hp.ts` keeps its ledger in
// memory and every charge here is the real code path a click takes.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { formatPrice, resetHpLedgerForTest, getHpPolicy } from "rakotis";
import {
  chargeHp,
  confirmHp,
  creditFor,
  dismissHpFlash,
  explainFor,
  hpBalances,
  hpConfirm,
  hpFlash,
  labelFor,
  priceFor,
  recoverHp,
  refreshHp,
  resolveHpConfirm,
  setHpTranslator,
  stopHp,
  withHp,
} from "../../src/components/hp/useHp";

beforeEach(async () => {
  resetHpLedgerForTest();
  stopHp();
  setHpTranslator(null);
  await refreshHp();
});

const daily = () => hpBalances.value.daily.balanceCenti;
const weekly = () => hpBalances.value.weekly.balanceCenti;

// ── prices reach the call sites unchanged ───────────────────────────────────

describe("prices", () => {
  it("reports a negative price for an action and a positive credit for a recovery", () => {
    expect(priceFor("dht.presence.enable")).toBe(-1000);
    expect(creditFor("dht.presence.withdraw")).toBe(500);
  });

  it("scales a metered price by the quantity given", () => {
    expect(priceFor("file.send")).toBe(-100);
    expect(priceFor("file.send", { bytes: 100 * 1024 * 1024 })).toBe(-500); // capped
    expect(priceFor("vox.call", { minutes: 10 })).toBe(-400);
  });

  it("prices an action this build does not have at zero", () => {
    // A surface gated out at compile time has no price rather than a wrong one.
    expect(priceFor("some.future.action")).toBe(0);
  });
});

// ── charging ────────────────────────────────────────────────────────────────

describe("charging", () => {
  it("subtracts from BOTH meters at once", async () => {
    await chargeHp("dht.presence.enable");
    expect(daily()).toBe(9000);
    expect(weekly()).toBe(69_000);
  });

  it("charges a toggle once and then stops", async () => {
    await chargeHp("dht.presence.enable");
    const after = daily();
    await chargeHp("dht.presence.enable");
    await chargeHp("dht.presence.enable");
    expect(daily()).toBe(after);
  });

  it("charges an event every single time", async () => {
    await chargeHp("ticket.export.clearnet");
    await chargeHp("ticket.export.clearnet");
    expect(daily()).toBe(10_000 - 2000);
  });

  it("never charges an ordinary encrypted message on the safe lane", async () => {
    for (let i = 0; i < 20; i++) await chargeHp("msg.tor.mls", { bytes: 4096 });
    expect(daily()).toBe(10_000);
  });

  it("bills a clearnet message a little, and more when it is large", async () => {
    await chargeHp("msg.clearnet.mls", { bytes: 20 });
    expect(daily()).toBe(9995);
    await chargeHp("msg.clearnet.mls", { bytes: 4 * 1024 * 1024 });
    expect(daily()).toBe(9995 - 25);
  });

  it("coalesces repeated metered charges into one bucket", async () => {
    for (let i = 0; i < 47; i++) await chargeHp("msg.clearnet.mls", { bytes: 20 });
    const { hpLedger } = await import("rakotis");
    const rows = (await hpLedger()).filter((r) => r.code === "msg.clearnet.mls");
    // One row per hour, not one row per message — the ledger must not become a
    // timestamped log of when you sent things.
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(47);
    expect(rows[0].hp).toBe(-235);
  });

  it("makes a switch flipped off and on again a net loss", async () => {
    await chargeHp("dht.presence.enable");
    await recoverHp("dht.presence.withdraw");
    await chargeHp("dht.presence.enable");
    expect(daily()).toBe(10_000 - 1000 + 500 - 1000);
  });

  it("pays nothing for a recovery whose exposure was never live", async () => {
    await recoverHp("dht.presence.withdraw");
    expect(daily()).toBe(10_000);
  });
});

// ── calendar ────────────────────────────────────────────────────────────────

describe("meetings and polls", () => {
  it("costs exactly what the same information costs as a chat message", async () => {
    // Meetings ride `sendSync` → `sendEncryptedMedia`, the same MLS seam an
    // ordinary message uses. To a relay the two events are indistinguishable, so
    // scheduling "Tuesday 3pm" must not be cheaper than typing it.
    expect(priceFor("calendar.share.clearnet")).toBe(priceFor("msg.clearnet.mls"));
    expect(priceFor("calendar.share.tor")).toBe(priceFor("msg.tor.mls"));
  });

  it("is free over Tor", async () => {
    for (let i = 0; i < 25; i++) await chargeHp("calendar.share.tor");
    expect(daily()).toBe(10_000);
  });

  it("bills a little on a clearnet room", async () => {
    await chargeHp("calendar.share.clearnet");
    expect(daily()).toBe(9995);
  });

  it("has no plaintext lane, because the calendar cannot send unencrypted", () => {
    // `sendSync` encrypts or throws, and `canSendTo` gates on mlsStatus ===
    // "ready". A `.plain` price would name a state that cannot occur.
    const { getHpPolicy: policy } = { getHpPolicy };
    const ids = policy().actions.map((a) => a.id);
    expect(ids).toContain("calendar.share.tor");
    expect(ids).toContain("calendar.share.clearnet");
    expect(ids).not.toContain("calendar.share.clearnet.plain");
    expect(ids.filter((id) => id.startsWith("calendar."))).toHaveLength(2);
  });
});

// ── the confirm gate ────────────────────────────────────────────────────────

describe("confirmation", () => {
  it("does not ask for a low-cost action", async () => {
    await expect(confirmHp("room.create.clearnet")).resolves.toBe(true);
    expect(hpConfirm.value).toBeNull();
  });

  it("asks for a high-cost action and honours a refusal", async () => {
    const pending = confirmHp("dht.nickname.publish");
    expect(hpConfirm.value).not.toBeNull();
    expect(hpConfirm.value?.centi).toBe(-2000);
    resolveHpConfirm(false);
    await expect(pending).resolves.toBe(false);
    expect(hpConfirm.value).toBeNull();
  });

  it("asks for a high-cost action and lets it through on approval", async () => {
    const pending = confirmHp("dht.nickname.publish");
    resolveHpConfirm(true);
    await expect(pending).resolves.toBe(true);
  });

  it("asks even for a cheap action once a meter is empty", async () => {
    // Drain today with repeated clearnet ticket exports.
    for (let i = 0; i < 10; i++) await chargeHp("ticket.export.clearnet");
    expect(daily()).toBe(0);
    const pending = confirmHp("room.create.tor");
    expect(hpConfirm.value?.exhausted).toBe(true);
    resolveHpConfirm(true);
    await expect(pending).resolves.toBe(true);
  });

  it("never asks about a free action, even at zero", async () => {
    for (let i = 0; i < 10; i++) await chargeHp("ticket.export.clearnet");
    await expect(confirmHp("msg.tor.mls")).resolves.toBe(true);
    expect(hpConfirm.value).toBeNull();
  });

  it("keeps file sends one-tap at any size, because the cap holds them below the threshold", async () => {
    // file.send is capped at 5 HP — moderate — and the gate opens at 10. So no
    // transfer, however large, interrupts on price alone. That is the cap doing
    // its job, and it is worth pinning: raising the cap past 10 would silently
    // turn every big attachment into a modal.
    await expect(confirmHp("file.send", { bytes: 1024 })).resolves.toBe(true);
    await expect(confirmHp("file.send", { bytes: 4096 * 1024 * 1024 })).resolves.toBe(true);
    expect(hpConfirm.value).toBeNull();
    expect(Math.abs(priceFor("file.send", { bytes: 4096 * 1024 * 1024 })))
      .toBeLessThan(getHpPolicy().confirmAtCenti);
  });

  it("scales the gate with a metered quantity where the cap allows it", async () => {
    // vox.call caps at 10 HP, exactly the threshold, so a long call DOES ask.
    await expect(confirmHp("vox.call", { minutes: 1 })).resolves.toBe(true);
    const pending = confirmHp("vox.call", { minutes: 600 });
    expect(hpConfirm.value?.centi).toBe(-1000);
    resolveHpConfirm(false);
    await expect(pending).resolves.toBe(false);
  });
});

// ── withHp: confirm → act → charge, in that order ───────────────────────────

describe("withHp", () => {
  it("runs the action and then charges", async () => {
    const order: string[] = [];
    const run = vi.fn(async () => {
      order.push("acted");
      return "done";
    });
    const result = await withHp("room.create.clearnet", run);
    expect(result).toBe("done");
    expect(order).toEqual(["acted"]);
    expect(daily()).toBe(9500);
  });

  it("does not act at all when the confirmation is declined", async () => {
    const run = vi.fn();
    const pending = withHp("dht.nickname.publish", run);
    resolveHpConfirm(false);
    expect(await pending).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(daily()).toBe(10_000);
  });
});

// ── the flash ───────────────────────────────────────────────────────────────

describe("the flash", () => {
  it("reports what was spent", async () => {
    await chargeHp("dht.presence.enable");
    expect(hpFlash.value?.centi).toBe(-1000);
    expect(formatPrice(hpFlash.value!.centi)).toBe("−10 HP");
  });

  it("stays silent for a no-op", async () => {
    await chargeHp("dht.presence.enable");
    dismissHpFlash();
    await chargeHp("dht.presence.enable"); // already live
    expect(hpFlash.value).toBeNull();
  });

  it("stays silent on the free lane", async () => {
    await chargeHp("msg.tor.mls", { bytes: 999 });
    expect(hpFlash.value).toBeNull();
  });

  it("re-animates two identical charges in a row", async () => {
    await chargeHp("ticket.export.clearnet");
    const first = hpFlash.value!.seq;
    await chargeHp("ticket.export.clearnet");
    expect(hpFlash.value!.seq).toBeGreaterThan(first);
  });
});

// ── labels ──────────────────────────────────────────────────────────────────

describe("labels", () => {
  it("falls back to the raw id with no translator registered", () => {
    expect(labelFor("vox.call")).toBe("vox.call");
    expect(explainFor("vox.call")).toBe("");
  });

  it("reads through a registered translator", () => {
    const seen: string[] = [];
    setHpTranslator({
      t: (k) => {
        seen.push(k);
        return `T:${k}`;
      },
      has: () => true,
    });
    expect(labelFor("dht.nickname.publish")).toBe("T:hp.action.dhtNicknamePublish");
    expect(explainFor("dht.nickname.publish")).toBe("T:hp.explain.dhtNicknamePublish");
    expect(seen).toContain("hp.action.dhtNicknamePublish");
  });

  it("survives a translator that throws", () => {
    setHpTranslator({
      t: () => {
        throw new Error("boom");
      },
      has: () => true,
    });
    expect(labelFor("vox.call")).toBe("vox.call");
  });

  it("has a translation key for every action and recovery in the table", async () => {
    const { default: en } = await import("../../src/i18n/en");
    const policy = getHpPolicy();
    const camel = (id: string) =>
      id
        .split(/[._]/)
        .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1)))
        .join("");
    const actions = (en as Record<string, any>).hp.action;
    const explains = (en as Record<string, any>).hp.explain;
    for (const a of policy.actions) {
      expect(actions[camel(a.id)], `hp.action.${camel(a.id)}`).toBeTruthy();
      expect(explains[a.explainKey.replace("hp.explain.", "")], a.explainKey).toBeTruthy();
    }
    for (const r of [...policy.recoveries, ...policy.dataSources]) {
      expect(actions[camel(r.id)], `hp.action.${camel(r.id)}`).toBeTruthy();
      expect(explains[r.explainKey.replace("hp.explain.", "")], r.explainKey).toBeTruthy();
    }
  });
});

// ── lifecycle ───────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  it("drops everything on lock so one profile's shape cannot leak into the next", async () => {
    await chargeHp("dht.nickname.publish");
    expect(daily()).toBeLessThan(10_000);
    stopHp();
    expect(hpFlash.value).toBeNull();
    expect(hpConfirm.value).toBeNull();
    expect(daily()).toBe(10_000);
  });

  it("resolves a pending confirmation as declined when the vault locks", async () => {
    const pending = confirmHp("dht.nickname.publish");
    stopHp();
    await expect(pending).resolves.toBe(false);
  });
});
