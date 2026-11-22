import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import { OyaModal } from "petalite/primitives";
import type { ChatChannel } from "rakotis";
import { i18n } from "../../src/i18n";
import ChatPanel from "../../src/components/ChatPanel.vue";
import JoinRoomModal from "../../src/components/chat/JoinRoomModal.vue";
import type { P2pRoomsController } from "../../src/components/chat/useP2pRooms";

// The mobile QR scanner regression.
//
// Both the join window and the camera sheet are OyaModals teleported to <body>,
// and teleport siblings stack by MOUNT order — not by which one opened last. The
// scanner is declared before JoinRoomModal in ChatPanel, so with both open the
// join modal's bg-black/70 backdrop and its opaque card painted straight over the
// live camera feed ("the camera is barely visible / cut out"). What is pinned
// here: the two are never on screen at the same time, the join window comes back
// on a decode AND on a dismiss (it owns the connect/MLS progress + the auto-close
// countdown), the sheet rides its own z layer, and the scan box is sized relative
// to the viewfinder — a fixed px box larger than the rendered video makes
// html5-qrcode reject start(), i.e. a camera that never opens on a narrow phone.

const { qr } = vi.hoisted(() => ({
  qr: {
    starts: 0,
    stops: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: null as any,
    onSuccess: null as ((decoded: string) => void) | null,
  },
}));

const invokeMock = vi.fn(async (cmd: string) => {
  if (cmd === "invite_peek") return { kind: "general", inviter: "a", expiresAt: Date.now() + 6e5, tor: false };
  if (cmd === "invite_redeem") return { welcome: "V0VMQ09NRQ==", roomName: "R", peers: [], onion: "" };
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...(a as [string])) }));

vi.mock("html5-qrcode", () => ({
  Html5Qrcode: class {
    constructor(public elementId: string) {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async start(_camera: unknown, config: any, onSuccess: (decoded: string) => void) {
      qr.starts += 1;
      qr.config = config;
      qr.onSuccess = onSuccess;
    }
    async stop() {
      qr.stops += 1;
    }
  },
}));

function makeChannel() {
  return {
    currentRoom: ref<string | null>(null),
    error: ref<string | null>(null),
    isParticipant: ref(true),
    isEncrypted: ref(false),
    mlsStatus: ref("idle"),
    p2pRooms: ref<unknown[]>([]),
    loadP2pRooms: vi.fn(async () => {}),
    createRoom: vi.fn(async () => null),
    mlsIdentity: ref("me"),
    currentUserName: ref("me"),
    joinByInvite: vi.fn(async () => true),
    cancelJoin: vi.fn(async () => {}),
    deleteRoom: vi.fn(async () => {}),
  };
}
type Channel = ReturnType<typeof makeChannel>;

// Everything that isn't part of the overlay handoff is stubbed; the scanner and
// the join modal stay real.
const GLOBAL = () => ({
  plugins: [i18n],
  stubs: {
    teleport: true,
    ChatHeader: true,
    ObserverBanner: true,
    RoomStatusBar: true,
    MessageList: true,
    MessageComposer: true,
    RoomsSidebar: true,
    ParticipantsPanel: true,
    CreateRoomModal: true,
    RoomInfoModal: true,
    DeleteRoomModal: true,
    MobileRoomsDrawer: true,
  },
});

async function mountPanel(channel: Channel) {
  const wrapper = mount(ChatPanel, {
    props: { channel: channel as unknown as ChatChannel },
    global: GLOBAL(),
  });
  await flushPromises();
  const controller = wrapper.findComponent(JoinRoomModal).props("controller") as P2pRoomsController;
  return { wrapper, controller };
}

const joinModal = (w: ReturnType<typeof mount>) => w.find("[data-testid='join-room-modal']");
const scannerModal = (w: ReturnType<typeof mount>) => w.find("[data-testid='qr-scanner-modal']");

/** Open the join window, then hit its camera button. */
async function openCamera(wrapper: ReturnType<typeof mount>, controller: P2pRoomsController) {
  controller.openJoin();
  await nextTick();
  await wrapper.find("[data-testid='join-scan']").trigger("click");
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  // mockClear, not clearAllMocks: the implementation above IS the fixture, and
  // resetting it would make every redemption resolve undefined.
  invokeMock.mockClear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  qr.starts = 0;
  qr.stops = 0;
  qr.config = null;
  qr.onSuccess = null;
});

describe("ChatPanel — join window ⇄ camera handoff", () => {
  it("opens the join window with the camera sheet closed", async () => {
    const channel = makeChannel();
    const { wrapper, controller } = await mountPanel(channel);

    expect(joinModal(wrapper).exists()).toBe(false);
    controller.openJoin();
    await nextTick();

    expect(joinModal(wrapper).exists()).toBe(true);
    expect(scannerModal(wrapper).exists()).toBe(false);
  });

  it("never renders the camera sheet and the join window at the same time", async () => {
    const channel = makeChannel();
    const { wrapper, controller } = await mountPanel(channel);
    await openCamera(wrapper, controller);

    // THE regression: the join modal must be gone, not merely behind the feed.
    expect(scannerModal(wrapper).exists()).toBe(true);
    expect(joinModal(wrapper).exists()).toBe(false);
    expect(controller.joinOpen.value).toBe(false);
    // …and exactly one overlay is mounted, so nothing can paint over the camera.
    expect(wrapper.findAll("[data-testid='oya-modal-overlay']")).toHaveLength(1);
    expect(qr.starts).toBe(1);
  });

  it("gives the camera sheet its own stacking layer, above the modal layer", async () => {
    const channel = makeChannel();
    const { wrapper, controller } = await mountPanel(channel);
    await openCamera(wrapper, controller);

    const overlay = wrapper.find("[data-testid='oya-modal-overlay']");
    expect(overlay.attributes("style")).toContain("z-index: 75");
  });

  it("brings the join window back on a decode and starts the join there", async () => {
    const channel = makeChannel();
    const { wrapper, controller } = await mountPanel(channel);
    await openCamera(wrapper, controller);

    // Park the REDEEM (not the settings read that precedes it) so the window
    // stays on its progress state — what this test is about is the handoff, not
    // the outcome.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "invite_peek") return { kind: "general", inviter: "a", expiresAt: Date.now() + 6e5, tor: false };
      if (cmd === "invite_redeem") return new Promise(() => {});
      return null;
    });
    // A scanned invitation — the only thing the join field takes now.
    qr.onSuccess!("  jybucrq  ");
    await flushPromises();

    expect(scannerModal(wrapper).exists()).toBe(false);
    expect(joinModal(wrapper).exists()).toBe(true);
    expect(qr.stops).toBe(1); // camera released
    // Trimmed and redeemed: the peek is the first thing the redemption does.
    expect(invokeMock).toHaveBeenCalledWith("invite_peek", { ticket: "jybucrq" });
    // The join window is what renders the connect/MLS progress + countdown.
    expect(controller.joinStarted.value).toBe(true);
    expect(wrapper.text()).toContain("Connecting to the room…");

    wrapper.unmount();
  });

  it("brings the join window back when the camera sheet is dismissed", async () => {
    const channel = makeChannel();
    const { wrapper, controller } = await mountPanel(channel);
    await openCamera(wrapper, controller);

    const cancel = wrapper.findAll("button").find((b) => b.text() === "Cancel")!;
    await cancel.trigger("click");
    await flushPromises();

    expect(scannerModal(wrapper).exists()).toBe(false);
    expect(joinModal(wrapper).exists()).toBe(true);
    expect(controller.joinOpen.value).toBe(true);
    expect(qr.stops).toBe(1);
    expect(invokeMock).not.toHaveBeenCalledWith("invite_peek", expect.anything());
  });

  it("sizes the scan box from the viewfinder instead of a fixed 220 px box", async () => {
    const channel = makeChannel();
    const { wrapper, controller } = await mountPanel(channel);
    await openCamera(wrapper, controller);

    // A fixed box is what html5-qrcode rejects when the video comes up smaller
    // than it (start() throws → the camera never opens).
    expect(typeof qr.config.qrbox).toBe("function");
    expect(qr.config.qrbox(300, 400)).toEqual({ width: 240, height: 240 });
    // Never larger than the rendered video, in either axis.
    const tight = qr.config.qrbox(180, 120);
    expect(tight.width).toBeLessThanOrEqual(180);
    expect(tight.height).toBeLessThanOrEqual(120);

    wrapper.unmount();
  });
});

describe("OyaModal — stacking prop", () => {
  it("defaults to the shared modal layer", () => {
    const wrapper = mount(OyaModal, { props: { open: true }, global: { stubs: { teleport: true } } });
    expect(wrapper.find("[data-testid='oya-modal-overlay']").attributes("style")).toContain("z-index: 60");
  });

  it("honours an explicit layer so nested overlays can't silently stack", () => {
    const wrapper = mount(OyaModal, { props: { open: true, z: 75 }, global: { stubs: { teleport: true } } });
    expect(wrapper.find("[data-testid='oya-modal-overlay']").attributes("style")).toContain("z-index: 75");
  });

  it("measures itself against the dynamic viewport and the safe-area insets", () => {
    const wrapper = mount(OyaModal, { props: { open: true }, global: { stubs: { teleport: true } } });
    const classes = wrapper.find("[data-testid='oya-modal-overlay']").classes();
    // 100vh counts the mobile URL bar — the classic "content runs off the bottom".
    expect(classes).toContain("h-[100dvh]");
    expect(classes).toContain("pb-[calc(1.5rem+env(safe-area-inset-bottom))]");
  });
});
