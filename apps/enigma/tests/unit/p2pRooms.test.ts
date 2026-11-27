import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { nextTick, ref } from "vue";
import type { ChatChannel, P2pRoomEntry } from "rakotis";

// The shared P2P rooms controller (useP2pRooms) beyond its connect windows,
// which torConnect.test.ts covers: creating a room, the room-info and delete
// flows, what the join field refuses, and joining from an uploaded QR image.
//
// It runs in Tauri mode against the IPC hook, so a join's invitation peek and
// redemption go through the same backend calls the app makes.

const { qr } = vi.hoisted(() => ({
  qr: { decoded: "" as string | null, clears: 0, clearFails: false, regions: [] as string[] },
}));
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class {
    constructor(region: string) {
      qr.regions.push(region);
    }
    async scanFile() {
      if (qr.decoded === null) throw new Error("No MultiFormat Readers were able to detect the code.");
      return qr.decoded;
    }
    async clear() {
      qr.clears += 1;
      if (qr.clearFails) throw new Error("already cleared");
    }
  },
}));

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`no backend for ${cmd}`);
  return h(args ?? {});
});
const callsTo = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

import "@tauri-apps/api/core";
import { useP2pRooms } from "../../src/components/chat/useP2pRooms";

/** base32 of [0x4E, …] — an invitation, the only thing the join field takes. */
const INVITE = "jybucrq";

function makeChannel() {
  return {
    error: ref<string | null>(null),
    isEncrypted: ref(false),
    mlsIdentity: ref("me"),
    currentUserName: ref("me"),
    p2pRooms: ref<P2pRoomEntry[]>([]),
    createRoom: vi.fn<(name: string) => Promise<string | null>>(async () => null),
    joinByInvite: vi.fn(async () => true),
    cancelJoin: vi.fn(async () => {}),
    deleteRoom: vi.fn<(room: P2pRoomEntry) => Promise<void>>(async () => {}),
  };
}
type Channel = ReturnType<typeof makeChannel>;
const controller = (ch: Channel) => useP2pRooms(ch as unknown as ChatChannel);

async function flush() {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
  await nextTick();
}

function fileEvent(file: File | null) {
  const input = document.createElement("input");
  input.type = "file";
  Object.defineProperty(input, "files", { value: file ? [file] : [], configurable: true });
  return { event: { target: input } as unknown as Event, input };
}

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockClear();
  Object.assign(qr, { decoded: "", clears: 0, clearFails: false, regions: [] });
  handlers = {
    kv_get: () => null,
    invite_peek: () => ({ kind: "general", inviter: "alice", expiresAt: Date.now() + 6e5 }),
    mls_init_session: () => true,
    mls_key_package: () => [1, 2, 3],
    invite_redeem: () => ({ welcome: "V0VMQ09NRQ==", roomName: "R", peers: [] }),
  };
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
});
afterEach(() => {
  vi.useRealTimers();
});

// ── create ──────────────────────────────────────────────────────────────────

describe("useP2pRooms — creating a room", () => {
  it("creates the trimmed name and records the slug with the room's saved name", async () => {
    const ch = makeChannel();
    ch.createRoom.mockImplementation(async () => {
      ch.p2pRooms.value = [{ room: "slug-1", name: "Book club" }];
      return "slug-1";
    });
    const ctrl = controller(ch);
    ctrl.openCreate();
    ctrl.name.value = "  Book club  ";
    await ctrl.createRoom();

    expect(ch.createRoom).toHaveBeenCalledWith("Book club");
    expect(ctrl.createdRoom.value).toEqual({ slug: "slug-1", name: "Book club" });
    expect(ctrl.name.value).toBe("");
    expect(ctrl.createBusy.value).toBe(false);
    expect(ctrl.createError.value).toBe("");
  });

  it("falls back to the typed name when the room has no saved entry", async () => {
    const ch = makeChannel();
    ch.createRoom.mockImplementation(async () => "slug-c");
    const ctrl = controller(ch);
    ctrl.name.value = "Plain";
    await ctrl.createRoom();
    await flush();
    expect(ctrl.createdRoom.value).toEqual({ slug: "slug-c", name: "Plain" });
  });

  it("does nothing for a blank name", async () => {
    const ch = makeChannel();
    const ctrl = controller(ch);
    ctrl.name.value = "   ";
    await ctrl.createRoom();
    expect(ch.createRoom).not.toHaveBeenCalled();
    expect(ctrl.createBusy.value).toBe(false);
  });

  it("ignores a second Create while the first is still launching", async () => {
    const ch = makeChannel();
    let finish!: (v: string | null) => void;
    ch.createRoom.mockImplementation(() => new Promise((r) => (finish = r)));
    const ctrl = controller(ch);
    ctrl.name.value = "Once";
    const first = ctrl.createRoom();
    await flush();
    expect(ctrl.createBusy.value).toBe(true);
    await ctrl.createRoom();
    expect(ch.createRoom).toHaveBeenCalledTimes(1);
    finish("slug-once");
    await first;
  });

  it("shows the channel's own reason when no room came back", async () => {
    const ch = makeChannel();
    ch.createRoom.mockImplementation(async () => {
      ch.error.value = "TOR_BOOTSTRAP_FAILED";
      return null;
    });
    const ctrl = controller(ch);
    ctrl.name.value = "Nope";
    await ctrl.createRoom();
    await flush();
    expect(ctrl.createError.value).toBe("TOR_BOOTSTRAP_FAILED");
    expect(ctrl.createBusy.value).toBe(false);
  });

  it("falls back to the launch-failed message when nothing says why", async () => {
    const ch = makeChannel();
    const ctrl = controller(ch);
    ctrl.name.value = "Nope";
    await ctrl.createRoom();
    expect(ctrl.createError.value).toBe("chat.launchFailed");

    ch.createRoom.mockRejectedValue(new Error(""));
    await ctrl.createRoom();
    expect(ctrl.createError.value).toBe("chat.launchFailed");
  });

  it("starts each New chat from an empty, idle form", async () => {
    const ch = makeChannel();
    const ctrl = controller(ch);
    ctrl.name.value = "half typed";
    ctrl.createError.value = "chat.joinTimeout";
    ctrl.openCreate();
    expect(ctrl.createOpen.value).toBe(true);
    expect(ctrl.name.value).toBe("");
    expect(ctrl.createError.value).toBe("");
    expect(ctrl.createBusy.value).toBe(false);
  });
});

// ── info + delete ───────────────────────────────────────────────────────────

describe("useP2pRooms — room info and delete", () => {
  const room: P2pRoomEntry = { room: "r1", name: "Old room" };

  it("opens the info window on the room picked", () => {
    const ctrl = controller(makeChannel());
    ctrl.openInfo(room);
    expect(ctrl.infoOpen.value).toBe(true);
    expect(ctrl.infoRoom.value).toEqual(room);
  });

  it("deletes the confirmed room and closes the confirmation", async () => {
    const ch = makeChannel();
    const ctrl = controller(ch);
    ctrl.openDeleteConfirm(room);
    expect(ctrl.deleteOpen.value).toBe(true);
    await ctrl.confirmDelete();
    await flush();

    expect(ch.deleteRoom).toHaveBeenCalledWith(room);
    expect(ctrl.deleteOpen.value).toBe(false);
    expect(ctrl.deleteRoomEntry.value).toBeNull();
    expect(ctrl.deleteBusy.value).toBe(false);
  });

  it("keeps the confirmation open when the delete fails", async () => {
    const ch = makeChannel();
    ch.deleteRoom.mockRejectedValue(new Error("busy"));
    const ctrl = controller(ch);
    ctrl.openDeleteConfirm(room);
    await expect(ctrl.confirmDelete()).rejects.toThrow("busy");
    await flush();
    expect(ctrl.deleteOpen.value).toBe(true);
    expect(ctrl.deleteRoomEntry.value).toEqual(room);
    expect(ctrl.deleteBusy.value).toBe(false);
  });

  it("deletes once however often Delete is pressed", async () => {
    const ch = makeChannel();
    let finish!: () => void;
    ch.deleteRoom.mockImplementation(() => new Promise((r) => (finish = r)));
    const ctrl = controller(ch);
    ctrl.openDeleteConfirm(room);
    const first = ctrl.confirmDelete();
    await ctrl.confirmDelete();
    expect(ch.deleteRoom).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it("does nothing with no room chosen", async () => {
    const ch = makeChannel();
    const ctrl = controller(ch);
    await ctrl.confirmDelete();
    expect(ch.deleteRoom).not.toHaveBeenCalled();
  });
});

// ── the join field ──────────────────────────────────────────────────────────

describe("useP2pRooms — what the join field takes", () => {
  it("ignores an empty field", async () => {
    const ctrl = controller(makeChannel());
    ctrl.ticket.value = "   ";
    await ctrl.joinRoom();
    expect(ctrl.joinStarted.value).toBe(false);
    expect(callsTo("invite_peek")).toHaveLength(0);
  });

  it("refuses anything that is not an invitation, saying so plainly", async () => {
    // Old room tickets and DHT codes still circulate as QR codes; they must be
    // turned away with a reason, not handed to a parser that no longer exists.
    const ctrl = controller(makeChannel());
    ctrl.ticket.value = "legacy-room-ticket";
    await ctrl.joinRoom();
    expect(ctrl.joinStarted.value).toBe(true);
    expect(ctrl.joinError.value).toBe("invite.errNotAnInvitation");
    expect(callsTo("invite_peek")).toHaveLength(0);
  });

  it("redeems a scanned code with surrounding whitespace removed", async () => {
    const ch = makeChannel();
    const ctrl = controller(ch);
    await ctrl.joinTicket(`  ${INVITE}\n`);
    await flush();
    expect(ctrl.ticket.value).toBe("");
    expect(callsTo("invite_peek")).toEqual([{ ticket: INVITE }]);
    expect(ch.joinByInvite).toHaveBeenCalledTimes(1);
    expect(ctrl.joinError.value).toBe("");
  });

  it("shows why a redemption was refused", async () => {
    handlers.invite_redeem = () => {
      throw "INVITE_USED: already redeemed";
    };
    const ctrl = controller(makeChannel());
    await ctrl.joinTicket(INVITE);
    await flush();
    expect(ctrl.joinError.value).toBe("invite.errUsed");
  });

  it("keeps the form on Cancel after a cancelled redemption returns", async () => {
    // The aborted call comes back with an error of its own; the user already
    // chose to cancel, so it must not pop the window into an error state.
    let failRedeem!: (e: unknown) => void;
    handlers.invite_redeem = () => new Promise((_r, rej) => (failRedeem = rej));
    const ch = makeChannel();
    const ctrl = controller(ch);
    const join = ctrl.joinTicket(INVITE);
    await flush();
    await ctrl.cancelJoin();
    failRedeem("INVITE_UNREACHABLE");
    await join;
    await flush();
    expect(ctrl.joinStarted.value).toBe(false);
    expect(ctrl.joinError.value).toBe("");
  });

  it("cancels only once however often Cancel is pressed", async () => {
    const ch = makeChannel();
    let finish!: () => void;
    ch.cancelJoin.mockImplementation(() => new Promise<void>((r) => (finish = r)));
    const ctrl = controller(ch);
    const first = ctrl.cancelJoin();
    await ctrl.cancelJoin();
    expect(ch.cancelJoin).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });
});

// ── joining from an uploaded QR image ───────────────────────────────────────

describe("useP2pRooms — joining from a QR image", () => {
  it("decodes the image off-screen and redeems what it holds", async () => {
    qr.decoded = INVITE;
    const ch = makeChannel();
    const ctrl = controller(ch);
    const { event, input } = fileEvent(new File(["png"], "qr.png"));
    await ctrl.scanFile(event);
    await flush();
    expect(qr.regions).toEqual(["p2p-qr-file-region"]);
    expect(qr.clears).toBe(1);
    expect(callsTo("invite_peek")).toEqual([{ ticket: INVITE }]);
    // Reset so picking the same file again fires a change event.
    expect(input.value).toBe("");
  });

  it("still joins when the decoder fails to tidy up after itself", async () => {
    qr.decoded = INVITE;
    qr.clearFails = true;
    const ctrl = controller(makeChannel());
    await ctrl.scanFile(fileEvent(new File(["png"], "qr.png")).event);
    await flush();
    expect(ctrl.scanError.value).toBe("");
    expect(callsTo("invite_peek")).toHaveLength(1);
  });

  it("says so when the image holds no QR code", async () => {
    qr.decoded = null;
    const ctrl = controller(makeChannel());
    await ctrl.scanFile(fileEvent(new File(["png"], "cat.png")).event);
    expect(ctrl.scanError.value).toBe("chat.qrNotFound");
    expect(ctrl.joinStarted.value).toBe(false);
  });

  it("clears an old scan error on the next attempt, and ignores a dismissed picker", async () => {
    qr.decoded = null;
    const ctrl = controller(makeChannel());
    await ctrl.scanFile(fileEvent(new File(["png"], "cat.png")).event);
    expect(ctrl.scanError.value).toBe("chat.qrNotFound");

    await ctrl.scanFile(fileEvent(null).event);
    // A dismissed picker changes nothing, not even the old message.
    expect(ctrl.scanError.value).toBe("chat.qrNotFound");
    expect(qr.regions).toHaveLength(1);

    qr.decoded = INVITE;
    await ctrl.scanFile(fileEvent(new File(["png"], "qr.png")).event);
    await flush();
    expect(ctrl.scanError.value).toBe("");
  });
});
