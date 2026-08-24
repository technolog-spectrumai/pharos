// Redeeming a scanned invitation.
//
// The join field takes one string and routes it by tag byte, so an invitation
// has to be recognised BEFORE the ticket parser sees it — and once recognised it
// goes down a different road entirely: connect to the inviter, prove the
// capability, be admitted by them.
//
// The refusals get most of the attention here. "Already used", "expired" and
// "addressed to someone else" call for different things from the person holding
// the code, and collapsing them into "failed" helps nobody.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref } from "vue";
import type { ChatChannel } from "rakotis";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useP2pRooms } from "../../src/components/chat/useP2pRooms";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** base32 of [0x4E, 0x01, 0x47, …] — a general invitation. */
const INVITE = "jybucrq";
/** base32 of [0x49, …] — an ordinary iroh room ticket. */
const TICKET = "jffci7y4nlaagnhsfexo2uomnfiuc2cbtblc";

const PEEK = { kind: "general", inviter: "alice-node-id", expiresAt: Date.now() + 3_600_000 };
const GRANT = { welcome: "V0VMQ09NRQ==", roomName: "Room One", peers: ["alice-node-id"], onion: "" };

function makeChannel() {
  const stub = {
    mlsIdentity: ref("bob"),
    currentUserName: ref("bob"),
    p2pRooms: ref([]),
    currentRoom: ref<{ slug: string; name: string } | null>(null),
    joinByInvite: vi.fn(async () => true),
    joinByTicket: vi.fn(async () => {}),
    loadP2pRooms: vi.fn(async () => {}),
    createRoom: vi.fn(),
    deleteRoom: vi.fn(),
    error: ref<string | null>(null),
    isEncrypted: ref(false),
    cancelJoin: vi.fn(),
    openP2pRoom: vi.fn(),
    forgetP2pRoom: vi.fn(),
  };
  return { channel: stub as unknown as ChatChannel, stub };
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "invite_peek") return PEEK;
    if (cmd === "mls_init_session") return true;
    if (cmd === "mls_key_package") return [1, 2, 3];
    if (cmd === "invite_redeem") return GRANT;
    if (cmd === "kv_get") return null;
    return null;
  });
});

describe("redeeming an invitation", () => {
  it("routes an invitation away from the ticket parser", async () => {
    const { channel, stub } = makeChannel();
    const c = useP2pRooms(channel);
    c.ticket.value = INVITE;
    await c.joinRoom();
    await flush();

    expect(invokeMock.mock.calls.some((x) => x[0] === "invite_peek")).toBe(true);
    // The topic-join path must never have been entered.
    expect(stub.joinByTicket).not.toHaveBeenCalled();
  });

  it("leaves an ordinary room ticket on the ticket path", async () => {
    const { channel, stub } = makeChannel();
    const c = useP2pRooms(channel);
    c.ticket.value = TICKET;
    await c.joinRoom();
    await flush();

    expect(invokeMock.mock.calls.some((x) => x[0] === "invite_peek")).toBe(false);
    expect(stub.joinByTicket).toHaveBeenCalled();
  });

  it("says who is inviting before committing to the code", async () => {
    const { channel } = makeChannel();
    const c = useP2pRooms(channel);
    c.ticket.value = INVITE;
    await c.joinRoom();
    await flush();
    expect(c.invitePeek.value?.inviter).toBe("alice-node-id");
  });

  it("builds its key package under a scratch room, then hands the grant over", async () => {
    // The chicken-and-egg the whole flow turns on: the KeyPackage must exist
    // before the room is known, because an invitation deliberately does not name
    // its room until the capability is proven.
    const { channel, stub } = makeChannel();
    const c = useP2pRooms(channel);
    c.ticket.value = INVITE;
    await c.joinRoom();
    await flush();

    const init = invokeMock.mock.calls.find((x) => x[0] === "mls_init_session");
    expect(init?.[1].room).toMatch(/^invite:/);
    expect(init?.[1].room).not.toBe("Room One");
    // And joinByInvite is told which scratch key to adopt from.
    expect(stub.joinByInvite).toHaveBeenCalledWith(GRANT, init?.[1].room);
  });

  it("clears the field after a successful redemption", async () => {
    const { channel } = makeChannel();
    const c = useP2pRooms(channel);
    c.ticket.value = INVITE;
    await c.joinRoom();
    await flush();
    expect(c.ticket.value).toBe("");
    expect(c.joinError.value).toBe("");
  });

  it("gives each refusal its own sentence", async () => {
    const cases: [string, string][] = [
      ["INVITE_NOT_FOR_YOU", "invite.errNotForYou"],
      ["INVITE_WRONG_RECIPIENT", "invite.errNotForYou"],
      ["INVITE_EXPIRED", "invite.errExpired"],
      ["INVITE_USED", "invite.errUsed"],
      ["INVITE_REVOKED", "invite.errRevoked"],
      ["INVITE_BUSY", "invite.errBusy"],
      ["INVITE_UNREACHABLE", "invite.errUnreachable"],
      ["INVITE_ADMIT_FAILED", "invite.errAdmitFailed"],
      ["INVITE_VERSION", "invite.errVersion"],
    ];
    for (const [code, key] of cases) {
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === "invite_peek") throw new Error(code);
        return null;
      });
      const { channel } = makeChannel();
      const c = useP2pRooms(channel);
      c.ticket.value = INVITE;
      await c.joinRoom();
      await flush();
      expect(c.joinError.value, code).toBe(key);
    }
  });

  it("falls back to one generic sentence rather than showing a raw error", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "invite_peek") throw new Error("something the backend said");
      return null;
    });
    const { channel } = makeChannel();
    const c = useP2pRooms(channel);
    c.ticket.value = INVITE;
    await c.joinRoom();
    await flush();
    expect(c.joinError.value).toBe("invite.errGeneric");
  });

  it("reports a refused admission without losing the invitation", async () => {
    // The inviter's room was closed. The invitation is still live — the lease
    // was released — so the copy has to invite a retry, not read as final.
    const { channel, stub } = makeChannel();
    (stub.joinByInvite as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const c = useP2pRooms(channel);
    c.ticket.value = INVITE;
    await c.joinRoom();
    await flush();
    expect(c.joinError.value).toBe("invite.errAdmitFailed");
  });

  it("does not redeem an empty field", async () => {
    const { channel } = makeChannel();
    const c = useP2pRooms(channel);
    c.ticket.value = "   ";
    await c.joinRoom();
    await flush();
    expect(invokeMock.mock.calls.some((x) => x[0] === "invite_peek")).toBe(false);
  });
});
