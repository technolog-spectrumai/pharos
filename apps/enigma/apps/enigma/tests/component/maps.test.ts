import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import MapShareCard from "../../src/components/map/MapShareCard.vue";
import EnigmaMapView from "../../src/views/EnigmaMapView.vue";
import RegionsPanel from "../../src/components/map/RegionsPanel.vue";
import { useMapStore } from "../../src/stores/map";
import type { MapRegionManifest } from "rakotis";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
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

// ── RegionsPanel under the Tauri stub — real region rows render ───────────────
// isTauri() only checks window.__TAURI_INTERNALS__, so component tests CAN
// exercise the activate flow; the e2e browser shell cannot (no runtime).

const REGION: MapRegionManifest = {
  id: "r1",
  name: "Poznań centrum",
  bbox: [16.8, 52.3, 17.1, 52.5],
  minZoom: 0,
  maxZoom: 12,
  size: 4096,
  blake3: "a".repeat(64),
  sourceUrl: "",
  version: 1,
};

describe("EnigmaMapView — active-region :key remount (Tauri stub)", () => {
  beforeEach(() => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case "map_regions_list": return [REGION];
        case "map_storage_usage": return { usedBytes: 4096, limitBytes: 512 * 1024 * 1024 };
        case "kv_get":
          return (args as { k?: string } | undefined)?.k === "map_active_region" ? "r1" : null;
        default: return undefined;
      }
    });
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("survives the boot-time key flip when a persisted active id resolves", async () => {
    // Mount, then resolve the stored id — the MapPanel :key flips from "none"
    // to "r1" and Vue swaps the instance. The old instance's async onMounted
    // must abort at its disposal guard instead of touching the dead container
    // (this was the "Enigma hit an error while starting" crash).
    const wrapper = mount(EnigmaMapView, { global: GLOBAL() });
    await flushPromises();
    const store = useMapStore();
    await store.reload();
    await flushPromises();
    expect(store.activeRegionId).toBe("r1");
    expect(wrapper.text()).toContain("Regions"); // view alive, no render error
  });
});

describe("RegionsPanel — activate toggle (Tauri stub)", () => {
  beforeEach(() => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "map_regions_list": return [REGION];
        case "map_storage_usage": return { usedBytes: 4096, limitBytes: 512 * 1024 * 1024 };
        case "app_get_use_tor": return false;
        case "kv_get": return null;
        default: return undefined;
      }
    });
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  function activateButton(wrapper: ReturnType<typeof mount>) {
    return wrapper
      .findAll("button")
      .find((b) => {
        const title = b.attributes("title") ?? "";
        return title.includes("current map") || title === "Deactivate";
      })!;
  }

  it("activating marks the row, persists, and asks the parent for the Map tab", async () => {
    const wrapper = mount(RegionsPanel, { global: GLOBAL() });
    await flushPromises();
    expect(wrapper.text()).toContain("Poznań centrum");
    expect(wrapper.text()).not.toContain("ACTIVE"); // uppercase badge styling

    await activateButton(wrapper).trigger("click");
    await flushPromises();

    const store = useMapStore();
    expect(store.activeRegionId).toBe("r1");
    expect(wrapper.emitted("show-map")).toHaveLength(1);
    expect(wrapper.text()).toContain("Active");
    // The persisted write went to the exact key Rust reads.
    expect(invokeMock).toHaveBeenCalledWith("kv_put", {
      ns: "p2p:settings", scope: "default", k: "map_active_region", v: "r1",
    });
  });

  it("deactivating clears the choice without another tab switch", async () => {
    const wrapper = mount(RegionsPanel, { global: GLOBAL() });
    await flushPromises();
    await activateButton(wrapper).trigger("click");
    await flushPromises();
    expect(wrapper.emitted("show-map")).toHaveLength(1);

    await activateButton(wrapper).trigger("click"); // now titled "Deactivate"
    await flushPromises();

    const store = useMapStore();
    expect(store.activeRegionId).toBeNull();
    expect(wrapper.emitted("show-map")).toHaveLength(1); // no second emit
    expect(invokeMock).toHaveBeenCalledWith("kv_put", {
      ns: "p2p:settings", scope: "default", k: "map_active_region", v: "",
    });
  });
});
