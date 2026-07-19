import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import MapShareCard from "../../src/components/map/MapShareCard.vue";
import EnigmaMapView from "../../src/views/EnigmaMapView.vue";
import { useMapStore } from "../../src/stores/map";
import type { Message } from "../../src/stores/chat";

// Map UI components in the browser/jsdom shell: no Tauri runtime, so the view
// renders its honest degraded state; the share cards are pure prop renderers.
// The real i18n instance rides as a plugin; Teleport (OyaModal) is stubbed.

const routerPush = vi.fn();
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return { ...actual, useRouter: () => ({ push: routerPush }) };
});

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  localStorage.clear();
  routerPush.mockClear();
  pinia = createPinia();
  setActivePinia(pinia);
});

const GLOBAL = () => ({ plugins: [i18n, pinia], stubs: { teleport: true } });

function makeMessage(map: Message["map"], self = false): Message {
  return {
    id: "m1",
    type: map!.type,
    user: "alice",
    initials: "A",
    avatar_url: null,
    content: "",
    map,
    participant_type: "human",
    self,
    encrypted: true,
    timestamp: new Date(0),
  };
}

describe("MapShareCard", () => {
  it("renders a pin card and opens it in Maps only on the button press", async () => {
    const message = makeMessage({
      type: "map_pin", v: 1, name: "Meet here", lat: 52.4, lng: 16.9, note: "back door",
    });
    const wrapper = mount(MapShareCard, { props: { message }, global: GLOBAL() });
    expect(wrapper.text()).toContain("Meet here");
    expect(wrapper.text()).toContain("back door");

    const store = useMapStore();
    expect(store.pendingFocus).toBeNull(); // nothing opened automatically

    await wrapper.find("button").trigger("click");
    expect(store.pendingFocus).toMatchObject({ type: "map_pin", name: "Meet here" });
    expect(routerPush).toHaveBeenCalledWith("/map");
  });

  it("renders a route card with its point count", () => {
    const message = makeMessage({
      type: "map_route", v: 1, name: "Loop", points: [[52.4, 16.9], [52.5, 17.0]],
    });
    const wrapper = mount(MapShareCard, { props: { message }, global: GLOBAL() });
    expect(wrapper.text()).toContain("Loop");
    expect(wrapper.text()).toContain("2 points");
  });

  it("renders a region offer with size/zoom and no download button on own shares", () => {
    const manifest = {
      id: "r1", name: "Poznań", bbox: [16.8, 52.3, 17.1, 52.5] as [number, number, number, number],
      minZoom: 0, maxZoom: 12, size: 2 * 1024 * 1024, blake3: "a".repeat(64),
      sourceUrl: "", version: 1 as const,
    };
    const share = { type: "map_region" as const, v: 1 as const, manifest, offerId: "o1", addr: "x" };

    const theirs = mount(MapShareCard, { props: { message: makeMessage(share) }, global: GLOBAL() });
    expect(theirs.text()).toContain("Poznań");
    expect(theirs.text()).toContain("2.0 MB");
    expect(theirs.find("button").exists()).toBe(true); // Download

    const mine = mount(MapShareCard, {
      props: { message: makeMessage(share, true) },
      global: GLOBAL(),
    });
    expect(mine.find("button").exists()).toBe(false); // own share: nothing to download
  });
});

describe("EnigmaMapView (browser shell)", () => {
  it("renders the Map/Regions tabs and the honest desktop-only state", async () => {
    const wrapper = mount(EnigmaMapView, { global: GLOBAL() });
    expect(wrapper.text()).toContain("Regions");
    expect(wrapper.text()).toContain("Maps require the desktop or mobile app");

    // Switch to the Regions sub-tab — same degraded state, no crash.
    const regionTab = wrapper.findAll("button").find((b) => b.text().includes("Regions"))!;
    await regionTab.trigger("click");
    expect(wrapper.text()).toContain("Maps require the desktop or mobile app");
  });
});
