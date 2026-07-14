import { describe, it, expect } from "vitest";
import {
  applyRemoteInvite,
  dayKey,
  meetingsOnDay,
  monthGrid,
  reminderDue,
  upcoming,
  validateMeetingDraft,
  wireFromMeeting,
  type Meeting,
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
