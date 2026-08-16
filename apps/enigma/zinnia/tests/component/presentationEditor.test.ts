import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import PresentationEditor from "../../src/editors/PresentationEditor.vue";
import SlideBlock from "../../src/editors/SlideBlock.vue";
import { i18n } from "../../src/i18n";
import { dumps, loads, newBlock } from "../../src/formats/presentation";

const GOLDEN = join(__dirname, "..", "golden", "presentation");
const read = (f: string) => readFileSync(join(GOLDEN, f), "utf8");

function mountDeck(content: string) {
  return mount(PresentationEditor, {
    props: { path: "/tmp/d.xml", name: "d.xml", content },
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}
const vmOf = (w: ReturnType<typeof mountDeck>) =>
  w.vm as unknown as { getContent(): string; isDirty(): boolean; markSaved(): void };

describe("opening a deck", () => {
  it("does not mark it dirty, and writes it back unchanged", async () => {
    // The editor must be able to open and close a deck without touching it —
    // otherwise every file shows a diff the moment somebody looks at it.
    const xml = read("kitchen_sink.xml");
    const w = mountDeck(xml);
    await flushPromises();
    expect(vmOf(w).isDirty()).toBe(false);
    expect(vmOf(w).getContent()).toBe(xml);
  });

  it("shows the filmstrip and the slide counter", async () => {
    const w = mountDeck(read("kitchen_sink.xml"));
    await flushPromises();
    expect(w.find('[data-testid="filmstrip-0"]').exists()).toBe(true);
    expect(w.find('[data-testid="filmstrip-1"]').exists()).toBe(true);
    expect(w.get('[data-testid="slide-counter"]').text()).toBe("1 / 2");
  });

  it("says so when the file is not a presentation", async () => {
    const w = mountDeck("<document version='3'/>");
    await flushPromises();
    expect(w.find('[data-testid="deck-parse-error"]').exists()).toBe(true);
  });
});

describe("structure edits", () => {
  it("adds a slide after the current one and follows it", async () => {
    const w = mountDeck(read("kitchen_sink.xml"));
    await flushPromises();
    await w.get('[data-testid="add-slide"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-testid="slide-counter"]').text()).toBe("2 / 3");
    expect(vmOf(w).isDirty()).toBe(true);
  });

  it("changing layout keeps every block, including one whose slot vanishes", async () => {
    // The format's promise: a block keeps its own slot even when the layout has
    // no such box, so switching away and back must not shuffle the deck.
    const w = mountDeck(read("kitchen_sink.xml"));
    await flushPromises();
    await w.get('[data-testid="filmstrip-1"]').trigger("click"); // the two-column slide
    await flushPromises();

    const before = loads(vmOf(w).getContent()).slides[1];
    await w.get('[data-testid="layout-select"]').setValue("section"); // one box
    await flushPromises();
    const after = loads(vmOf(w).getContent()).slides[1];

    expect(after.layout).toBe("section");
    expect(after.blocks.length).toBe(before.blocks.length);
    // Slots are untouched in the FILE even though they all render in one box.
    expect(after.blocks.map((b) => b.slot)).toEqual(before.blocks.map((b) => b.slot));
  });

  it("round-trips a deck through an edit and back without losing unknown data", async () => {
    const w = mountDeck(read("carry_through.xml"));
    await flushPromises();
    await w.get('[data-testid="add-slide"]').trigger("click");
    await flushPromises();
    const out = vmOf(w).getContent();
    // Unknown attrs, unknown block type and unknown elements all still there.
    expect(out).toContain('zz-root="keep"');
    expect(out).toContain('zz-slide="keep"');
    expect(out).toContain('type="futuretype"');
    expect(out).toContain("weirdchild");
    expect(out).toContain("deckwide");
  });

  it("never deletes the last slide", async () => {
    const w = mountDeck(read("minimal.xml"));
    await flushPromises();
    const before = loads(vmOf(w).getContent()).slides.length;
    expect(before).toBe(1);
    // The button is disabled, and the guard holds even if it is called anyway.
    expect(loads(vmOf(w).getContent()).slides.length).toBe(1);
  });

  it("markSaved re-baselines so a saved deck is not dirty", async () => {
    const w = mountDeck(read("minimal.xml"));
    await flushPromises();
    await w.get('[data-testid="add-slide"]').trigger("click");
    await flushPromises();
    expect(vmOf(w).isDirty()).toBe(true);
    vmOf(w).markSaved();
    expect(vmOf(w).isDirty()).toBe(false);
  });
});

describe("block rendering matches memo's template", () => {
  const render = (block: Parameters<typeof newBlock>[0], trustHtml = true) =>
    mount(SlideBlock, { props: { block: newBlock(block), trustHtml } });

  it("escapes a code block rather than rendering it", () => {
    // Showing the markup is the entire point of a code block.
    const w = render({ type: "code", payload: "<b>not bold</b>" });
    expect(w.html()).toContain("&lt;b&gt;");
    expect(w.find("b").exists()).toBe(false);
  });

  it("shows a formula's cached KaTeX, and falls back to the source", () => {
    expect(render({ type: "formula", payload: "x^2", render: "<span>K</span>" }).html())
      .toContain("<span>K</span>");
    // Never a blank: a formula you can read as source beats an empty space.
    expect(render({ type: "formula", payload: "x^2" }).text()).toContain("x^2");
  });

  it("renders a legacy html block only when trusted", () => {
    expect(render({ type: "html", payload: "<i>live</i>" }, true).find("i").exists()).toBe(true);
    const inert = render({ type: "html", payload: "<i>live</i>" }, false);
    expect(inert.find("i").exists()).toBe(false);
    expect(inert.text()).toContain("Legacy");
  });

  it("shows a placeholder for a block type from a newer build", () => {
    // find(), not attributes(): the v-if chain starts with <component :is>, so
    // Vue compiles the template as a fragment and the wrapper has no single root.
    const w = render({ type: "futuretype", payload: "x" });
    expect(w.find('[data-type="unknown"]').exists()).toBe(true);
    expect(w.text()).toContain("futuretype");
  });

  it("resolves the auto-fit scale, and treats 1.0 as full size", () => {
    expect(render({ type: "text", payload: "x", attrs: { scale: "auto:0.80" } }).html())
      .toContain("0.80");
    expect(render({ type: "text", payload: "x", attrs: { scale: "1.0" } }).html())
      .not.toContain("memo-block-scale");
  });

  it("uses the heading level the block asks for", () => {
    expect(render({ type: "heading", payload: "T", attrs: { level: "1" } }).find("h1").exists()).toBe(true);
    expect(render({ type: "heading", payload: "T" }).find("h2").exists()).toBe(true); // default
  });
});

describe("the host routes by root element", () => {
  it("a deck and a document are both .xml and must not be confused", async () => {
    const { sniffIsPresentation } = await import("../../src/formats/presentation");
    const { sniffIsDocument } = await import("../../src/formats/document");
    const deck = read("minimal.xml");
    expect(sniffIsPresentation(deck)).toBe(true);
    expect(sniffIsDocument(deck)).toBe(false);
  });
});

describe("a new deck", () => {
  it("serialises to something the editor reopens as a deck", async () => {
    const { newPresentation, sniffIsPresentation } = await import("../../src/formats/presentation");
    const xml = dumps(newPresentation(""));
    expect(sniffIsPresentation(xml)).toBe(true);
    const w = mountDeck(xml);
    await flushPromises();
    expect(w.find('[data-testid="deck-parse-error"]').exists()).toBe(false);
  });
});
