import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref, nextTick } from "vue";
import type { ChatChannel } from "rakotis";

// Tor-connect UX matrix for the create/join modals (useP2pRooms controller):
// the connect window waits N seconds (N = the user setting, Settings tab) for the
// transport, then keeps the window one more N-second interval so the outcome can
// be read (total lifetime ≈ 2×N), with a visible countdown. A hung Tor join is
// aborted (cancelJoin frees the onion lock); iroh joins are never aborted.

const { mockGetConnectTimeoutSecs } = vi.hoisted(() => ({
  mockGetConnectTimeoutSecs: vi.fn(async () => 5),
}));

vi.mock("rakotis", () => ({
  // Mirror of useChatChannel.isTorTicket (base32 first byte == 0x54). Duplicated
  // here because mocking "rakotis" replaces the whole module.
  isTorTicket: (ticket: string) => {
    const B32 = "abcdefghijklmnopqrstuvwxyz234567";
    const s = ticket.trim().toLowerCase();
    if (s.length < 2) return false;
    const a = B32.indexOf(s[0]);
    const b = B32.indexOf(s[1]);
    if (a < 0 || b < 0) return false;
    return (((a << 3) | (b >> 2)) & 0xff) === 0x54;
  },
  getConnectTimeoutSecs: mockGetConnectTimeoutSecs,
}));

import { useP2pRooms } from "../../src/components/chat/useP2pRooms";

const TOR_TICKET = "kqaa"; // base32(0x54, …)
const IROH_TICKET = "aaaqeay"; // tagless

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
    // The controller reads the created room's DHT code off the remembered list.
    p2pRooms: ref<Array<{ room: string; name: string; ticket: string; code?: string }>>([]),
    createRoom: vi.fn<(name: string) => Promise<string | null>>(),
    joinByTicket: vi.fn<(t: string) => Promise<void>>(),
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
  mockGetConnectTimeoutSecs.mockImplementation(async () => 5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Tor join — connect window (N) + read window (N)", () => {
  it("hung Tor join: times out at N with the timeout message, aborts the onion dial, then auto-closes after N more", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    ch.joinByTicket.mockReturnValue(new Promise(() => {})); // hangs forever

    ctrl.openJoin();
    ctrl.ticket.value = TOR_TICKET;
    void ctrl.joinRoom();
    await flush();

    expect(ctrl.joinStarted.value).toBe(true);
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
    const join = deferred<void>();
    ch.joinByTicket.mockReturnValue(join.promise);

    ctrl.openJoin();
    ctrl.ticket.value = TOR_TICKET;
    void ctrl.joinRoom();
    await flush();

    // Transport connects at t=2s — inside the window, so no error is shown.
    await vi.advanceTimersByTimeAsync(2_000);
    join.resolve();
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

  it("transport connects but MLS never establishes → still times out at N and aborts (the field-bug shape)", async () => {
    // This is exactly how the dropped-startMls bug presented: "Connected" but
    // "Not encrypted" forever. The connect window covers the key exchange too.
    const ch = makeChannel();
    const ctrl = makeController(ch);
    ch.joinByTicket.mockResolvedValue(undefined); // transport joins instantly

    ctrl.openJoin();
    ctrl.ticket.value = TOR_TICKET;
    void ctrl.joinRoom();
    await flush();
    expect(ctrl.joinError.value).toBe("");

    // isEncrypted never flips → at N the join is declared failed.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctrl.joinError.value).toBe("chat.joinTimeout");
    expect(ch.cancelJoin).toHaveBeenCalledTimes(1);

    // …and the read window still follows before auto-close.
    await flush();
    expect(ctrl.autoCloseSecs.value).toBe(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctrl.joinOpen.value).toBe(false);
  });

  it("fast transport error surfaces immediately and still gets the read window", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    ch.joinByTicket.mockImplementation(async () => {
      ch.error.value = "invalid tor ticket";
    });

    ctrl.openJoin();
    ctrl.ticket.value = TOR_TICKET;
    void ctrl.joinRoom();
    await flush();

    expect(ctrl.joinError.value).toBe("invalid tor ticket");
    expect(ch.cancelJoin).not.toHaveBeenCalled(); // it failed, nothing to abort
    await flush();
    expect(ctrl.autoCloseSecs.value).toBe(5); // read window armed for the error too
  });

  it("user cancel mid-join aborts the dial and returns to the form without a countdown", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    ch.joinByTicket.mockReturnValue(new Promise(() => {}));

    ctrl.openJoin();
    ctrl.ticket.value = TOR_TICKET;
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
    ch.joinByTicket.mockReturnValue(new Promise(() => {}));

    ctrl.openJoin();
    ctrl.ticket.value = TOR_TICKET;
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

  it("iroh join times out with the same message but never aborts (cancel is Tor-only)", async () => {
    const ch = makeChannel();
    const ctrl = makeController(ch);
    ch.joinByTicket.mockReturnValue(new Promise(() => {}));

    ctrl.openJoin();
    ctrl.ticket.value = IROH_TICKET;
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
    ch.joinByTicket.mockReturnValue(new Promise(() => {}));

    ctrl.openJoin();
    ctrl.ticket.value = TOR_TICKET;
    void ctrl.joinRoom();
    await flush();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ctrl.joinError.value).toBe(""); // 5 s default would have fired
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctrl.joinError.value).toBe("chat.joinTimeout");
  });
});

describe("Tor create — the same timeout governs the launch window", () => {
  it("hung onion launch: shows the timeout error at N; a late success still shows the ticket", async () => {
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
    create.resolve("ticket-xyz");
    await flush();
    expect(ctrl.createdTicket.value).toBe("ticket-xyz");
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
    create.resolve("ticket-abc");
    await flush();
    expect(ctrl.createdTicket.value).toBe("ticket-abc");
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
