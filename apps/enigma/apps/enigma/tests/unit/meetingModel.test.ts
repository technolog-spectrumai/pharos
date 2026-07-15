import { describe, it, expect } from "vitest";
import {
  applyRemoteInvite,
  applyRemotePoll,
  dayKey,
  meetingsOnDay,
  monthGrid,
  pollExpired,
  reminderDue,
  tallyPoll,
  upcoming,
  validateMeetingDraft,
  validatePollDraft,
  wireFromMeeting,
  wireFromPoll,
  type Meeting,
  type MeetingPoll,
  type MeetingPollWire,
  type MeetingWire,
} from "../../src/components/calendar/meetingModel";

const HOUR = 3_600_000;
const MIN = 60_000;

function makeMeeting(over: Partial<Meeting> = {}): Meeting {
  const start = Date.UTC(2026, 6, 20, 10, 0);
  return {
    id: "m-1",
    title: "Standup",
    description: "",
    location: "",
    start,
    end: start + HOUR,
    organizer: "alice",
    organizerDevice: "alice-device",
    roomSlug: "room-1",
    roomName: "Room 1",
    status: "scheduled",
    attendees: {},
    mine: false,
    rev: 1,
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
    ...over,
  };
}

function makeWire(over: Partial<MeetingWire> = {}): MeetingWire {
  const m = makeMeeting();
  return {
    ...wireFromMeeting(m),
    fromName: "alice",
    fromDevice: "alice-device",
    ...over,
  };
}

describe("monthGrid", () => {
  it("is a 6×7 Monday-first grid padded with adjacent-month days", () => {
    const weeks = monthGrid(new Date(2026, 6, 14)); // July 2026; Jul 1 is a Wednesday
    expect(weeks).toHaveLength(6);
    weeks.forEach((w) => expect(w).toHaveLength(7));
    expect(dayKey(weeks[0][0])).toBe("2026-06-29"); // Monday before the 1st
    expect(dayKey(weeks[0][2])).toBe("2026-07-01");
    expect(dayKey(weeks[5][6])).toBe("2026-08-09"); // trailing pad
  });

  it("cells are contiguous days", () => {
    const flat = monthGrid(new Date(2026, 6, 1)).flat();
    for (let i = 1; i < flat.length; i++) {
      expect(flat[i].getTime() - flat[i - 1].getTime()).toBe(24 * HOUR);
    }
  });

  it("handles February, leap and non-leap", () => {
    const feb26 = monthGrid(new Date(2026, 1, 10)).flat().map(dayKey); // Feb 1 2026 = Sunday
    expect(feb26[0]).toBe("2026-01-26");
    expect(feb26).toContain("2026-02-28");
    expect(feb26).not.toContain("2026-02-29");

    const feb24 = monthGrid(new Date(2024, 1, 1)).flat().map(dayKey);
    expect(feb24).toContain("2024-02-29"); // leap day present
  });
});

describe("dayKey / selectors", () => {
  it("buckets by local day with zero padding", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  it("meetingsOnDay filters by start day and sorts by time", () => {
    const day = new Date(2026, 6, 20, 0, 0).getTime();
    const late = makeMeeting({ id: "late", start: day + 15 * HOUR, end: day + 16 * HOUR });
    const early = makeMeeting({ id: "early", start: day + 9 * HOUR, end: day + 10 * HOUR });
    const other = makeMeeting({ id: "other", start: day + 30 * HOUR, end: day + 31 * HOUR });
    const found = meetingsOnDay([late, other, early], dayKey(day));
    expect(found.map((m) => m.id)).toEqual(["early", "late"]);
  });

  it("upcoming keeps scheduled, unfinished meetings, soonest first, limited", () => {
    const now = Date.UTC(2026, 6, 14, 12, 0);
    const past = makeMeeting({ id: "past", start: now - 2 * HOUR, end: now - HOUR });
    const running = makeMeeting({ id: "running", start: now - 10 * MIN, end: now + 50 * MIN });
    const soon = makeMeeting({ id: "soon", start: now + HOUR, end: now + 2 * HOUR });
    const cancelled = makeMeeting({ id: "gone", start: now + HOUR, end: now + 2 * HOUR, status: "cancelled" });
    expect(upcoming([soon, past, cancelled, running], now).map((m) => m.id)).toEqual(["running", "soon"]);
    expect(upcoming([soon, running], now, 1).map((m) => m.id)).toEqual(["running"]);
  });
});

describe("validateMeetingDraft", () => {
  const start = Date.UTC(2026, 6, 20, 10, 0);
  it("accepts a valid draft", () => {
    expect(validateMeetingDraft({ title: "Sync", start, end: start + HOUR })).toBeNull();
  });
  it("rejects a blank title", () => {
    expect(validateMeetingDraft({ title: "   ", start, end: start + HOUR })).toBe("titleRequired");
  });
  it("rejects end before/equal to start", () => {
    expect(validateMeetingDraft({ title: "Sync", start, end: start })).toBe("endBeforeStart");
    expect(validateMeetingDraft({ title: "Sync", start, end: start - MIN })).toBe("endBeforeStart");
  });
  it("rejects unparsed times", () => {
    expect(validateMeetingDraft({ title: "Sync", start: NaN, end: start })).toBe("timeRequired");
  });
});

describe("applyRemoteInvite", () => {
  it("first sight of a whole-room invite → pending RSVP, not mine", () => {
    const m = applyRemoteInvite(undefined, makeWire(), "bob");
    expect(m).not.toBeNull();
    expect(m!.myRsvp).toBe("pending");
    expect(m!.mine).toBe(false);
    expect(m!.reminded).toBe(false);
  });

  it("an invite targeting others leaves me without an RSVP", () => {
    const m = applyRemoteInvite(undefined, makeWire({ invited: ["carol"] }), "bob");
    expect(m!.myRsvp).toBeUndefined();
  });

  it("drops stale or duplicate revisions", () => {
    const existing = makeMeeting({ rev: 2 });
    expect(applyRemoteInvite(existing, makeWire({ rev: 2 }), "bob")).toBeNull();
    expect(applyRemoteInvite(existing, makeWire({ rev: 1 }), "bob")).toBeNull();
  });

  it("drops updates from a device other than the organizer's", () => {
    const existing = makeMeeting();
    const forged = makeWire({ rev: 2, fromDevice: "mallory-device" });
    expect(applyRemoteInvite(existing, forged, "bob")).toBeNull();
  });

  it("never remote-edits a meeting I organize", () => {
    const existing = makeMeeting({ mine: true });
    expect(applyRemoteInvite(existing, makeWire({ rev: 5 }), "alice")).toBeNull();
  });

  it("preserves my local RSVP and mirrors it into the roster", () => {
    const existing = makeMeeting({ myRsvp: "accepted" });
    const m = applyRemoteInvite(existing, makeWire({ rev: 2 }), "bob");
    expect(m!.myRsvp).toBe("accepted");
    expect(m!.attendees.bob.status).toBe("accepted");
  });

  it("resets `reminded` only when the start moved", () => {
    const existing = makeMeeting({ reminded: true });
    const same = applyRemoteInvite(existing, makeWire({ rev: 2 }), "bob");
    expect(same!.reminded).toBe(true);
    const moved = applyRemoteInvite(existing, makeWire({ rev: 3, start: existing.start + HOUR, end: existing.end + HOUR }), "bob");
    expect(moved!.reminded).toBe(false);
  });
});

describe("reminderDue", () => {
  const now = Date.UTC(2026, 6, 14, 12, 0);
  const base = makeMeeting({ start: now + 4 * MIN, end: now + HOUR, myRsvp: "pending" });

  it("fires inside the lead window, once", () => {
    expect(reminderDue(base, now, 5)).toBe(true);
    expect(reminderDue({ ...base, reminded: true }, now, 5)).toBe(false);
  });
  it("stays quiet outside the window", () => {
    expect(reminderDue(base, now, 3)).toBe(false);
  });
  it("fires for an in-progress meeting, never after it ended", () => {
    expect(reminderDue({ ...base, start: now - 10 * MIN }, now, 5)).toBe(true);
    expect(reminderDue({ ...base, start: now - 2 * HOUR, end: now - HOUR }, now, 5)).toBe(false);
  });
  it("skips declined and cancelled meetings", () => {
    expect(reminderDue({ ...base, myRsvp: "declined" }, now, 5)).toBe(false);
    expect(reminderDue({ ...base, status: "cancelled" }, now, 5)).toBe(false);
  });
});

describe("wireFromMeeting", () => {
  it("strips local-only flags", () => {
    const wire = wireFromMeeting(makeMeeting({ mine: true, myRsvp: "accepted", reminded: true, needsBroadcast: true }));
    expect(wire).not.toHaveProperty("mine");
    expect(wire).not.toHaveProperty("myRsvp");
    expect(wire).not.toHaveProperty("reminded");
    expect(wire).not.toHaveProperty("needsBroadcast");
    expect(wire.meetingId).toBe("m-1");
  });
});

describe("applyRemoteInvite — RSVP seeding from the wire roster", () => {
  it("first sight adopts my ballot-derived status (poll-created meetings)", () => {
    const wire = makeWire({ attendees: { bob: { status: "accepted", respondedAt: "2026-07-15T09:00:00.000Z" } } });
    const m = applyRemoteInvite(undefined, wire, "bob");
    expect(m!.myRsvp).toBe("accepted");
  });

  it("without a roster row I still start pending, and a local RSVP always wins", () => {
    expect(applyRemoteInvite(undefined, makeWire(), "bob")!.myRsvp).toBe("pending");
    const existing = makeMeeting({ myRsvp: "declined" });
    const wire = makeWire({ rev: 2, attendees: { bob: { status: "accepted" } } });
    expect(applyRemoteInvite(existing, wire, "bob")!.myRsvp).toBe("declined");
  });
});

// ── polls ─────────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 6, 20, 10, 0);

function makePoll(over: Partial<MeetingPoll> = {}): MeetingPoll {
  return {
    id: "p-1",
    title: "Retro",
    description: "",
    location: "",
    slots: [
      { id: "s1", start: T0, end: T0 + HOUR },
      { id: "s2", start: T0 + 24 * HOUR, end: T0 + 25 * HOUR },
      { id: "s3", start: T0 + 48 * HOUR, end: T0 + 49 * HOUR },
    ],
    organizer: "alice",
    organizerDevice: "alice-device",
    roomSlug: "room-1",
    roomName: "Room 1",
    status: "open",
    votes: {},
    mine: false,
    rev: 1,
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:00:00.000Z",
    ...over,
  };
}

function makePollWire(over: Partial<MeetingPollWire> = {}): MeetingPollWire {
  return { ...wireFromPoll(makePoll()), fromName: "alice", fromDevice: "alice-device", ...over };
}

describe("validatePollDraft", () => {
  const good = {
    title: "Retro",
    description: "",
    location: "",
    slots: [
      { start: T0, end: T0 + HOUR },
      { start: T0 + HOUR, end: T0 + 2 * HOUR },
    ],
    roomSlug: "room-1",
    roomName: "Room 1",
  };
  it("accepts a valid draft, with or without a deadline", () => {
    expect(validatePollDraft(good)).toBeNull();
    expect(validatePollDraft({ ...good, deadline: T0 - HOUR })).toBeNull();
  });
  it("rejects a blank title", () => {
    expect(validatePollDraft({ ...good, title: " " })).toBe("titleRequired");
  });
  it("requires at least two slots", () => {
    expect(validatePollDraft({ ...good, slots: [good.slots[0]] })).toBe("needTwoSlots");
  });
  it("rejects a slot with end before start or unparsed times", () => {
    expect(validatePollDraft({ ...good, slots: [good.slots[0], { start: T0, end: T0 }] })).toBe("slotTimeInvalid");
    expect(validatePollDraft({ ...good, slots: [good.slots[0], { start: NaN, end: T0 }] })).toBe("slotTimeInvalid");
  });
  it("requires a room", () => {
    expect(validatePollDraft({ ...good, roomSlug: "" })).toBe("roomRequired");
  });
  it("rejects an unparsed deadline", () => {
    expect(validatePollDraft({ ...good, deadline: NaN })).toBe("deadlineInvalid");
  });
});

describe("tallyPoll", () => {
  it("counts per choice and sorts yes desc, ifneedbe desc, then earlier slot", () => {
    const poll = makePoll({
      votes: {
        bob: { votes: { s1: "yes", s2: "yes", s3: "no" }, votedAt: "t" },
        carol: { votes: { s1: "ifneedbe", s2: "yes", s3: "ifneedbe" }, votedAt: "t" },
        dave: { votes: { s2: "no", s3: "ifneedbe" }, votedAt: "t" },
      },
    });
    const tally = tallyPoll(poll);
    expect(tally.map((t) => t.slotId)).toEqual(["s2", "s1", "s3"]);
    expect(tally[0]).toEqual({ slotId: "s2", yes: 2, ifneedbe: 0, no: 1 });
    expect(tally[1]).toEqual({ slotId: "s1", yes: 1, ifneedbe: 1, no: 0 });
  });

  it("breaks full ties by the earlier slot and ignores unknown slot ids", () => {
    const poll = makePoll({ votes: { bob: { votes: { ghost: "yes" }, votedAt: "t" } } });
    expect(tallyPoll(poll).map((t) => t.slotId)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("pollExpired", () => {
  it("false without a deadline; boundary-exact with one", () => {
    expect(pollExpired(makePoll(), T0)).toBe(false);
    const p = makePoll({ deadline: T0 });
    expect(pollExpired(p, T0)).toBe(false);
    expect(pollExpired(p, T0 + 1)).toBe(true);
  });
});

describe("wireFromPoll", () => {
  it("strips local-only flags", () => {
    const wire = wireFromPoll(makePoll({ mine: true, myVotes: { s1: "yes" }, needsBroadcast: true }));
    expect(wire).not.toHaveProperty("mine");
    expect(wire).not.toHaveProperty("myVotes");
    expect(wire).not.toHaveProperty("needsBroadcast");
    expect(wire.pollId).toBe("p-1");
  });
});

describe("applyRemotePoll", () => {
  it("first sight stores the poll as not-mine", () => {
    const p = applyRemotePoll(undefined, makePollWire(), "bob");
    expect(p).not.toBeNull();
    expect(p!.mine).toBe(false);
    expect(p!.myVotes).toBeUndefined();
  });

  it("drops stale revs, foreign senders, and edits to my own poll", () => {
    const existing = makePoll({ rev: 2 });
    expect(applyRemotePoll(existing, makePollWire({ rev: 2 }), "bob")).toBeNull();
    expect(applyRemotePoll(existing, makePollWire({ rev: 3, fromDevice: "mallory-device" }), "bob")).toBeNull();
    expect(applyRemotePoll(makePoll({ mine: true }), makePollWire({ rev: 5 }), "alice")).toBeNull();
  });

  it("my local ballot survives a snapshot upsert and overrides my row", () => {
    const existing = makePoll({
      myVotes: { s1: "yes", s2: "no" },
      votes: { bob: { votes: { s1: "yes", s2: "no" }, votedAt: "2026-07-15T11:00:00.000Z", device: "bob-device" } },
    });
    // The organizer's snapshot doesn't have my ballot yet (it never reached them).
    const wire = makePollWire({ rev: 2, votes: { carol: { votes: { s1: "ifneedbe" }, votedAt: "t" } } });
    const merged = applyRemotePoll(existing, wire, "bob");
    expect(merged!.myVotes).toEqual({ s1: "yes", s2: "no" });
    expect(merged!.votes.bob.votes).toEqual({ s1: "yes", s2: "no" });
    expect(merged!.votes.carol.votes).toEqual({ s1: "ifneedbe" });
  });

  it("a close snapshot carries chosenSlotId and meetingId through", () => {
    const existing = makePoll();
    const wire = makePollWire({ rev: 2, status: "closed", chosenSlotId: "s2", meetingId: "m-9" });
    const merged = applyRemotePoll(existing, wire, "bob");
    expect(merged!.status).toBe("closed");
    expect(merged!.chosenSlotId).toBe("s2");
    expect(merged!.meetingId).toBe("m-9");
  });
});
