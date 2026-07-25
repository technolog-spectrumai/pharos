import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import EnigmaMindView from "../../src/views/EnigmaMindView.vue";
import MindDumpPanel from "../../src/components/mind/MindDumpPanel.vue";
import { getMind, resetMind } from "../../src/components/mind/useMind";
import { i18n } from "../../src/i18n";

// Mounts the real view/panels against the real mind singleton — the wiring
// between pills, panels and the orchestrator is exactly what a refactor is
// most likely to silently break.

function mountView() {
  return mount(EnigmaMindView, { global: { plugins: [i18n] } });
}

function mountDump() {
  return mount(MindDumpPanel, {
    props: { mind: getMind() },
    global: { plugins: [i18n] },
  });
}

beforeEach(() => {
  localStorage.clear();
  resetMind();
  i18n.global.locale.value = "en";
  // OyaModal teleports into <body>; drop leftovers between tests.
  document.body.innerHTML = "";
});

describe("EnigmaMindView", () => {
  it("renders the header and starts on the Map sub-tab", async () => {
    const w = mountView();
    await flushPromises();
    expect(w.text()).toContain("Mind");
    expect(w.find("[data-testid='mind-canvas']").exists()).toBe(true);
  });

  it("switches to the Dump sub-tab and back", async () => {
    const w = mountView();
    await flushPromises();
    const pills = w.findAll("button").filter((b) => ["Map", "Dump"].includes(b.text()));
    await pills[1].trigger("click");
    expect(w.find("[data-testid='mind-canvas']").exists()).toBe(false);
    expect(w.find("textarea").exists()).toBe(true);
    await pills[0].trigger("click");
    expect(w.find("[data-testid='mind-canvas']").exists()).toBe(true);
  });

  it("shows the storage banner when the doc read failed", async () => {
    const w = mountView();
    await flushPromises();
    getMind().loadFailed.value = true;
    await w.vm.$nextTick();
    expect(w.text()).toContain("will NOT be saved");
  });
});

describe("MindDumpPanel", () => {
  it("captures a draft and lists it newest-first", async () => {
    const w = mountDump();
    await getMind().load();
    await w.find("textarea").setValue("first thought");
    await w.findAll("button").find((b) => b.text().includes("Capture"))!.trigger("click");
    await w.find("textarea").setValue("second thought");
    await w.findAll("button").find((b) => b.text().includes("Capture"))!.trigger("click");

    const cards = w.text();
    expect(cards.indexOf("second thought")).toBeLessThan(cards.indexOf("first thought"));
    expect(getMind().dump.value.entries).toHaveLength(2);
  });

  it("links an entry to a topic through the picker and removes it from the list", async () => {
    const mind = getMind();
    await mind.load();
    const topic = mind.addNode("topic", "Ideas", "", 0, 0)!;
    const entry = mind.addDumpEntry("A thought\nwith body")!;

    const w = mountDump();
    await w.findAll("button").find((b) => b.text().includes("Link to topic"))!.trigger("click");
    await w.vm.$nextTick();
    // The picker is teleported to <body>, outside the wrapper's subtree.
    const topicBtn = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Ideas")!;
    topicBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await w.vm.$nextTick();

    expect(mind.dump.value.entries).toHaveLength(0);
    expect(mind.nodes.value.map((n) => n.title)).toContain("A thought");
    expect(mind.edges.value[0]).toMatchObject({ source: topic.id });
    expect(w.text()).not.toContain("A thought");
    void entry;
  });

  it("explains itself when no topics exist yet", async () => {
    const mind = getMind();
    await mind.load();
    mind.addDumpEntry("loose thought");
    const w = mountDump();
    await w.findAll("button").find((b) => b.text().includes("Link to topic"))!.trigger("click");
    await w.vm.$nextTick();
    expect(document.body.textContent).toContain("No topic nodes yet");
  });
});
