import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { useMeetings } from "../../src/components/calendar/useMeetings";
import { wireFromMeeting, type Meeting } from "../../src/components/calendar/meetingModel";
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
