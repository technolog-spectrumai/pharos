import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import App from "../../src/App.vue";
import EditorHost from "../../src/views/EditorHost.vue";
import { i18n } from "../../src/i18n";

function mountApp() {
  return mount(App, {
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

beforeEach(() => {
  localStorage.clear();
  i18n.global.locale.value = "en";
});

describe("the file menu", () => {
  it("stands where the wordmark was and stays closed until asked", async () => {
    const w = mountApp();
    await flushPromises();
    expect(w.find('[data-testid="app-menu-panel"]').exists()).toBe(false);
    expect(w.get('[data-testid="app-menu"]').attributes("aria-expanded")).toBe("false");

    await w.get('[data-testid="app-menu"]').trigger("click");
    expect(w.find('[data-testid="app-menu-panel"]').exists()).toBe(true);
    expect(w.get('[data-testid="app-menu"]').attributes("aria-expanded")).toBe("true");
  });

  it("offers exactly new, open, save and save as", async () => {
    const w = mountApp();
    await flushPromises();
    await w.get('[data-testid="app-menu"]').trigger("click");
    for (const id of ["new", "open", "save", "saveAs"]) {
      expect(w.find(`[data-testid="menu-${id}"]`).exists(), id).toBe(true);
    }
    // Five, not four: the sketch is the default tab and it offers a PNG export,
    // which the menu renders beside the four file commands.
    expect(w.findAll('[data-testid="app-menu-panel"] [role="menuitem"]')).toHaveLength(5);
  });

  it("runs the command on the tab that is on screen, not another one", async () => {
    // The whole reason the menu holds no file state: four tabs, four open
    // files. A command that reached the wrong one would discard the wrong
    // buffer. Asserted through the effect rather than a spy — the menu calls
    // the exposed closure, which patching `vm` does not intercept.
    const w = mountApp();
    await flushPromises();

    // Dirty the WRITE tab, then leave it.
    const write = w.findComponent(EditorHost);
    write.findComponent({ name: "SketchEditor" }).vm.$emit("update:dirty", true);
    await flushPromises();
    expect((write.vm as unknown as { dirty: boolean }).dirty).toBe(true);

    await w.get('[data-testid="nav-sketch"]').trigger("click");
    await flushPromises();

    // New, on the sketch tab.
    await w.get('[data-testid="app-menu"]').trigger("click");
    await w.get('[data-testid="menu-new"]').trigger("click");
    await flushPromises();

    // The write tab's unsaved work survived: New did not reach it.
    expect((write.vm as unknown as { dirty: boolean }).dirty).toBe(true);
    // …and the header is showing the sketch tab's file.
    expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.svg$/);
  });

  it("closes after running a command", async () => {
    const w = mountApp();
    await flushPromises();
    await w.get('[data-testid="app-menu"]').trigger("click");
    await w.get('[data-testid="menu-new"]').trigger("click");
    expect(w.find('[data-testid="app-menu-panel"]').exists()).toBe(false);
  });

  it("disables every command on Settings, which has no file", async () => {
    const w = mountApp();
    await flushPromises();
    await w.get('[data-testid="nav-settings"]').trigger("click");
    await flushPromises();
    await w.get('[data-testid="app-menu"]').trigger("click");

    for (const id of ["new", "open", "save", "saveAs"]) {
      expect(w.get(`[data-testid="menu-${id}"]`).attributes("disabled"), id).toBeDefined();
    }
    expect(w.find('[data-testid="file-name"]').exists()).toBe(false);
  });

  it("leaves Save enabled for a file that has never been written", async () => {
    // A never-saved file is always savable even when untouched — there is no
    // path on disk yet, so Save means Save As. The greyed-out case is the
    // file that exists and has not changed, which needs a real write to set up
    // and is covered where saving is tested.
    const w = mountApp();
    await flushPromises();
    await w.get('[data-testid="app-menu"]').trigger("click");
    expect(w.get('[data-testid="menu-save"]').attributes("disabled")).toBeUndefined();
  });

  it("shows the open file's name and its unsaved marker", async () => {
    const w = mountApp();
    await flushPromises();
    expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.\w+$/);
    expect(w.find('[title="Unsaved changes"]').exists()).toBe(false);

    const host = w.findComponent(EditorHost);
    host.vm.$emit("update:dirty", true);
    // The host owns dirty; poke the editor the way a real edit would.
    const inner = host.findComponent({ name: "SketchEditor" });
    if (inner.exists()) inner.vm.$emit("update:dirty", true);
    await flushPromises();
    expect(w.find('[title="Unsaved changes"]').exists()).toBe(true);
  });
});

describe("keyboard shortcuts across tabs", () => {
  it("passes the on-screen flag down to the editors", async () => {
    // The mechanism: every visited tab stays MOUNTED so a half-written document
    // survives a switch, which also leaves every editor holding a live window
    // keydown listener. The flag is what stops the off-screen ones answering.
    const w = mountApp();
    await flushPromises();
    await w.get('[data-testid="nav-sketch"]').trigger("click");
    await flushPromises();

    // Switch away, then check the one left behind is still mounted and inert.
    // Settings, not the Code tab — that one was removed, and any tab that is
    // not the sketch serves to move it off screen.
    await w.get('[data-testid="nav-settings"]').trigger("click");
    await flushPromises();
    const sketch = w.findComponent({ name: "SketchEditor" });
    expect(sketch.exists()).toBe(true); // still alive, just not on screen
    expect(sketch.props("active")).toBe(false);
  });
});

describe("the export command", () => {
  it("appears only for a tab that offers one", async () => {
    // Export is per-editor: the sketch has PNG, Settings has no editor at all.
    // An entry always present and usually inert would be worse than one that
    // arrives with the tab it belongs to.
    const w = mountApp();
    await flushPromises();
    await w.get('[data-testid="nav-settings"]').trigger("click");
    await flushPromises();
    await w.get('[data-testid="app-menu"]').trigger("click");
    expect(w.find('[data-testid="menu-export"]').exists()).toBe(false);

    await w.get('[data-testid="app-menu"]').trigger("click"); // close
    await w.get('[data-testid="nav-sketch"]').trigger("click");
    await flushPromises();
    await w.get('[data-testid="app-menu"]').trigger("click");
    expect(w.find('[data-testid="menu-export"]').exists()).toBe(true);
  });

  it("is gone from the sketch's own toolbar", async () => {
    const w = mountApp();
    await flushPromises();
    await w.get('[data-testid="nav-sketch"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-testid="svg-export-png"]').exists()).toBe(false);
  });
});
