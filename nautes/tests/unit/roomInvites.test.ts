import { describe, it, expect, vi, afterEach } from "vitest";
import { ref } from "vue";
import type { ChatChannel } from "rakotis";

// Direct room invites (useRoomInvites): the offer/accept handshake needs the
// Tauri runtime — in a plain browser it must degrade to a clear error, never a
// hang or a throw. The join-on-accept prefers the DHT code only when our own
// toggle is on (that's what makes the invitee a secret-holder).

vi.mock("rakotis", () => ({
  getDhtDiscovery: vi.fn(async () => false),
}));

import { useRoomInvites } from "../../src/components/contacts/useRoomInvites";

function makeChannel() {
  return {
    p2pRooms: ref([]),
    openP2pRoom: vi.fn(async () => {}),
    joinByTicket: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useRoomInvites — browser (no Tauri runtime)", () => {
  it("reports direct invites as unavailable instead of hanging", async () => {
    const ch = makeChannel();
    const invites = useRoomInvites(ch as unknown as ChatChannel);
    expect(invites.available).toBe(false);

    await invites.sendInvite("a".repeat(64), {
      room: "r1",
      name: "general",
      ticket: "t",
    } as never);
    expect(invites.outgoing.value).toBe("error");
    expect(invites.outgoingError.value).toBe("contacts.inviteUnavailable");
    // The room must not be opened when the invite can't be delivered at all.
    expect(ch.openP2pRoom).not.toHaveBeenCalled();

    invites.resetOutgoing();
    expect(invites.outgoing.value).toBe("idle");
    expect(invites.outgoingError.value).toBe("");
  });

  it("accept/decline without a pending invite are safe no-ops", async () => {
    const ch = makeChannel();
    const invites = useRoomInvites(ch as unknown as ChatChannel);
    await invites.accept();
    await invites.decline();
    expect(ch.joinByTicket).not.toHaveBeenCalled();
    expect(invites.incoming.value).toBeNull();
  });
});
