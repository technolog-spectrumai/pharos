import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import EditorHost from "../../src/views/EditorHost.vue";
import { i18n } from "../../src/i18n";

// The host owns the file; the mounted editor owns the buffer. What matters
// here is the seam between them: dirty flows up, save asks the editor for its
// content, and a fresh open remounts rather than reuses the editor.
function mountHost() {
  return mount(EditorHost, { global: { plugins: [i18n], stubs: { teleport: true } } });
}

describe("the editor host", () => {
  it("mounts the sketch editor for a new drawing", async () => {
    const w = mountHost();
    await flushPromises();
    // The toolbar's tool buttons prove the sketch editor is live inside.
    expect(w.findAll("button").length).toBeGreaterThan(8);
    expect(w.find('[data-testid="file-save"]').exists()).toBe(true);
  });

  it("shows the dirty dot when the editor reports changes", async () => {
    const w = mountHost();
    await flushPromises();
    expect(w.find('[title="Unsaved changes"]').exists()).toBe(false);
    // Reach through the seam the way the editor does: the emitted event.
    w.findComponent({ name: "SketchEditor" }).vm.$emit("update:dirty", true);
    await flushPromises();
    expect(w.find('[title="Unsaved changes"]').exists()).toBe(true);
  });

  it("routes by extension", async () => {
    const w = mountHost();
    await flushPromises();
    expect(w.find('[data-testid="file-name"]').text()).toMatch(/\.svg$/);
  });
});
