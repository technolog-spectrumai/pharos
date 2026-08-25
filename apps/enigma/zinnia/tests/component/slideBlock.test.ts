import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import SlideBlock from "../../src/editors/SlideBlock.vue";
import { i18n } from "../../src/i18n";
import type { Block } from "../../src/formats/presentation";

// A deck's `svg` and `html` blocks are the only places this app puts markup it
// did not author into the page. What is tested here is where that markup LANDS —
// in the document, or in a scope of its own — because the difference is whether
// a stylesheet a file carries can restyle the app around it.

/** The shape of the attack: an inline `<style>` inside an inline `<svg>` is
 *  scoped to the DOCUMENT, not to the SVG, so this rule reaches everything. */
const HOSTILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg">'
  + '<style>.oya-button { display: none }</style>'
  + '<rect width="10" height="10" /></svg>';

const block = (over: Partial<Block> = {}): Block => ({
  id: "b1",
  type: "svg",
  payload: HOSTILE_SVG,
  attrs: {},
  items: [],
  ...over,
}) as Block;

function mountBlock(b: Block, trustHtml = true) {
  return mount(SlideBlock, {
    props: { block: b, trustHtml },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
}

async function setSandbox(on: boolean) {
  const { useSandbox } = await import("../../src/security/useSandbox");
  useSandbox().set(on);
}

beforeEach(async () => {
  localStorage.clear();
  await setSandbox(false);
});

describe("a slide block's raw markup", () => {
  it("goes straight into the document while isolation is off", async () => {
    // The default. Stated as a test so the default is a decision, not a drift.
    const w = mountBlock(block());
    await flushPromises();
    expect(w.find('[data-testid="shadow-host"]').exists()).toBe(false);
    // The file's stylesheet is in the app's own DOM, where it applies to
    // everything — this is exactly the hole the setting exists to close.
    expect(w.html()).toContain("<style>");
    w.unmount();
  });

  it("renders inside a scope of its own once isolation is on", async () => {
    await setSandbox(true);
    const w = mountBlock(block());
    await flushPromises();

    const host = w.get('[data-testid="shadow-host"]');
    expect(host.exists()).toBe(true);
    // Nothing the file brought is in the light DOM.
    expect(w.html()).not.toContain("<style>");
    expect(w.html()).not.toContain("<rect");

    // …it is in the shadow root, where its stylesheet reaches nothing outside.
    const root = (host.element as HTMLElement).shadowRoot;
    expect(root).not.toBeNull();
    expect(root!.innerHTML).toContain("oya-button");
    expect(root!.innerHTML).toContain("<rect");
    w.unmount();
  });

  it("isolates a legacy html block the same way", async () => {
    await setSandbox(true);
    const w = mountBlock(block({ type: "html", payload: "<style>body{display:none}</style><p>hi</p>" }));
    await flushPromises();
    const root = (w.get('[data-testid="shadow-host"]').element as HTMLElement).shadowRoot;
    expect(root!.innerHTML).toContain("display:none");
    expect(w.html()).not.toContain("display:none");
    w.unmount();
  });

  it("keeps an untrusted html block inert, isolated or not", async () => {
    // `trustHtml` is the older, coarser gate and it still comes first: a deck
    // being listed rather than opened renders a placeholder either way.
    await setSandbox(true);
    const w = mountBlock(block({ type: "html", payload: "<p>hi</p>" }), false);
    await flushPromises();
    expect(w.find('[data-testid="shadow-host"]').exists()).toBe(false);
    expect(w.text()).toContain("Legacy HTML slide");
    w.unmount();
  });

  it("repaints the scope when the payload changes", async () => {
    // The host element keeps its identity across an edit, and attachShadow
    // throws if called twice — so the root is made once and refilled.
    await setSandbox(true);
    const w = mountBlock(block());
    await flushPromises();
    await w.setProps({ block: block({ payload: "<svg><circle /></svg>" }) });
    await flushPromises();
    const root = (w.get('[data-testid="shadow-host"]').element as HTMLElement).shadowRoot;
    expect(root!.innerHTML).toContain("<circle");
    expect(root!.innerHTML).not.toContain("<rect");
    w.unmount();
  });

  it("leaves the other block types alone", async () => {
    // Only the two raw-markup types change. A formula's cached KaTeX and a
    // heading's rich text are the deck format's own, and isolating them would
    // cut them off from the stylesheet that makes a slide look like a slide.
    await setSandbox(true);
    for (const type of ["heading", "text", "quote"] as const) {
      const w = mountBlock(block({ type, payload: "<em>x</em>" }));
      await flushPromises();
      expect(w.find('[data-testid="shadow-host"]').exists(), type).toBe(false);
      expect(w.html(), type).toContain("<em>");
      w.unmount();
    }
  });
});

describe("the isolation setting", () => {
  it("is off unless it was turned on", async () => {
    const { useSandbox } = await import("../../src/security/useSandbox");
    expect(useSandbox().enabled.value).toBe(false);
  });

  it("remembers the choice", async () => {
    const { useSandbox } = await import("../../src/security/useSandbox");
    useSandbox().set(true);
    expect(localStorage.getItem("zinnia:sandbox")).toBe("1");
    useSandbox().set(false);
    expect(localStorage.getItem("zinnia:sandbox")).toBe("0");
  });
});
