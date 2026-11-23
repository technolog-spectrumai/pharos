// The room dialogs: New chat, Join a chat and Room info.
//
// Each of them is a thin view over the shared useP2pRooms controller and the
// chat channel, so the tests hand them a controller/channel made of plain refs
// and drive the states directly. What is pinned is what the user reads in each
// state — a join that is still dialling has to say so and offer Cancel, a join
// that failed has to say why and offer Retry — and which controller action a
// click reaches.

import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref, type Ref } from "vue";
import type { ChatChannel, P2pRoomEntry } from "rakotis";
import { i18n } from "../../src/i18n";
import CreateRoomModal from "../../src/components/chat/CreateRoomModal.vue";
import JoinRoomModal from "../../src/components/chat/JoinRoomModal.vue";
import RoomInfoModal from "../../src/components/chat/RoomInfoModal.vue";
import RoomShareCard from "../../src/components/chat/RoomShareCard.vue";
import type { P2pRoomsController } from "../../src/components/chat/useP2pRooms";

(i18n.global.locale as any).value = "en";
const tr = i18n.global.t as unknown as (key: string, params?: Record<string, unknown>, plural?: number) => string;

// OyaModal teleports to <body>; stubbing the teleport keeps the card inside the
// wrapper. The share card has its own suite (roomShare.test.ts) and talks to
// Tauri, so here it is only checked for what it is handed.
const GLOBAL = { plugins: [i18n], stubs: { teleport: true, RoomShareCard: true } };

const asController = (c: unknown) => c as P2pRoomsController;
const asChannel = (c: unknown) => c as ChatChannel;

function buttonByText(w: ReturnType<typeof mount>, text: string) {
  const btn = w.findAll("button").find((b) => b.text().includes(text));
  expect(btn, `button "${text}"`).toBeDefined();
  return btn!;
}

// ── New chat ────────────────────────────────────────────────────────────────

function createController() {
  return {
    name: ref(""),
    createdRoom: ref<{ slug: string; name: string } | null>(null),
    createBusy: ref(false),
    createError: ref(""),
    createRoom: vi.fn(async () => {}),
  };
}

describe("CreateRoomModal", () => {
  it("says it is launching an onion while the room comes up", async () => {
    // Every room is an onion this device hosts; publishing it can take a
    // while, and the wording is what tells the user the wait is Tor's.
    const ctrl = createController();
    ctrl.createBusy.value = true;
    const w = mount(CreateRoomModal, { props: { open: false, controller: asController(ctrl) }, global: GLOBAL });
    await w.setProps({ open: true });
    await flushPromises();
    expect(w.text()).toContain("Launching your onion service");
    expect(w.find('input[placeholder="New room name"]').exists()).toBe(false);
  });

  it("says the room is ready and hands the new room to the share card", async () => {
    const ctrl = createController();
    const w = mount(CreateRoomModal, { props: { open: false, controller: asController(ctrl) }, global: GLOBAL });
    await w.setProps({ open: true });
    await flushPromises();
    ctrl.createdRoom.value = { slug: "room-7", name: "Book club" };
    await flushPromises();

    expect(w.text()).toContain(tr("chat.roomReady"));
    expect(w.text()).toContain(tr("chat.roomReadyHint"));
    expect(w.text()).not.toContain("★");
    const card = w.findComponent(RoomShareCard);
    expect(card.props()).toMatchObject({ roomSlug: "room-7", roomName: "Book club" });
  });

  it("creates from the name form, and shows the failure with Retry", async () => {
    const ctrl = createController();
    const w = mount(CreateRoomModal, { props: { open: true, controller: asController(ctrl) }, global: GLOBAL });
    await buttonByText(w, "Create").trigger("click");
    expect(ctrl.createRoom).toHaveBeenCalledTimes(1);

    ctrl.createError.value = "chat.joinTimeout";
    await flushPromises();
    expect(w.text()).toContain("Couldn't connect in time. Try again.");
    await buttonByText(w, "Try again").trigger("click");
    expect(ctrl.createRoom).toHaveBeenCalledTimes(2);
  });

  it("closes from its footer", async () => {
    const w = mount(CreateRoomModal, { props: { open: true, controller: asController(createController()) }, global: GLOBAL });
    await buttonByText(w, "Close").trigger("click");
    expect(w.emitted("update:open")).toEqual([[false]]);
  });
});

// ── Join a chat ─────────────────────────────────────────────────────────────

function joinController() {
  return {
    ticket: ref(""),
    scanError: ref(""),
    joinStarted: ref(false),
    joinError: ref(""),
    autoCloseSecs: ref<number | null>(null),
    invitePeek: ref<{ kind: string; inviter: string; expiresAt: number } | null>(null),
    joinRoom: vi.fn(async () => {}),
    cancelJoin: vi.fn(async () => {}),
    scanFile: vi.fn(async () => {}),
    resetJoin: vi.fn(),
  };
}
function joinChannel() {
  return { isEncrypted: ref(false), mlsStatus: ref("idle") };
}

function mountJoin(ctrl = joinController(), ch = joinChannel()) {
  const w = mount(JoinRoomModal, {
    props: { open: true, controller: asController(ctrl), channel: asChannel(ch) },
    global: GLOBAL,
  });
  return { w, ctrl, ch };
}

describe("JoinRoomModal — the form", () => {
  it("writes what is pasted into the controller and joins on Enter or the Join button", async () => {
    const { w, ctrl } = mountJoin();
    const field = w.get('input[placeholder="Paste an invitation"]');
    await field.setValue("jybucrq");
    expect(ctrl.ticket.value).toBe("jybucrq");

    await field.trigger("keyup.enter");
    expect(ctrl.joinRoom).toHaveBeenCalledTimes(1);
    await buttonByText(w, "Join").trigger("click");
    expect(ctrl.joinRoom).toHaveBeenCalledTimes(2);
  });

  it("says who is inviting before the invitation is redeemed", async () => {
    // An invitation is a connection to a person; the peek names them (shortened
    // to something a human can compare) while the rendezvous runs.
    const ctrl = joinController();
    ctrl.invitePeek.value = { kind: "personal", inviter: "a1b2c3d4e5f6a7b8c9d0", expiresAt: 0 };
    const { w } = mountJoin(ctrl);
    expect(w.get('[data-testid="invite-peek"]').text()).toBe("Connecting to a1b2c3d4e5f6…");
  });

  it("shows no inviter line before anything has been peeked", () => {
    const { w } = mountJoin();
    expect(w.find('[data-testid="invite-peek"]').exists()).toBe(false);
  });

  it("explains an uploaded image that held no QR code", () => {
    const ctrl = joinController();
    ctrl.scanError.value = "chat.qrNotFound";
    const { w } = mountJoin(ctrl);
    expect(w.text()).toContain("No QR code found in that image.");
  });

  it("opens the image picker from the upload button", async () => {
    const { w } = mountJoin();
    const click = vi.spyOn(w.get('input[type="file"]').element as HTMLInputElement, "click");
    await w.get('button[aria-label="Upload a QR image"]').trigger("click");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("hands a picked QR image to the controller's decoder", async () => {
    const { w, ctrl } = mountJoin();
    await w.get('input[type="file"]').trigger("change");
    expect(ctrl.scanFile).toHaveBeenCalledTimes(1);
  });

  it("asks the parent for the camera rather than opening it itself", async () => {
    // The camera sheet replaces this window (see qrScanner.test.ts), so the
    // modal only announces the intent.
    const { w } = mountJoin();
    await w.get('[data-testid="join-scan"]').trigger("click");
    expect(w.emitted("open-camera")).toHaveLength(1);
  });

  it("closes from its footer", async () => {
    const { w } = mountJoin();
    await buttonByText(w, "Close").trigger("click");
    expect(w.emitted("update:open")).toEqual([[false]]);
  });
});

describe("JoinRoomModal — progress", () => {
  function started(patch: (c: ReturnType<typeof joinController>, ch: ReturnType<typeof joinChannel>) => void) {
    const ctrl = joinController();
    const ch = joinChannel();
    ctrl.joinStarted.value = true;
    patch(ctrl, ch);
    return mountJoin(ctrl, ch);
  }

  it("shows it is connecting and offers Cancel, which aborts the join", async () => {
    // Every join dials an onion, which can hang, so Cancel is always on offer
    // until the session is encrypted.
    const { w, ctrl } = started(() => {});
    expect(w.text()).toContain("Connecting to the room…");
    expect(w.find('input[placeholder="Paste an invitation"]').exists()).toBe(false);
    await buttonByText(w, "Cancel").trigger("click");
    expect(ctrl.cancelJoin).toHaveBeenCalledTimes(1);
  });

  it("still offers Cancel while the key exchange runs", () => {
    const { w } = started((_ctrl, ch) => (ch.mlsStatus.value = "key_exchange"));
    expect(w.findAll("button").some((b) => b.text() === "Cancel")).toBe(true);
  });

  it("moves on to 'establishing encryption' once the key exchange starts", () => {
    const { w } = started((_c, ch) => {
      ch.mlsStatus.value = "key_exchange";
    });
    expect(w.text()).toContain("Establishing encryption…");
  });

  it("reports success only once the session is encrypted, and stops offering Cancel", () => {
    const { w } = started((_c, ch) => {
      ch.isEncrypted.value = true;
    });
    expect(w.text()).toContain("Connected — encryption active.");
    expect(w.findAll("button").some((b) => b.text() === "Cancel")).toBe(false);
  });

  it("states the failure and offers Retry, which resets the join", async () => {
    const { w, ctrl } = started((c) => {
      c.joinError.value = "invite.errExpired";
    });
    expect(w.text()).toContain("This invitation has expired. Ask for a new one.");
    // An error is terminal: Retry, not Cancel.
    expect(w.findAll("button").some((b) => b.text() === "Cancel")).toBe(false);
    await buttonByText(w, "Try again").trigger("click");
    expect(ctrl.resetJoin).toHaveBeenCalledTimes(1);
  });

  it("an error outranks an encrypted session in what it says", () => {
    const { w } = started((c, ch) => {
      c.joinError.value = "chat.joinTimeout";
      ch.isEncrypted.value = true;
    });
    expect(w.text()).toContain("Couldn't connect in time. Try again.");
    expect(w.text()).not.toContain("Connected — encryption active.");
  });

  it("counts down to closing itself once the outcome is on screen", async () => {
    const { w, ctrl } = started((c) => (c.joinError.value = "chat.joinTimeout"));
    expect(w.text()).not.toContain("Closing in");
    ctrl.autoCloseSecs.value = 4;
    await flushPromises();
    expect(w.text()).toContain("Closing in 4 s…");
  });
});

// ── Room info ───────────────────────────────────────────────────────────────

function mountInfo(room: P2pRoomEntry | null) {
  const infoRoom = ref(room) as Ref<P2pRoomEntry | null>;
  const w = mount(RoomInfoModal, {
    props: { open: true, controller: asController({ infoRoom }), channel: asChannel({}) },
    global: GLOBAL,
  });
  return { w, infoRoom };
}

describe("RoomInfoModal", () => {
  it("names the room and says this device created it", () => {
    const { w } = mountInfo({ room: "room-9", name: "Archive", host: true });
    expect(w.text()).toContain("Archive");
    expect(w.text()).toContain("You're the room host");
  });

  it("shows no host badge for a room this device joined", () => {
    const { w } = mountInfo({ room: "r2", name: "Joined" });
    expect(w.text()).toContain("Joined");
    expect(w.text()).not.toContain("You're the room host");
  });

  it("says every room is invite-only and runs over Tor", () => {
    const { w } = mountInfo({ room: "r2", name: "Joined" });
    expect(w.text()).toContain(tr("chat.inviteOnly"));
    expect(w.text()).toContain(tr("chat.inviteOnlyOnHint"));
    expect(w.text()).toContain(tr("chat.overTor"));
    expect(w.text()).toContain(tr("chat.overTorHint"));
  });

  it("has no captain tools: no logo, rules or bans", () => {
    const { w } = mountInfo({ room: "room-9", name: "Archive", host: true });
    expect(w.find("img").exists()).toBe(false);
    expect(w.find("textarea").exists()).toBe(false);
    expect(w.find('input[type="file"]').exists()).toBe(false);
    expect(w.text()).not.toContain("Room rules");
    expect(w.text()).not.toContain("Banned");
    expect(w.find('font-awesome-icon-stub[icon="star"]').exists()).toBe(false);
  });

  it("hands the share card the room", () => {
    const { w } = mountInfo({ room: "r3", name: "Legacy" });
    expect(w.findComponent(RoomShareCard).props()).toMatchObject({ roomSlug: "r3", roomName: "Legacy" });
  });

  it("renders no card at all when there is no room to describe", async () => {
    const { w } = mountInfo(null);
    expect(w.text()).not.toContain("Invite only");
    await buttonByText(w, "Close").trigger("click");
    expect(w.emitted("update:open")).toEqual([[false]]);
  });
});
