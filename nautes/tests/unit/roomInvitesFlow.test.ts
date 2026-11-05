import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import type { ChatChannel, P2pRoomEntry } from "rakotis";

// Direct room invites (useRoomInvites) on the desktop: the half of the
// handshake that runs over the Tauri runtime. The browser half, where all of
// this must degrade to a clear error, is roomInvites.test.ts; the Contacts view
// drives the happy paths end to end (contactsView.test.ts).
//
// Pinned here are the edges: one invite in flight at a time, the decision
// window lapsing on the Rust side, an answer that cannot be delivered, and a
// redemption that fails AFTER we already said yes — which must surface, since
// the inviter now believes we are on our way in.

// Backend: the REAL Tauri API, faked at its IPC hook (see contactsView.test.ts).
type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
const invokeMock = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  const h = handlers[cmd];
  if (!h) throw new Error(`no backend for ${cmd}`);
  return h(args ?? {});
});
const callsTo = (cmd: string) => invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);

const listeners = new Map<string, (e: { payload: Record<string, string> }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: Record<string, string> }) => void) => {
    listeners.set(name, cb);
    return () => {};
  },
}));

import "@tauri-apps/api/core";
import { useRoomInvites } from "../../src/components/contacts/useRoomInvites";
import { stopHp } from "../../src/components/hp/useHp";

const ROOM: P2pRoomEntry = { room: "room-1", name: "Book club" };
const ALA = "a1".repeat(32);

function makeChannel() {
  return {
    mlsIdentity: ref("me"),
    currentUserName: ref("Me"),
    openP2pRoom: vi.fn(async () => {}),
    joinByInvite: vi.fn(async () => true),
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) await flushPromises();
}

async function freshInvites(ch = makeChannel()) {
  const invites = useRoomInvites(ch as unknown as ChatChannel);
  await settle(); // listeners register, the node start is nudged
  return { invites, ch };
}

function announce(payload: Record<string, string>) {
  listeners.get("invite://incoming")!({ payload });
}

beforeEach(() => {
  invokeMock.mockClear();
  listeners.clear();
  handlers = {
    realtime_node_info: () => ({}),
    invite_send: () => "accepted",
    invite_respond: () => null,
    hp_ledger: () => [],
    hp_charge: (a) => ({ applied: -100, code: a.actionId }),
  };
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
  stopHp();
});

describe("useRoomInvites — desktop: becoming invitable", () => {
  it("listens for invites and wakes the node so the invite ALPN is up", async () => {
    const { invites } = await freshInvites();
    expect(invites.available).toBe(true);
    expect([...listeners.keys()].sort()).toEqual(["invite://incoming", "invite://resolved"]);
    expect(callsTo("realtime_node_info")).toHaveLength(1);
  });

  it("shrugs off a node that refuses to start (offline mode)", async () => {
    handlers.realtime_node_info = () => {
      throw new Error("OFFLINE_BLOCKED");
    };
    const { invites } = await freshInvites();
    // Still listening: an offline profile can come back online later.
    expect(listeners.has("invite://incoming")).toBe(true);
    expect(invites.incoming.value).toBeNull();
  });
});

describe("useRoomInvites — desktop: sending", () => {
  it("records a decline as declined", async () => {
    handlers.invite_send = () => "declined";
    const { invites } = await freshInvites();
    await invites.sendInvite(ALA, ROOM);
    expect(invites.outgoing.value).toBe("declined");
    expect(invites.outgoingError.value).toBe("");
  });

  it("treats any answer other than 'accepted' as a decline", async () => {
    // A garbled or unexpected answer must never read as a yes.
    handlers.invite_send = () => "maybe";
    const { invites } = await freshInvites();
    await invites.sendInvite(ALA, ROOM);
    expect(invites.outgoing.value).toBe("declined");
  });

  it("sends one invite at a time", async () => {
    let answer!: (v: string) => void;
    handlers.invite_send = () => new Promise<string>((r) => (answer = r));
    const { invites, ch } = await freshInvites();
    const first = invites.sendInvite(ALA, ROOM);
    await settle();
    expect(invites.outgoing.value).toBe("waiting");

    await invites.sendInvite(ALA, { room: "room-2", name: "Other" });
    expect(ch.openP2pRoom).toHaveBeenCalledTimes(1);
    expect(callsTo("invite_send")).toEqual([{ nodeId: ALA, room: "room-1", name: "Book club" }]);

    answer("accepted");
    await first;
    expect(invites.outgoing.value).toBe("accepted");
  });

  it("keeps an Error's message when the offer fails", async () => {
    handlers.invite_send = () => {
      throw new Error("INVITE_BUSY: contact is answering another invite");
    };
    const { invites } = await freshInvites();
    await invites.sendInvite(ALA, ROOM);
    expect(invites.outgoing.value).toBe("error");
    expect(invites.outgoingError.value).toBe("INVITE_BUSY: contact is answering another invite");
  });

  it("fails without sending when the room cannot be opened", async () => {
    // The admission runs against the open room; sending first would admit
    // the contact to nothing.
    const ch = makeChannel();
    ch.openP2pRoom.mockRejectedValue(new Error("room gone"));
    const { invites } = await freshInvites(ch);
    await invites.sendInvite(ALA, ROOM);
    expect(invites.outgoing.value).toBe("error");
    expect(invites.outgoingError.value).toBe("room gone");
    expect(callsTo("invite_send")).toHaveLength(0);
  });

  it("starts the next invite from a clean slate after a failure", async () => {
    handlers.invite_send = () => {
      throw "INVITE_UNREACHABLE";
    };
    const { invites } = await freshInvites();
    await invites.sendInvite(ALA, ROOM);
    expect(invites.outgoingError.value).toBe("INVITE_UNREACHABLE");
    handlers.invite_send = () => "accepted";
    await invites.sendInvite(ALA, ROOM);
    expect(invites.outgoing.value).toBe("accepted");
    expect(invites.outgoingError.value).toBe("");
  });
});

describe("useRoomInvites — desktop: receiving", () => {
  const INVITE = { inviteId: "inv-1", fromNodeId: ALA, roomName: "Book club", invite: "sealed" };

  it("holds an incoming invite, filling gaps in a partial payload with empty strings", async () => {
    const { invites } = await freshInvites();
    announce({ inviteId: "inv-2" });
    expect(invites.incoming.value).toEqual({ inviteId: "inv-2", fromNodeId: "", roomName: "", invite: "" });
  });

  it("drops the invite when Rust says its decision window lapsed", async () => {
    const { invites } = await freshInvites();
    announce(INVITE);
    listeners.get("invite://resolved")!({ payload: { inviteId: "some-other" } });
    expect(invites.incoming.value?.inviteId).toBe("inv-1");
    listeners.get("invite://resolved")!({ payload: { inviteId: "inv-1" } });
    expect(invites.incoming.value).toBeNull();
  });

  it("declines even when the answer cannot be delivered", async () => {
    handlers.invite_respond = () => {
      throw new Error("inviter gone");
    };
    const { invites } = await freshInvites();
    announce(INVITE);
    await invites.decline();
    expect(callsTo("invite_respond")).toEqual([{ inviteId: "inv-1", accept: false }]);
    expect(invites.incoming.value).toBeNull();
  });

  it("still redeems after an accept that could not be delivered", async () => {
    // The answer is a courtesy to a parked inviter; the redemption is what
    // actually gets us in, and it carries its own proof.
    handlers.invite_respond = () => {
      throw new Error("stream reset");
    };
    handlers.invite_peek = () => ({ kind: "personal", inviter: ALA, expiresAt: 9_999_999_999_999 });
    handlers.mls_init_session = () => true;
    handlers.mls_key_package = () => [1, 2, 3];
    handlers.invite_redeem = () => ({ welcome: "V0VMQ09NRQ==", roomName: "Book club", peers: [ALA], onion: "" });
    const { invites, ch } = await freshInvites();
    announce(INVITE);
    await invites.accept();
    expect(callsTo("invite_peek")).toEqual([{ ticket: "sealed" }]);
    expect(ch.joinByInvite).toHaveBeenCalledTimes(1);
    expect(invites.acceptError.value).toBe("");
  });

  it("surfaces a redemption that fails after we said yes", async () => {
    handlers.invite_peek = () => {
      throw "INVITE_EXPIRED";
    };
    const { invites, ch } = await freshInvites();
    announce(INVITE);
    await invites.accept();
    expect(callsTo("invite_respond")).toEqual([{ inviteId: "inv-1", accept: true }]);
    expect(invites.acceptError.value).toBe("invite.errExpired");
    expect(ch.joinByInvite).not.toHaveBeenCalled();
    expect(invites.incoming.value).toBeNull();
  });

  it("clears a stale accept error on the next accept", async () => {
    handlers.invite_peek = () => {
      throw "INVITE_REVOKED";
    };
    const { invites } = await freshInvites();
    announce(INVITE);
    await invites.accept();
    expect(invites.acceptError.value).toBe("invite.errRevoked");

    handlers.invite_peek = () => ({ kind: "personal", inviter: ALA, expiresAt: 9_999_999_999_999 });
    handlers.mls_init_session = () => true;
    handlers.mls_key_package = () => [7];
    handlers.invite_redeem = () => ({ welcome: "V0VMQ09NRQ==", roomName: "Book club", peers: [], onion: "" });
    announce({ ...INVITE, inviteId: "inv-3" });
    await invites.accept();
    expect(invites.acceptError.value).toBe("");
  });
});
