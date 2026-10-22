import { describe, it, expect, beforeEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { i18n } from "../../src/i18n";
import CalendarPanel from "../../src/components/calendar/CalendarPanel.vue";
import DayEventsPanel from "../../src/components/calendar/DayEventsPanel.vue";
import MeetingRow from "../../src/components/calendar/MeetingRow.vue";
import MeetingFormModal from "../../src/components/calendar/MeetingFormModal.vue";
import PollCard from "../../src/components/calendar/PollCard.vue";
import PollFormModal from "../../src/components/calendar/PollFormModal.vue";
import { dayKey, type Meeting, type MeetingPoll } from "../../src/components/calendar/meetingModel";

// The calendar UI components lean on the globally-injected $t and (for the
// modals) OyaModal's Teleport — the real i18n instance rides as a plugin and
// Teleport is stubbed so modal content stays inside the wrapper.

const HOUR = 3_600_000;

const GLOBAL = { plugins: [i18n], stubs: { teleport: true } } as const;

const ROOMS = [
  { room: "room-1", name: "Crew", ticket: "t1" },
  { room: "room-2", name: "Family", ticket: "t2" },
];

function makeMeeting(over: Partial<Meeting> = {}): Meeting {
  const start = Date.now() + 24 * HOUR;
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
    roomName: "Crew",
    status: "scheduled",
    attendees: {},
    mine: false,
    myRsvp: "pending",
    rev: 1,
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:00:00.000Z",
    ...over,
  };
}

function makePoll(over: Partial<MeetingPoll> = {}): MeetingPoll {
  const t0 = Date.now() + 24 * HOUR;
  return {
    id: "p-1",
    title: "Retro",
    description: "",
    location: "",
    slots: [
      { id: "s1", start: t0, end: t0 + HOUR },
      { id: "s2", start: t0 + 24 * HOUR, end: t0 + 25 * HOUR },
    ],
    organizer: "carol",
    organizerDevice: "carol-device",
    roomSlug: "room-1",
    roomName: "Crew",
    status: "open",
    votes: {},
    mine: false,
    rev: 1,
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T10:00:00.000Z",
    ...over,
  };
}

function buttonByText(wrapper: VueWrapper, text: string) {
  const btn = wrapper.findAll("button").find((b) => b.text().includes(text));
  expect(btn, `button "${text}"`).toBeDefined();
  return btn!;
}

beforeEach(() => {
  i18n.global.locale.value = "en";
});

// ── CalendarPanel ─────────────────────────────────────────────────────────────

describe("CalendarPanel", () => {
  const anchor = new Date(2026, 6, 15); // July 2026
  const july = (day: number, hour = 10) => new Date(2026, 6, day, hour).getTime();

  function dayCell(wrapper: VueWrapper, day: number) {
    // July 2026's grid (Jun 29 – Aug 9) holds days 20/22 exactly once.
    const cell = wrapper
      .findAll("button")
      .find((b) => b.find("span").exists() && b.find("span").text() === String(day));
    expect(cell, `day cell ${day}`).toBeDefined();
    return cell!;
  }

  it("renders a Monday-first 6×7 grid with weekday headers", () => {
    const wrapper = mount(CalendarPanel, {
      props: { meetings: [], modelValue: anchor },
      global: GLOBAL,
    });
    // 42 day cells + prev/today/next controls
    const dayButtons = wrapper
      .findAll("button")
      .filter((b) => b.find("span").exists() && /^\d+$/.test(b.find("span").text()));
    expect(dayButtons).toHaveLength(42);
    expect(wrapper.text()).toContain("2026");
  });

  it("marks scheduled meetings with filled dots and skips cancelled ones", () => {
    const wrapper = mount(CalendarPanel, {
      props: {
        meetings: [
          makeMeeting({ id: "a", start: july(20), end: july(20) + HOUR }),
          makeMeeting({ id: "b", start: july(20, 15), end: july(20, 16) }),
          makeMeeting({ id: "c", start: july(20, 17), end: july(20, 18), status: "cancelled" }),
        ],
        modelValue: anchor,
      },
      global: GLOBAL,
    });
    const dots = dayCell(wrapper, 20).findAll("span.bg-accent-light");
    expect(dots).toHaveLength(2);
  });

  it("marks open-poll slot days with hollow dots; confirmed meetings take precedence", () => {
    const poll = makePoll({
      slots: [
        { id: "s1", start: july(22), end: july(22) + HOUR },
        { id: "s2", start: july(22, 15), end: july(22, 16) },
      ],
    });
    const wrapper = mount(CalendarPanel, {
      props: {
        meetings: [makeMeeting({ start: july(22, 8), end: july(22, 9) })],
        polls: [poll, makePoll({ id: "p-2", status: "cancelled", slots: poll.slots })],
        modelValue: anchor,
      },
      global: GLOBAL,
    });
    const cell = dayCell(wrapper, 22);
    expect(cell.findAll("span.bg-accent-light")).toHaveLength(1); // the meeting
    expect(cell.findAll("span.border-accent-light")).toHaveLength(2); // open poll only
  });

  it("emits the picked day and navigates months", async () => {
    const wrapper = mount(CalendarPanel, {
      props: { meetings: [], modelValue: anchor },
      global: GLOBAL,
    });
    await dayCell(wrapper, 20).trigger("click");
    const picked = wrapper.emitted("update:modelValue")![0][0] as Date;
    expect(dayKey(picked)).toBe("2026-07-20");

    const heading = () => wrapper.find("h2").text();
    const before = heading();
    await wrapper.findAll("button")[2].trigger("click"); // controls are prev / Today / next
    expect(heading()).not.toBe(before);
  });
});

// ── MeetingRow ────────────────────────────────────────────────────────────────

describe("MeetingRow", () => {
  it("offers Accept/Decline to a pending invitee and emits the response", async () => {
    const wrapper = mount(MeetingRow, { props: { meeting: makeMeeting() }, global: GLOBAL });
    await buttonByText(wrapper, "Accept").trigger("click");
    await buttonByText(wrapper, "Decline").trigger("click");
    expect(wrapper.emitted("respond")).toEqual([["accepted"], ["declined"]]);
  });

  it("shows my answer with a change link after responding", async () => {
    const wrapper = mount(MeetingRow, {
      props: { meeting: makeMeeting({ myRsvp: "accepted" }) },
      global: GLOBAL,
    });
    expect(wrapper.text()).toContain("You accepted");
    await buttonByText(wrapper, "Change").trigger("click");
    expect(wrapper.emitted("respond")).toEqual([["declined"]]); // flips to the opposite
  });

  it("gives the organizer Edit/Cancel plus the attendee roster", async () => {
    const wrapper = mount(MeetingRow, {
      props: {
        meeting: makeMeeting({
          mine: true,
          myRsvp: undefined,
          attendees: { bob: { status: "accepted" }, carol: { status: "pending" } },
        }),
      },
      global: GLOBAL,
    });
    expect(wrapper.text()).toContain("bob");
    expect(wrapper.text()).toContain("carol");
    await buttonByText(wrapper, "Edit meeting").trigger("click");
    await buttonByText(wrapper, "Cancel meeting").trigger("click");
    expect(wrapper.emitted("edit")).toHaveLength(1);
    expect(wrapper.emitted("cancelMeeting")).toHaveLength(1);
  });

  it("renders a cancelled meeting struck-through with only local removal", async () => {
    const wrapper = mount(MeetingRow, {
      props: { meeting: makeMeeting({ status: "cancelled" }) },
      global: GLOBAL,
    });
    expect(wrapper.find("p.line-through").exists()).toBe(true);
    expect(wrapper.findAll("button").some((b) => b.text().includes("Accept"))).toBe(false);
    await buttonByText(wrapper, "Remove from calendar").trigger("click");
    expect(wrapper.emitted("remove")).toHaveLength(1);
  });
});

// ── DayEventsPanel ────────────────────────────────────────────────────────────

describe("DayEventsPanel", () => {
  it("lists the selected day's meetings and forwards row events", async () => {
    const day = new Date(Date.now() + 24 * HOUR);
    const onDay = makeMeeting({ start: day.getTime(), end: day.getTime() + HOUR });
    const wrapper = mount(DayEventsPanel, {
      props: { day, meetings: [onDay] },
      global: GLOBAL,
    });
    expect(wrapper.text()).toContain("Standup");
    await buttonByText(wrapper, "Accept").trigger("click");
    expect(wrapper.emitted("respond")).toEqual([["m-1", "accepted"]]);
  });

  it("shows the empty state when the day has no meetings", () => {
    const wrapper = mount(DayEventsPanel, {
      props: { day: new Date(), meetings: [] },
      global: GLOBAL,
    });
    expect(wrapper.text()).toContain("No meetings this day.");
  });
});

// ── MeetingFormModal ──────────────────────────────────────────────────────────

describe("MeetingFormModal", () => {
  async function open(props: Record<string, unknown> = {}) {
    const wrapper = mount(MeetingFormModal, {
      props: { open: false, rooms: ROOMS, currentRoomSlug: "room-1", ...props },
      global: GLOBAL,
    });
    await wrapper.setProps({ open: true }); // the prefill watcher runs on the flip
    return wrapper;
  }

  it("rejects an empty title without emitting save", async () => {
    const wrapper = await open();
    await wrapper.find("form").trigger("submit");
    expect(wrapper.text()).toContain("A title is required.");
    expect(wrapper.emitted("save")).toBeUndefined();
  });

  it("rejects an end before the start", async () => {
    const wrapper = await open();
    await wrapper.find("input[type='text']").setValue("Sync");
    const [start, end] = wrapper.findAll("input[type='time']");
    await start.setValue("14:00");
    await end.setValue("13:00");
    await wrapper.find("form").trigger("submit");
    expect(wrapper.text()).toContain("The end must be after the start.");
    expect(wrapper.emitted("save")).toBeUndefined();
  });

  it("emits a draft with local epoch times and closes", async () => {
    const wrapper = await open();
    await wrapper.find("input[type='text']").setValue("Sync");
    await wrapper.find("input[type='date']").setValue("2026-07-20");
    const [start, end] = wrapper.findAll("input[type='time']");
    await start.setValue("10:00");
    await end.setValue("11:30");
    await wrapper.find("form").trigger("submit");

    const draft = wrapper.emitted("save")![0][0] as Record<string, unknown>;
    expect(draft.title).toBe("Sync");
    expect(draft.start).toBe(new Date("2026-07-20T10:00").getTime());
    expect(draft.end).toBe(new Date("2026-07-20T11:30").getTime());
    expect(draft.roomSlug).toBe("room-1"); // defaults to the current room
    expect(draft.roomName).toBe("Crew");
    expect(wrapper.emitted("update:open")).toEqual([[false]]);
  });

  it("offers a local-only option and prefills + locks the room when editing", async () => {
    const wrapper = await open({ meeting: makeMeeting({ title: "Planning", roomSlug: "room-2", roomName: "Family" }) });
    const select = wrapper.find("select");
    expect(select.attributes("disabled")).toBeDefined(); // room fixed after creation
    expect(select.findAll("option")[0].attributes("value")).toBe(""); // "no invitees" option exists
    expect((wrapper.find("input[type='text']").element as HTMLInputElement).value).toBe("Planning");
    expect((select.element as HTMLSelectElement).value).toBe("room-2");
  });
});

// ── PollFormModal ─────────────────────────────────────────────────────────────

describe("PollFormModal", () => {
  async function open(props: Record<string, unknown> = {}) {
    const wrapper = mount(PollFormModal, {
      props: { open: false, rooms: ROOMS, currentRoomSlug: "room-2", ...props },
      global: GLOBAL,
    });
    await wrapper.setProps({ open: true });
    return wrapper;
  }

  it("starts with two slot rows; more can be added, and only then removed", async () => {
    const wrapper = await open();
    expect(wrapper.findAll("input[type='date']")).toHaveLength(2);
    expect(wrapper.findAll("button[title='Remove slot']")).toHaveLength(0); // 2 is the minimum

    await buttonByText(wrapper, "Add time slot").trigger("click");
    expect(wrapper.findAll("input[type='date']")).toHaveLength(3);
    expect(wrapper.findAll("button[title='Remove slot']")).toHaveLength(3);

    await wrapper.find("button[title='Remove slot']").trigger("click");
    expect(wrapper.findAll("input[type='date']")).toHaveLength(2);
  });

  it("requires a room — the select has no empty option and defaults to the current room", async () => {
    const wrapper = await open();
    const select = wrapper.find("select");
    const values = select.findAll("option").map((o) => o.attributes("value"));
    expect(values).toEqual(["room-1", "room-2"]);
    expect((select.element as HTMLSelectElement).value).toBe("room-2");
  });

  it("rejects an empty title without emitting save", async () => {
    const wrapper = await open();
    await wrapper.find("form").trigger("submit");
    expect(wrapper.text()).toContain("A title is required.");
    expect(wrapper.emitted("save")).toBeUndefined();
  });

  it("emits a draft with slot epochs; a blank deadline stays undefined", async () => {
    const wrapper = await open();
    await wrapper.find("input[type='text']").setValue("Retro");
    const dates = wrapper.findAll("input[type='date']");
    const times = wrapper.findAll("input[type='time']");
    await dates[0].setValue("2026-07-20");
    await times[0].setValue("10:00");
    await times[1].setValue("11:00");
    await dates[1].setValue("2026-07-21");
    await times[2].setValue("14:00");
    await times[3].setValue("15:00");
    await wrapper.find("form").trigger("submit");

    const draft = wrapper.emitted("save")![0][0] as Record<string, any>;
    expect(draft.slots).toEqual([
      { start: new Date("2026-07-20T10:00").getTime(), end: new Date("2026-07-20T11:00").getTime() },
      { start: new Date("2026-07-21T14:00").getTime(), end: new Date("2026-07-21T15:00").getTime() },
    ]);
    expect(draft.deadline).toBeUndefined();
    expect(draft.roomSlug).toBe("room-2");
    expect(wrapper.emitted("update:open")).toEqual([[false]]);
  });

  it("passes a set deadline through as epoch ms", async () => {
    const wrapper = await open();
    await wrapper.find("input[type='text']").setValue("Retro");
    await wrapper.find("input[type='datetime-local']").setValue("2026-07-16T12:30");
    await wrapper.find("form").trigger("submit");
    const draft = wrapper.emitted("save")![0][0] as Record<string, any>;
    expect(draft.deadline).toBe(new Date("2026-07-16T12:30").getTime());
  });
});

// ── PollCard ──────────────────────────────────────────────────────────────────

describe("PollCard", () => {
  it("prompts an unvoted invitee and emits votes per slot", async () => {
    const wrapper = mount(PollCard, { props: { poll: makePoll() }, global: GLOBAL });
    expect(wrapper.text()).toContain("Awaiting your vote");
    // First slot row's three-state buttons come first in DOM order.
    await buttonByText(wrapper, "If need be").trigger("click");
    expect(wrapper.emitted("vote")![0]).toEqual(["s1", "ifneedbe"]);
  });

  it("highlights my selected choice", () => {
    const wrapper = mount(PollCard, {
      props: { poll: makePoll({ myVotes: { s1: "yes" }, votes: { alice: { votes: { s1: "yes" }, votedAt: "t" } } }) },
      global: GLOBAL,
    });
    const yesBtn = wrapper.findAll("button").find((b) => b.text() === "Yes")!;
    expect(yesBtn.classes().join(" ")).toContain("bg-success-light");
  });

  it("orders slots best-first with a Leading badge and voter chips", async () => {
    const poll = makePoll({
      votes: {
        bob: { votes: { s2: "yes" }, votedAt: "t" },
        carol: { votes: { s1: "no", s2: "yes" }, votedAt: "t" },
      },
    });
    const wrapper = mount(PollCard, { props: { poll }, global: GLOBAL });
    expect(wrapper.text()).toContain("Leading");
    expect(wrapper.text()).toContain("bob");
    // s2 leads (2 yes) — the first slot row's vote buttons target s2 now.
    await buttonByText(wrapper, "Yes").trigger("click");
    expect(wrapper.emitted("vote")![0][0]).toBe("s2");
  });

  it("freezes voting after the deadline and shows the ended state", () => {
    const wrapper = mount(PollCard, {
      props: { poll: makePoll({ deadline: Date.now() - 1000 }) },
      global: GLOBAL,
    });
    expect(wrapper.text()).toContain("Voting ended");
    expect(wrapper.findAll("button").some((b) => b.text() === "Yes")).toBe(false);
  });

  it("gives the organizer per-slot confirm and a cancel-poll action", async () => {
    const wrapper = mount(PollCard, { props: { poll: makePoll({ mine: true }) }, global: GLOBAL });
    await buttonByText(wrapper, "Schedule this time").trigger("click");
    expect(wrapper.emitted("confirmSlot")![0]).toEqual(["s1"]);
    await buttonByText(wrapper, "Cancel poll").trigger("click");
    expect(wrapper.emitted("cancelPoll")).toHaveLength(1);
  });

  it("shows a closed poll as scheduled — no voting, chosen slot marked, locally removable", async () => {
    const wrapper = mount(PollCard, {
      props: { poll: makePoll({ status: "closed", chosenSlotId: "s2", meetingId: "m-9" }) },
      global: GLOBAL,
    });
    expect(wrapper.text()).toContain("Scheduled");
    expect(wrapper.findAll("button").some((b) => b.text() === "Yes")).toBe(false);
    await buttonByText(wrapper, "Remove from calendar").trigger("click");
    expect(wrapper.emitted("remove")).toHaveLength(1);
  });
});
