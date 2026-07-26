import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import SharedSharesCard from "../../src/components/map/SharedSharesCard.vue";
import type { SharedItem } from "../../src/components/map/sharedLayerModel";

// The sidebar is where an out-of-coverage share stops being invisible: the map
// can't draw it, so this card must still name it, say who shared it, and let
// the user save it.

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

const GLOBAL = () => ({ plugins: [i18n, pinia] });

function pinItem(key: string, over: Partial<SharedItem> = {}): SharedItem {
  return {
    key,
    kind: "pin",
    sender: "Bob",
    self: false,
    at: 0,
    share: { type: "map_pin", v: 1, name: `Pin ${key}`, lat: 52.4, lng: 16.9 },
    covered: true,
    ...over,
  };
}

function mountCard(props: Partial<{ onMap: SharedItem[]; outside: SharedItem[]; visible: boolean }> = {}) {
  return mount(SharedSharesCard, {
    props: { onMap: [], outside: [], visible: true, ...props },
    global: GLOBAL(),
  });
}

describe("SharedSharesCard", () => {
  it("says so when nothing has been shared", () => {
    expect(mountCard().text()).toContain("Nothing shared in this room yet");
  });

  it("lists drawable items with sender and coordinates, and emits focus/save", async () => {
    const w = mountCard({ onMap: [pinItem("a")] });
    expect(w.text()).toContain("Pin a");
    expect(w.text()).toContain("from Bob");
    expect(w.text()).toContain("52.4000");

    await w.findAll("button")[1].trigger("click"); // the row itself
    expect(w.emitted("focus")?.[0]?.[0]).toMatchObject({ key: "a" });

    await w.findAll("button").at(-1)!.trigger("click"); // the save (+) button
    expect(w.emitted("save")?.[0]?.[0]).toMatchObject({ key: "a" });
  });

  it("counts out-of-coverage items and reveals them on demand", async () => {
    const w = mountCard({
      onMap: [pinItem("here")],
      outside: [pinItem("far", { covered: false, share: { type: "map_pin", v: 1, name: "Far away", lat: 0, lng: 0 } })],
    });
    expect(w.text()).toContain("1 outside your maps");
    // Collapsed by default — the map is the primary surface.
    expect(w.text()).not.toContain("Far away");

    await w.find("[data-testid='shared-outside-toggle']").trigger("click");
    expect(w.text()).toContain("Far away");
    expect(w.text()).toContain("Import a region covering these");
  });

  it("mirrors the layer toggle", async () => {
    const w = mountCard({ onMap: [pinItem("a")], visible: false });
    await w.find("[data-testid='shared-sidebar-toggle']").trigger("click");
    expect(w.emitted("toggle")).toHaveLength(1);
  });

  it("labels your own shares as yours", () => {
    const w = mountCard({ onMap: [pinItem("mine", { self: true })] });
    expect(w.text()).toContain("you");
  });
});
