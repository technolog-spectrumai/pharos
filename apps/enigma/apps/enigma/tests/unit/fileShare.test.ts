import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";
import { useFileShare } from "../../src/components/chat/useFileShare";
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

  it("a huge offer is still shown when no limit is set (0 = unlimited)", async () => {
    const { channel, emitSync } = makeChannel();
    const share = useFileShare(channel);

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
