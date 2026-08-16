import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import DocumentEditor from "../../src/editors/DocumentEditor.vue";
import { i18n } from "../../src/i18n";
import { dumps, loads, newDocument } from "../../src/formats/document";

// The risk this file exists for: a schema that knows LESS than cyprian's
// silently deletes formatting the moment a document is opened and saved. Every
// custom construct gets a round-trip assertion.

function mountDoc(content: string) {
  return mount(DocumentEditor, {
    props: { path: "/tmp/a.xml", name: "a.xml", content },
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

function docWith(body: string): string {
  return dumps({ ...newDocument("T"), content: body });
}

/** What the editor would write back, after a full parse → TipTap → serialise. */
async function roundTrip(body: string): Promise<string> {
  const w = mountDoc(docWith(body));
  await flushPromises();
  const vm = w.vm as unknown as { getContent(): string };
  return loads(vm.getContent()).content;
}

describe("cyprian markup survives the editor", () => {
  it("keeps headings, emphasis and lists", async () => {
    const out = await roundTrip("<h1>Title</h1><p><strong>bold</strong> <em>it</em></p><ul><li>a</li></ul>");
    expect(out).toContain("<h1>Title</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>it</em>");
    expect(out).toContain("<li>");
  });

  it("keeps the ink mark as a class, never a style attribute", async () => {
    // The server strips style=, which is the entire reason cy-ink-* exists.
    const out = await roundTrip('<p><span class="cy-ink-accent">tinted</span></p>');
    expect(out).toContain("cy-ink-accent");
    expect(out).not.toContain("style=");
  });

  it("keeps a callout with its tone", async () => {
    const out = await roundTrip('<div class="cy-callout" data-tone="warn"><p>careful</p></div>');
    expect(out).toContain("cy-callout");
    expect(out).toContain('data-tone="warn"');
    expect(out).toContain("careful");
  });

  it("keeps a formula's latex AND its cached rendering", async () => {
    // The rendering is what the PDF shows — WeasyPrint runs no JavaScript, so
    // dropping it on round trip would silently blank every formula in exports.
    const out = await roundTrip(
      '<div class="cy-formula" data-latex="e^{i\\pi}+1=0"><span class="katex">RENDERED</span></div>');
    expect(out).toContain('data-latex="e^{i\\pi}+1=0"');
    expect(out).toContain("RENDERED");
  });

  it("keeps a page break", async () => {
    expect(await roundTrip('<p>a</p><div class="cy-pagebreak"></div><p>b</p>'))
      .toContain("cy-pagebreak");
  });

  it("keeps a table with its header row", async () => {
    const out = await roundTrip("<table><tbody><tr><th>R</th><td>1</td></tr></tbody></table>");
    expect(out).toContain("<th");
    expect(out).toContain("<td");
  });

  it("keeps an inline base64 image", async () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(await roundTrip(`<img src="${src}" alt="x">`)).toContain(src);
  });
});

describe("the envelope", () => {
  it("opens without marking the document dirty", async () => {
    const w = mountDoc(docWith("<p>hello</p>"));
    await flushPromises();
    expect((w.vm as unknown as { isDirty(): boolean }).isDirty()).toBe(false);
  });

  it("carries title, font, margins, toc and cover through a round trip", async () => {
    const source = dumps({
      ...newDocument("Report"), font: "mono", margins: "wide", toc: true, cover: true,
    });
    const w = mountDoc(source);
    await flushPromises();
    const out = loads((w.vm as unknown as { getContent(): string }).getContent());
    expect(out.title).toBe("Report");
    expect(out.font).toBe("mono");
    expect(out.margins).toBe("wide");
    expect(out.toc).toBe(true);
    expect(out.cover).toBe(true);
  });

  it("carries unknown root attributes and elements through the editor", async () => {
    const source = dumps({
      ...newDocument("X"),
      attrs: { "zz-future": "keep" },
      extra: ['<futurething a="1"/>'],
    });
    const w = mountDoc(source);
    await flushPromises();
    const written = (w.vm as unknown as { getContent(): string }).getContent();
    expect(written).toContain('zz-future="keep"');
    expect(written).toContain("futurething");
  });

  it("marks dirty when page setup changes", async () => {
    const w = mountDoc(docWith("<p>x</p>"));
    await flushPromises();
    const vm = w.vm as unknown as { isDirty(): boolean };
    expect(vm.isDirty()).toBe(false);
    await w.get('[data-testid="doc-setup"]').trigger("click");
    await w.get('[data-testid="doc-toc"]').setValue(true);
    await flushPromises();
    expect(vm.isDirty()).toBe(true);
  });
});

describe("a file that is not a document", () => {
  it("says so and offers the text editor", async () => {
    const w = mountDoc("<notadocument/>");
    await flushPromises();
    expect(w.find('[data-testid="doc-parse-error"]').exists()).toBe(true);
    expect(w.text()).toContain("not a Cyprian document");
  });
});

describe("the source knob", () => {
  it("shows the body as HTML and applies edits back through the schema", async () => {
    const w = mountDoc(docWith("<p>seed body</p>"));
    await flushPromises();
    await w.get('[data-testid="view-source"]').trigger("click");
    const src = w.get('[data-testid="doc-source"]');
    expect((src.element as HTMLTextAreaElement).value).toContain("seed body");

    // Edit the source, switch back: the change lands in the editor…
    await src.setValue("<p>from the source pane</p><script>alert(1)</script>");
    await w.get('[data-testid="view-wysiwyg"]').trigger("click");
    await flushPromises();
    const vm = w.vm as unknown as { getContent(): string };
    expect(vm.getContent()).toContain("from the source pane");
    // …and hostile markup does not: the schema drops what it does not know,
    // exactly as it would on paste.
    expect(vm.getContent()).not.toContain("<script");
  });

  it("saves what the source pane holds while it is open", async () => {
    const w = mountDoc(docWith("<p>x</p>"));
    await flushPromises();
    await w.get('[data-testid="view-source"]').trigger("click");
    await w.get('[data-testid="doc-source"]').setValue("<p>unsaved source edit</p>");
    const vm = w.vm as unknown as { getContent(): string };
    // Ctrl+S in source view must not save a stale WYSIWYG body.
    expect(vm.getContent()).toContain("unsaved source edit");
  });
});

describe("block operations", () => {
  // TipTap opens with the cursor in the FIRST block, so every case starts there.
  it("moves the current block down and back up", async () => {
    const w = mountDoc(docWith("<p>one</p><p>two</p>"));
    await flushPromises();
    const vm = w.vm as unknown as { getContent(): string };
    await w.get('[data-testid="blk-down"]').trigger("click");
    expect(vm.getContent().indexOf("two")).toBeLessThan(vm.getContent().indexOf("one"));
    await w.get('[data-testid="blk-up"]').trigger("click");
    expect(vm.getContent().indexOf("one")).toBeLessThan(vm.getContent().indexOf("two"));
  });

  it("does nothing at the edge instead of corrupting the document", async () => {
    const w = mountDoc(docWith("<p>one</p><p>two</p>"));
    await flushPromises();
    const vm = w.vm as unknown as { getContent(): string };
    const before = vm.getContent();
    await w.get('[data-testid="blk-up"]').trigger("click"); // first block: no-op
    expect(vm.getContent()).toBe(before);
  });

  it("deletes the current block, and the last block clears instead", async () => {
    const w = mountDoc(docWith("<p>one</p><p>two</p>"));
    await flushPromises();
    const vm = w.vm as unknown as { getContent(): string };
    await w.get('[data-testid="blk-del"]').trigger("click");
    expect(vm.getContent()).not.toContain("one");
    expect(vm.getContent()).toContain("two");
    // A document is never empty: deleting the only block leaves a blank one.
    await w.get('[data-testid="blk-del"]').trigger("click");
    expect(vm.getContent()).not.toContain("two");
  });

  it("adds a fresh block below the current one", async () => {
    const w = mountDoc(docWith("<p>one</p>"));
    await flushPromises();
    const vm = w.vm as unknown as { getContent(): string };
    await w.get('[data-testid="blk-add"]').trigger("click");
    // Two paragraphs now; the original text is intact.
    expect((vm.getContent().match(/<p/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(vm.getContent()).toContain("one");
  });
});
