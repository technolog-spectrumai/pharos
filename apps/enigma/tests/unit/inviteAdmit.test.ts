// The inviter's half of a redemption.
//
// Rust does every check and takes the invitation's lease, then asks the frontend
// to run the MLS add — because the commit has to reach the room's existing
// members over that room's transport, which only the channel can do. These tests
// pin the contract between those two halves, and in particular the failure path:
// a refusal must be FAST and explicit, so Rust releases the lease instead of
// burning the invitation on a timeout.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatChannel } from "rakotis";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const listeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(name, cb);
    return () => listeners.delete(name);
  }),
}));

import { useInviteAdmit } from "../../src/components/chat/useInviteAdmit";

const flush = () => new Promise((r) => setTimeout(r, 0));

const REQUEST = {
  requestId: "req-1",
  inviteId: "aabb",
  roomSlug: "room-1",
  roomName: "Room One",
  keyPackage: "a2V5",
  redeemer: "bob-node",
  redeemerName: "bob",
};

function makeChannel(admit: ChatChannel["admitInvited"]) {
  return { admitInvited: vi.fn(admit) } as unknown as ChatChannel & {
    admitInvited: ReturnType<typeof vi.fn>;
  };
}

/** The `invite_admit` answers sent back to Rust, in order. */
const answers = () =>
  invokeMock.mock.calls.filter((c) => c[0] === "invite_admit").map((c) => c[1]);

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  invokeMock.mockResolvedValue(true);
});

describe("useInviteAdmit", () => {
  it("admits the redeemer and answers with the Welcome and coordinates", async () => {
    const channel = makeChannel(async () => ({
      welcome: "V0VMQ09NRQ==",
      roomName: "Room One",
      peers: ["alice-node"],
    }));
    const ctl = useInviteAdmit(channel);
    await flush();

    listeners.get("invite://admit")?.({ payload: REQUEST });
    await flush();

    expect(channel.admitInvited).toHaveBeenCalledWith("room-1", "a2V5");
    const [{ requestId, answer }] = answers();
    expect(requestId).toBe("req-1");
    expect(answer.ok).toBe(true);
    expect(answer.welcome).toBe("V0VMQ09NRQ==");
    expect(answer.roomName).toBe("Room One");
    expect(answer.peers).toEqual(["alice-node"]);
    expect(ctl.lastAdmitted.value?.name).toBe("bob");
  });

  it("answers with every member's onion and nothing more", async () => {
    // The newcomer links to all members; the answer carries exactly the grant's
    // fields — there is no separate onion/transport coordinate any more.
    const channel = makeChannel(async () => ({
      welcome: "V0VMQ09NRQ==",
      roomName: "Room One",
      peers: ["me.onion", "carol.onion"],
    }));
    useInviteAdmit(channel);
    await flush();

    listeners.get("invite://admit")?.({ payload: REQUEST });
    await flush();

    const [{ answer }] = answers();
    expect(answer).toEqual({
      ok: true,
      welcome: "V0VMQ09NRQ==",
      roomName: "Room One",
      peers: ["me.onion", "carol.onion"],
    });
  });

  it("refuses immediately when the room is not open, so the lease comes back", async () => {
    // THE failure that matters. A redemption completes only while the inviter
    // has that room open; answering at once releases the invitation instead of
    // letting it be burned by a timeout.
    const channel = makeChannel(async () => null);
    const ctl = useInviteAdmit(channel);
    await flush();

    listeners.get("invite://admit")?.({ payload: REQUEST });
    await flush();

    const [{ answer }] = answers();
    expect(answer.ok).toBe(false);
    expect(answers()).toHaveLength(1);
    expect(ctl.lastRefusal.value).toBe("invite.admitRoomClosed");
    expect(ctl.lastAdmitted.value).toBeNull();
  });

  it("never answers ok for a room the channel would not admit to", async () => {
    // A mismatched slug reaches `admitInvited`, which returns null — the guard
    // lives in the channel, where the room state actually is.
    const channel = makeChannel(async (slug: string) =>
      slug === "room-1" ? { welcome: "w", roomName: "R", peers: [] } : null,
    );
    useInviteAdmit(channel);
    await flush();

    listeners.get("invite://admit")?.({ payload: { ...REQUEST, roomSlug: "another-room" } });
    await flush();

    expect(answers()[0].answer.ok).toBe(false);
  });

  it("keeps the failure reason on this side", async () => {
    // Why an admission failed can name a room or a group state; the redeemer
    // gets a bare code from Rust. The detail is for the inviter's log only.
    const channel = makeChannel(async () => null);
    useInviteAdmit(channel);
    await flush();

    listeners.get("invite://admit")?.({ payload: REQUEST });
    await flush();

    const [{ answer }] = answers();
    expect(typeof answer.error).toBe("string");
    expect(answer.error).not.toContain("room-1");
    expect(answer.error).not.toContain("Room One");
  });

  it("handles a second redemption after a failed one", async () => {
    // A refused attempt must not wedge the listener: the invitation is still
    // live, and the holder is expected to retry.
    let open = false;
    const channel = makeChannel(async () =>
      open ? { welcome: "w", roomName: "R", peers: [] } : null,
    );
    useInviteAdmit(channel);
    await flush();

    listeners.get("invite://admit")?.({ payload: REQUEST });
    await flush();
    open = true;
    listeners.get("invite://admit")?.({ payload: { ...REQUEST, requestId: "req-2" } });
    await flush();

    const all = answers();
    expect(all).toHaveLength(2);
    expect(all[0].answer.ok).toBe(false);
    expect(all[1].answer.ok).toBe(true);
    expect(all[1].requestId).toBe("req-2");
  });

  it("survives an invite_admit that rejects", async () => {
    // The answer is best-effort: Rust times the request out on its own, and a
    // throw here would take the listener with it.
    invokeMock.mockRejectedValue(new Error("ipc gone"));
    const channel = makeChannel(async () => ({
      welcome: "w",
      roomName: "R",
      peers: [],
    }));
    useInviteAdmit(channel);
    await flush();

    listeners.get("invite://admit")?.({ payload: REQUEST });
    await expect(flush()).resolves.toBeUndefined();
  });
});
