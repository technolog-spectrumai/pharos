// The Vox panel through a whole call: the idle start/join card, the waiting
// ticket, ringing out, the live call, and the ways a call code gets in (paste,
// camera, uploaded image).
//
// The controller (useVoxCall) has its own unit suite; here it is a stub, and
// what is pinned is the panel's side of the contract — which controller verb a
// control reaches and with what, and what the user is told in each phase. Two
// rules carry most of the weight. Calls are iroh-only, so in Tor or airplane
// mode every control that STARTS a call is visible but disabled, with the
// reason; and the room-member list never offers to ring yourself.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { ref } from "vue";
import { setOffline, setUseTor } from "rakotis";

const { qr } = vi.hoisted(() => ({
  qr: {
    regions: [] as string[],
    startArgs: null as unknown[] | null,
    onSuccess: null as ((decoded: string) => void) | null,
    stops: 0,
    clears: 0,
    startFails: false,
    decoded: "" as string | null,
  },
}));
vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class {
    constructor(region: string) {
      qr.regions.push(region);
    }
    async start(camera: unknown, config: unknown, onSuccess: (d: string) => void) {
      if (qr.startFails) throw new Error("NotAllowedError");
      qr.startArgs = [camera, config];
      qr.onSuccess = onSuccess;
    }
    async stop() {
      qr.stops += 1;
    }
    async scanFile(_file: File, _showImage: boolean) {
      if (qr.decoded === null) throw new Error("No MultiFormat Readers were able to detect the code.");
      return qr.decoded;
    }
    async clear() {
      qr.clears += 1;
    }
  },
}));

const toDataURL = vi.fn(async (text: string, _opts?: unknown) => `data:image/png;base64,QR(${text})`);
vi.mock("qrcode", () => ({ toDataURL: (t: string, o: unknown) => toDataURL(t, o) }));

function makeVox() {
  return {
    available: true,
    phase: ref("idle"),
    ticket: ref(""),
    incomingName: ref(""),
    peerName: ref(""),
    muted: ref(false),
    error: ref(""),
    callSeconds: ref(0),
    spectrum: ref<number[]>([]),
    encryption: ref(""),
    nickResults: ref<{ node_id: string; name: string; ts: number }[]>([]),
    createCall: vi.fn(),
    joinByTicket: vi.fn(),
    callNode: vi.fn(),
    callByNick: vi.fn(),
    callPeer: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
    hangup: vi.fn(),
    restart: vi.fn(),
    toggleMute: vi.fn(),
  };
}
let vox = makeVox();
const p2p = {
  participants: ref<{ id?: string; name: string }[]>([]),
  mlsIdentity: ref("me-id"),
};
vi.mock("../../src/stores/chat", () => ({ useChatStore: () => ({ vox, p2p }) }));

import { i18n } from "../../src/i18n";
import VoxPanel from "../../src/components/vox/VoxPanel.vue";

(i18n.global.locale as any).value = "en";

let pinia: Pinia;
async function mountPanel(darkMode = true) {
  const w = mount(VoxPanel, { props: { darkMode }, global: { plugins: [i18n, pinia] } });
  await flushPromises(); // the network policy refresh on mount
  return w;
}

const byText = (w: ReturnType<typeof mount>, text: string) => {
  const b = w.findAll("button").find((x) => x.text().trim() === text);
  expect(b, `button "${text}"`).toBeDefined();
  return b!;
};
const nickInput = (w: ReturnType<typeof mount>) => w.get('input[placeholder="Nickname"]');
const codeArea = (w: ReturnType<typeof mount>) => w.get('textarea[placeholder="Paste a call code"]');

beforeEach(() => {
  vox = makeVox();
  p2p.participants.value = [{ id: "me-id", name: "Me" }];
  pinia = createPinia();
  setActivePinia(pinia);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  Object.assign(qr, {
    regions: [],
    startArgs: null,
    onSuccess: null,
    stops: 0,
    clears: 0,
    startFails: false,
    decoded: "",
  });
  toDataURL.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── idle: who can be called ─────────────────────────────────────────────────

describe("VoxPanel — calling someone in the room", () => {
  it("lists the other addressable members, never yourself", async () => {
    p2p.participants.value = [
      { id: "me-id", name: "Me" },
      { id: "bob-id", name: "Bob" },
      { name: "No id yet" }, // presence not settled — nothing to dial
      { id: "carol-id", name: "" },
    ];
    const w = await mountPanel();
    const rows = w.findAll("li").map((li) => li.text());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Bob");
    // A member without a display name is shown by id rather than as a blank row.
    expect(rows[1]).toContain("carol-id");
    expect(w.text()).not.toContain("No id yet");
  });

  it("rings the member whose Call was pressed", async () => {
    p2p.participants.value = [
      { id: "me-id", name: "Me" },
      { id: "bob-id", name: "Bob" },
      { id: "carol-id", name: "Carol" },
    ];
    const w = await mountPanel();
    const carolRow = w.findAll("li").find((li) => li.text().includes("Carol"))!;
    await carolRow.get("button").trigger("click");
    expect(vox.callPeer).toHaveBeenCalledWith({ id: "carol-id", name: "Carol" });
  });

  it("says so when nobody else is in the room", async () => {
    const w = await mountPanel();
    expect(w.text()).toContain("No one else is in the current room.");
  });
});

describe("VoxPanel — calling by nickname", () => {
  it("looks up the trimmed nickname, from the button or Enter", async () => {
    const w = await mountPanel();
    await nickInput(w).setValue("  bob  ");
    const card = w.findAll("div").find((d) => d.text().startsWith("Call by nickname"))!;
    await card.get("button").trigger("click");
    expect(vox.callByNick).toHaveBeenLastCalledWith("bob");
    await nickInput(w).trigger("keydown", { key: "Enter" });
    expect(vox.callByNick).toHaveBeenCalledTimes(2);
  });

  it("does not look up a blank nickname", async () => {
    const w = await mountPanel();
    await nickInput(w).setValue("   ");
    await nickInput(w).trigger("keydown", { key: "Enter" });
    expect(vox.callByNick).not.toHaveBeenCalled();
  });

  it("asks the user to pick when several claim a nickname, showing a fingerprint of each", async () => {
    // Nickname claims are unauthenticated, so the panel shows enough of each
    // NodeId to tell them apart instead of picking one for the user.
    vox.nickResults.value = [
      { node_id: "0123456789abcdefghijklmnop", name: "bob", ts: 2 },
      { node_id: "short-id", name: "", ts: 1 },
    ];
    const w = await mountPanel();
    expect(w.text()).toContain("Several people claim this nickname");
    const rows = w.findAll("li");
    expect(rows[0].text()).toContain("0123456789…klmnop");
    // A short id is shown whole; a nameless claim reads "?".
    expect(rows[1].text()).toContain("short-id");
    expect(rows[1].text()).toContain("?");
    await rows[1].get("button").trigger("click");
    expect(vox.callNode).toHaveBeenCalledWith("short-id", "");
  });

  it("shows no pick-list for a single claim", async () => {
    vox.nickResults.value = [{ node_id: "n1", name: "bob", ts: 1 }];
    const w = await mountPanel();
    expect(w.text()).not.toContain("Several people claim this nickname");
  });
});

describe("VoxPanel — ticket calls", () => {
  it("starts a ticket call", async () => {
    const w = await mountPanel();
    await byText(w, "Start a call").trigger("click");
    expect(vox.createCall).toHaveBeenCalledTimes(1);
  });

  it("joins a pasted code, trimmed, and empties the field", async () => {
    const w = await mountPanel();
    await codeArea(w).setValue("  tkt-123 \n");
    await byText(w, "Join").trigger("click");
    expect(vox.joinByTicket).toHaveBeenCalledWith("tkt-123");
    expect((codeArea(w).element as HTMLTextAreaElement).value).toBe("");
  });

  it("does not join with an empty field", async () => {
    const w = await mountPanel();
    await byText(w, "Join").trigger("click");
    expect(vox.joinByTicket).not.toHaveBeenCalled();
  });
});

describe("VoxPanel — network policy", () => {
  const startControls = (w: ReturnType<typeof mount>) =>
    w.findAll("button").filter((b) => ["Call", "Start a call", "Join", "Scan QR code", "Upload a QR image"].includes(b.text().trim()));

  it("disables every call-starting control in Tor mode and says why", async () => {
    p2p.participants.value = [{ id: "me-id", name: "Me" }, { id: "bob-id", name: "Bob" }];
    await setUseTor(true);
    const w = await mountPanel();
    expect(w.get('[data-testid="vox-blocked"]').text()).toContain("Unavailable in Tor mode");
    const controls = startControls(w);
    // Room-member Call, nickname Call, Start, Join, Scan, Upload.
    expect(controls).toHaveLength(6);
    for (const b of controls) expect(b.attributes("disabled"), b.text()).toBeDefined();
  });

  it("gives the airplane-mode reason when offline", async () => {
    await setOffline(true);
    const w = await mountPanel();
    expect(w.get('[data-testid="vox-blocked"]').text()).toBe("Unavailable in airplane mode.");
    for (const b of startControls(w)) expect(b.attributes("disabled"), b.text()).toBeDefined();
  });

  it("shows no warning and leaves the controls on when calls are allowed", async () => {
    const w = await mountPanel();
    expect(w.find('[data-testid="vox-blocked"]').exists()).toBe(false);
    for (const b of startControls(w)) expect(b.attributes("disabled"), b.text()).toBeUndefined();
  });
});

// ── getting a code in by QR ─────────────────────────────────────────────────

describe("VoxPanel — scanning a call code", () => {
  it("opens the rear camera, dials what it decodes and puts the camera away", async () => {
    const w = await mountPanel();
    await byText(w, "Scan QR code").trigger("click");
    await flushPromises();
    expect(qr.regions).toEqual(["vox-qr-region"]);
    expect(qr.startArgs![0]).toEqual({ facingMode: "environment" });
    expect(byText(w, "Stop scanning").exists()).toBe(true);

    qr.onSuccess!("  tkt-cam  ");
    await flushPromises();
    expect(vox.joinByTicket).toHaveBeenCalledWith("tkt-cam");
    expect(qr.stops).toBe(1);
    expect(byText(w, "Scan QR code").exists()).toBe(true);
  });

  it("stops the camera on demand", async () => {
    const w = await mountPanel();
    await byText(w, "Scan QR code").trigger("click");
    await flushPromises();
    await byText(w, "Stop scanning").trigger("click");
    await flushPromises();
    expect(qr.stops).toBe(1);
    expect(vox.joinByTicket).not.toHaveBeenCalled();
  });

  it("explains a camera that cannot be opened", async () => {
    qr.startFails = true;
    const w = await mountPanel();
    await byText(w, "Scan QR code").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("Camera access denied or unavailable.");
    expect(byText(w, "Scan QR code").exists()).toBe(true);
  });

  it("releases the camera when the panel goes away mid-scan", async () => {
    const w = await mountPanel();
    await byText(w, "Scan QR code").trigger("click");
    await flushPromises();
    w.unmount();
    await flushPromises();
    expect(qr.stops).toBe(1);
  });

  it("reads a code from an uploaded image and dials it", async () => {
    qr.decoded = " tkt-img ";
    const w = await mountPanel();
    const input = w.get('input[type="file"]');
    const click = vi.spyOn(input.element as HTMLInputElement, "click");
    await byText(w, "Upload a QR image").trigger("click");
    expect(click).toHaveBeenCalledTimes(1);
    Object.defineProperty(input.element, "files", { value: [new File(["png"], "qr.png")], configurable: true });
    await input.trigger("change");
    await flushPromises();
    expect(qr.regions).toEqual(["vox-qr-file-region"]);
    expect(qr.clears).toBe(1);
    expect(vox.joinByTicket).toHaveBeenCalledWith("tkt-img");
  });

  it("explains an uploaded image that holds no code", async () => {
    qr.decoded = null;
    const w = await mountPanel();
    const input = w.get('input[type="file"]');
    Object.defineProperty(input.element, "files", { value: [new File(["png"], "cat.png")], configurable: true });
    await input.trigger("change");
    await flushPromises();
    expect(w.text()).toContain("No QR code found in that image.");
    expect(vox.joinByTicket).not.toHaveBeenCalled();
  });

  it("does nothing when the image picker is dismissed", async () => {
    const w = await mountPanel();
    const input = w.get('input[type="file"]');
    Object.defineProperty(input.element, "files", { value: [], configurable: true });
    await input.trigger("change");
    await flushPromises();
    expect(qr.regions).toEqual([]);
  });
});

// ── the call itself ─────────────────────────────────────────────────────────

describe("VoxPanel — waiting for someone to join", () => {
  async function waiting() {
    vox.phase.value = "waiting";
    const w = await mountPanel();
    vox.ticket.value = "tkt-wait";
    await flushPromises();
    return w;
  }

  it("shows the ticket as text and as a QR", async () => {
    const w = await waiting();
    expect((w.get("textarea[readonly]").element as HTMLTextAreaElement).value).toBe("tkt-wait");
    expect(toDataURL).toHaveBeenCalledWith("tkt-wait", expect.objectContaining({ errorCorrectionLevel: "L" }));
    expect(w.get('img[alt="Call QR code"]').attributes("src")).toBe("data:image/png;base64,QR(tkt-wait)");
    expect(w.text()).toContain("Waiting for someone to join…");
  });

  it("drops the QR when the ticket is withdrawn", async () => {
    const w = await waiting();
    vox.ticket.value = "";
    await flushPromises();
    expect(w.find('img[alt="Call QR code"]').exists()).toBe(false);
  });

  it("shows the text ticket alone when the QR cannot be drawn", async () => {
    toDataURL.mockRejectedValueOnce(new Error("too long"));
    const w = await waiting();
    expect(w.find('img[alt="Call QR code"]').exists()).toBe(false);
    expect((w.get("textarea[readonly]").element as HTMLTextAreaElement).value).toBe("tkt-wait");
  });

  it("copies the ticket and confirms briefly", async () => {
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const w = await waiting();
    vi.useFakeTimers();
    await byText(w, "Copy").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("tkt-wait");
    expect(w.text()).toContain("Copy ✓");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(w.text()).not.toContain("✓");
  });

  it("claims nothing when the clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
      configurable: true,
    });
    const w = await waiting();
    await byText(w, "Copy").trigger("click");
    await flushPromises();
    expect(w.text()).not.toContain("✓");
  });

  it("cancels the waiting call", async () => {
    const w = await waiting();
    await byText(w, "Cancel").trigger("click");
    expect(vox.hangup).toHaveBeenCalledTimes(1);
  });
});

describe("VoxPanel — ringing out and ringing in", () => {
  it("names the callee while calling out, and cancels", async () => {
    vox.phase.value = "calling";
    vox.peerName.value = "Bob";
    const w = await mountPanel();
    expect(w.text()).toContain("Calling Bob…");
    await byText(w, "Cancel").trigger("click");
    expect(vox.hangup).toHaveBeenCalledTimes(1);
  });

  it("says just 'Calling…' when the callee is not known yet", async () => {
    vox.phase.value = "calling";
    const w = await mountPanel();
    expect(w.text()).toContain("Calling…");
    expect(w.text()).not.toContain("Calling Bob");
  });

  it("answers or refuses a ringing call", async () => {
    vox.phase.value = "incoming";
    vox.incomingName.value = "Dana";
    const w = await mountPanel();
    await byText(w, "Accept").trigger("click");
    await byText(w, "Decline").trigger("click");
    expect(vox.accept).toHaveBeenCalledTimes(1);
    expect(vox.decline).toHaveBeenCalledTimes(1);
  });
});

describe("VoxPanel — a live call", () => {
  async function connected(patch: () => void = () => {}, darkMode = true) {
    vox.phase.value = "connected";
    vox.peerName.value = "bob";
    vox.encryption.value = "mls";
    patch();
    return mountPanel(darkMode);
  }
  const bars = (w: ReturnType<typeof mount>) => w.findAll(".rounded-full.w-1\\.5");

  it("shows who is on the line and for how long", async () => {
    const w = await connected(() => (vox.callSeconds.value = 65));
    // The avatar carries the initial, upper-cased.
    expect(w.get(".h-16.w-16").text()).toBe("B");
    expect(w.text()).toContain("bob");
    expect(w.text()).toContain("01:05");
    vox.callSeconds.value = 3_599;
    await flushPromises();
    expect(w.text()).toContain("59:59");
  });

  it("falls back to '?' for a peer with no name", async () => {
    const w = await connected(() => (vox.peerName.value = ""));
    expect(w.get(".h-16.w-16").text()).toBe("?");
  });

  it("follows the theme on the avatar", async () => {
    const dark = await connected();
    expect(dark.get(".h-16.w-16").classes()).toContain("bg-bubble-bg-dark");
    const light = await connected(() => {}, false);
    expect(light.get(".h-16.w-16").classes()).toContain("bg-bubble-bg-light");
  });

  it("says the call is end-to-end encrypted when MLS keyed it", async () => {
    const w = await connected();
    expect(w.text()).toContain("End-to-end encrypted");
    expect(w.text()).not.toContain("Transport-encrypted only");
  });

  it("warns about a transport-only call and offers to reconnect", async () => {
    // Without a shared identity the media is only transport-encrypted; the fix
    // is a fresh call that retries the MLS handshake.
    const w = await connected(() => (vox.encryption.value = "transport"));
    expect(w.text()).toContain("Transport-encrypted only (no shared identity)");
    await byText(w, "Reconnect").trigger("click");
    expect(vox.restart).toHaveBeenCalledTimes(1);
  });

  it("draws a flat equalizer until the first spectrum frame, then follows it", async () => {
    const w = await connected();
    expect(bars(w)).toHaveLength(24);
    expect(bars(w)[0].attributes("style")).toContain("height: 6%");
    vox.spectrum.value = [0.5, 1];
    await flushPromises();
    expect(bars(w)).toHaveLength(2);
    expect(bars(w)[0].attributes("style")).toContain("height: 50%");
    expect(bars(w)[1].attributes("style")).toContain("height: 100%");
  });

  it("mutes and unmutes, dimming the equalizer while muted", async () => {
    const w = await connected(() => (vox.spectrum.value = [1]));
    await byText(w, "Mute").trigger("click");
    expect(vox.toggleMute).toHaveBeenCalledTimes(1);
    vox.muted.value = true;
    await flushPromises();
    expect(byText(w, "Unmute").exists()).toBe(true);
    expect(bars(w)[0].attributes("style")).toContain("opacity: 0.3");
  });

  it("hangs up", async () => {
    const w = await connected();
    await byText(w, "Hang up").trigger("click");
    expect(vox.hangup).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale error off a live call", async () => {
    const w = await connected(() => (vox.error.value = "vox.errorGeneric"));
    expect(w.text()).not.toContain("The call could not be completed.");
  });
});

describe("VoxPanel — errors", () => {
  it("translates the controller's own error keys", async () => {
    vox.error.value = "vox.declined";
    const w = await mountPanel();
    expect(w.text()).toContain("Call declined.");
  });

  it("translates a chat key the controller borrows", async () => {
    vox.error.value = "chat.cameraDenied";
    const w = await mountPanel();
    expect(w.text()).toContain("Camera access denied or unavailable.");
  });

  it("shows a raw backend message as it came", async () => {
    // Not every failure has a key: a Rust error string is shown verbatim rather
    // than run through the translator, which would mangle it.
    vox.error.value = "TOR_BLOCKED: voice needs a direct connection";
    const w = await mountPanel();
    expect(w.text()).toContain("TOR_BLOCKED: voice needs a direct connection");
  });
});
