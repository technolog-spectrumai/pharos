// The room dialogs: New chat, Join a chat, Room info, and the captain's
// moderation sheet for one member.
//
// Each of them is a thin view over the shared useP2pRooms controller and the
// chat channel, so the tests hand them a controller/channel made of plain refs
// and drive the states directly. What is pinned is what the user reads in each
// state — a join that is hanging over Tor has to say so and offer Cancel, a
// join that failed has to say why and offer Retry — and which channel action a
// click reaches, with what arguments: a mute that lands on the wrong member, or
// a kick that fires on the first tap, is the kind of slip nobody notices until
// it has already happened to someone.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref, type Ref } from "vue";
import { type ChatChannel, type Participant, type P2pRoomEntry } from "rakotis";
import { i18n } from "../../src/i18n";
import CreateRoomModal from "../../src/components/chat/CreateRoomModal.vue";
import JoinRoomModal from "../../src/components/chat/JoinRoomModal.vue";
import RoomInfoModal from "../../src/components/chat/RoomInfoModal.vue";
import ModerateMemberModal from "../../src/components/chat/ModerateMemberModal.vue";
import RoomShareCard from "../../src/components/chat/RoomShareCard.vue";
import type { P2pRoomsController } from "../../src/components/chat/useP2pRooms";

(i18n.global.locale as any).value = "en";

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
  it("says it is launching an onion while a Tor room comes up", async () => {
    // Publishing an onion descriptor can take a long while; the wording is what
    // tells the user the wait is Tor's and not a hang.
    const ctrl = createController();
    ctrl.createBusy.value = true;
    const w = mount(CreateRoomModal, { props: { open: false, controller: asController(ctrl) }, global: GLOBAL });
    await w.setProps({ open: true });
    await flushPromises();
    expect(w.text()).toContain("Launching your onion service");
    expect(w.text()).not.toContain("Creating your room");
  });

  it("names the creator as host and hands the new room to the share card", async () => {
    const ctrl = createController();
    const w = mount(CreateRoomModal, { props: { open: false, controller: asController(ctrl) }, global: GLOBAL });
    await w.setProps({ open: true });
    await flushPromises();
    ctrl.createdRoom.value = { slug: "room-7", name: "Book club" };
    await flushPromises();

    expect(w.text()).toContain("You're the room host");
    // Over Tor the creator hosts the onion, so the ★ explanation is shown too.
    expect(w.text()).toContain("you'll see a ★ by your name");
    const card = w.findComponent(RoomShareCard);
    expect(card.props()).toMatchObject({ roomSlug: "room-7", roomName: "Book club", tor: true });
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
    joiningTor: ref(false),
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
    const field = w.get('input[placeholder="Paste ticket to join"]');
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

  it("shows plain connecting over iroh, with nothing to cancel", () => {
    const { w } = started(() => {});
    expect(w.text()).toContain("Connecting to the room…");
    // Cancel exists to free a hung onion dial; an iroh dial holds no such lock.
    expect(w.findAll("button").some((b) => b.text() === "Cancel")).toBe(false);
    expect(w.find('input[placeholder="Paste ticket to join"]').exists()).toBe(false);
  });

  it("names the onion launch over Tor and offers Cancel, which aborts the join", async () => {
    const { w, ctrl } = started((c) => (c.joiningTor.value = true));
    expect(w.text()).toContain("Launching your onion service");
    await buttonByText(w, "Cancel").trigger("click");
    expect(ctrl.cancelJoin).toHaveBeenCalledTimes(1);
  });

  it("moves on to 'establishing encryption' once the key exchange starts", () => {
    const { w } = started((c, ch) => {
      c.joiningTor.value = true;
      ch.mlsStatus.value = "key_exchange";
    });
    expect(w.text()).toContain("Establishing encryption…");
  });

  it("reports success only once the session is encrypted, and stops offering Cancel", () => {
    const { w } = started((c, ch) => {
      c.joiningTor.value = true;
      ch.isEncrypted.value = true;
    });
    expect(w.text()).toContain("Connected — encryption active.");
    expect(w.findAll("button").some((b) => b.text() === "Cancel")).toBe(false);
  });

  it("states the failure and offers Retry, which resets the join", async () => {
    const { w, ctrl } = started((c) => {
      c.joiningTor.value = true;
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

function infoChannel(opts: { current?: string | null; captain?: boolean } = {}) {
  return {
    currentRoom: ref(opts.current ? { slug: opts.current, name: "Live" } : null),
    amCaptain: ref(opts.captain ?? false),
    roomLogo: ref(""),
    roomRules: ref(""),
    bans: ref<string[]>([]),
    setRoomLogo: vi.fn(async () => {}),
    setRoomRules: vi.fn(async () => {}),
    unbanMember: vi.fn(async () => {}),
  };
}

function mountInfo(room: P2pRoomEntry | null, ch = infoChannel()) {
  const infoRoom = ref(room) as Ref<P2pRoomEntry | null>;
  const w = mount(RoomInfoModal, {
    props: { open: true, controller: asController({ infoRoom }), channel: asChannel(ch) },
    global: GLOBAL,
  });
  return { w, ch, infoRoom };
}

describe("RoomInfoModal — a saved room that is not open", () => {
  const saved = {
    room: "room-9",
    name: "Archive",
    tor: true,
    host: true,
    logo: "data:image/png;base64,TE9HTw==",
    rules: "Be kind.",
    bans: ["banned-1"],
  } as P2pRoomEntry;

  it("shows the meta last received for it, read-only", () => {
    // Edits broadcast over the room's live MLS group, so a room that is not open
    // has nobody to send them to: display only.
    const { w } = mountInfo(saved, infoChannel({ current: "some-other-room", captain: true }));
    expect(w.text()).toContain("Archive");
    expect(w.get('img[alt="Room logo"]').attributes("src")).toBe(saved.logo);
    expect(w.text()).toContain("Be kind.");
    expect(w.text()).not.toContain("Set room logo");
    expect(w.text()).not.toContain("Edit");
    expect(w.text()).not.toContain("Banned identities");
  });

  it("labels the transport and marks a Tor host with the captain star", () => {
    const { w } = mountInfo(saved);
    expect(w.text()).toContain("Tor");
    expect(w.text()).toContain("You're the room host");
    expect(w.find('font-awesome-icon-stub[icon="star"]').exists()).toBe(true);
  });

  it("labels an iroh room as such and shows no host line for a joined one", () => {
    const { w } = mountInfo({ room: "r2", name: "Joined" } as P2pRoomEntry);
    expect(w.text()).toContain("iroh");
    expect(w.text()).not.toContain("You're the room host");
    // No rules and no captain rights: the whole rules block is absent.
    expect(w.text()).not.toContain("Room rules");
  });

  it("hands the share card the saved room, with Tor as a strict boolean", () => {
    const { w } = mountInfo({ room: "r3", name: "Legacy" } as P2pRoomEntry);
    expect(w.findComponent(RoomShareCard).props()).toMatchObject({ roomSlug: "r3", roomName: "Legacy", tor: false });
  });

  it("renders no card at all when there is no room to describe", async () => {
    const { w } = mountInfo(null);
    expect(w.text()).not.toContain("Invite only");
    await buttonByText(w, "Close").trigger("click");
    expect(w.emitted("update:open")).toEqual([[false]]);
  });
});

describe("RoomInfoModal — the open room", () => {
  const live = { room: "room-live", name: "Live", logo: "stale", rules: "stale rules" } as P2pRoomEntry;

  it("shows the channel's live meta rather than the saved copy", () => {
    const ch = infoChannel({ current: "room-live", captain: false });
    ch.roomRules.value = "Fresh rules";
    const { w } = mountInfo(live, ch);
    expect(w.text()).toContain("Fresh rules");
    expect(w.text()).not.toContain("stale rules");
    // The channel has no logo, so the saved one must not leak back in.
    expect(w.find('img[alt="Room logo"]').exists()).toBe(false);
    // A member who is not captain gets no editing controls.
    expect(w.text()).not.toContain("Set room logo");
    expect(w.text()).not.toContain("Edit");
  });

  it("lets the captain pick a logo and passes the file to the channel", async () => {
    const ch = infoChannel({ current: "room-live", captain: true });
    const { w } = mountInfo(live, ch);
    const input = w.get('input[type="file"]');
    const click = vi.spyOn(input.element as HTMLInputElement, "click");
    await buttonByText(w, "Set room logo").trigger("click");
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File(["png"], "logo.png", { type: "image/png" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    expect(ch.setRoomLogo).toHaveBeenCalledWith(file);
  });

  it("does nothing when the logo picker is dismissed", async () => {
    const ch = infoChannel({ current: "room-live", captain: true });
    const { w } = mountInfo(live, ch);
    const input = w.get('input[type="file"]');
    Object.defineProperty(input.element, "files", { value: [], configurable: true });
    await input.trigger("change");
    expect(ch.setRoomLogo).not.toHaveBeenCalled();
  });

  it("offers Remove only when there is a logo, and clears it with null", async () => {
    const ch = infoChannel({ current: "room-live", captain: true });
    const { w } = mountInfo(live, ch);
    expect(w.findAll("button").some((b) => b.text() === "Remove")).toBe(false);
    ch.roomLogo.value = "data:image/jpeg;base64,QQ==";
    await flushPromises();
    await buttonByText(w, "Remove").trigger("click");
    expect(ch.setRoomLogo).toHaveBeenCalledWith(null);
  });

  it("starts the rules editor from the current rules and saves the edited text", async () => {
    const ch = infoChannel({ current: "room-live", captain: true });
    ch.roomRules.value = "No spam.";
    const { w } = mountInfo(live, ch);
    await buttonByText(w, "Edit").trigger("click");
    const area = w.get("textarea");
    expect((area.element as HTMLTextAreaElement).value).toBe("No spam.");
    expect(area.attributes("maxlength")).toBe("2000");

    await area.setValue("No spam. No ads.");
    await buttonByText(w, "Save rules").trigger("click");
    await flushPromises();
    expect(ch.setRoomRules).toHaveBeenCalledWith("No spam. No ads.");
    expect(w.find("textarea").exists()).toBe(false);
  });

  it("drops an edit on Cancel without saving it", async () => {
    const ch = infoChannel({ current: "room-live", captain: true });
    const { w } = mountInfo(live, ch);
    // A captain with no rules yet still sees the block, with an empty state.
    expect(w.text()).toContain("No rules set.");
    await buttonByText(w, "Edit").trigger("click");
    await w.get("textarea").setValue("draft");
    await buttonByText(w, "Cancel").trigger("click");
    expect(ch.setRoomRules).not.toHaveBeenCalled();
    expect(w.find("textarea").exists()).toBe(false);
  });

  it("forgets a half-finished edit when the window is closed and reopened", async () => {
    const ch = infoChannel({ current: "room-live", captain: true });
    const { w } = mountInfo(live, ch);
    await buttonByText(w, "Edit").trigger("click");
    expect(w.find("textarea").exists()).toBe(true);
    await w.setProps({ open: false });
    await w.setProps({ open: true });
    expect(w.find("textarea").exists()).toBe(false);
  });

  it("lists banned identities for the captain and lifts the one clicked", async () => {
    const ch = infoChannel({ current: "room-live", captain: true });
    ch.bans.value = ["mallory-id", "trudy-id"];
    const { w } = mountInfo(live, ch);
    expect(w.text()).toContain("Banned identities");
    const row = w.findAll("div").find((d) => d.text().startsWith("trudy-id"))!;
    await row.get("button").trigger("click");
    expect(ch.unbanMember).toHaveBeenCalledWith("trudy-id");
    expect(ch.unbanMember).toHaveBeenCalledTimes(1);
  });
});

// ── Moderate member ─────────────────────────────────────────────────────────

function modChannel() {
  return {
    muteMember: vi.fn(async () => {}),
    unmuteMember: vi.fn(async () => {}),
    kickMember: vi.fn(async () => {}),
  };
}

const NOW = new Date("2026-03-01T12:00:00Z").getTime();

function member(patch: Partial<Participant> = {}): Participant {
  return { id: "bob-id", name: "Bob", avatar_url: "", type: "human", ...patch };
}

function mountModerate(participant: Participant | null = member(), ch = modChannel()) {
  const w = mount(ModerateMemberModal, {
    props: { open: true, participant, channel: asChannel(ch) },
    global: GLOBAL,
  });
  return { w, ch };
}

describe("ModerateMemberModal", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers the presets in the same units the mute badge uses", () => {
    const { w } = mountModerate();
    const labels = w.findAll("button").map((b) => b.text());
    expect(labels).toEqual(expect.arrayContaining(["5m", "1h", "24h"]));
  });

  it("mutes the member for the preset's minutes and closes", async () => {
    const { w, ch } = mountModerate();
    await buttonByText(w, "1h").trigger("click");
    await flushPromises();
    expect(ch.muteMember).toHaveBeenCalledWith("bob-id", 60);
    expect(w.emitted("update:open")).toEqual([[false]]);
  });

  it("keeps the custom Mute button disabled until a positive number is typed", async () => {
    const { w } = mountModerate();
    const apply = buttonByText(w, "Mute");
    expect(apply.attributes("disabled")).toBeDefined();
    await w.get('input[type="number"]').setValue("-3");
    expect(apply.attributes("disabled")).toBeDefined();
    await w.get('input[type="number"]').setValue("15");
    expect(apply.attributes("disabled")).toBeUndefined();
  });

  it("mutes for a custom number of whole minutes, from the button or Enter", async () => {
    const { w, ch } = mountModerate();
    const input = w.get('input[type="number"]');
    await input.setValue("7.6");
    await buttonByText(w, "Mute").trigger("click");
    await flushPromises();
    expect(ch.muteMember).toHaveBeenLastCalledWith("bob-id", 8);

    await input.setValue("42");
    await input.trigger("keyup.enter");
    await flushPromises();
    expect(ch.muteMember).toHaveBeenLastCalledWith("bob-id", 42);
  });

  it("refuses to mute a member without an identity", async () => {
    // A roster row with no id cannot be addressed over the seam; muting it
    // would broadcast a mute for nobody and close as if it had worked.
    const { w, ch } = mountModerate(member({ id: undefined }));
    await buttonByText(w, "5m").trigger("click");
    await flushPromises();
    expect(ch.muteMember).not.toHaveBeenCalled();
    expect(w.emitted("update:open")).toBeUndefined();
  });

  it("shows how long an active mute has left and lifts it early", async () => {
    const { w, ch } = mountModerate(member({ muteUntil: NOW + 90 * 60_000 }));
    expect(w.text()).toContain("Muted for 1h 30m");
    await buttonByText(w, "Unmute").trigger("click");
    await flushPromises();
    expect(ch.unmuteMember).toHaveBeenCalledWith("bob-id");
    expect(w.emitted("update:open")).toEqual([[false]]);
  });

  it("treats an expired mute as no mute at all", () => {
    const { w } = mountModerate(member({ muteUntil: NOW - 1 }));
    expect(w.text()).not.toContain("Muted for");
    expect(w.findAll("button").some((b) => b.text().includes("Unmute"))).toBe(false);
  });

  it("asks for confirmation before kicking, and kicks on the second tap", async () => {
    const { w, ch } = mountModerate();
    const kick = buttonByText(w, "Kick from room");
    await kick.trigger("click");
    expect(ch.kickMember).not.toHaveBeenCalled();
    expect(kick.text()).toContain("Confirm kick");

    await kick.trigger("click");
    await flushPromises();
    expect(ch.kickMember).toHaveBeenCalledWith("bob-id");
    expect(w.emitted("update:open")).toEqual([[false]]);
  });

  it("disarms a pending kick and clears the custom minutes when reopened", async () => {
    const { w, ch } = mountModerate();
    await buttonByText(w, "Kick from room").trigger("click");
    await w.get('input[type="number"]').setValue("9");
    await w.setProps({ open: false });
    await w.setProps({ open: true });

    expect(w.text()).toContain("Kick from room");
    expect(w.text()).not.toContain("Confirm kick");
    expect((w.get('input[type="number"]').element as HTMLInputElement).value).toBe("");
    // A single tap after reopening is a first tap again.
    await buttonByText(w, "Kick from room").trigger("click");
    expect(ch.kickMember).not.toHaveBeenCalled();
  });

  it("does not kick a member without an identity, even when confirmed", async () => {
    const { w, ch } = mountModerate(member({ id: undefined }));
    const kick = buttonByText(w, "Kick from room");
    await kick.trigger("click");
    await kick.trigger("click");
    await flushPromises();
    expect(ch.kickMember).not.toHaveBeenCalled();
  });

  it("renders only the footer with no participant, and closes from it", async () => {
    const { w } = mountModerate(null);
    expect(w.text()).not.toContain("Mute for");
    await buttonByText(w, "Close").trigger("click");
    expect(w.emitted("update:open")).toEqual([[false]]);
  });
});
