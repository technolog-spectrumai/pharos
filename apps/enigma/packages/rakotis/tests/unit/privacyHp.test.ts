// Privacy HP — the policy model: fixed prices, variant selection, meter
// derivation, regeneration, rollovers, clock rollback and display.
//
// Everything under test is pure, so `now` is passed explicitly and no fake
// timers are needed anywhere in this file.

import { describe, it, expect } from "vitest";
import { currentLocale } from "../../src/i18n/dateFormat";
import {
  deriveBalances,
  exposureLive,
  findAction,
  findRecovery,
  formatHp,
  formatMeter,
  formatPrice,
  historyRows,
  HP_RUNGS,
  inviteActionId,
  messageActionId,
  meterBand,
  meterPercent,
  needsConfirm,
  priceOf,
  regenPerHour,
  roomActionId,
  severityOf,
  torActiveNow,
  type HpEntry,
} from "../../src/privacyHp";
import { FALLBACK_HP_POLICY as P } from "../../src/services/hp";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MIB = 1024 * 1024;
const T0 = 1_800_000_000_000; // a fixed, arbitrary "now"

const spend = (ts: number, code: string, hpCenti: number): HpEntry => ({
  ts,
  kind: "spend",
  code,
  hp: -hpCenti,
  n: 1,
  bucket: 0,
});
const credit = (ts: number, code: string, hpCenti: number): HpEntry => ({
  ts,
  kind: "recover",
  code,
  hp: hpCenti,
  n: 1,
  bucket: 0,
});
const act = (id: string) => {
  const a = findAction(P, id);
  if (!a) throw new Error(`no action ${id}`);
  return a;
};

// ── fixed prices ────────────────────────────────────────────────────────────

describe("fixed prices", () => {
  it("charges the same for the same action every time", () => {
    // The central promise of the feature: no randomness, no personalisation.
    const a = act("invite.general.create.clearnet");
    const runs = Array.from({ length: 50 }, () => priceOf(a));
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).toBe(500);
  });

  it("prices the severe exposures at the top rung", () => {
    expect(act("dht.nickname.publish").costCenti).toBe(1000);
  });

  it("puts no price on the Tor switch at all", () => {
    // Tor changes the regeneration RATE, not a price. The old one-time charge
    // for switching it off punished the transition while ignoring the posture —
    // and since Tor ships off, a profile that never touched the switch was never
    // charged despite being permanently exposed.
    expect(findAction(P, "transport.tor.disable")).toBeNull();
    expect(findAction(P, "transport.tor.enable")).toBeNull();
    expect(findRecovery(P, "transport.tor.enable")).toBeNull();
  });

  it("keeps severityOf's rungs in step with the price table", () => {
    // The ladder lives in privacy_hp.yaml and is pinned by build.rs, but
    // `severityOf` needs it too — and it has no policy to read. This is what
    // stops the two drifting when the scale is re-tuned.
    const used = new Set(
      P.actions.filter((a) => a.kind !== "metered").map((a) => a.costCenti),
    );
    for (const centi of used) {
      expect(Object.values(HP_RUNGS), `${centi} is not a rung`).toContain(centi);
    }
    for (const r of P.recoveries) {
      expect(Object.values(HP_RUNGS), `${r.id} credit`).toContain(r.creditCenti);
    }
  });

  it("prices every fixed action on a ladder rung", () => {
    const rungs = [50, 150, 250, 500, 1000];
    for (const a of P.actions) {
      if (a.kind === "metered") continue;
      expect(rungs, `${a.id} is off the ladder`).toContain(a.costCenti);
    }
  });

  it("never charges an ordinary message on the safe lane", () => {
    expect(priceOf(act("msg.tor.mls"), 64 * MIB)).toBe(0);
  });

  it("makes every Tor variant cheaper than its clearnet twin", () => {
    for (const pair of [
      ["room.create.tor", "room.create.clearnet"],
      ["room.join.tor", "room.join.clearnet"],
      ["invite.general.create.tor", "invite.general.create.clearnet"],
      ["invite.personal.create.tor", "invite.personal.create.clearnet"],
      ["msg.tor.mls", "msg.clearnet.mls"],
      ["msg.tor.plain", "msg.clearnet.plain"],
    ]) {
      expect(act(pair[0]).costCenti, pair[0]).toBeLessThan(act(pair[1]).costCenti);
    }
  });

  it("gives every action a one-sentence explanation key", () => {
    for (const a of P.actions) expect(a.explainKey).toMatch(/^hp\.explain\.[a-zA-Z]+$/);
    for (const r of P.recoveries) expect(r.explainKey).toMatch(/^hp\.explain\.[a-zA-Z]+$/);
  });
});

// ── metered arithmetic (must match privacy_hp.rs exactly) ───────────────────

describe("metered pricing", () => {
  it("bills a tiny message at the base rate only", () => {
    expect(priceOf(act("msg.clearnet.mls"), 20)).toBe(2);
  });

  it("bills message size per MiB when not on Tor", () => {
    expect(priceOf(act("msg.clearnet.mls"), 4 * MIB)).toBe(10);
    expect(priceOf(act("msg.clearnet.plain"), 4 * MIB)).toBe(125);
  });

  it("never bills size on Tor", () => {
    expect(priceOf(act("msg.tor.mls"), 64 * MIB)).toBe(0);
    expect(priceOf(act("msg.tor.plain"), 64 * MIB)).toBe(5);
  });

  it("caps a single event", () => {
    expect(priceOf(act("msg.clearnet.mls"), 64 * MIB)).toBe(50);
    expect(priceOf(act("msg.clearnet.plain"), 64 * MIB)).toBe(250);
    expect(priceOf(act("file.send"), 4096 * MIB)).toBe(250);
    expect(priceOf(act("vox.call"), 0, 600)).toBe(500);
  });

  it("charges a long call more than a short one", () => {
    expect(priceOf(act("vox.call"), 0, 1)).toBe(155);
    expect(priceOf(act("vox.call"), 0, 60)).toBe(450);
  });
});

// ── variant selection ───────────────────────────────────────────────────────

describe("variant selection", () => {
  it("picks a lane from transport and MLS state", () => {
    expect(messageActionId({ tor: true, mlsReady: true })).toBe("msg.tor.mls");
    expect(messageActionId({ tor: false, mlsReady: true })).toBe("msg.clearnet.mls");
    expect(messageActionId({ tor: true, mlsReady: false })).toBe("msg.tor.plain");
    expect(messageActionId({ tor: false, mlsReady: false })).toBe("msg.clearnet.plain");
  });

  it("resolves every lane to a real table entry", () => {
    for (const tor of [true, false]) {
      for (const mlsReady of [true, false]) {
        expect(findAction(P, messageActionId({ tor, mlsReady }))).not.toBeNull();
      }
    }
  });

  it("drops the rate to zero the moment MLS reports ready over Tor", () => {
    const before = act(messageActionId({ tor: true, mlsReady: false })).costCenti;
    const after = act(messageActionId({ tor: true, mlsReady: true })).costCenti;
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(0);
  });

  it("picks room variants by transport", () => {
    expect(roomActionId("create", true)).toBe("room.create.tor");
    expect(roomActionId("join", false)).toBe("room.join.clearnet");
  });
});

// ── invitations ─────────────────────────────────────────────────────────────

describe("invitations", () => {
  it("makes a private invite far cheaper than a bearer one", () => {
    // The headline. A bearer invite is readable by anyone who sees it; a private
    // one is sealed to a single contact, and costs under a third.
    expect(priceOf(act("invite.personal.create.clearnet"))).toBe(150);
    expect(priceOf(act("invite.general.create.clearnet"))).toBe(500);
    expect(priceOf(act("invite.personal.create.tor"))).toBe(50);
  });

  it("charges a bearer invite far more than a private one", () => {
    const personal = priceOf(act("invite.personal.create.clearnet"));
    const general = priceOf(act("invite.general.create.clearnet"));
    expect(general).toBeGreaterThan(personal * 3);
  });

  it("always confirms a bearer invite, so the warning precedes the tap", () => {
    const full = deriveBalances(P, [], T0);
    expect(needsConfirm(P, -priceOf(act("invite.general.create.clearnet")), full)).toBe(true);
    // ...and never interrupts a private one.
    expect(needsConfirm(P, -priceOf(act("invite.personal.create.clearnet")), full)).toBe(false);
    expect(needsConfirm(P, -priceOf(act("invite.personal.create.tor")), full)).toBe(false);
  });

  it("keeps a bearer invite on the top rung it inherited from the room ticket", () => {
    // It was priced level with `ticket.export.clearnet` — same address, same
    // audience — and that comparison outlived the thing it compared to. The price
    // is pinned here so it does not drift now that nothing sits beside it.
    expect(priceOf(act("invite.general.create.clearnet"))).toBe(500);
  });

  it("selects the variant from kind and transport", () => {
    expect(inviteActionId("personal", false)).toBe("invite.personal.create.clearnet");
    expect(inviteActionId("personal", true)).toBe("invite.personal.create.tor");
    expect(inviteActionId("general", false)).toBe("invite.general.create.clearnet");
    expect(inviteActionId("general", true)).toBe("invite.general.create.tor");
  });

  it("resolves every variant to a real table entry", () => {
    for (const kind of ["personal", "general"] as const) {
      for (const tor of [true, false]) {
        expect(findAction(P, inviteActionId(kind, tor)), `${kind}/${tor}`).not.toBeNull();
      }
    }
  });

  it("makes every Tor invite cheaper than its clearnet twin", () => {
    for (const kind of ["personal", "general"] as const) {
      expect(priceOf(act(inviteActionId(kind, true)))).toBeLessThan(
        priceOf(act(inviteActionId(kind, false))),
      );
    }
  });

  it("pays a revocation without pairing it to one transport", () => {
    // A bearer invite can be minted on either transport, so pairing the credit
    // to one action id would silently refuse to pay for the other. The verified
    // state change is enforced at the call site instead.
    const rec = findRecovery(P, "invite.revoke");
    expect(rec).not.toBeNull();
    expect(rec!.creditCenti).toBe(250);
    expect(rec!.requires).toBeNull();
  });
});

// ── closing a room ──────────────────────────────────────────────────────────

describe("invite-only rooms", () => {
  it("no longer pays a credit for something that cannot be chosen", () => {
    // There was a +2.5 credit for closing a room. Every room is invite-only now,
    // so there is no open state to leave and nothing to reward: paying for it
    // would be paying every user, once per room, for the app's own default.
    expect(findRecovery(P, "room.inviteonly.enable")).toBeNull();
    expect(findAction(P, "room.inviteonly.enable")).toBeNull();
    expect(findRecovery(P, "room.inviteonly.disable")).toBeNull();
    expect(findAction(P, "room.inviteonly.disable")).toBeNull();
  });

  it("prices no way into a room except an invitation", () => {
    // The retired credentials. Their absence from the table is what stops a
    // stale call site quietly charging for something the app cannot do.
    for (const id of ["ticket.export.clearnet", "ticket.export.tor", "dht.room_code.publish"]) {
      expect(findAction(P, id), id).toBeNull();
    }
  });
});

// ── confirmation policy ─────────────────────────────────────────────────────

describe("confirmation", () => {
  const full = deriveBalances(P, [], T0);

  it("confirms high and severe costs only", () => {
    expect(needsConfirm(P, -1000, full)).toBe(true);
    expect(needsConfirm(P, -500, full)).toBe(true);
    expect(needsConfirm(P, -250, full)).toBe(false);
    expect(needsConfirm(P, -50, full)).toBe(false);
    expect(needsConfirm(P, -2, full)).toBe(false);
  });

  it("confirms anything once a meter is empty", () => {
    const drained = deriveBalances(P, [spend(T0, "x", 100_000)], T0);
    expect(drained.daily.balanceCenti).toBe(0);
    expect(needsConfirm(P, -2, drained)).toBe(true);
  });

  it("never confirms a free action", () => {
    const drained = deriveBalances(P, [spend(T0, "x", 100_000)], T0);
    expect(needsConfirm(P, 0, drained)).toBe(false);
  });

  it("maps costs onto ladder names", () => {
    expect(severityOf(-1000)).toBe("severe");
    expect(severityOf(-500)).toBe("high");
    expect(severityOf(-250)).toBe("moderate");
    expect(severityOf(-150)).toBe("low");
    expect(severityOf(-2)).toBe("negligible");
  });
});

// ── meters ──────────────────────────────────────────────────────────────────

describe("meter derivation", () => {
  it("starts the meter full with no history", () => {
    const b = deriveBalances(P, [], T0);
    expect(b.daily.balanceCenti).toBe(10_000);
    expect(b.daily.msToNextHp).toBeNull();
  });

  it("subtracts a charge from the meter", () => {
    const b = deriveBalances(P, [spend(T0, "dht.presence.enable", 1000)], T0);
    expect(b.daily.balanceCenti).toBe(9000);
  });

  it("derives the same balances from the same rows every time", () => {
    const log = [spend(T0 - HOUR, "room.create.clearnet", 500), credit(T0, "room.leave", 300)];
    const a = deriveBalances(P, log, T0);
    const b = deriveBalances(P, [...log].reverse(), T0);
    expect(a).toEqual(b);
  });

  it("clamps a meter at zero rather than going negative", () => {
    const b = deriveBalances(P, [spend(T0, "x", 999_999)], T0);
    expect(b.daily.balanceCenti).toBe(0);
  });

  it("never lets credits push a meter above its ceiling", () => {
    const b = deriveBalances(P, [credit(T0, "room.rekey", 5000)], T0);
    expect(b.daily.balanceCenti).toBe(P.dailyMaxCenti);
  });
});

// ── regeneration ────────────────────────────────────────────────────────────

describe("regeneration", () => {
  it("heals the daily meter at 4 HP per hour", () => {
    const log = [spend(T0, "dht.presence.enable", 1000)];
    expect(deriveBalances(P, log, T0).daily.balanceCenti).toBe(9000);
    expect(deriveBalances(P, log, T0 + HOUR).daily.balanceCenti).toBe(9400);
    expect(deriveBalances(P, log, T0 + 2 * HOUR).daily.balanceCenti).toBe(9800);
  });


  it("heals continuously rather than in hourly steps", () => {
    // The visible difference between "+1/hour" and a bar that creeps.
    const log = [spend(T0, "transport.tor.disable", 2000)];
    const quarter = deriveBalances(P, log, T0 + 15 * 60_000).daily.balanceCenti;
    expect(quarter).toBe(8100);
  });

  it("fully heals a charge and then stops", () => {
    const log = [spend(T0, "dht.presence.enable", 1000)];
    const late = deriveBalances(P, log, T0 + 100 * HOUR);
    expect(late.daily.balanceCenti).toBe(P.dailyMaxCenti);
    expect(late.daily.unhealedCenti).toBe(0);
  });

  it("heals nothing when the clock has been set backwards", () => {
    // A charge stamped "in the future" must not heal, and must not un-heal.
    const log = [spend(T0, "dht.presence.enable", 1000)];
    const b = deriveBalances(P, log, T0 - 5 * HOUR);
    expect(b.daily.balanceCenti).toBe(9000);
  });

  it("counts down to the next WHOLE HP, not the next hundredth", () => {
    // Regeneration is continuous, so a hundredth arrives every 9 seconds — but
    // the UI says "+1 HP", so the countdown has to mean that.
    const log = [spend(T0, "transport.tor.disable", 2000)];
    expect(deriveBalances(P, log, T0).daily.msToNextHp).toBe(15 * 60_000);
    expect(deriveBalances(P, log, T0 + 60_000).daily.msToNextHp).toBe(14 * 60_000);
    // Weekly ticks a whole HP once an hour.
  });

  it("reports no next tick once the meter is full", () => {
    expect(deriveBalances(P, [], T0).daily.msToNextHp).toBeNull();
  });

  it("heals each charge on its own clock", () => {
    // An old charge can be fully settled while a fresh one still weighs.
    const log = [spend(T0 - 10 * HOUR, "dht.presence.enable", 1000), spend(T0, "room.create.clearnet", 500)];
    const b = deriveBalances(P, log, T0);
    expect(b.daily.unhealedCenti).toBe(500);
  });
});

// ── Tor changes the rate, not a price ───────────────────────────────────────

describe("Tor regeneration", () => {
  const posture = (ts: number, on: boolean): HpEntry => ({
    ts,
    kind: "posture",
    code: on ? "transport.tor.on" : "transport.tor.off",
    hp: 0,
    n: 1,
    bucket: 0,
  });

  it("heals three times faster while Tor is on", () => {
    const charge = spend(T0, "transport.onion_stable.enable", 2000);
    const off = deriveBalances(P, [charge], T0 + HOUR).daily;
    const on = deriveBalances(P, [posture(T0 - 1, true), charge], T0 + HOUR).daily;
    expect(off.balanceCenti).toBe(8400); // −20, +4 back
    expect(on.balanceCenti).toBe(9200); // −20, +12 back
  });

  it("reports the rate actually in force", () => {
    const plain = deriveBalances(P, [], T0);
    expect(plain.daily.regenPerHourCenti).toBe(400);
    expect(plain.daily.torActive).toBe(false);
    const tor = deriveBalances(P, [posture(T0 - 1, true)], T0);
    expect(tor.daily.regenPerHourCenti).toBe(1200);
    expect(tor.daily.torActive).toBe(true);
  });

  it("always advertises what Tor would pay, whatever the current posture", () => {
    // Drives the "you could be regenerating faster" hint.
    const plain = deriveBalances(P, [], T0).daily;
    expect(plain.torRegenPerHourCenti).toBe(1200);
  });

  it("does not re-heal the past when Tor is switched on", () => {
    // THE property this design exists for. A naive implementation multiplies
    // total elapsed time by the current rate, so flipping the switch would jump
    // the meter. Here the balance is identical either side of the flip.
    const charge = spend(T0, "transport.onion_stable.enable", 2000);
    const flip = T0 + HOUR;
    const justBefore = deriveBalances(P, [charge], flip).daily.balanceCenti;
    const justAfter = deriveBalances(P, [charge, posture(flip, true)], flip).daily.balanceCenti;
    expect(justAfter).toBe(justBefore);
  });

  it("does not un-heal the past when Tor is switched off", () => {
    const charge = spend(T0, "transport.onion_stable.enable", 2000);
    const flip = T0 + HOUR;
    const log = [posture(T0 - 1, true), charge];
    const before = deriveBalances(P, log, flip).daily.balanceCenti;
    const after = deriveBalances(P, [...log, posture(flip, false)], flip).daily.balanceCenti;
    expect(after).toBe(before);
  });

  it("counts each hour at the rate that was actually in force", () => {
    // One hour with Tor off (+4), then one with it on (+12) = 16 back.
    const charge = spend(T0, "transport.onion_stable.enable", 2000);
    const log = [charge, posture(T0 + HOUR, true)];
    expect(deriveBalances(P, log, T0 + 2 * HOUR).daily.balanceCenti).toBe(9600);
    // And the mirror image: fast hour first, then slow.
    const log2 = [posture(T0 - 1, true), charge, posture(T0 + HOUR, false)];
    expect(deriveBalances(P, log2, T0 + 2 * HOUR).daily.balanceCenti).toBe(9600);
  });

  it("counts a charge made mid-Tor-session at the Tor rate", () => {
    const log = [posture(T0, true), spend(T0 + HOUR, "transport.onion_stable.enable", 2000)];
    expect(deriveBalances(P, log, T0 + 2 * HOUR).daily.balanceCenti).toBe(9200);
  });

  it("treats an absent posture history as Tor off", () => {
    // The shipped default. A profile that predates the marker must not be
    // credited with protection it never had.
    expect(deriveBalances(P, [], T0).daily.torActive).toBe(false);
  });

  it("keeps posture markers out of the balance entirely", () => {
    // Zero-HP rows: neither spend nor credit, and they must not dilute either.
    const log = [posture(T0, true), posture(T0 + 1, false), posture(T0 + 2, true)];
    const b = deriveBalances(P, log, T0 + 3);
    expect(b.daily.balanceCenti).toBe(P.dailyMaxCenti);
    expect(b.daily.unhealedCenti).toBe(0);
    expect(b.daily.creditedCenti).toBe(0);
  });

  it("keeps posture markers out of the history view", () => {
    // "Why did this change?" lists what cost or earned HP. A rate change did
    // neither, so listing it would be noise the user cannot act on.
    const log = [posture(T0, true), spend(T0 + 1, "vox.call", 900)];
    const rows = historyRows(P, log, T0 + 2);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe("vox.call");
  });

  it("counts the countdown down at the Tor rate", () => {
    const charge = spend(T0, "transport.onion_stable.enable", 2000);
    expect(deriveBalances(P, [charge], T0).daily.msToNextHp).toBe(15 * 60_000);
    expect(
      deriveBalances(P, [posture(T0 - 1, true), charge], T0).daily.msToNextHp,
    ).toBe(5 * 60_000);
  });

  it("reads the current posture from the newest marker", () => {
    expect(torActiveNow([posture(T0, true), posture(T0 + 1, false)])).toBe(false);
    expect(torActiveNow([posture(T0 + 1, false), posture(T0, true)])).toBe(false);
    expect(torActiveNow([posture(T0, false), posture(T0 + 1, true)])).toBe(true);
    expect(torActiveNow([])).toBe(false);
  });
});

// ── windows and rollover ────────────────────────────────────────────────────

describe("rolling windows", () => {
  it("drops a charge out of the daily window after 24 h", () => {
    const log = [spend(T0 - DAY - 1, "transport.tor.disable", 2000)];
    expect(deriveBalances(P, log, T0).daily.balanceCenti).toBe(P.dailyMaxCenti);
  });



  it("does not double-count the drip and the window expiry", () => {
    // Ten 20 HP charges, one a minute apart. The daily drip is 4 HP/h, so by
    // `now` the i-th has healed floor(i x 100 / 60) centi — 72 centi in total.
    // The point of the assertion is that the total is EXACTLY the drip and
    // nothing else: the 7-day expiry has not also taken a slice.
    const log = Array.from({ length: 10 }, (_, i) => spend(T0 - i * 60_000, "transport.tor.disable", 2000));
    const b = deriveBalances(P, log, T0);
    const drip = Array.from({ length: 10 }, (_, i) => Math.floor((i * 100) / 60)).reduce((x, y) => x + y, 0);
    expect(drip).toBe(72);
  });

  it("survives a restart: balances come from rows alone", () => {
    // Nothing is cached, so "reloading" is just calling again with the same rows.
    const log = [spend(T0 - 3 * HOUR, "vox.call", 900)];
    expect(deriveBalances(P, log, T0)).toEqual(deriveBalances(P, [...log], T0));
  });
});

// ── exposure pairing ────────────────────────────────────────────────────────

describe("exposure pairing", () => {
  it("reports a toggle live once charged", () => {
    expect(exposureLive(P, [spend(T0, "dht.presence.enable", 1000)], "dht.presence.enable")).toBe(true);
  });

  it("settles it when the paired recovery is awarded", () => {
    const log = [spend(T0, "dht.presence.enable", 1000), credit(T0 + 1, "dht.presence.withdraw", 500)];
    expect(exposureLive(P, log, "dht.presence.enable")).toBe(false);
  });

  it("ignores an unrelated recovery", () => {
    const log = [spend(T0, "dht.presence.enable", 1000), credit(T0 + 1, "room.leave", 300)];
    expect(exposureLive(P, log, "dht.presence.enable")).toBe(true);
  });

  it("makes a switch flipped off and on again a net loss", () => {
    const log = [
      spend(T0, "dht.presence.enable", 1000),
      credit(T0 + 1, "dht.presence.withdraw", 500),
      spend(T0 + 2, "dht.presence.enable", 1000),
    ];
    const b = deriveBalances(P, log, T0 + 2);
    // −10 +5 −10 = −15, never a profit.
    expect(b.daily.balanceCenti).toBe(8500);
    expect(exposureLive(P, log, "dht.presence.enable")).toBe(true);
  });
});

// ── history ─────────────────────────────────────────────────────────────────

describe("why did this change", () => {
  it("lists newest first", () => {
    const log = [spend(T0 - HOUR, "room.create.clearnet", 500), spend(T0, "vox.call", 900)];
    const rows = historyRows(P, log, T0);
    expect(rows[0].code).toBe("vox.call");
    expect(rows[1].code).toBe("room.create.clearnet");
  });

  it("shows how much of a charge has healed", () => {
    const rows = historyRows(P, [spend(T0 - HOUR, "transport.tor.disable", 2000)], T0);
    expect(rows[0].healedCenti).toBe(400);
    expect(rows[0].settled).toBe(false);
  });

  it("marks a charge settled once regeneration has repaid it", () => {
    const rows = historyRows(P, [spend(T0 - 10 * HOUR, "room.create.clearnet", 500)], T0);
    expect(rows[0].settled).toBe(true);
  });

  it("keeps the activation count of a coalesced bucket", () => {
    const bucket: HpEntry = { ts: T0, kind: "spend", code: "msg.clearnet.mls", hp: -235, n: 47, bucket: 1 };
    expect(historyRows(P, [bucket], T0)[0].n).toBe(47);
  });

  it("never exceeds the requested limit", () => {
    const log = Array.from({ length: 500 }, (_, i) => spend(T0 - i, "file.send", 100));
    expect(historyRows(P, log, T0, 25)).toHaveLength(25);
  });
});

// ── display ─────────────────────────────────────────────────────────────────

describe("display", () => {
  it("formats whole and fractional HP without trailing zeros", () => {
    expect(formatHp(300)).toBe("3");
    expect(formatHp(5)).toBe("0.05");
    expect(formatHp(8725)).toBe("87.25");
    expect(formatHp(50)).toBe("0.5");
  });

  it("writes the decimal separator in the user's language", () => {
    // Halving the ladder made most prices fractional, so this is on almost every
    // button. Polish takes a comma: "−0,5 HP", not "−0.5 HP".
    currentLocale.value = "pl";
    try {
      expect(formatHp(50)).toBe("0,5");
      expect(formatHp(8725)).toBe("87,25");
      expect(formatPrice(-50)).toBe("−0,5 HP");
      // Whole numbers have no separator to get wrong, in either language.
      expect(formatHp(300)).toBe("3");
    } finally {
      currentLocale.value = "en";
    }
  });

  it("uses a real minus sign on a price badge", () => {
    expect(formatPrice(-300)).toBe("−3 HP");
    expect(formatPrice(500)).toBe("+5 HP");
    expect(formatPrice(0)).toBe("0 HP");
  });

  it("labels a meter as balance over maximum", () => {
    const b = deriveBalances(P, [spend(T0, "room.create.clearnet", 500)], T0);
    expect(formatMeter(b.daily)).toBe("95 / 100");
  });

  it("reports a percentage and a band for the bar", () => {
    const full = deriveBalances(P, [], T0).daily;
    expect(meterPercent(full)).toBe(100);
    expect(meterBand(full)).toBe("full");
    const empty = deriveBalances(P, [spend(T0, "x", 100_000)], T0).daily;
    expect(meterBand(empty)).toBe("empty");
  });
});
