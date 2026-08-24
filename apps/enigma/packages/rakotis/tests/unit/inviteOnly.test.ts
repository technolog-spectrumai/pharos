// Invite-only rooms: the flag, how it travels, and what it refuses.
//
// A room marked invite-only refuses gossip `mls_key_package` frames outright, so
// the only way in is a redeemed invitation — which never rides gossip at all.
// That narrows §9.7, the app's oldest access-control gap.
//
// It does NOT close it cryptographically. Every member enforces independently,
// so the guarantee is only as strong as the weakest member's client: one member
// on a modified or older build still auto-admits. These tests pin the behaviour
// of THIS client, which is all a client can promise.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { messageHandlers, mockTransport } = vi.hoisted(() => {
  const messageHandlers: Array<(room: string, data: unknown) => void> = [];
  const mockTransport = {
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    joinRoomByNode: vi.fn(),
    cancelJoin: vi.fn(),
    leaveRoom: vi.fn(),
    forgetTorOnion: vi.fn(),
    setCaptain: vi.fn(),
    nodeInfo: vi.fn(async () => null),
    send: vi.fn(),
    onMessage: vi.fn((h: (room: string, data: unknown) => void) => {
      messageHandlers.push(h);
      return () => {};
    }),
    onStatus: vi.fn(() => () => {}),
    lastStatus: vi.fn((): string | undefined => undefined),
  };
  return { messageHandlers, mockTransport };
});

vi.mock("../../src/chatTransport", () => ({ chatTransport: mockTransport }));

const { crypto } = vi.hoisted(() => ({
  crypto: {
    clearState: vi.fn(async () => {}),
    initSession: vi.fn(async () => {}),
    keyPackage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    members: vi.fn(async () => []),
    addMember: vi.fn(async () => ({ commit: new Uint8Array([9]), welcome: new Uint8Array([8]) })),
    removeMember: vi.fn(async () => null),
    joinFromWelcome: vi.fn(async () => true),
    processMessage: vi.fn(async () => null),
    adoptSession: vi.fn(async () => true),
  },
}));

vi.mock("../../src/crypto", () => ({
  cryptoService: crypto,
  bytesToBase64: (b: Uint8Array) => btoa(String.fromCharCode(...b)),
  base64ToBytes: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}));

vi.mock("../../src/services/appStorage", () => ({
  getRuntimeConfig: vi.fn(async () => ({ profile: "t", identity: "me-device", profile_state_path: "" })),
  getChatHistoryCapMsgs: vi.fn(async () => 500),
}));

vi.mock("../../src/services/localDb", () => ({
  kvGet: vi.fn(async () => null),
  kvPut: vi.fn(async () => {}),
  kvDelete: vi.fn(async () => {}),
  kvClearNamespace: vi.fn(async () => {}),
}));

import { useChatChannel } from "../../src/useChatChannel";

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Deliver a gossip frame as if it arrived on the open room's topic. */
async function deliver(data: Record<string, unknown>) {
  for (const h of messageHandlers) h("room-1", data);
  await flush();
}

const STRANGER_KP = {
  type: "mls_key_package",
  key_package: "AQID",
  package: "AQID",
  device_id: "zz-stranger",
  user: "stranger",
};

/** A channel sitting in an open, MLS-ready room. `me-device` sorts before
 *  `zz-stranger`, so this client is the one that would do the adding. */
async function readyChannel(opts: Parameters<typeof useChatChannel>[0] = {}) {
  mockTransport.createRoom.mockResolvedValue({ room: "room-1", name: "Room One", ticket: "t" });
  const ch = useChatChannel(opts);
  ch.mlsIdentity.value = "me-device";
  await ch.createRoom("Room One");
  await flush();
  ch.mlsStatus.value = "ready";
  return ch;
}

beforeEach(() => {
  vi.clearAllMocks();
  messageHandlers.length = 0;
  mockTransport.lastStatus.mockReturnValue(undefined);
});

// ── the flag travels on room_meta ───────────────────────────────────────────

describe("the invite-only flag", () => {
  it("starts off", async () => {
    const ch = await readyChannel();
    expect(ch.inviteOnly.value).toBe(false);
  });

  it("is set by the captain and broadcast in the meta snapshot", async () => {
    const ch = await readyChannel();
    ch.captainId.value = "me-device"; // we are the captain
    expect(await ch.setInviteOnly(true)).toBe(true);
    expect(ch.inviteOnly.value).toBe(true);
    // It rides the existing captain-authored snapshot, not a new message type.
    expect(crypto.addMember).not.toHaveBeenCalled();
  });

  it("reports whether the flag actually moved, so a credit is only paid once", async () => {
    const ch = await readyChannel();
    ch.captainId.value = "me-device";
    expect(await ch.setInviteOnly(true)).toBe(true);
    expect(await ch.setInviteOnly(true)).toBe(false); // already closed
    expect(await ch.setInviteOnly(false)).toBe(true);
  });

  it("cannot be set by a non-captain", async () => {
    const ch = await readyChannel();
    ch.captainId.value = "someone-else";
    expect(await ch.setInviteOnly(true)).toBe(false);
    expect(ch.inviteOnly.value).toBe(false);
  });
});

// ── enforcement ─────────────────────────────────────────────────────────────

describe("enforcement", () => {
  it("admits a gossip key package while the room is open", async () => {
    // The baseline, so the refusal below means something.
    const ch = await readyChannel();
    ch.captainId.value = "me-device";
    await deliver(STRANGER_KP);
    expect(crypto.addMember).toHaveBeenCalled();
  });

  it("refuses a gossip key package while invite-only", async () => {
    const ch = await readyChannel();
    ch.captainId.value = "me-device";
    await ch.setInviteOnly(true);
    mockTransport.send.mockClear();
    await deliver(STRANGER_KP);
    expect(crypto.addMember).not.toHaveBeenCalled();
  });

  it("does not answer a refused stranger with our own key package", async () => {
    // The half-closed door this guard's PLACEMENT exists to prevent: a check
    // below the admin split would close the branch that adds and leave the one
    // that defers still handing our key package to a stranger.
    const ch = await readyChannel();
    ch.mlsIdentity.value = "zz-me"; // sorts AFTER the stranger → the defer branch
    ch.captainId.value = "zz-me";
    await ch.setInviteOnly(true);
    mockTransport.send.mockClear();
    await deliver({ ...STRANGER_KP, device_id: "aa-stranger" });
    const sent = mockTransport.send.mock.calls.filter(
      ([, p]) => (p as { type?: string }).type === "mls_key_package",
    );
    expect(sent).toHaveLength(0);
    expect(crypto.addMember).not.toHaveBeenCalled();
  });

  it("still admits through the invitation path in a closed room", async () => {
    // THE test. Invitations do not ride gossip — `admitInvited` calls addMember
    // directly — which is exactly why closing the room does not close them.
    const ch = await readyChannel();
    ch.captainId.value = "me-device";
    await ch.setInviteOnly(true);
    const grant = await ch.admitInvited("room-1", "AQID");
    expect(grant).not.toBeNull();
    expect(crypto.addMember).toHaveBeenCalled();
  });

  it("leaves the ban guard independent of the invite-only guard", async () => {
    // Two separate reasons to refuse; neither may quietly stand in for the other.
    const ch = await readyChannel();
    ch.captainId.value = "me-device";
    expect(ch.inviteOnly.value).toBe(false);
    await ch.kickMember("zz-stranger").catch(() => {});
    crypto.addMember.mockClear();
    await deliver(STRANGER_KP);
    expect(crypto.addMember).not.toHaveBeenCalled();
  });

  it("exempts a headless channel, which carries its own admission check", async () => {
    // devlink / peer sync gate on a linkKey proof and have no room meta at all.
    const ch = await readyChannel({ headless: true });
    ch.captainId.value = "me-device";
    ch.inviteOnly.value = true; // even if something set it
    await deliver(STRANGER_KP);
    expect(crypto.addMember).toHaveBeenCalled();
  });
});

// ── applying a snapshot ─────────────────────────────────────────────────────

describe("receiving a meta snapshot", () => {
  // `room_meta` rides the MLS seam, so it arrives as an `mls_app` frame whose
  // plaintext is the snapshot — delivering it as plain gossip would test a path
  // that does not exist.
  const meta = (rev: number, extra: Record<string, unknown> = {}) => ({
    type: "room_meta",
    device_id: "captain",
    rev,
    logo: "",
    rules: "",
    mutes: {},
    bans: [],
    ...extra,
  });

  async function deliverMeta(from: string, inner: Record<string, unknown>) {
    crypto.processMessage.mockResolvedValueOnce(
      new TextEncoder().encode(JSON.stringify(inner)),
    );
    await deliver({ type: "mls_app", ciphertext: "AQ==", device_id: from, user: from });
  }

  it("closes the room when the captain says so", async () => {
    const ch = await readyChannel();
    ch.captainId.value = "captain";
    await deliverMeta("captain", meta(1, { inviteOnly: true }));
    expect(ch.inviteOnly.value).toBe(true);
  });

  it("cannot be reopened by a stale snapshot", async () => {
    // The rev guard matters most here: replaying an old snapshot must not be a
    // way to reopen a room somebody deliberately closed.
    const ch = await readyChannel();
    ch.captainId.value = "captain";
    await deliverMeta("captain", meta(5, { inviteOnly: true }));
    await deliverMeta("captain", meta(2, { inviteOnly: false }));
    expect(ch.inviteOnly.value).toBe(true);
  });

  it("treats a snapshot without the field as open", async () => {
    // What an older peer's snapshot looks like. Absent means open — the flag is
    // additive, so a build that never heard of it cannot close a room by
    // accident, and cannot keep one closed either.
    const ch = await readyChannel();
    ch.captainId.value = "captain";
    await deliverMeta("captain", meta(1, { inviteOnly: true }));
    expect(ch.inviteOnly.value).toBe(true);
    await deliverMeta("captain", meta(2));
    expect(ch.inviteOnly.value).toBe(false);
  });

  it("ignores a snapshot that did not come from the captain at the same revision", async () => {
    const ch = await readyChannel();
    ch.captainId.value = "captain";
    await deliverMeta("captain", meta(9, { inviteOnly: false }));
    // Same rev from a non-captain: only STRICTLY newer is accepted from anyone
    // else, which is the captaincy-handoff rule.
    await deliverMeta("impostor", meta(9, { inviteOnly: true }));
    expect(ch.inviteOnly.value).toBe(false);
  });
});
