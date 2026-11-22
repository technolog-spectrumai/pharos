import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ref } from "vue";
import { useFileShare } from "../../src/components/chat/useFileShare";
import { hpConfirm, refreshHp, resolveHpConfirm, stopHp } from "../../src/components/hp/useHp";
import type { ChatChannel } from "rakotis";

// useFileShare orchestrates the offer/accept signaling over the channel's MLS
// `onSync`/`sendSync` seam and drives the `file_*` Tauri commands. We stub the
// channel and the tauri modules; the streaming itself is the Rust backend's job
// (covered by its own tests) — here we verify the signaling state machine.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// listen() registrations, keyed by event name, so tests can fire backend events.
const backendListeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    backendListeners.set(name, cb);
    return () => backendListeners.delete(name);
  }),
}));

const openMock = vi.fn();
const saveMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
  save: (...args: unknown[]) => saveMock(...args),
}));

const OFFER_META = {
  offer_id: "offer-1",
  addr: "b32addr",
  name: "report.pdf",
  size: 4096,
  mime: "application/pdf",
};

function makeChannel() {
  let handler: ((type: string, payload: Record<string, unknown>, sender: string) => void) | null = null;
  const channel = {
    onSync: vi.fn((fn: typeof handler) => {
      handler = fn;
      return () => {
        handler = null;
      };
    }),
    sendSync: vi.fn(async () => {}),
    currentUserName: ref("alice"),
    mlsIdentity: ref("alice-device"),
  };
  /** Deliver an inner MLS message as the channel's sync router would. */
  const emitSync = (type: string, payload: Record<string, unknown>, sender = "bob") => {
    handler?.(type, payload, sender);
  };
  return { channel: channel as unknown as ChatChannel, stub: channel, emitSync };
}

/** Fire a backend `file://*` event on the registered listener. */
function fireBackend(name: string, payload: unknown) {
  backendListeners.get(name)?.({ payload });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  backendListeners.clear();
  (window as any).__TAURI_INTERNALS__ = {};
  invokeMock.mockResolvedValue(undefined);
  openMock.mockResolvedValue("/home/alice/report.pdf");
  saveMock.mockResolvedValue("/home/bob/report.pdf");
});

describe("useFileShare — host side (offer)", () => {
  it("offer() registers the file and relays an addressed file_offer over the seam", async () => {
    const { channel, stub } = makeChannel();
    const share = useFileShare(channel);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "file_offer_create" ? OFFER_META : undefined,
    );

    await share.offer({ id: "bob-device", name: "bob" });

    expect(invokeMock).toHaveBeenCalledWith("file_offer_create", { path: "/home/alice/report.pdf" });
    expect(stub.sendSync).toHaveBeenCalledWith("file_offer", {
      offerId: "offer-1",
      target: "bob-device",
      addr: "b32addr",
      name: "report.pdf",
      size: 4096,
      mime: "application/pdf",
      fromName: "alice",
    });
    expect(share.state.value).toBe("offering");
    expect(share.fileName.value).toBe("report.pdf");
    expect(share.direction.value).toBe("send");
  });

  it("offer() without a target errors instead of broadcasting", async () => {
    const { channel, stub } = makeChannel();
    const share = useFileShare(channel);

    await share.offer({ id: "", name: "" });

    expect(share.state.value).toBe("error");
    expect(stub.sendSync).not.toHaveBeenCalled();
  });

  it("a cancelled file picker leaves the offer flow silently", async () => {
    const { channel, stub } = makeChannel();
    const share = useFileShare(channel);
    openMock.mockResolvedValue(null);

    await share.offer({ id: "bob-device", name: "bob" });

    expect(share.state.value).toBe("idle");
    expect(stub.sendSync).not.toHaveBeenCalled();
  });

  it("peer decline flips to declined and forgets the offer", async () => {
    const { channel, emitSync } = makeChannel();
    const share = useFileShare(channel);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "file_offer_create" ? OFFER_META : undefined,
    );
    await share.offer({ id: "bob-device", name: "bob" });

    emitSync("file_decline", { offerId: "offer-1" });
    await flush();

    expect(share.state.value).toBe("declined");
    expect(invokeMock).toHaveBeenCalledWith("file_offer_cancel", { offerId: "offer-1" });
  });

  it("file://done completes the transfer and cleans up the hosted offer", async () => {
    const { channel } = makeChannel();
    const share = useFileShare(channel);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "file_offer_create" ? OFFER_META : undefined,
    );
    await share.offer({ id: "bob-device", name: "bob" });

    fireBackend("file://progress", { offerId: "offer-1", dir: "send", transferred: 2048, total: 4096 });
    expect(share.state.value).toBe("transferring");
    expect(share.progress.value).toBeCloseTo(0.5);

    fireBackend("file://done", { offerId: "offer-1", dir: "send" });
    await flush();
    expect(share.state.value).toBe("done");
    expect(share.progress.value).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith("file_offer_cancel", { offerId: "offer-1" });
  });

  it("ignores backend events for other transfers", async () => {
    const { channel } = makeChannel();
    const share = useFileShare(channel);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "file_offer_create" ? OFFER_META : undefined,
    );
    await share.offer({ id: "bob-device", name: "bob" });

    fireBackend("file://error", { offerId: "someone-elses", message: "boom" });
    expect(share.state.value).toBe("offering");
    expect(share.error.value).toBeNull();
  });
});

describe("useFileShare — recipient side", () => {
  const incomingOffer = {
    offerId: "offer-9",
    target: "alice-device",
    addr: "peer-addr",
    name: "photo.png",
    size: 1000,
    mime: "image/png",
    fromName: "bob",
  };

  it("an offer addressed to us becomes an incoming prompt", async () => {
    const { channel, emitSync } = makeChannel();
    const share = useFileShare(channel);

    emitSync("file_offer", incomingOffer);
    await flush();

    expect(share.state.value).toBe("incoming");
    expect(share.peerName.value).toBe("bob");
    expect(share.fileName.value).toBe("photo.png");
    expect(share.direction.value).toBe("recv");
  });

  it("an offer addressed to another member is ignored (rooms broadcast)", async () => {
    const { channel, emitSync } = makeChannel();
    const share = useFileShare(channel);

    emitSync("file_offer", { ...incomingOffer, target: "carol-device" });
    await flush();

    expect(share.state.value).toBe("idle");
  });

  it("accept() confirms over the seam and starts the download", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const share = useFileShare(channel);
    emitSync("file_offer", incomingOffer);
    await flush();

    await share.accept();

    expect(saveMock).toHaveBeenCalledWith({ defaultPath: "photo.png" });
    expect(stub.sendSync).toHaveBeenCalledWith("file_accept", { offerId: "offer-9" });
    expect(invokeMock).toHaveBeenCalledWith("file_download", {
      addr: "peer-addr",
      offerId: "offer-9",
      dest: "/home/bob/report.pdf",
    });
    expect(share.state.value).toBe("transferring");
  });

  it("decline() refuses over the seam and resets", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const share = useFileShare(channel);
    emitSync("file_offer", incomingOffer);
    await flush();

    await share.decline();

    expect(stub.sendSync).toHaveBeenCalledWith("file_decline", { offerId: "offer-9" });
    expect(share.state.value).toBe("idle");
  });

  it("with nothing stored, the build-config default (16 MB) is enforced", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const share = useFileShare(channel);

    emitSync("file_offer", { ...incomingOffer, size: 10 * 1024 * 1024 * 1024 });
    await flush();

    expect(stub.sendSync).toHaveBeenCalledWith("file_decline", { offerId: "offer-9" });
    expect(share.state.value).toBe("error");
    expect(share.error.value).toContain("16 MB");
  });

  it("a stored 0 disables the limit — a huge offer is still shown", async () => {
    const { channel, emitSync } = makeChannel();
    const share = useFileShare(channel);
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "0" : undefined));

    emitSync("file_offer", { ...incomingOffer, size: 10 * 1024 * 1024 * 1024 });
    await flush();

    expect(share.state.value).toBe("incoming");
  });

  it("a busy host ignores a new incoming offer", async () => {
    const { channel, emitSync } = makeChannel();
    const share = useFileShare(channel);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "file_offer_create" ? OFFER_META : undefined,
    );
    await share.offer({ id: "bob-device", name: "bob" });

    emitSync("file_offer", incomingOffer);
    await flush();

    expect(share.state.value).toBe("offering");
    expect(share.fileName.value).toBe("report.pdf");
  });
});

describe("useFileShare — max file size guard (Settings)", () => {
  // The guard reads Settings via rakotis' getMaxFileSizeMb() → kv_get on the
  // encrypted store, which lands on the same invoke mock ("1" = 1 MB limit).
  const TWO_MB = 2 * 1024 * 1024;

  it("blocks sending a file over the limit and forgets the offer", async () => {
    const { channel, stub } = makeChannel();
    const share = useFileShare(channel);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "file_offer_create"
        ? { ...OFFER_META, size: TWO_MB }
        : cmd === "kv_get"
          ? "1"
          : undefined,
    );

    await share.offer({ id: "bob-device", name: "bob" });
    await flush(); // the cancel is fire-and-forget behind a lazy import

    expect(share.state.value).toBe("error");
    expect(share.error.value).toContain("1 MB");
    expect(stub.sendSync).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("file_offer_cancel", { offerId: "offer-1" });
  });

  it("auto-declines an incoming offer over the limit", async () => {
    const { channel, stub, emitSync } = makeChannel();
    const share = useFileShare(channel);
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "1" : undefined));

    emitSync("file_offer", {
      offerId: "offer-9",
      target: "alice-device",
      addr: "peer-addr",
      name: "movie.mp4",
      size: TWO_MB,
      fromName: "bob",
    });
    await flush();

    expect(stub.sendSync).toHaveBeenCalledWith("file_decline", { offerId: "offer-9" });
    expect(share.state.value).toBe("error");
    expect(share.error.value).toContain("1 MB");
  });

  it("allows a file exactly at the limit", async () => {
    const { channel, stub } = makeChannel();
    const share = useFileShare(channel);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "file_offer_create"
        ? { ...OFFER_META, size: 1024 * 1024 }
        : cmd === "kv_get"
          ? "1"
          : undefined,
    );

    await share.offer({ id: "bob-device", name: "bob" });

    expect(share.state.value).toBe("offering");
    expect(stub.sendSync).toHaveBeenCalledWith("file_offer", expect.objectContaining({ offerId: "offer-1" }));
  });
});

// ── the remaining edges of the state machine ────────────────────────────────
// A transfer is a two-party protocol over a broadcast room, so most of what can
// go wrong is a message that is not for us, arrives late, or arrives while we
// are busy. Each of those must leave the other transfer untouched.

describe("useFileShare — host side, edges", () => {
  // The HP meter is module state; never let a drained one leak into a later test.
  afterEach(() => stopHp());

  function hosting() {
    const ctx = makeChannel();
    const share = useFileShare(ctx.channel);
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "file_offer_create" ? OFFER_META : undefined));
    return { share, ...ctx };
  }

  it("refuses to offer in a plain browser, saying it is desktop-only", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    const { channel, stub } = makeChannel();
    const share = useFileShare(channel);
    await share.offer({ id: "bob-device", name: "bob" });
    expect(share.state.value).toBe("error");
    expect(share.error.value).toBe("File sharing is desktop-only.");
    expect(openMock).not.toHaveBeenCalled();
    expect(stub.sendSync).not.toHaveBeenCalled();
  });

  it("bills the transfer once the offer is on the wire, by the file's size", async () => {
    const { share } = hosting();
    await share.offer({ id: "bob-device", name: "bob" });
    expect(invokeMock).toHaveBeenCalledWith("hp_charge", { actionId: "file.send", bytes: 4096, minutes: null });
  });

  it("withdraws the registered file and sends nothing when the user declines the price", async () => {
    // confirmHp only asks when a meter is already empty; drain it, then say no.
    const { share, stub } = hosting();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "file_offer_create") return OFFER_META;
      if (cmd === "hp_ledger") return [{ ts: Date.now(), kind: "spend", code: "x", hp: -1_000_000, n: 1, bucket: 0 }];
      return undefined;
    });
    await refreshHp();
    const pending = share.offer({ id: "bob-device", name: "bob" });
    for (let i = 0; i < 10 && !hpConfirm.value; i++) await flush();
    expect(hpConfirm.value).not.toBeNull();
    resolveHpConfirm(false);
    await pending;
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("file_offer_cancel", { offerId: "offer-1" });
    expect(stub.sendSync).not.toHaveBeenCalled();
    expect(share.state.value).toBe("idle");
    expect(invokeMock).not.toHaveBeenCalledWith("hp_charge", expect.anything());
  });

  it("reports a backend failure while registering the file", async () => {
    const { share, stub } = hosting();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "file_offer_create") throw new Error("permission denied");
      return undefined;
    });
    await share.offer({ id: "bob-device", name: "bob" });
    expect(share.state.value).toBe("error");
    expect(share.error.value).toBe("permission denied");
    expect(stub.sendSync).not.toHaveBeenCalled();
  });

  it("reports a thrown string as it came", async () => {
    const { share } = hosting();
    openMock.mockRejectedValue("dialog unavailable");
    await share.offer({ id: "bob-device", name: "bob" });
    expect(share.error.value).toBe("dialog unavailable");
  });

  it("authorizes exactly the KeyPackage the recipient accepted with", async () => {
    const { share, emitSync } = hosting();
    await share.offer({ id: "bob-device", name: "bob" });
    emitSync("file_accept", { offerId: "offer-1", kpHash: "kp-hash-1" });
    await flush();
    expect(invokeMock).toHaveBeenCalledWith("file_authorize", { offerId: "offer-1", kpHash: "kp-hash-1" });
    expect(share.state.value).toBe("transferring");
  });

  it("authorizes nothing for an accept that carries no KeyPackage", async () => {
    // Possession of {addr, offerId} alone must not get anyone the file.
    const { share, emitSync } = hosting();
    await share.offer({ id: "bob-device", name: "bob" });
    emitSync("file_accept", { offerId: "offer-1" });
    await flush();
    expect(invokeMock).not.toHaveBeenCalledWith("file_authorize", expect.anything());
    expect(share.state.value).toBe("transferring");
  });

  it("ignores an accept, decline or cancel for someone else's offer", async () => {
    const { share, emitSync } = hosting();
    await share.offer({ id: "bob-device", name: "bob" });
    emitSync("file_accept", { offerId: "other", kpHash: "kp" });
    emitSync("file_decline", { offerId: "other" });
    emitSync("file_cancel", { offerId: "other" });
    await flush();
    expect(share.state.value).toBe("offering");
    expect(invokeMock).not.toHaveBeenCalledWith("file_authorize", expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith("file_offer_cancel", expect.anything());
  });

  it("does not step back to transferring for a repeated accept once bytes flow", async () => {
    const { share, emitSync } = hosting();
    await share.offer({ id: "bob-device", name: "bob" });
    fireBackend("file://done", { offerId: "offer-1", dir: "send" });
    emitSync("file_accept", { offerId: "offer-1", kpHash: "kp" });
    await flush();
    expect(share.state.value).toBe("done");
  });

  it("cancelling an offer tells the peer and withdraws the file", async () => {
    const { share, stub } = hosting();
    await share.offer({ id: "bob-device", name: "bob" });
    stub.sendSync.mockRejectedValueOnce(new Error("channel closed"));
    await share.cancel();
    await flush();
    expect(stub.sendSync).toHaveBeenCalledWith("file_cancel", { offerId: "offer-1" });
    expect(invokeMock).toHaveBeenCalledWith("file_offer_cancel", { offerId: "offer-1" });
    expect(share.state.value).toBe("idle");
    expect(share.fileName.value).toBe("");
  });

  it("a cancel with nothing in flight just resets", async () => {
    const { channel, stub } = makeChannel();
    const share = useFileShare(channel);
    await share.cancel();
    expect(stub.sendSync).not.toHaveBeenCalled();
    expect(share.state.value).toBe("idle");
  });

  it("the peer's cancel resets our side", async () => {
    const { share, emitSync } = hosting();
    await share.offer({ id: "bob-device", name: "bob" });
    emitSync("file_cancel", { offerId: "offer-1" });
    await flush();
    expect(share.state.value).toBe("idle");
  });

  it("a backend error without a message still says the transfer failed", async () => {
    const { share } = hosting();
    await share.offer({ id: "bob-device", name: "bob" });
    fireBackend("file://error", { offerId: "offer-1", message: "" });
    expect(share.state.value).toBe("error");
    expect(share.error.value).toBe("Transfer failed.");
  });

  it("reads progress against an unknown total as zero, not NaN", async () => {
    const { share } = hosting();
    await share.offer({ id: "bob-device", name: "bob" });
    fireBackend("file://progress", { offerId: "offer-1", dir: "send", transferred: 100, total: 0 });
    expect(share.progress.value).toBe(0);
    expect(share.state.value).toBe("transferring");
  });
});

describe("useFileShare — recipient side, edges", () => {
  const offer = {
    offerId: "offer-9",
    target: "alice-device",
    addr: "peer-addr",
    name: "photo.png",
    size: 1000,
    mime: "image/png",
    fromName: "bob",
  };

  async function receiving(payload: Record<string, unknown> = offer) {
    const ctx = makeChannel();
    const share = useFileShare(ctx.channel);
    ctx.emitSync("file_offer", payload);
    await flush();
    return { share, ...ctx };
  }

  it("ignores sync traffic that is not a file transfer's", async () => {
    const { channel, emitSync } = makeChannel();
    const share = useFileShare(channel);
    emitSync("vox_offer", { offerId: "v1", target: "alice-device" });
    emitSync("sync_snapshot", {});
    await flush();
    expect(share.state.value).toBe("idle");
  });

  it("names the sender by their MLS identity when the offer carries no name", async () => {
    const { share } = await receiving({ offerId: "offer-9", target: "alice-device", addr: "a" });
    expect(share.peerName.value).toBe("bob");
    expect(share.fileName.value).toBe("");
    expect(share.fileSize.value).toBe(0);
  });

  it("takes an unaddressed offer as ours (a two-person room)", async () => {
    const { share } = await receiving({ ...offer, target: undefined });
    expect(share.state.value).toBe("incoming");
  });

  it("stays on the offer when the save dialog is dismissed", async () => {
    saveMock.mockResolvedValue(null);
    const { share, stub } = await receiving();
    await share.accept();
    expect(share.state.value).toBe("incoming");
    expect(stub.sendSync).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("file_download", expect.anything());
  });

  it("publishes the hash of the KeyPackage it minted for this transfer", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "file_prepare" ? "kp-hash-9" : undefined));
    const { share, stub } = await receiving();
    await share.accept();
    expect(invokeMock).toHaveBeenCalledWith("file_prepare", { offerId: "offer-9" });
    expect(stub.sendSync).toHaveBeenCalledWith("file_accept", { offerId: "offer-9", kpHash: "kp-hash-9" });
  });

  it("reports a download that fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "file_download") throw new Error("connection refused");
      return undefined;
    });
    const { share } = await receiving();
    await share.accept();
    expect(share.state.value).toBe("error");
    expect(share.error.value).toBe("connection refused");
  });

  it("accept and decline do nothing without an offer on screen", async () => {
    const { channel, stub } = makeChannel();
    const share = useFileShare(channel);
    await share.accept();
    await share.decline();
    expect(saveMock).not.toHaveBeenCalled();
    expect(stub.sendSync).not.toHaveBeenCalled();
  });

  it("declines even when the refusal cannot be delivered", async () => {
    const { share, stub } = await receiving();
    stub.sendSync.mockRejectedValueOnce(new Error("channel closed"));
    await share.decline();
    expect(share.state.value).toBe("idle");
  });

  it("cancelling an incoming offer declines it to the sender", async () => {
    const { share, stub } = await receiving();
    stub.sendSync.mockRejectedValueOnce(new Error("channel closed"));
    await share.cancel();
    expect(stub.sendSync).toHaveBeenCalledWith("file_decline", { offerId: "offer-9" });
    expect(share.state.value).toBe("idle");
  });

  it("drops the offer when the sender withdraws it", async () => {
    const { share, emitSync } = await receiving();
    emitSync("file_cancel", { offerId: "offer-9" });
    await flush();
    expect(share.state.value).toBe("idle");
    expect(share.peerName.value).toBe("");
  });

  it("ignores a second offer while a download is running", async () => {
    const { share, emitSync } = await receiving();
    await share.accept();
    emitSync("file_offer", { ...offer, offerId: "offer-10", name: "other.zip" });
    await flush();
    expect(share.state.value).toBe("transferring");
    expect(share.fileName.value).toBe("photo.png");
  });

  it("follows download progress and completes without withdrawing anything", async () => {
    // Only the host serves an offer; the recipient has nothing to cancel on done.
    const { share } = await receiving();
    await share.accept();
    invokeMock.mockClear();
    fireBackend("file://progress", { offerId: "offer-9", dir: "recv", transferred: 250, total: 1000 });
    expect(share.direction.value).toBe("recv");
    expect(share.progress.value).toBeCloseTo(0.25);
    fireBackend("file://done", { offerId: "offer-9", dir: "recv" });
    await flush();
    expect(share.state.value).toBe("done");
    expect(invokeMock).not.toHaveBeenCalledWith("file_offer_cancel", expect.anything());
  });

  it("ignores progress and completion for other transfers", async () => {
    const { share } = await receiving();
    fireBackend("file://progress", { offerId: "nope", dir: "recv", transferred: 1, total: 2 });
    fireBackend("file://done", { offerId: "nope", dir: "recv" });
    expect(share.state.value).toBe("incoming");
    expect(share.progress.value).toBe(0);
  });

  it("reset() clears a finished transfer back to idle", async () => {
    const { share } = await receiving();
    share.reset();
    expect(share.state.value).toBe("idle");
    expect(share.direction.value).toBe("");
    expect(share.error.value).toBeNull();
  });
});
