import { describe, it, expect, afterAll, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { initBuildConfig, getDhtDiscovery, setDhtDiscovery } from "rakotis";

// A build without the `dht` feature (Standard — technology.md §20) must not merely
// disable the DHT: every surface that mentions it has to GO. The off-state copy
// for each one ("Enable DHT discovery in Settings…", "Turn on DHT discovery…")
// points at a Settings→Connections card that does not exist in such a build, so
// leaving a surface visible would instruct the user to do something impossible.
//
// The two big views (Settings, Contacts) gate on the same `dhtAllowed` const and
// are not mounted here — no test in this repo mounts them, and Contacts is
// Pro-only anyway, i.e. only ever built alongside the DHT. What IS pinned here
// is the component-level surfaces plus the rakotis choke point they all rely on.

const voxStub = {
  available: ref(true),
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
vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({
    vox: voxStub,
    p2p: { participants: ref([]), mlsIdentity: ref("me") },
  }),
}));

import VoxPanel from "../../src/components/vox/VoxPanel.vue";
import RoomInfoModal from "../../src/components/chat/RoomInfoModal.vue";
import { i18n } from "../../src/i18n";

(i18n.global.locale as any).value = "en";

// setup.ts seeds a DHT-capable build; this file is about the other case. The
// components read the flag at setup time, so this must run before any mount.
await initBuildConfig({ dht_enabled: false });
afterAll(async () => {
  await initBuildConfig({ dht_enabled: true });
});

const ROOM_WITH_CODE = {
  room: "topic-abc",
  name: "Book club",
  ticket: "iroh-ticket-blob",
  // A room joined/created by a DHT-capable build keeps its code in kv, and
  // `p2p:rooms` replicates over the device-link rail — so a DHT-less build can
  // genuinely hold one. It must not offer a code it cannot serve.
  code: "dabcdefghijklmnop",
  peers: [] as string[],
};

function mountRoomInfo() {
  return mount(RoomInfoModal, {
    props: {
      open: true,
      controller: { infoRoom: ref(ROOM_WITH_CODE) } as any,
      channel: {
        currentRoom: ref(null),
        amCaptain: ref(false),
        roomLogo: ref(""),
        roomRules: ref(""),
        // Part of the channel contract since invite-only rooms: false = open.
        inviteOnly: ref(false),
      } as any,
    },
    global: { plugins: [i18n, pinia] },
  });
}

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); });

describe("a build without the DHT has no DHT surface", () => {
  it("rakotis reads the toggle as off whatever the kv says", async () => {
    await setDhtDiscovery(true);
    expect(await getDhtDiscovery()).toBe(false);
  });

  it("Vox drops call-by-nickname but keeps the ticket and room-member flows", () => {
    const wrapper = mount(VoxPanel, { props: { darkMode: true }, global: { plugins: [i18n, pinia] } });
    const text = wrapper.text();
    expect(text).not.toContain("Call by nickname");
    // The instruction that cannot be followed. This one assertion covers every
    // "…in Settings" string, so a sixth surface added later fails loudly here.
    expect(text).not.toContain("DHT discovery in Settings");
    // Still a usable Vox tab: this is what Plus ships.
    expect(text).toContain("Start a call");
  });

  it("room info offers no standing room credential at all", () => {
    mountRoomInfo();
    // OyaModal teleports to <body>, and OyaCopyField renders its payload as a
    // readonly input value rather than text — so read both from the document.
    const shown = [...document.body.querySelectorAll("input")].map((i) => i.value);
    // Neither of the two permanent credentials this app used to hand out: the
    // room code was always DHT-gated, and the ticket is gone from every build.
    expect(shown).not.toContain(ROOM_WITH_CODE.code);
    expect(shown).not.toContain(ROOM_WITH_CODE.ticket);
    expect(document.body.textContent).not.toContain("join without a ticket");
  });
});

// Positive controls: without these, the assertions above would still pass if
// the surfaces had been deleted outright or the fixtures stopped matching.
describe("the same surfaces are present when the build HAS the DHT", () => {
  it("shows call-by-nickname and the room code", async () => {
    await initBuildConfig({ dht_enabled: true });
    document.body.innerHTML = "";
    try {
      const vox = mount(VoxPanel, { props: { darkMode: true }, global: { plugins: [i18n, pinia] } });
      expect(vox.text()).toContain("Call by nickname");

      // Room info shows no credential on a DHT build either — the room code is
      // not a way in any more, so enabling the DHT does not bring one back.
      mountRoomInfo();
      const shown = [...document.body.querySelectorAll("input")].map((i) => i.value);
      expect(shown).not.toContain(ROOM_WITH_CODE.code);
    } finally {
      await initBuildConfig({ dht_enabled: false });
    }
  });
});
