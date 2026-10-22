// The Calendar tab as a whole: the view owns no meeting state of its own — it
// routes what its panels and forms emit into the app-wide meetings orchestrator,
// and keeps the three confirmation dialogs that stand between a click and a
// room-wide broadcast. calendar.test.ts covers the panels on their own; this
// file pins the wiring: which orchestrator call a gesture becomes, with exactly
// which arguments, and that the destructive ones wait for the second click.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { ref } from "vue";
import { formatDate, type P2pRoomEntry } from "rakotis";
import type { Meeting, MeetingPoll } from "../../src/components/calendar/meetingModel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let store: any;
vi.mock("../../src/stores/chat", () => ({ useChatStore: () => store }));

import { i18n } from "../../src/i18n";
import EnigmaCalendarView from "../../src/views/EnigmaCalendarView.vue";

(i18n.global.locale as any).value = "en";

const HOUR = 3_600_000;
// A fixed "now": the form defaults (next full hour) and the past/upcoming split
// both read the clock, so every expectation below is about this moment.
const NOW = new Date(2026, 6, 15, 10, 30);
const at = (day: number, hour: number) => new Date(2026, 6, day, hour).getTime();

const ROOMS: P2pRoomEntry[] = [
  { room: "room-1", name: "Crew" },
  { room: "room-2", name: "Family" },
];

function makeMeeting(over: Partial<Meeting> = {}): Meeting {
  return {
    id: "m-1",
    title: "Standup",
    description: "",
    location: "",
    start: at(15, 14),
    end: at(15, 15),
    organizer: "alice",
    organizerDevice: "alice-device",
    roomSlug: "room-1",
    roomName: "Crew",
    status: "scheduled",
    attendees: {},
    mine: false,
    myRsvp: "pending",
    rev: 1,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...over,
  };
}

function makePoll(over: Partial<MeetingPoll> = {}): MeetingPoll {
  return {
    id: "p-1",
    title: "Retro",
    description: "",
    location: "",
    slots: [
      { id: "s1", start: at(20, 10), end: at(20, 11) },
      { id: "s2", start: at(21, 10), end: at(21, 11) },
    ],
    organizer: "carol",
    organizerDevice: "carol-device",
    roomSlug: "room-1",
    roomName: "Crew",
    status: "open",
    votes: {},
    mine: false,
    rev: 1,
    createdAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
    ...over,
  };
}

function makeStore() {
  return {
    meetings: {
      meetings: ref<Meeting[]>([]),
      polls: ref<MeetingPoll[]>([]),
      create: vi.fn(async () => {}),
      update: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
      removeLocal: vi.fn(async () => {}),
      createPoll: vi.fn(async () => {}),
      votePoll: vi.fn(async () => {}),
      confirmPoll: vi.fn(async () => {}),
      cancelPoll: vi.fn(async () => {}),
      removePollLocal: vi.fn(async () => {}),
    },
    p2p: {
      p2pRooms: ref<P2pRoomEntry[]>([...ROOMS]),
      currentRoom: ref<{ slug: string } | null>({ slug: "room-1" }),
      openP2pRoom: vi.fn(async () => {}),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  store = makeStore();
});

afterEach(() => {
  vi.useRealTimers();
});

async function mountView() {
  const w = mount(EnigmaCalendarView, {
    // Modals teleport to <body>; stubbing keeps them inside the wrapper.
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
  await flushPromises();
  return w;
}

/** Exact label match: "Cancel" must not find "Cancel meeting". */
function button(w: VueWrapper, label: string) {
  const btn = w.findAll("button").find((b) => b.text().trim() === label);
  expect(btn, `button "${label}"`).toBeDefined();
  return btn!;
}

const titleField = (w: VueWrapper) => w.find('input[placeholder="What is the meeting about?"]');

// ── meetings ────────────────────────────────────────────────────────────────

describe("creating a meeting", () => {
  it("sends the drafted meeting and opens its room so the invite can go out", async () => {
    // Inviting a room that is not the open one: the outbox only flushes once
    // that room's MLS session is up, so the view switches to it.
    const w = await mountView();
    await button(w, "New meeting").trigger("click");
    await titleField(w).setValue("Planning");
    await w.find("select").setValue("room-2");
    await w.find("form").trigger("submit");
    await flushPromises();

    expect(store.meetings.create).toHaveBeenCalledWith({
      title: "Planning",
      description: "",
      location: "",
      // The form opens on the next full hour, one hour long.
      start: at(15, 11),
      end: at(15, 12),
      roomSlug: "room-2",
      roomName: "Family",
    });
    expect(store.p2p.openP2pRoom).toHaveBeenCalledWith(ROOMS[1]);
    expect(store.meetings.update).not.toHaveBeenCalled();
    // The form closed itself on save.
    expect(titleField(w).exists()).toBe(false);
  });

  it("defaults the invite to the open room and leaves it open", async () => {
    const w = await mountView();
    await button(w, "New meeting").trigger("click");
    expect((w.find("select").element as HTMLSelectElement).value).toBe("room-1");
    await titleField(w).setValue("Standup");
    await w.find("form").trigger("submit");
    await flushPromises();

    expect(store.meetings.create).toHaveBeenCalledWith(expect.objectContaining({ roomSlug: "room-1" }));
    expect(store.p2p.openP2pRoom).not.toHaveBeenCalled();
  });

  it("opens no room for a meeting that invites nobody", async () => {
    store.p2p.currentRoom.value = null;
    const w = await mountView();
    await button(w, "New meeting").trigger("click");
    await titleField(w).setValue("Dentist");
    await w.find("form").trigger("submit");
    await flushPromises();

    expect(store.meetings.create).toHaveBeenCalledWith(expect.objectContaining({ roomSlug: "", roomName: "" }));
    expect(store.p2p.openP2pRoom).not.toHaveBeenCalled();
  });

  it("does not open a room it no longer knows", async () => {
    // The room list can change under an open form (the room was left).
    const w = await mountView();
    await button(w, "New meeting").trigger("click");
    await titleField(w).setValue("Planning");
    await w.find("select").setValue("room-2");
    store.p2p.p2pRooms.value = [ROOMS[0]];
    await w.find("form").trigger("submit");
    await flushPromises();

    expect(store.meetings.create).toHaveBeenCalledTimes(1);
    expect(store.p2p.openP2pRoom).not.toHaveBeenCalled();
  });
});

describe("the selected day", () => {
  it("lists today's meetings first, and another day's after picking it in the grid", async () => {
    store.meetings.meetings.value = [
      makeMeeting({ id: "a", title: "Standup" }),
      makeMeeting({ id: "b", title: "Dinner", start: at(16, 19), end: at(16, 21) }),
    ];
    const w = await mountView();
    const dayList = () => w.findAll(".rounded-lg.border.p-3").map((r) => r.text());
    expect(dayList().some((t) => t.includes("Standup"))).toBe(true);
    expect(dayList().some((t) => t.includes("Dinner"))).toBe(false);

    const sixteenth = w
      .findAll("button")
      .find((b) => b.find("span").exists() && b.find("span").text() === "16")!;
    await sixteenth.trigger("click");

    expect(dayList().some((t) => t.includes("Dinner"))).toBe(true);
    expect(dayList().some((t) => t.includes("Standup"))).toBe(false);
  });
});

describe("answering and housekeeping", () => {
  it("passes an RSVP through with the meeting's id", async () => {
    store.meetings.meetings.value = [makeMeeting({ id: "m-7" })];
    const w = await mountView();
    await button(w, "Decline").trigger("click");
    expect(store.meetings.respond).toHaveBeenCalledWith("m-7", "declined");
  });

  it("drops a past meeting from this device only", async () => {
    store.meetings.meetings.value = [makeMeeting({ id: "m-past", start: at(15, 8), end: at(15, 9) })];
    const w = await mountView();
    await button(w, "Remove from calendar").trigger("click");
    expect(store.meetings.removeLocal).toHaveBeenCalledWith("m-past");
    expect(store.meetings.cancel).not.toHaveBeenCalled();
  });
});

describe("editing my meeting", () => {
  it("reopens the form on that meeting and saves as an update, not a new invite", async () => {
    const mine = makeMeeting({ id: "m-9", title: "Retro", mine: true, start: at(15, 16), end: at(15, 17) });
    store.meetings.meetings.value = [mine];
    const w = await mountView();
    await button(w, "Edit meeting").trigger("click");

    expect((titleField(w).element as HTMLInputElement).value).toBe("Retro");
    await titleField(w).setValue("Retro (moved)");
    await w.find("form").trigger("submit");
    await flushPromises();

    expect(store.meetings.update).toHaveBeenCalledWith(
      "m-9",
      expect.objectContaining({ title: "Retro (moved)", start: at(15, 16), end: at(15, 17), roomSlug: "room-1" }),
    );
    expect(store.meetings.create).not.toHaveBeenCalled();
    expect(store.p2p.openP2pRoom).not.toHaveBeenCalled();
  });

  it("opens a blank form again after an edit (the edit target does not stick)", async () => {
    store.meetings.meetings.value = [makeMeeting({ id: "m-9", title: "Retro", mine: true })];
    const w = await mountView();
    await button(w, "Edit meeting").trigger("click");
    await button(w, "Cancel").trigger("click");
    await button(w, "New meeting").trigger("click");

    expect((titleField(w).element as HTMLInputElement).value).toBe("");
    await titleField(w).setValue("Fresh");
    await w.find("form").trigger("submit");
    await flushPromises();
    expect(store.meetings.create).toHaveBeenCalledTimes(1);
    expect(store.meetings.update).not.toHaveBeenCalled();
  });
});

describe("cancelling my meeting", () => {
  // The cancellation is broadcast to the whole room, so it takes a second click.
  async function askToCancel() {
    store.meetings.meetings.value = [makeMeeting({ id: "m-9", title: "Retro", mine: true })];
    const w = await mountView();
    await button(w, "Cancel meeting").trigger("click");
    return w;
  }

  it("asks first, naming the meeting, and does nothing until confirmed", async () => {
    const w = await askToCancel();
    expect(w.text()).toContain("Cancel “Retro” for everyone?");
    expect(store.meetings.cancel).not.toHaveBeenCalled();
  });

  it("backing out keeps the meeting", async () => {
    const w = await askToCancel();
    await button(w, "Cancel").trigger("click");
    expect(w.text()).not.toContain("for everyone?");
    expect(store.meetings.cancel).not.toHaveBeenCalled();
  });

  it("confirming cancels exactly that meeting and closes the dialog", async () => {
    const w = await askToCancel();
    // The dialog's button carries the same label as the row's; it renders last.
    const confirm = w.findAll("button").filter((b) => b.text().trim() === "Cancel meeting").at(-1)!;
    await confirm.trigger("click");
    await flushPromises();

    expect(store.meetings.cancel).toHaveBeenCalledWith("m-9");
    expect(w.text()).not.toContain("for everyone?");
  });
});

// ── polls ───────────────────────────────────────────────────────────────────

describe("the polls section", () => {
  it("is absent while there is no poll", async () => {
    const w = await mountView();
    expect(w.text()).not.toContain("Finding a time");
  });

  it("lists open polls first, newest first, then scheduled, then cancelled", async () => {
    store.meetings.polls.value = [
      makePoll({ id: "a", title: "Closed one", status: "closed", createdAt: "2026-07-14T00:00:00.000Z" }),
      makePoll({ id: "b", title: "Old open", status: "open", createdAt: "2026-07-01T00:00:00.000Z" }),
      makePoll({ id: "c", title: "Cancelled one", status: "cancelled", createdAt: "2026-07-14T00:00:00.000Z" }),
      makePoll({ id: "d", title: "New open", status: "open", createdAt: "2026-07-12T00:00:00.000Z" }),
    ];
    const w = await mountView();
    const text = w.text();
    expect(text).toContain("Finding a time");
    const order = ["New open", "Old open", "Closed one", "Cancelled one"].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("records a vote against the poll and slot it was cast on", async () => {
    // Bob's vote makes s2 the leading slot, so it is the first row of the card.
    store.meetings.polls.value = [makePoll({ votes: { bob: { votes: { s2: "yes" }, at: 1 } } as never })];
    const w = await mountView();
    await w.findAll("button").filter((b) => b.text().trim() === "No")[0].trigger("click");
    expect(store.meetings.votePoll).toHaveBeenCalledWith("p-1", "s2", "no");
  });

  it("drops a finished poll from this device only", async () => {
    store.meetings.polls.value = [makePoll({ id: "p-done", status: "closed", chosenSlotId: "s1" })];
    const w = await mountView();
    await button(w, "Remove from calendar").trigger("click");
    expect(store.meetings.removePollLocal).toHaveBeenCalledWith("p-done");
  });
});

describe("scheduling a poll's winning time", () => {
  async function pick() {
    store.meetings.polls.value = [makePoll({ id: "p-3", title: "Retro", mine: true })];
    const w = await mountView();
    await w.findAll("button").filter((b) => b.text().trim() === "Schedule this time")[0].trigger("click");
    return w;
  }

  it("asks first, naming the poll and the exact time", async () => {
    const w = await pick();
    const when = formatDate(at(20, 10), "dayMonthWeekdayTime");
    expect(w.text()).toContain(`Schedule “Retro” for ${when} and close the poll?`);
    expect(store.meetings.confirmPoll).not.toHaveBeenCalled();
  });

  it("confirming closes the poll on that slot", async () => {
    const w = await pick();
    const confirm = w.findAll("button").filter((b) => b.text().trim() === "Schedule this time").at(-1)!;
    await confirm.trigger("click");
    await flushPromises();

    expect(store.meetings.confirmPoll).toHaveBeenCalledWith("p-3", "s1");
    expect(w.text()).not.toContain("and close the poll?");
  });

  it("backing out schedules nothing", async () => {
    const w = await pick();
    await button(w, "Cancel").trigger("click");
    expect(store.meetings.confirmPoll).not.toHaveBeenCalled();
    expect(w.text()).not.toContain("and close the poll?");
  });
});

describe("cancelling my poll", () => {
  it("asks, naming the poll, and cancels only once confirmed", async () => {
    store.meetings.polls.value = [makePoll({ id: "p-4", title: "Retro", mine: true })];
    const w = await mountView();
    await button(w, "Cancel poll").trigger("click");
    expect(w.text()).toContain("Cancel the poll “Retro” for everyone?");
    expect(store.meetings.cancelPoll).not.toHaveBeenCalled();

    const confirm = w.findAll("button").filter((b) => b.text().trim() === "Cancel poll").at(-1)!;
    await confirm.trigger("click");
    await flushPromises();
    expect(store.meetings.cancelPoll).toHaveBeenCalledWith("p-4");
    expect(w.text()).not.toContain("for everyone?");
  });
});

describe("creating a poll", () => {
  it("sends the draft and opens the poll's room when it is not the open one", async () => {
    const w = await mountView();
    await button(w, "New poll").trigger("click");
    await titleField(w).setValue("When can we meet?");
    await w.find("select").setValue("room-2");
    await w.find("form").trigger("submit");
    await flushPromises();

    expect(store.meetings.createPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "When can we meet?",
        roomSlug: "room-2",
        roomName: "Family",
        // Two proposed slots by default: tomorrow and the day after, from the
        // top of the current hour.
        slots: [
          { start: at(16, 10), end: at(16, 11) },
          { start: at(17, 10), end: at(17, 11) },
        ],
      }),
    );
    expect(store.p2p.openP2pRoom).toHaveBeenCalledWith(ROOMS[1]);
  });
});
