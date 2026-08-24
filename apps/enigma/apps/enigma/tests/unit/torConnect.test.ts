import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, nextTick } from "vue";
import type { ChatChannel } from "rakotis";

// Connect-window UX matrix for the create/join modals (useP2pRooms controller):
// the window waits N seconds (N = the user setting, Settings tab) for the join,
// then keeps itself open one more N-second interval so the outcome can be read
// (total lifetime ≈ 2×N), with a visible countdown. A hung Tor redemption is
// aborted (cancelJoin frees the onion lock); an iroh one is never aborted.
//
// The join being timed is now a REDEMPTION — an invitation is the only way in —
// so the thing that hangs is the `invite_peek` / `invite_redeem` invoke rather
// than a transport join. The window's shape is unchanged, which is the point:
// removing tickets was not meant to change how long anyone waits.

const { mockGetConnectTimeoutSecs } = vi.hoisted(() => ({
  mockGetConnectTimeoutSecs: vi.fn(async () => 5),
}));

// PARTIAL mock: the real module underneath, with only the seam this test drives
// replaced. A whole-module replacement used to be enough, but the controller also
// reaches for rakotis' Privacy MANA helpers, and re-stubbing every export a
// dependency happens to use is a standing breakage.
vi.mock("rakotis", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConnectTimeoutSecs: mockGetConnectTimeoutSecs,
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { useP2pRooms } from "../../src/components/chat/useP2pRooms";

/** base32 of [0x4E, …] — an invitation, the only thing the join field takes. */
const INVITE = "jybucrq";

/** Make the redeem hang for ever, after a peek that names the transport. */
function hangingRedeem(tor: boolean) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "invite_peek") return { kind: "general", inviter: "alice", expiresAt: Date.now() + 6e5, tor };
    if (cmd === "invite_redeem") return new Promise(() => {});
    return null;
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function makeChannel() {
  return {
    error: ref<string | null>(null),
    isEncrypted: ref(false),
    mlsIdentity: ref("me"),
    currentUserName: ref("me"),
    // The controller reads the created room's transport off the remembered list.
    p2pRooms: ref<Array<{ room: string; name: string; tor?: boolean }>>([]),
    createRoom: vi.fn<(name: string) => Promise<string | null>>(),
    joinByInvite: vi.fn(async () => true),
    cancelJoin: vi.fn(async () => {}),
    deleteRoom: vi.fn(async () => {}),
  };
}
type Channel = ReturnType<typeof makeChannel>;

function makeController(channel: Channel) {
  return useP2pRooms(channel as unknown as ChatChannel);
}

/** Flush pending microtasks + Vue watchers under fake timers. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  mockGetConnectTimeoutSecs.mockImplementation(async () => 5);
  hangingRedeem(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Tor join — connect window (N) + read window (N)", () => {
  it("hung Tor join: times out at N with the timeout message, aborts the onion dial, then auto-closes after N more", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    hangingRedeem(true); // the redeem invoke never settles

    ctrl.openJoin();
    ctrl.ticket.value = INVITE;
    void ctrl.joinRoom();
    await flush();

    expect(ctrl.joinStarted.value).toBe(true);
    // The peek said Tor, so Cancel is on offer and the timeout will abort.
    expect(ctrl.joiningTor.value).toBe(true);

    // Just before N: still spinning, no error, not aborted.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(ctrl.joinError.value).toBe("");
    expect(ch.cancelJoin).not.toHaveBeenCalled();

    // At N: timeout error + the hung Tor dial is aborted (frees the onion lock).
    await vi.advanceTimersByTimeAsync(200);
    expect(ctrl.joinError.value).toBe("chat.joinTimeout");
    expect(ch.cancelJoin).toHaveBeenCalledTimes(1);

    // The read window arms with the same N and counts down.
    await flush();
    expect(ctrl.autoCloseSecs.value).toBe(5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctrl.autoCloseSecs.value).toBe(3);
    expect(ctrl.joinOpen.value).toBe(true); // still readable

    // At 2×N total the window closes itself.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ctrl.joinOpen.value).toBe(false);
    expect(ctrl.autoCloseSecs.value).toBe(null);
  });

  it("successful Tor join: encrypted inside the window → no timeout; the window stays N seconds (countdown) then closes", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    const join = deferred<unknown>();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "invite_peek") return { kind: "general", inviter: "a", expiresAt: Date.now() + 6e5, tor: true };
      if (cmd === "invite_redeem") return join.promise;
      return null;
    });

    ctrl.openJoin();
    ctrl.ticket.value = INVITE;
    void ctrl.joinRoom();
    await flush();

    // The inviter admits us at t=2s — inside the window, so no error is shown.
    await vi.advanceTimersByTimeAsync(2_000);
    join.resolve({ welcome: "V0VMQ09NRQ==", roomName: "R", peers: [], onion: "x.onion" });
    await flush();
    expect(ctrl.joinError.value).toBe("");
    expect(ch.cancelJoin).not.toHaveBeenCalled();

    // MLS establishes at t=3s (still inside the window) → the connect timer is
    // disarmed and the read window arms; the modal closes N seconds later.
    await vi.advanceTimersByTimeAsync(1_000);
    ch.isEncrypted.value = true;
    await flush();
    expect(ctrl.autoCloseSecs.value).toBe(5);

    // Advancing past the original N deadline must NOT produce a timeout error.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ctrl.joinError.value).toBe("");

    await vi.advanceTimersByTimeAsync(2_500);
    expect(ctrl.joinOpen.value).toBe(false);
  });

  it("admitted onto the transport but never into the group → a named error, not a hang", async () => {
    // The successor to the old field bug ("Connected" but "Not encrypted" for
    // ever, only a manual reset recovering). A redemption reports admission
    // directly: the inviter either adds us to the MLS group or does not, so this
    // now surfaces as a specific refusal inside the window instead of an
    // open-ended wait. The read window still arms, so the message can be read.
    const ch = makeChannel();
    const ctrl = makeController(ch);
    ch.joinByInvite.mockResolvedValue(false); // their room was not open
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "invite_peek") return { kind: "general", inviter: "a", expiresAt: Date.now() + 6e5, tor: true };
      if (cmd === "invite_redeem") return { welcome: "V0VMQ09NRQ==", roomName: "R", peers: [], onion: "x.onion" };
      return null;
    });

    ctrl.openJoin();
    ctrl.ticket.value = INVITE;
    void ctrl.joinRoom();
    await flush();

    expect(ctrl.joinError.value).toBe("invite.errAdmitFailed");
    // Nothing hung, so nothing to abort — and no timeout should follow either.
    expect(ch.cancelJoin).not.toHaveBeenCalled();
    await flush();
    expect(ctrl.autoCloseSecs.value).toBe(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctrl.joinOpen.value).toBe(false);
    expect(ctrl.joinError.value).toBe("invite.errAdmitFailed"); // never overwritten
  });

  it("fast transport error surfaces immediately and still gets the read window", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "invite_peek") throw new Error("INVITE_EXPIRED");
      return null;
    });

    ctrl.openJoin();
    ctrl.ticket.value = INVITE;
    void ctrl.joinRoom();
    await flush();

    expect(ctrl.joinError.value).toBe("invite.errExpired");
    expect(ch.cancelJoin).not.toHaveBeenCalled(); // it failed, nothing to abort
    await flush();
    expect(ctrl.autoCloseSecs.value).toBe(5); // read window armed for the error too
  });

  it("user cancel mid-join aborts the dial and returns to the form without a countdown", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    hangingRedeem(true);

    ctrl.openJoin();
    ctrl.ticket.value = INVITE;
    void ctrl.joinRoom();
    await flush();

    await vi.advanceTimersByTimeAsync(1_000);
    await ctrl.cancelJoin();
    await flush();

    expect(ch.cancelJoin).toHaveBeenCalledTimes(1);
    expect(ctrl.joinStarted.value).toBe(false); // back to the paste/scan form
    expect(ctrl.joinOpen.value).toBe(true);
    expect(ctrl.autoCloseSecs.value).toBe(null);

    // The stale connect timer must not fire a timeout error later.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctrl.joinError.value).toBe("");
  });

  it("Retry after a timeout clears the read-window countdown", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    hangingRedeem(true);

    ctrl.openJoin();
    ctrl.ticket.value = INVITE;
    void ctrl.joinRoom();
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(ctrl.autoCloseSecs.value).toBe(5);

    ctrl.resetJoin(); // the modal's Retry button
    await flush();
    expect(ctrl.autoCloseSecs.value).toBe(null);
    expect(ctrl.joinError.value).toBe("");
    expect(ctrl.joinOpen.value).toBe(true);
  });

  it("iroh redemption times out with the same message but never aborts (cancel is Tor-only)", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    hangingRedeem(false); // the peek says iroh — nothing holding an onion lock

    ctrl.openJoin();
    ctrl.ticket.value = INVITE;
    void ctrl.joinRoom();
    await flush();
    expect(ctrl.joiningTor.value).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctrl.joinError.value).toBe("chat.joinTimeout");
    expect(ch.cancelJoin).not.toHaveBeenCalled();
  });

  it("honours the user-configured timeout from Settings (7 s → no error at 5 s)", async () => {
    mockGetConnectTimeoutSecs.mockImplementation(async () => 7);
    const ch = makeChannel();
    const ctrl = makeController(ch);
    hangingRedeem(true);

    ctrl.openJoin();
    ctrl.ticket.value = INVITE;
    void ctrl.joinRoom();
    await flush();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctrl.joinError.value).toBe(""); // 5 s default would have fired
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctrl.joinError.value).toBe("chat.joinTimeout");
  });
});

describe("Tor create — the same timeout governs the launch window", () => {
  it("hung onion launch: shows the timeout error at N; a late success still opens the room", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    const create = deferred<string | null>();
    ch.createRoom.mockReturnValue(create.promise);

    ctrl.openCreate();
    ctrl.name.value = "aaaa";
    void ctrl.createRoom();
    await flush();
    expect(ctrl.createBusy.value).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctrl.createBusy.value).toBe(false); // spinner replaced by the error
    expect(ctrl.createError.value).toBe("chat.joinTimeout");

    // The invoke was never aborted — when the onion finally publishes, success wins.
    ch.p2pRooms.value = [{ room: "room-xyz", name: "aaaa", tor: true }];
    create.resolve("room-xyz");
    await flush();
    expect(ctrl.createdRoom.value?.slug).toBe("room-xyz");
    expect(ctrl.createError.value).toBe("");
  });

  it("create finishing inside the window never shows a timeout", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    const create = deferred<string | null>();
    ch.createRoom.mockReturnValue(create.promise);

    ctrl.openCreate();
    ctrl.name.value = "aaaa";
    void ctrl.createRoom();
    await flush();

    await vi.advanceTimersByTimeAsync(3_000);
    ch.p2pRooms.value = [{ room: "room-abc", name: "aaaa" }];
    create.resolve("room-abc");
    await flush();
    expect(ctrl.createdRoom.value?.slug).toBe("room-abc");
    expect(ctrl.createError.value).toBe("");

    // Past N — the cleared timer must stay quiet.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctrl.createError.value).toBe("");
  });

  it("create failure inside the window shows the transport error, not the timeout", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    ch.createRoom.mockImplementation(async () => {
      ch.error.value = "tor: local resource (port, lockfile, etc.) already in use";
      return null;
    });

    ctrl.openCreate();
    ctrl.name.value = "aaaa";
    void ctrl.createRoom();
    await flush();

    expect(ctrl.createError.value).toBe("tor: local resource (port, lockfile, etc.) already in use");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctrl.createError.value).toBe("tor: local resource (port, lockfile, etc.) already in use");
  });
});
