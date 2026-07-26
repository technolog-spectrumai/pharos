import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import EnigmaMindView from "../../src/views/EnigmaMindView.vue";
import MindInspector from "../../src/components/mind/MindInspector.vue";
import MindNodeEditModal from "../../src/components/mind/MindNodeEditModal.vue";
import MindTopicsPanel from "../../src/components/mind/MindTopicsPanel.vue";
import { getMind, resetMind } from "../../src/components/mind/useMind";
import { i18n } from "../../src/i18n";

// Mounts the real view/panels against the real mind singleton — the wiring
// between pills, panels, modals and the orchestrator is exactly what a
// refactor is most likely to silently break.
//
// OyaModal teleports to <body>, so modal assertions/query clicks go through
// document.*, and beforeEach clears the body.

function mountView() {
  return mount(EnigmaMindView, { global: { plugins: [i18n] } });
}

function bodyByTestId(id: string): HTMLElement {
  const el = document.body.querySelector(`[data-testid='${id}']`);
  if (!el) throw new Error(`missing [data-testid=${id}] in body`);
  return el as HTMLElement;
}

function clickInBody(id: string) {
  bodyByTestId(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function typeInBody(id: string, value: string) {
  const input = bodyByTestId(id) as HTMLInputElement | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  resetMind();
  i18n.global.locale.value = "en";
  document.body.innerHTML = "";
});

describe("EnigmaMindView", () => {
  it("renders the sub-tab bar and starts on the Map sub-tab", async () => {
    const w = mountView();
    await flushPromises();
    // The big "Mind" title was dropped when Board/Sketch/Mind moved under the
    // Notes tab (the Notes pill already labels it); the Map/Topics sub-tab bar and
    // the canvas are what confirm the view mounted on its Map sub-tab.
    const pills = w.findAll("button").map((b) => b.text());
    expect(pills).toContain("Map");
    expect(pills).toContain("Topics");
    expect(w.find("[data-testid='mind-canvas']").exists()).toBe(true);
  });

  it("switches to the Topics sub-tab and back", async () => {
    const w = mountView();
    await flushPromises();
    const pills = w.findAll("button").filter((b) => ["Map", "Topics"].includes(b.text()));
    await pills[1].trigger("click");
    expect(w.find("[data-testid='mind-canvas']").exists()).toBe(false);
    expect(w.text()).toContain("No topics yet");
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
    clickInBody("mind-import-confirm");
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

describe("MindNodeEditModal", () => {
  function mountModal() {
    return mount(MindNodeEditModal, {
      props: { mind: getMind() },
      global: { plugins: [i18n] },
    });
  }

  it("seeds drafts, saves everything as ONE undo step", async () => {
    const mind = getMind();
    await mind.load();
    const n = mind.addNode("note", "before", "<div>old</div>", 0, 0)!;
    const w = mountModal();

    mind.editNodeId.value = n.id;
    await w.vm.$nextTick();
    expect((bodyByTestId("mind-edit-title") as HTMLInputElement).value).toBe("before");

    typeInBody("mind-edit-title", "after");
    clickInBody("mind-edit-kind-topic");
    await w.vm.$nextTick();
    document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await w.vm.$nextTick();

    expect(mind.editNodeId.value).toBeNull();
    expect(mind.nodes.value[0]).toMatchObject({ title: "after", kind: "topic", content: "<div>old</div>" });
    mind.undo(); // one step unwinds the whole modal commit
    expect(mind.nodes.value[0]).toMatchObject({ title: "before", kind: "note" });
  });

  it("discard drops every draft on the floor", async () => {
    const mind = getMind();
    await mind.load();
    const n = mind.addNode("note", "untouched", "", 0, 0)!;
    const w = mountModal();

    mind.editNodeId.value = n.id;
    await w.vm.$nextTick();
    typeInBody("mind-edit-title", "scribbles");
    clickInBody("mind-edit-discard");
    await w.vm.$nextTick();

    expect(mind.editNodeId.value).toBeNull();
    expect(mind.nodes.value[0]).toMatchObject({ title: "untouched", kind: "note", content: "" });
  });

  it("plain-text mode saves escaped HTML", async () => {
    const mind = getMind();
    await mind.load();
    const n = mind.addNode("note", "n", "", 0, 0)!;
    const w = mountModal();

    mind.editNodeId.value = n.id;
    await w.vm.$nextTick();
    clickInBody("mind-edit-mode-plain");
    await w.vm.$nextTick();
    typeInBody("mind-edit-plain", "line <one>\nline & two");
    document.body.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await w.vm.$nextTick();

    expect(mind.nodes.value[0].content).toBe("line &lt;one&gt;<br>line &amp; two");
  });

  it("closes itself when the node vanishes underneath it", async () => {
    const mind = getMind();
    await mind.load();
    const n = mind.addNode("note", "doomed", "", 0, 0)!;
    const w = mountModal();

    mind.editNodeId.value = n.id;
    await w.vm.$nextTick();
    mind.deleteNode(n.id);
    await w.vm.$nextTick();
    expect(mind.editNodeId.value).toBeNull();
  });
});

describe("MindTopicsPanel", () => {
  function mountTopics() {
    return mount(MindTopicsPanel, {
      props: { mind: getMind() },
      global: { plugins: [i18n] },
    });
  }

  it("lists topics with their link counts", async () => {
    const mind = getMind();
    await mind.load();
    const t1 = mind.addNode("topic", "Alpha", "", 0, 0)!;
    mind.addNode("topic", "Beta", "", 0, 100);
    const n = mind.addNode("note", "note", "", 100, 0)!;
    mind.addEdge(n.id, t1.id);

    const w = mountTopics();
    expect(w.text()).toContain("Alpha");
    expect(w.text()).toContain("Beta");
    expect(w.text()).toContain("1 linked");
    expect(w.text()).toContain("0 linked");
  });

  it("opens details with linked nodes in either direction and a no-description hint", async () => {
    const mind = getMind();
    await mind.load();
    const topic = mind.addNode("topic", "Hub", "", 0, 0)!;
    const inbound = mind.addNode("note", "points at hub", "", 100, 0)!;
    const outbound = mind.addNode("note", "hub points here", "", 200, 0)!;
    mind.addEdge(inbound.id, topic.id);
    mind.addEdge(topic.id, outbound.id);

    const w = mountTopics();
    await w.findAll("button").find((b) => b.text().includes("Hub"))!.trigger("click");
    await w.vm.$nextTick();

    expect(document.body.textContent).toContain("points at hub");
    expect(document.body.textContent).toContain("hub points here");
    expect(document.body.textContent).toContain("No description.");
  });

  it("add note creates a note→topic link and opens the shared edit modal", async () => {
    const mind = getMind();
    await mind.load();
    const topic = mind.addNode("topic", "Hub", "", 0, 0)!;

    const w = mountTopics();
    await w.findAll("button").find((b) => b.text().includes("Hub"))!.trigger("click");
    await w.vm.$nextTick();
    clickInBody("mind-topic-add-note");
    await w.vm.$nextTick();

    expect(mind.nodes.value).toHaveLength(2);
    const note = mind.nodes.value.find((n) => n.kind === "note")!;
    expect(mind.edges.value[0]).toMatchObject({ source: note.id, target: topic.id });
    expect(mind.editNodeId.value).toBe(note.id);
  });
});

describe("MindInspector", () => {
  function mountInspector() {
    return mount(MindInspector, {
      props: { mind: getMind() },
      global: { plugins: [i18n] },
    });
  }

  it("shows the empty state, then a selection summary with the Edit door", async () => {
    const mind = getMind();
    await mind.load();
    const w = mountInspector();
    expect(w.text()).toContain("Select a node or a link");

    const n = mind.addNode("note", "Idea", "", 0, 0)!;
    mind.select({ kind: "node", id: n.id });
    await w.vm.$nextTick();
    expect(w.text()).toContain("Idea");
    await w.find("[data-testid='mind-open-edit']").trigger("click");
    expect(mind.editNodeId.value).toBe(n.id);
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
