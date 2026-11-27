// The room screen's header and conversation: the one-line state, Invite, the
// room menu, quiet system lines, and the invite card while alone.
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import type { ChatChannel } from "rakotis";
import { i18n } from "../../src/i18n";
import ChatHeader from "../../src/components/chat/ChatHeader.vue";
import MessageList from "../../src/components/chat/MessageList.vue";
import type { P2pRoomsController } from "../../src/components/chat/useP2pRooms";

(i18n.global.locale as any).value = "en";

function channel(over: Record<string, unknown> = {}) {
  return {
    currentRoom: ref<{ slug: string; name: string } | null>({ slug: "r1", name: "R1" }),
    p2pRooms: ref([{ room: "r1", name: "R1", host: true }]),
    mlsStatus: ref("ready"),
    wsStatus: ref("waiting"),
    linkedOnions: ref<string[]>([]),
    participants: ref([{ name: "Me" }]),
    messages: ref<any[]>([]),
    forceResetMls: vi.fn(),
    leaveParticipant: vi.fn(),
    ...over,
  };
}
const controller = () => ({ openInfo: vi.fn(), openDeleteConfirm: vi.fn() });
const opts = { global: { plugins: [i18n], stubs: { "font-awesome-icon": true } } };

describe("ChatHeader", () => {
  it("says on one line that the room is encrypted and nobody else is linked", () => {
    const w = mount(ChatHeader, { props: { channel: channel() as unknown as ChatChannel, controller: controller() as unknown as P2pRoomsController }, ...opts });
    expect(w.get("h2").text()).toBe("R1");
    const state = w.get("[data-testid=room-state]").text();
    expect(state).toContain("Encrypted");
    expect(state).toContain("Waiting for others");
  });

  it("counts the linked members", () => {
    const ch = channel({ wsStatus: ref("connected"), linkedOnions: ref(["a.onion", "b.onion"]) });
    const w = mount(ChatHeader, { props: { channel: ch as unknown as ChatChannel, controller: controller() as unknown as P2pRoomsController }, ...opts });
    expect(w.get("[data-testid=room-state]").text()).toContain("Linked to 2");
  });

  it("opens the invitation from the Invite button", async () => {
    const c = controller();
    const w = mount(ChatHeader, { props: { channel: channel() as unknown as ChatChannel, controller: c as unknown as P2pRoomsController }, ...opts });
    await w.get("[data-testid=invite-button]").trigger("click");
    expect(c.openInfo).toHaveBeenCalledWith(expect.objectContaining({ room: "r1" }));
  });

  it("keeps the rarer actions in the menu, and each closes it", async () => {
    const ch = channel();
    const c = controller();
    const w = mount(ChatHeader, { props: { channel: ch as unknown as ChatChannel, controller: c as unknown as P2pRoomsController }, ...opts });
    expect(w.find("[role=menu]").exists()).toBe(false);
    await w.get("[data-testid=room-menu]").trigger("click");
    const item = (t: string) => w.findAll("[role=menuitem]").find((b) => b.text().includes(t))!;
    await item("Reset encryption").trigger("click");
    expect(ch.forceResetMls).toHaveBeenCalled();
    expect(w.find("[role=menu]").exists()).toBe(false);
    await w.get("[data-testid=room-menu]").trigger("click");
    await item("Delete room").trigger("click");
    expect(c.openDeleteConfirm).toHaveBeenCalled();
  });
});

describe("ChatHeader — participants", () => {
  it("lists the room's participants in a modal from the room menu", async () => {
    const ch = channel({ participants: ref([{ name: "Me" }, { name: "Ann", linked: true }]) });
    const w = mount(ChatHeader, {
      props: { channel: ch as unknown as ChatChannel, controller: controller() as unknown as P2pRoomsController },
      global: { plugins: [i18n], stubs: { "font-awesome-icon": true, teleport: true } },
    });
    expect(w.find("[data-testid=participants-modal]").exists()).toBe(false);
    await w.get("[data-testid=room-menu]").trigger("click");
    await w.get("[data-testid=menu-participants]").trigger("click");
    const modal = w.get("[data-testid=participants-modal]");
    expect(modal.text()).toContain("Participants");
    expect(modal.text()).toContain("Ann");
    expect(modal.text()).toContain("Linked");
  });
});

describe("MessageList", () => {
  it("shows an invite card while we are alone, and none once someone is here", async () => {
    const ch = channel();
    const c = controller();
    const w = mount(MessageList, { props: { channel: ch as unknown as ChatChannel, controller: c as unknown as P2pRoomsController }, ...opts });
    expect(w.find("[data-testid=alone-card]").exists()).toBe(true);
    await w.get("[data-testid=alone-card] button").trigger("click");
    expect(c.openInfo).toHaveBeenCalled();
    ch.participants.value = [{ name: "Me" }, { name: "Ann" }];
    await w.vm.$nextTick();
    expect(w.find("[data-testid=alone-card]").exists()).toBe(false);
  });

  it("renders notices as quiet lines, not as messages from someone", () => {
    const ch = channel({
      messages: ref([
        { id: "1", type: "system_info", user: "System", content: "Connected to R1.", timestamp: new Date() },
        { id: "2", type: "mls_app", user: "Ann", initials: "A", content: "hi", timestamp: new Date(), self: false },
      ]),
    });
    const w = mount(MessageList, { props: { channel: ch as unknown as ChatChannel, controller: controller() as unknown as P2pRoomsController }, ...opts });
    const lines = w.findAll("[data-testid=system-line]");
    expect(lines).toHaveLength(1);
    expect(lines[0].text()).toBe("Connected to R1.");
    expect(w.findAll("article")).toHaveLength(1);
  });
});

describe("ChatHeader — route", () => {
  it("says Direct without a Beacon, Via Beacon with one, and when it is down", async () => {
    const { beaconReach } = await import("../../src/beaconMailbox");
    const onion = `${"a".repeat(56)}.onion`;
    const mk = (rooms: unknown) =>
      mount(ChatHeader, { props: { channel: channel({ p2pRooms: ref(rooms) }) as unknown as ChatChannel, controller: controller() as unknown as P2pRoomsController }, ...opts });
    expect(mk([{ room: "r1", name: "R1" }]).get("[data-testid=room-route]").text()).toBe("Direct");
    expect(mk([{ room: "r1", name: "R1", beacon: onion }]).get("[data-testid=room-route]").text()).toBe("Via Beacon");
    beaconReach.r1 = "down";
    expect(mk([{ room: "r1", name: "R1", beacon: onion }]).get("[data-testid=room-route]").text()).toBe("Beacon unreachable");
    delete beaconReach.r1;
  });
});
