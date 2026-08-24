// Privacy MANA — the app-side orchestration: what actually gets charged, when a
// confirmation is raised, what the flash says, and what must stay silent.
//
// These run in browser mode (no Tauri), so `services/mana.ts` keeps its ledger in
// memory and every charge here is the real code path a click takes.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { formatPrice, resetManaLedgerForTest, getManaPolicy } from "rakotis";
import {
  chargeMana,
  confirmMana,
  creditFor,
  dismissManaFlash,
  explainFor,
  manaBalances,
  manaConfirm,
  manaFlash,
  labelFor,
  priceFor,
  recoverMana,
  refreshMana,
  resolveManaConfirm,
  setManaTranslator,
  stopMana,
  withMana,
} from "../../src/components/mana/useMana";

beforeEach(async () => {
  resetManaLedgerForTest();
  stopMana();
  setManaTranslator(null);
  await refreshMana();
});

const daily = () => manaBalances.value.daily.balanceCenti;

// ── prices reach the call sites unchanged ───────────────────────────────────

describe("prices", () => {
  it("reports a negative price for an action and a positive credit for a recovery", () => {
    expect(priceFor("dht.presence.enable")).toBe(-500);
    expect(creditFor("dht.presence.withdraw")).toBe(250);
  });

  it("scales a metered price by the quantity given", () => {
    expect(priceFor("file.send")).toBe(-50);
    expect(priceFor("file.send", { bytes: 100 * 1024 * 1024 })).toBe(-250); // capped
    expect(priceFor("vox.call", { minutes: 10 })).toBe(-200);
  });

  it("prices an action this build does not have at zero", () => {
    // A surface gated out at compile time has no price rather than a wrong one.
    expect(priceFor("some.future.action")).toBe(0);
  });
});

// ── charging ────────────────────────────────────────────────────────────────

describe("charging", () => {
  it("subtracts from the meter", async () => {
    await chargeMana("dht.presence.enable");
    expect(daily()).toBe(9500);
  });

  it("charges a toggle once and then stops", async () => {
    await chargeMana("dht.presence.enable");
    const after = daily();
    await chargeMana("dht.presence.enable");
    await chargeMana("dht.presence.enable");
    expect(daily()).toBe(after);
  });

  it("charges an event every single time", async () => {
    await chargeMana("invite.general.create.clearnet");
    await chargeMana("invite.general.create.clearnet");
    expect(daily()).toBe(10_000 - 1000);
  });

  it("never charges an ordinary encrypted message on the safe lane", async () => {
    for (let i = 0; i < 20; i++) await chargeMana("msg.tor.mls", { bytes: 4096 });
    expect(daily()).toBe(10_000);
  });

  it("bills a clearnet message a little, and more when it is large", async () => {
    await chargeMana("msg.clearnet.mls", { bytes: 20 });
    expect(daily()).toBe(9998);
    await chargeMana("msg.clearnet.mls", { bytes: 4 * 1024 * 1024 });
    expect(daily()).toBe(9998 - 10);
  });

  it("coalesces repeated metered charges into one bucket", async () => {
    for (let i = 0; i < 47; i++) await chargeMana("msg.clearnet.mls", { bytes: 20 });
    const { manaLedger } = await import("rakotis");
    const rows = (await manaLedger()).filter((r) => r.code === "msg.clearnet.mls");
    // One row per hour, not one row per message — the ledger must not become a
    // timestamped log of when you sent things.
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(47);
    expect(rows[0].mana).toBe(-94);
  });

  it("makes a switch flipped off and on again a net loss", async () => {
    await chargeMana("dht.presence.enable");
    await recoverMana("dht.presence.withdraw");
    await chargeMana("dht.presence.enable");
    expect(daily()).toBe(10_000 - 500 + 250 - 500);
  });

  it("pays nothing for a recovery whose exposure was never live", async () => {
    await recoverMana("dht.presence.withdraw");
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
    for (let i = 0; i < 25; i++) await chargeMana("calendar.share.tor");
    expect(daily()).toBe(10_000);
  });

  it("bills a little on a clearnet room", async () => {
    await chargeMana("calendar.share.clearnet");
    expect(daily()).toBe(9998);
  });

  it("has no plaintext lane, because the calendar cannot send unencrypted", () => {
    // `sendSync` encrypts or throws, and `canSendTo` gates on mlsStatus ===
    // "ready". A `.plain` price would name a state that cannot occur.
    const { getManaPolicy: policy } = { getManaPolicy };
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
    await expect(confirmMana("room.create.clearnet")).resolves.toBe(true);
    expect(manaConfirm.value).toBeNull();
  });

  it("asks for a high-cost action and honours a refusal", async () => {
    const pending = confirmMana("dht.nickname.publish");
    expect(manaConfirm.value).not.toBeNull();
    expect(manaConfirm.value?.centi).toBe(-1000);
    resolveManaConfirm(false);
    await expect(pending).resolves.toBe(false);
    expect(manaConfirm.value).toBeNull();
  });

  it("asks for a high-cost action and lets it through on approval", async () => {
    const pending = confirmMana("dht.nickname.publish");
    resolveManaConfirm(true);
    await expect(pending).resolves.toBe(true);
  });

  it("asks even for a cheap action once a meter is empty", async () => {
    // Drain today with repeated clearnet bearer invitations.
    for (let i = 0; i < 20; i++) await chargeMana("invite.general.create.clearnet");
    expect(daily()).toBe(0);
    const pending = confirmMana("room.create.tor");
    expect(manaConfirm.value?.exhausted).toBe(true);
    resolveManaConfirm(true);
    await expect(pending).resolves.toBe(true);
  });

  it("never asks about a free action, even at zero", async () => {
    for (let i = 0; i < 20; i++) await chargeMana("invite.general.create.clearnet");
    await expect(confirmMana("msg.tor.mls")).resolves.toBe(true);
    expect(manaConfirm.value).toBeNull();
  });

  it("keeps file sends one-tap at any size, because the cap holds them below the threshold", async () => {
    // file.send is capped at 5 MANA — moderate — and the gate opens at 10. So no
    // transfer, however large, interrupts on price alone. That is the cap doing
    // its job, and it is worth pinning: raising the cap past 10 would silently
    // turn every big attachment into a modal.
    await expect(confirmMana("file.send", { bytes: 1024 })).resolves.toBe(true);
    await expect(confirmMana("file.send", { bytes: 4096 * 1024 * 1024 })).resolves.toBe(true);
    expect(manaConfirm.value).toBeNull();
    expect(Math.abs(priceFor("file.send", { bytes: 4096 * 1024 * 1024 })))
      .toBeLessThan(getManaPolicy().confirmAtCenti);
  });

  it("scales the gate with a metered quantity where the cap allows it", async () => {
    // vox.call caps at 10 MANA, exactly the threshold, so a long call DOES ask.
    await expect(confirmMana("vox.call", { minutes: 1 })).resolves.toBe(true);
    const pending = confirmMana("vox.call", { minutes: 600 });
    expect(manaConfirm.value?.centi).toBe(-500);
    resolveManaConfirm(false);
    await expect(pending).resolves.toBe(false);
  });
});

// ── withMana: confirm → act → charge, in that order ───────────────────────────

describe("withMana", () => {
  it("runs the action and then charges", async () => {
    const order: string[] = [];
    const run = vi.fn(async () => {
      order.push("acted");
      return "done";
    });
    const result = await withMana("room.create.clearnet", run);
    expect(result).toBe("done");
    expect(order).toEqual(["acted"]);
    expect(daily()).toBe(9750);
  });

  it("does not act at all when the confirmation is declined", async () => {
    const run = vi.fn();
    const pending = withMana("dht.nickname.publish", run);
    resolveManaConfirm(false);
    expect(await pending).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(daily()).toBe(10_000);
  });
});

// ── the flash ───────────────────────────────────────────────────────────────

describe("the flash", () => {
  it("reports what was spent", async () => {
    await chargeMana("dht.presence.enable");
    expect(manaFlash.value?.centi).toBe(-500);
    expect(formatPrice(manaFlash.value!.centi)).toBe("−5 MANA");
  });

  it("stays silent for a no-op", async () => {
    await chargeMana("dht.presence.enable");
    dismissManaFlash();
    await chargeMana("dht.presence.enable"); // already live
    expect(manaFlash.value).toBeNull();
  });

  it("stays silent on the free lane", async () => {
    await chargeMana("msg.tor.mls", { bytes: 999 });
    expect(manaFlash.value).toBeNull();
  });

  it("re-animates two identical charges in a row", async () => {
    await chargeMana("invite.general.create.clearnet");
    const first = manaFlash.value!.seq;
    await chargeMana("invite.general.create.clearnet");
    expect(manaFlash.value!.seq).toBeGreaterThan(first);
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
    setManaTranslator({
      t: (k) => {
        seen.push(k);
        return `T:${k}`;
      },
      has: () => true,
    });
    expect(labelFor("dht.nickname.publish")).toBe("T:mana.action.dhtNicknamePublish");
    expect(explainFor("dht.nickname.publish")).toBe("T:mana.explain.dhtNicknamePublish");
    expect(seen).toContain("mana.action.dhtNicknamePublish");
  });

  it("survives a translator that throws", () => {
    setManaTranslator({
      t: () => {
        throw new Error("boom");
      },
      has: () => true,
    });
    expect(labelFor("vox.call")).toBe("vox.call");
  });

  it("has a translation key for every action and recovery in the table", async () => {
    const { default: en } = await import("../../src/i18n/en");
    const policy = getManaPolicy();
    const camel = (id: string) =>
      id
        .split(/[._]/)
        .map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1)))
        .join("");
    const actions = (en as Record<string, any>).mana.action;
    const explains = (en as Record<string, any>).mana.explain;
    for (const a of policy.actions) {
      expect(actions[camel(a.id)], `mana.action.${camel(a.id)}`).toBeTruthy();
      expect(explains[a.explainKey.replace("mana.explain.", "")], a.explainKey).toBeTruthy();
    }
    for (const r of [...policy.recoveries, ...policy.dataSources]) {
      expect(actions[camel(r.id)], `mana.action.${camel(r.id)}`).toBeTruthy();
      expect(explains[r.explainKey.replace("mana.explain.", "")], r.explainKey).toBeTruthy();
    }
  });
});

// ── lifecycle ───────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  it("drops everything on lock so one profile's shape cannot leak into the next", async () => {
    await chargeMana("dht.nickname.publish");
    expect(daily()).toBeLessThan(10_000);
    stopMana();
    expect(manaFlash.value).toBeNull();
    expect(manaConfirm.value).toBeNull();
    expect(daily()).toBe(10_000);
  });

  it("resolves a pending confirmation as declined when the vault locks", async () => {
    const pending = confirmMana("dht.nickname.publish");
    stopMana();
    await expect(pending).resolves.toBe(false);
  });
});
