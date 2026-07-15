import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { useMeetings } from "../../src/components/calendar/useMeetings";
import {
  wireFromMeeting,
  wireFromPoll,
  type Meeting,
  type MeetingPoll,
} from "../../src/components/calendar/meetingModel";
import type { ChatChannel } from "rakotis";

// useMeetings orchestrates meeting invite/RSVP signaling over the channel's
// MLS `onSync`/`sendSync` seam and persists through the encrypted kv store.
// We stub the channel and back the kv commands with an in-memory map; the
// notification plugin is mocked so the reminder tick is observable.

const kvStore = new Map<string, string>();
const invokeMock = vi.fn(async (cmd: string, args: any) => {
  if (cmd === "kv_get") return kvStore.get(`${args.ns}:${args.scope}:${args.k}`) ?? null;
  if (cmd === "kv_put") {
    kvStore.set(`${args.ns}:${args.scope}:${args.k}`, args.v);
    return undefined;
  }
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as [string, any])),
}));

const permissionGrantedMock = vi.fn(async () => true);
const requestPermissionMock = vi.fn(async () => "granted");
const sendNotificationMock = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: (...a: unknown[]) => permissionGrantedMock(...(a as [])),
  requestPermission: (...a: unknown[]) => requestPermissionMock(...(a as [])),
  sendNotification: (...a: unknown[]) => sendNotificationMock(...(a as [unknown])),
}));

const HOUR = 3_600_000;
const MIN = 60_000;

function makeChannel() {
  let handler:
    | ((type: string, payload: Record<string, unknown>, sender: string) => void | Promise<void>)
    | null = null;
  const stub = {
    onSync: vi.fn((fn: typeof handler) => {
      handler = fn;
      return () => {
        handler = null;
      };
    }),
    sendSync: vi.fn(async () => {}),
    postSystemNotice: vi.fn(),
    currentUserName: ref("alice"),
    mlsIdentity: ref("alice-device"),
    currentRoom: ref<{ slug: string; name: string } | null>({ slug: "room-1", name: "Room 1" }),
    mlsStatus: ref("ready"),
    participants: ref([
      { id: "alice-device", name: "alice", avatar_url: "", type: "human" },
      { id: "bob-device", name: "bob", avatar_url: "", type: "human" },
    ]),
  };
  const emitSync = async (type: string, payload: Record<string, unknown>, sender = "bob") => {
    await handler?.(type, payload, sender);
  };
  return { channel: stub as unknown as ChatChannel, stub, emitSync };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const DRAFT = {
  title: "Design sync",
  description: "quarterly",
  location: "hq",
  start: Date.now() + 2 * HOUR,
  end: Date.now() + 3 * HOUR,
  roomSlug: "room-1",
  roomName: "Room 1",
};

/** An invite wire payload as bob's device would receive it from organizer carol. */
function inviteFromCarol(over: Partial<Record<string, unknown>> = {}) {
  const m: Meeting = {
    id: "mt-9",
    title: "Retro",
    description: "",
    location: "",
    start: Date.now() + 2 * HOUR,
    end: Date.now() + 3 * HOUR,
    organizer: "carol",
    organizerDevice: "carol-device",
    roomSlug: "room-1",
    roomName: "Room 1",
    status: "scheduled",
    attendees: {},
    mine: true,
    rev: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { ...wireFromMeeting(m), fromName: "carol", fromDevice: "carol-device", ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  kvStore.clear();
  (window as any).__TAURI_INTERNALS__ = {};
  permissionGrantedMock.mockResolvedValue(true);
});

describe("useMeetings — organizer side", () => {
  it("create() persists encrypted-at-rest and broadcasts a full meeting_invite", async () => {
    const { channel, stub } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();

    const m = await meetings.create(DRAFT);

    expect(stub.sendSync).toHaveBeenCalledWith(
      "meeting_invite",
      expect.objectContaining({
        meetingId: m.id,
        title: "Design sync",
        organizer: "alice",
        organizerDevice: "alice-device",
        rev: 1,
        fromName: "alice",
        fromDevice: "alice-device",
        attendees: { bob: { status: "pending", device: "bob-device" } },
      }),
    );
    expect(m.needsBroadcast).toBe(false); // flushed immediately (room open + ready)
    const stored = JSON.parse(kvStore.get("meetings:default:") ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].mine).toBe(true);
  });

  it("a local-only meeting (no room) sends nothing", async () => {
    const { channel, stub } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();

    await meetings.create({ ...DRAFT, roomSlug: "", roomName: "" });

    expect(stub.sendSync).not.toHaveBeenCalled();
  });

  it("holds the invite in the outbox until MLS is ready, then flushes", async () => {
    const { channel, stub } = makeChannel();
    stub.mlsStatus.value = "initializing";
    const meetings = useMeetings(channel);
    await flush();

    const m = await meetings.create(DRAFT);
    expect(stub.sendSync).not.toHaveBeenCalled();
    expect(m.needsBroadcast).toBe(true);

    stub.mlsStatus.value = "ready";
    await flush();
    expect(stub.sendSync).toHaveBeenCalledWith("meeting_invite", expect.objectContaining({ meetingId: m.id }));
  });

  it("update() bumps the revision and broadcasts meeting_update; a moved start re-arms the reminder", async () => {
    const { channel, stub } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    const m = await meetings.create(DRAFT);
    m.reminded = true;

    await meetings.update(m.id, { ...DRAFT, start: DRAFT.start + HOUR, end: DRAFT.end + HOUR });

    expect(stub.sendSync).toHaveBeenLastCalledWith(
      "meeting_update",
      expect.objectContaining({ meetingId: m.id, rev: 2, start: DRAFT.start + HOUR }),
    );
    expect(m.reminded).toBe(false);
  });

  it("cancel() broadcasts meeting_cancel and keeps the record", async () => {
    const { channel, stub } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    const m = await meetings.create(DRAFT);

    await meetings.cancel(m.id);

    expect(stub.sendSync).toHaveBeenLastCalledWith("meeting_cancel", {
      meetingId: m.id,
      rev: 2,
      fromName: "alice",
      fromDevice: "alice-device",
    });
    expect(meetings.meetings.value[0].status).toBe("cancelled");
  });

  it("an incoming meeting_response fills the organizer's roster", async () => {
    const { channel, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    const m = await meetings.create(DRAFT);

    await emitSync("meeting_response", {
      meetingId: m.id,
      status: "accepted",
      respondedAt: "2026-07-14T12:00:00.000Z",
      fromName: "bob",
      fromDevice: "bob-device",
    });

    expect(meetings.meetings.value[0].attendees.bob).toEqual({
      status: "accepted",
      respondedAt: "2026-07-14T12:00:00.000Z",
      device: "bob-device",
    });
  });

  it("participant growth re-broadcasts future meetings (late joiners catch up)", async () => {
    const { channel, stub } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    const m = await meetings.create(DRAFT);
    stub.sendSync.mockClear();

    stub.participants.value = [
      ...stub.participants.value,
      { id: "carol-device", name: "carol", avatar_url: "", type: "human" },
    ];
    await flush();

    expect(stub.sendSync).toHaveBeenCalledWith("meeting_invite", expect.objectContaining({ meetingId: m.id }));
  });
});

describe("useMeetings — invitee side", () => {
  it("an incoming invite is stored pending, posts a chat notice and lights the dot", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();

    await emitSync("meeting_invite", inviteFromCarol(), "carol");

    const m = meetings.meetings.value[0];
    expect(m.myRsvp).toBe("pending");
    expect(m.mine).toBe(false);
    expect(meetings.pendingInviteCount.value).toBe(1);
    expect(stub.postSystemNotice).toHaveBeenCalledTimes(1);
    expect(String(stub.postSystemNotice.mock.calls[0][0])).toContain("Retro");
  });

  it("a re-broadcast duplicate neither duplicates the meeting nor re-notifies", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();

    await emitSync("meeting_invite", inviteFromCarol(), "carol");
    await emitSync("meeting_invite", inviteFromCarol(), "carol");

    expect(meetings.meetings.value).toHaveLength(1);
    expect(stub.postSystemNotice).toHaveBeenCalledTimes(1);
  });

  it("respond() records my RSVP and sends meeting_response", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_invite", inviteFromCarol(), "carol");

    await meetings.respond("mt-9", "accepted");

    expect(stub.sendSync).toHaveBeenCalledWith(
      "meeting_response",
      expect.objectContaining({ meetingId: "mt-9", status: "accepted", fromName: "alice", fromDevice: "alice-device" }),
    );
    expect(meetings.meetings.value[0].myRsvp).toBe("accepted");
    expect(meetings.pendingInviteCount.value).toBe(0);
  });

  it("honors an organizer update, drops a forged one", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_invite", inviteFromCarol(), "carol");
    stub.postSystemNotice.mockClear();

    await emitSync("meeting_update", inviteFromCarol({ rev: 2, title: "Retro (moved)" }), "carol");
    expect(meetings.meetings.value[0].title).toBe("Retro (moved)");
    expect(meetings.meetings.value[0].rev).toBe(2);
    expect(stub.postSystemNotice).toHaveBeenCalledTimes(1);

    await emitSync(
      "meeting_update",
      inviteFromCarol({ rev: 3, title: "hijack", fromDevice: "mallory-device" }),
      "mallory",
    );
    expect(meetings.meetings.value[0].title).toBe("Retro (moved)");
  });

  it("honors an organizer cancel, ignores a stale one", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_invite", inviteFromCarol(), "carol");
    stub.postSystemNotice.mockClear();

    await emitSync("meeting_cancel", { meetingId: "mt-9", rev: 1, fromName: "carol", fromDevice: "carol-device" });
    expect(meetings.meetings.value[0].status).toBe("scheduled"); // rev 1 ≤ stored rev — stale

    await emitSync("meeting_cancel", { meetingId: "mt-9", rev: 2, fromName: "carol", fromDevice: "carol-device" });
    expect(meetings.meetings.value[0].status).toBe("cancelled");
    expect(meetings.pendingInviteCount.value).toBe(0);
    expect(stub.postSystemNotice).toHaveBeenCalledTimes(1);
  });

  it("ignores self-echoed messages", async () => {
    const { channel, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();

    await emitSync("meeting_invite", inviteFromCarol({ fromDevice: "alice-device" }), "alice");

    expect(meetings.meetings.value).toHaveLength(0);
  });
});

describe("useMeetings — reminders", () => {
  it("fires the OS notification exactly once per meeting, lead time from Settings", async () => {
    kvStore.set("p2p:settings:default:meeting_reminder_mins", "5");
    const { channel, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_invite", inviteFromCarol({ start: Date.now() + 4 * MIN, end: Date.now() + HOUR }), "carol");

    await meetings.reminderTick();
    await meetings.reminderTick();

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    // the fired flag is persisted — a restart must not re-fire
    expect(JSON.parse(kvStore.get("meetings:default:")!)[0].reminded).toBe(true);
  });

  it("a lead of 0 disables reminders", async () => {
    kvStore.set("p2p:settings:default:meeting_reminder_mins", "0");
    const { channel, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_invite", inviteFromCarol({ start: Date.now() + MIN, end: Date.now() + HOUR }), "carol");

    await meetings.reminderTick();

    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("stays quiet outside the lead window", async () => {
    kvStore.set("p2p:settings:default:meeting_reminder_mins", "5");
    const { channel, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_invite", inviteFromCarol({ start: Date.now() + 2 * HOUR, end: Date.now() + 3 * HOUR }), "carol");

    await meetings.reminderTick();

    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});

describe("useMeetings — persistence", () => {
  it("reload() re-reads the profile's meeting list (profile switch)", async () => {
    const { channel } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await meetings.create({ ...DRAFT, roomSlug: "", roomName: "" });
    expect(meetings.meetings.value).toHaveLength(1);

    kvStore.set("meetings:default:", "[]"); // the switched profile has no meetings
    await meetings.reload();

    expect(meetings.meetings.value).toHaveLength(0);
  });
});

// ── polls (doodle-style slot voting) ──────────────────────────────────────────

const POLL_DRAFT = {
  title: "Retro",
  description: "quarterly",
  location: "hq",
  slots: [
    { start: Date.now() + 24 * HOUR, end: Date.now() + 25 * HOUR },
    { start: Date.now() + 48 * HOUR, end: Date.now() + 49 * HOUR },
  ],
  roomSlug: "room-1",
  roomName: "Room 1",
};

/** A poll wire payload as alice's device would receive it from organizer carol. */
function pollFromCarol(over: Partial<Record<string, unknown>> = {}) {
  const p: MeetingPoll = {
    id: "pl-9",
    title: "Retro",
    description: "",
    location: "",
    slots: [
      { id: "s1", start: Date.now() + 24 * HOUR, end: Date.now() + 25 * HOUR },
      { id: "s2", start: Date.now() + 48 * HOUR, end: Date.now() + 49 * HOUR },
    ],
    organizer: "carol",
    organizerDevice: "carol-device",
    roomSlug: "room-1",
    roomName: "Room 1",
    status: "open",
    votes: {},
    mine: true,
    rev: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { ...wireFromPoll(p), fromName: "carol", fromDevice: "carol-device", ...over };
}

describe("useMeetings polls — organizer side", () => {
  it("createPoll persists under the polls key and broadcasts a full meeting_poll", async () => {
    const { channel, stub } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();

    const p = await meetings.createPoll(POLL_DRAFT);

    expect(stub.sendSync).toHaveBeenCalledWith(
      "meeting_poll",
      expect.objectContaining({
        pollId: p.id,
        title: "Retro",
        organizer: "alice",
        organizerDevice: "alice-device",
        status: "open",
        rev: 1,
        fromName: "alice",
        fromDevice: "alice-device",
      }),
    );
    expect(p.slots).toHaveLength(2);
    expect(p.needsBroadcast).toBe(false); // flushed immediately
    const stored = JSON.parse(kvStore.get("meetings:default:polls") ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0].mine).toBe(true);
  });

  it("holds the poll in the outbox until MLS is ready, then flushes", async () => {
    const { channel, stub } = makeChannel();
    stub.mlsStatus.value = "initializing";
    const meetings = useMeetings(channel);
    await flush();

    const p = await meetings.createPoll(POLL_DRAFT);
    expect(stub.sendSync).not.toHaveBeenCalled();
    expect(p.needsBroadcast).toBe(true);

    stub.mlsStatus.value = "ready";
    await flush();
    expect(stub.sendSync).toHaveBeenCalledWith("meeting_poll", expect.objectContaining({ pollId: p.id }));
  });

  it("the organizer's own ballot travels as a rev-bumped snapshot", async () => {
    const { channel, stub } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    const p = await meetings.createPoll(POLL_DRAFT);
    stub.sendSync.mockClear();

    await meetings.votePoll(p.id, p.slots[0].id, "yes");

    expect(stub.sendSync).toHaveBeenCalledWith(
      "meeting_poll",
      expect.objectContaining({
        pollId: p.id,
        rev: 2,
        votes: expect.objectContaining({ alice: expect.objectContaining({ votes: { [p.slots[0].id]: "yes" } }) }),
      }),
    );
  });

  it("incoming ballots fill the vote map; late ballots after the deadline are dropped", async () => {
    const { channel, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    const p = await meetings.createPoll(POLL_DRAFT);

    await emitSync("meeting_poll_vote", {
      pollId: p.id,
      votes: { [p.slots[0].id]: "yes", [p.slots[1].id]: "no", ghost: "yes" },
      votedAt: "2026-07-15T12:00:00.000Z",
      fromName: "bob",
      fromDevice: "bob-device",
    });
    expect(p.votes.bob.votes).toEqual({ [p.slots[0].id]: "yes", [p.slots[1].id]: "no" }); // ghost filtered

    // stale ballot (older votedAt) is ignored
    await emitSync("meeting_poll_vote", {
      pollId: p.id,
      votes: { [p.slots[0].id]: "no" },
      votedAt: "2026-07-15T11:00:00.000Z",
      fromName: "bob",
      fromDevice: "bob-device",
    });
    expect(p.votes.bob.votes[p.slots[0].id]).toBe("yes");

    const expired = await meetings.createPoll({ ...POLL_DRAFT, deadline: Date.now() - 1000 });
    await emitSync("meeting_poll_vote", {
      pollId: expired.id,
      votes: { [expired.slots[0].id]: "yes" },
      votedAt: new Date().toISOString(),
      fromName: "bob",
      fromDevice: "bob-device",
    });
    expect(expired.votes).toEqual({});
  });

  it("confirmPoll closes the poll and creates the meeting — close sent BEFORE invite, attendees pre-seeded from ballots", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    const p = await meetings.createPoll(POLL_DRAFT);
    const [s1] = p.slots;
    await emitSync("meeting_poll_vote", { pollId: p.id, votes: { [s1.id]: "yes" }, votedAt: "t1", fromName: "bob", fromDevice: "bob-device" });
    await emitSync("meeting_poll_vote", { pollId: p.id, votes: { [s1.id]: "no" }, votedAt: "t2", fromName: "carol", fromDevice: "carol-device" });
    await emitSync("meeting_poll_vote", { pollId: p.id, votes: { [s1.id]: "ifneedbe" }, votedAt: "t3", fromName: "dave", fromDevice: "dave-device" });
    stub.sendSync.mockClear();

    const m = await meetings.confirmPoll(p.id, s1.id);

    expect(p.status).toBe("closed");
    expect(p.chosenSlotId).toBe(s1.id);
    expect(p.meetingId).toBe(m!.id);
    const types = stub.sendSync.mock.calls.map((c) => c[0]);
    expect(types.indexOf("meeting_poll_close")).toBeLessThan(types.indexOf("meeting_invite"));
    expect(stub.sendSync).toHaveBeenCalledWith(
      "meeting_poll_close",
      expect.objectContaining({ pollId: p.id, chosenSlotId: s1.id, meetingId: m!.id, rev: 2 }),
    );
    expect(m!.start).toBe(s1.start);
    expect(m!.attendees).toEqual({
      bob: { status: "accepted", respondedAt: "t1", device: "bob-device" },
      carol: { status: "declined", respondedAt: "t2", device: "carol-device" },
      dave: { status: "pending", respondedAt: "t3", device: "dave-device" },
    });
  });

  it("cancelPoll broadcasts and keeps the record; removePollLocal drops it", async () => {
    const { channel, stub } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    const p = await meetings.createPoll(POLL_DRAFT);

    await meetings.cancelPoll(p.id);
    expect(stub.sendSync).toHaveBeenLastCalledWith(
      "meeting_poll_cancel",
      expect.objectContaining({ pollId: p.id, rev: 2 }),
    );
    expect(meetings.polls.value[0].status).toBe("cancelled");

    await meetings.removePollLocal(p.id);
    expect(meetings.polls.value).toHaveLength(0);
  });

  it("participant growth re-broadcasts polls before meetings", async () => {
    const { channel, stub } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await meetings.create(DRAFT);
    const p = await meetings.createPoll(POLL_DRAFT);
    stub.sendSync.mockClear();

    stub.participants.value = [
      ...stub.participants.value,
      { id: "carol-device", name: "carol", avatar_url: "", type: "human" },
    ];
    await flush();

    const types = stub.sendSync.mock.calls.map((c) => c[0]);
    expect(types).toContain("meeting_poll");
    expect(types).toContain("meeting_invite");
    expect(types.indexOf("meeting_poll")).toBeLessThan(types.indexOf("meeting_invite"));
    expect(stub.sendSync).toHaveBeenCalledWith("meeting_poll", expect.objectContaining({ pollId: p.id }));
  });
});

describe("useMeetings polls — voter side", () => {
  it("an incoming poll is stored, posts a notice and lights the attention dot", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();

    await emitSync("meeting_poll", pollFromCarol(), "carol");

    const p = meetings.polls.value[0];
    expect(p.mine).toBe(false);
    expect(p.status).toBe("open");
    expect(meetings.pendingPollCount.value).toBe(1);
    expect(meetings.attentionCount.value).toBe(1);
    expect(stub.postSystemNotice).toHaveBeenCalledTimes(1);
    expect(String(stub.postSystemNotice.mock.calls[0][0])).toContain("Retro");
  });

  it("a re-broadcast duplicate neither duplicates the poll nor re-notifies", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();

    await emitSync("meeting_poll", pollFromCarol(), "carol");
    await emitSync("meeting_poll", pollFromCarol(), "carol");

    expect(meetings.polls.value).toHaveLength(1);
    expect(stub.postSystemNotice).toHaveBeenCalledTimes(1);
  });

  it("votePoll sends my ballot and clears the pending dot; voting is blocked after expiry", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_poll", pollFromCarol(), "carol");

    await meetings.votePoll("pl-9", "s1", "yes");
    await meetings.votePoll("pl-9", "s2", "ifneedbe");

    expect(stub.sendSync).toHaveBeenLastCalledWith(
      "meeting_poll_vote",
      expect.objectContaining({
        pollId: "pl-9",
        votes: { s1: "yes", s2: "ifneedbe" },
        fromName: "alice",
        fromDevice: "alice-device",
      }),
    );
    expect(meetings.pendingPollCount.value).toBe(0);

    stub.sendSync.mockClear();
    await emitSync("meeting_poll", pollFromCarol({ pollId: "pl-x", deadline: Date.now() - 1000 }), "carol");
    await meetings.votePoll("pl-x", "s1", "yes");
    expect(stub.sendSync).not.toHaveBeenCalled();
  });

  it("my un-sent ballot survives an organizer snapshot upsert", async () => {
    const { channel, stub, emitSync } = makeChannel();
    stub.mlsStatus.value = "initializing"; // ballot can't flush
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_poll", pollFromCarol(), "carol");
    await meetings.votePoll("pl-9", "s1", "yes");
    expect(meetings.polls.value[0].needsBroadcast).toBe(true);

    await emitSync("meeting_poll", pollFromCarol({ rev: 2, votes: { bob: { votes: { s1: "no" }, votedAt: "t" } } }), "carol");

    const p = meetings.polls.value[0];
    expect(p.rev).toBe(2);
    expect(p.needsBroadcast).toBe(true);
    expect(p.myVotes).toEqual({ s1: "yes" });
    expect(p.votes.alice.votes).toEqual({ s1: "yes" }); // my row wins over the snapshot
    expect(p.votes.bob.votes).toEqual({ s1: "no" });
  });

  it("honors an organizer close (with notice), drops forged or stale ones", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_poll", pollFromCarol(), "carol");
    stub.postSystemNotice.mockClear();

    await emitSync("meeting_poll_close", { pollId: "pl-9", rev: 2, chosenSlotId: "s1", meetingId: "mt-1", fromName: "mallory", fromDevice: "mallory-device" });
    expect(meetings.polls.value[0].status).toBe("open");

    await emitSync("meeting_poll_close", { pollId: "pl-9", rev: 1, chosenSlotId: "s1", meetingId: "mt-1", fromName: "carol", fromDevice: "carol-device" });
    expect(meetings.polls.value[0].status).toBe("open"); // stale rev

    await emitSync("meeting_poll_close", { pollId: "pl-9", rev: 2, chosenSlotId: "s1", meetingId: "mt-1", fromName: "carol", fromDevice: "carol-device" });
    const p = meetings.polls.value[0];
    expect(p.status).toBe("closed");
    expect(p.chosenSlotId).toBe("s1");
    expect(p.meetingId).toBe("mt-1");
    expect(meetings.pendingPollCount.value).toBe(0);
    expect(stub.postSystemNotice).toHaveBeenCalledTimes(1);
  });

  it("suppresses the invite notice for the meeting a poll close announced; yes-voters arrive accepted", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_poll", pollFromCarol(), "carol");
    await emitSync("meeting_poll_close", { pollId: "pl-9", rev: 2, chosenSlotId: "s1", meetingId: "mt-1", fromName: "carol", fromDevice: "carol-device" });
    stub.postSystemNotice.mockClear();

    const m: Meeting = {
      id: "mt-1",
      title: "Retro",
      description: "",
      location: "",
      start: Date.now() + 24 * HOUR,
      end: Date.now() + 25 * HOUR,
      organizer: "carol",
      organizerDevice: "carol-device",
      roomSlug: "room-1",
      roomName: "Room 1",
      status: "scheduled",
      attendees: { alice: { status: "accepted", respondedAt: "t" } },
      mine: true,
      rev: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await emitSync("meeting_invite", { ...wireFromMeeting(m), fromName: "carol", fromDevice: "carol-device" }, "carol");

    expect(meetings.meetings.value[0].myRsvp).toBe("accepted"); // no re-accept needed
    expect(stub.postSystemNotice).not.toHaveBeenCalled(); // close already announced it
  });

  it("honors an organizer cancel with a notice", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_poll", pollFromCarol(), "carol");
    stub.postSystemNotice.mockClear();

    await emitSync("meeting_poll_cancel", { pollId: "pl-9", rev: 2, fromName: "carol", fromDevice: "carol-device" });

    expect(meetings.polls.value[0].status).toBe("cancelled");
    expect(meetings.pendingPollCount.value).toBe(0);
    expect(stub.postSystemNotice).toHaveBeenCalledTimes(1);
  });

  it("reload() re-reads the polls list (profile switch)", async () => {
    const { channel, emitSync } = makeChannel();
    const meetings = useMeetings(channel);
    await flush();
    await emitSync("meeting_poll", pollFromCarol(), "carol");
    expect(meetings.polls.value).toHaveLength(1);

    kvStore.set("meetings:default:polls", "[]");
    await meetings.reload();

    expect(meetings.polls.value).toHaveLength(0);
  });
});
