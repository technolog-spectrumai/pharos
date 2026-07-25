import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import EnigmaMindView from "../../src/views/EnigmaMindView.vue";
import MindDumpPanel from "../../src/components/mind/MindDumpPanel.vue";
import MindInspector from "../../src/components/mind/MindInspector.vue";
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

describe("import flow", () => {
  /** jsdom file inputs are read-only; stuff the FileList in by hand. jsdom's
   *  FileReader fires onload from a macrotask, so flushPromises alone returns
   *  too early — wait a tick loop out. */
  async function pickFile(w: ReturnType<typeof mountView>, contents: string) {
    const input = w.find("input[type='file']");
    const file = new File([contents], "mind.json", { type: "application/json" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1));
      await flushPromises();
    }
  }

  it("validates, confirms with real counts, then replaces the doc", async () => {
    const w = mountView();
    await flushPromises();
    const mind = getMind();
    mind.addNode("note", "old", "", 0, 0);

    const file = {
      format: "enigma-mind",
      version: 1,
      exportedAt: "x",
      metadata: { nodeCount: 999, edgeCount: 999 }, // lies — the modal must not repeat them
      nodes: [
        { id: "a", kind: "topic", title: "Imported", content: "", x: 0, y: 0, collapsed: false },
        { junk: true },
      ],
      edges: [],
    };
    await pickFile(w, JSON.stringify(file));

    expect(document.body.textContent).toContain("replaced with 1 nodes and 0 links");
    const confirmBtn = [...document.body.querySelectorAll("button")].find((b) =>
      b.getAttribute("data-testid") === "mind-import-confirm",
    )!;
    confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(mind.nodes.value.map((n) => n.title)).toEqual(["Imported"]);
    mind.undo();
    expect(mind.nodes.value.map((n) => n.title)).toEqual(["old"]);
  });

  it("refuses foreign JSON without touching the map", async () => {
    const w = mountView();
    await flushPromises();
    const mind = getMind();
    mind.addNode("note", "keep", "", 0, 0);

    await pickFile(w, JSON.stringify({ some: "other file" }));
    expect(w.text()).toContain("Not a valid Enigma mind map file");
    expect(mind.nodes.value.map((n) => n.title)).toEqual(["keep"]);
  });

  it("reports unparseable files", async () => {
    const w = mountView();
    await flushPromises();
    await pickFile(w, "{nope");
    expect(w.text()).toContain("Not a valid Enigma mind map file");
  });
});

describe("MindInspector", () => {
  function mountInspector() {
    return mount(MindInspector, {
      props: { mind: getMind() },
      global: { plugins: [i18n] },
    });
  }

  it("shows the empty state until something is selected", async () => {
    const mind = getMind();
    await mind.load();
    const w = mountInspector();
    expect(w.text()).toContain("Select a node or a link");

    const n = mind.addNode("note", "Idea", "", 0, 0)!;
    mind.select({ kind: "node", id: n.id });
    await w.vm.$nextTick();
    expect((w.find("[data-testid='mind-title-input']").element as HTMLInputElement).value).toBe("Idea");
  });

  it("writes title edits through, but never an empty title", async () => {
    const mind = getMind();
    await mind.load();
    const n = mind.addNode("note", "Keep", "", 0, 0)!;
    mind.select({ kind: "node", id: n.id });
    const w = mountInspector();

    await w.find("[data-testid='mind-title-input']").setValue("Renamed");
    expect(mind.nodes.value[0].title).toBe("Renamed");

    await w.find("[data-testid='mind-title-input']").setValue("   ");
    expect(mind.nodes.value[0].title).toBe("Renamed");
  });

  it("toggles the node kind", async () => {
    const mind = getMind();
    await mind.load();
    const n = mind.addNode("note", "Hub", "", 0, 0)!;
    mind.select({ kind: "node", id: n.id });
    const w = mountInspector();

    await w.find("[data-testid='mind-kind-topic']").trigger("click");
    expect(mind.nodes.value[0].kind).toBe("topic");
  });

  it("edits, swaps and deletes an edge", async () => {
    const mind = getMind();
    await mind.load();
    const a = mind.addNode("note", "A", "", 0, 0)!;
    const b = mind.addNode("note", "B", "", 100, 0)!;
    const e = mind.addEdge(a.id, b.id, "old")!;
    mind.select({ kind: "edge", id: e.id });
    const w = mountInspector();

    expect(w.text()).toContain("A → B");
    await w.find("[data-testid='mind-label-input']").setValue("relates to");
    expect(mind.edges.value[0].label).toBe("relates to");

    await w.find("[data-testid='mind-swap-edge']").trigger("click");
    expect(mind.edges.value[0].source).toBe(b.id);

    await w.find("[data-testid='mind-delete-edge']").trigger("click");
    expect(mind.edges.value).toHaveLength(0);
    expect(mind.selected.value).toBeNull();
  });

  it("the change-endpoint buttons post a reconnect request for the canvas", async () => {
    const mind = getMind();
    await mind.load();
    const a = mind.addNode("note", "A", "", 0, 0)!;
    const b = mind.addNode("note", "B", "", 100, 0)!;
    const e = mind.addEdge(a.id, b.id)!;
    mind.select({ kind: "edge", id: e.id });
    const w = mountInspector();

    await w.findAll("button").find((btn) => btn.text().includes("Move end"))!.trigger("click");
    expect(mind.reconnectRequest.value).toEqual({ edgeId: e.id, end: "target" });
  });

  it("deleting the node from the panel clears it", async () => {
    const mind = getMind();
    await mind.load();
    const n = mind.addNode("note", "Doomed", "", 0, 0)!;
    mind.select({ kind: "node", id: n.id });
    const w = mountInspector();

    await w.find("[data-testid='mind-delete-node']").trigger("click");
    expect(mind.nodes.value).toHaveLength(0);
    expect(w.text()).toContain("Select a node or a link");
  });
});
