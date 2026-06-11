import { describe, it, expect } from "vitest";
import { dueReminders, reminderKey, reminderBody } from "../../src/composables/useMeetingReminders";
import { setLocale } from "../../src/i18n";
import type { EnigmaEvent } from "../../src/services/api";

// Minimal event factory — only the fields the reminder logic reads matter.
function ev(id: string, startMs: number, title = "Standup"): EnigmaEvent {
  return {
    id,
    title,
    description: "",
    start_time: new Date(startMs).toISOString(),
    end_time: new Date(startMs + 3_600_000).toISOString(),
    category: null,
    public: true,
    owner: null,
    address: null,
    capacity: null,
    requires_registration: false,
  };
}

const NOW = Date.UTC(2026, 5, 10, 12, 0, 0); // fixed "now"
const HORIZON = 15 * 60_000;

describe("reminderKey", () => {
  it("combines id and start so a rescheduled event re-pings", () => {
    expect(reminderKey({ id: "e1", start_time: "2026-06-10T12:30:00Z" })).toBe(
      "e1@2026-06-10T12:30:00Z",
    );
  });
});

describe("dueReminders", () => {
  const empty = new Set<string>();

  it("includes an event starting within the horizon", () => {
    const e = ev("e1", NOW + 10 * 60_000); // 10 min out, horizon 15
    expect(dueReminders([e], NOW, HORIZON, empty)).toEqual([e]);
  });

  it("excludes an event beyond the horizon", () => {
    const e = ev("e1", NOW + 20 * 60_000); // 20 min out
    expect(dueReminders([e], NOW, HORIZON, empty)).toEqual([]);
  });

  it("still fires for an event that started within the grace window", () => {
    const e = ev("e1", NOW - 30_000); // started 30 s ago (grace 60 s)
    expect(dueReminders([e], NOW, HORIZON, empty)).toEqual([e]);
  });

  it("drops an event that started well in the past", () => {
    const e = ev("e1", NOW - 5 * 60_000); // started 5 min ago
    expect(dueReminders([e], NOW, HORIZON, empty)).toEqual([]);
  });

  it("skips events already notified", () => {
    const e = ev("e1", NOW + 5 * 60_000);
    const notified = new Set([reminderKey(e)]);
    expect(dueReminders([e], NOW, HORIZON, notified)).toEqual([]);
  });

  it("ignores events with an unparseable start time", () => {
    const bad = { ...ev("e1", NOW), start_time: "not-a-date" };
    expect(dueReminders([bad], NOW, HORIZON, empty)).toEqual([]);
  });

  it("honours a larger horizon", () => {
    const e = ev("e1", NOW + 45 * 60_000); // 45 min out
    expect(dueReminders([e], NOW, 60 * 60_000, empty)).toEqual([e]);
    expect(dueReminders([e], NOW, HORIZON, empty)).toEqual([]);
  });
});

describe("reminderBody", () => {
  it("reports minutes until start for a future meeting", () => {
    setLocale("en", false);
    expect(reminderBody(ev("e1", NOW + 15 * 60_000), NOW)).toContain("Starts in 15 min");
  });

  it('says "now" once the meeting has reached its start time', () => {
    setLocale("en", false);
    expect(reminderBody(ev("e1", NOW), NOW)).toContain("Starting now");
  });
});
