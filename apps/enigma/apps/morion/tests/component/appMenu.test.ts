import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import App from "../../src/App.vue";
import EditorHost from "../../src/views/EditorHost.vue";
import { i18n } from "../../src/i18n";
import { NEW_FILE_KINDS } from "../../src/kinds";
import { useWorkspace } from "petalite/files";

function mountApp() {
  return mount(App, {
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

async function openMenu(w: ReturnType<typeof mountApp>) {
  await w.get('[data-testid="app-menu"]').trigger("click");
}

/** New, then a kind — the two clicks the menu asks for. */
async function newFrom(w: ReturnType<typeof mountApp>, kind: string) {
  await openMenu(w);
  await w.get('[data-testid="menu-new"]').trigger("click");
  await w.get(`[data-testid="menu-new-${kind}"]`).trigger("click");
  await flushPromises();
}

beforeEach(() => {
  localStorage.clear();
  i18n.global.locale.value = "en";
  // A workspace is open, as it is for every file command below; the one
  // test about having none clears it.
  const ws = useWorkspace();
  ws.root.value = "/home/u/work";
  ws.recent.value = ["/home/u/work", "/home/u/older", "/home/u/oldest"];
});

describe("the app menu", () => {
  it("stands where the wordmark was and stays closed until asked", async () => {
    const w = mountApp();
    await flushPromises();
    expect(w.find('[data-testid="app-menu-panel"]').exists()).toBe(false);
    expect(w.get('[data-testid="app-menu"]').attributes("aria-expanded")).toBe("false");

    await openMenu(w);
    expect(w.find('[data-testid="app-menu-panel"]').exists()).toBe(true);
    expect(w.get('[data-testid="app-menu"]').attributes("aria-expanded")).toBe("true");
  });

  it("offers the workspace, the file commands, then Settings — Security lives beside the files", async () => {
    const w = mountApp();
    await flushPromises();
    await openMenu(w);
    const ids = w.findAll('[data-testid="app-menu-panel"] [role="menuitem"]')
      .map((item) => item.attributes("data-testid"));
    expect(ids).toEqual(["menu-workspace", "menu-new", "menu-open", "menu-save", "menu-saveAs", "menu-settings"]);
  });

  it("unfolds New into one entry per kind", async () => {
    const w = mountApp();
    await flushPromises();
    await openMenu(w);
    expect(w.find('[data-testid="menu-new-deck"]').exists()).toBe(false);
    await w.get('[data-testid="menu-new"]').trigger("click");
    for (const item of NEW_FILE_KINDS) {
      expect(w.find(`[data-testid="menu-new-${item.kind}"]`).exists(), item.kind).toBe(true);
    }
    // Unfolding is not a command, so the menu stays open for the pick.
    expect(w.find('[data-testid="app-menu-panel"]').exists()).toBe(true);
  });

  it("creates the chosen kind and shows it in the header", async () => {
    const w = mountApp();
    await flushPromises();
    await newFrom(w, "deck");
    expect(w.findComponent({ name: "PresentationEditor" }).exists()).toBe(true);
    expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.pxml$/);
    // …and closes after running it.
    expect(w.find('[data-testid="app-menu-panel"]').exists()).toBe(false);

    await newFrom(w, "markdown");
    expect(w.findComponent({ name: "PresentationEditor" }).exists()).toBe(false);
    expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.md$/);
  });

  it("names the workspace and unfolds to its path, a picker, the recent folders and what a workspace is", async () => {
    const w = mountApp();
    await flushPromises();
    await openMenu(w);
    expect(w.get('[data-testid="menu-workspace-name"]').text()).toBe("work");
    expect(w.find('[data-testid="menu-workspace-pick"]').exists()).toBe(false);
    await w.get('[data-testid="menu-workspace"]').trigger("click");
    expect(w.get('[data-testid="menu-workspace-path"]').text()).toBe("/home/u/work");
    expect(w.get('[data-testid="menu-workspace-pick"]').text()).toContain("Change folder");
    // The recent list leaves out the folder that is open now.
    expect(w.get('[data-testid="menu-workspace-recent-0"]').text()).toBe("older");
    expect(w.get('[data-testid="menu-workspace-recent-1"]').text()).toBe("oldest");
    expect(w.find('[data-testid="menu-workspace-recent-2"]').exists()).toBe(false);
    expect(w.get('[data-testid="menu-workspace-hint"]').text()).toContain("folder on this computer");
    // Unfolding is not a command; the menu stays open.
    expect(w.find('[data-testid="app-menu-panel"]').exists()).toBe(true);
  });

  it("says when no workspace is open, and on the desktop disables Open, which has nowhere to look", async () => {
    useWorkspace().root.value = "";
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const w = mountApp();
      await flushPromises();
      await openMenu(w);
      expect(w.get('[data-testid="menu-workspace-name"]').text()).toBe("No workspace open");
      expect(w.get('[data-testid="menu-open"]').attributes("disabled")).toBeDefined();
      await w.get('[data-testid="menu-workspace"]').trigger("click");
      expect(w.get('[data-testid="menu-workspace-pick"]').text()).toContain("Choose a folder");
      expect(w.find('[data-testid="menu-workspace-path"]').exists()).toBe(false);
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it("keeps Open working in the browser build, which has no workspace and needs none", async () => {
    useWorkspace().root.value = "";
    const w = mountApp();
    await flushPromises();
    await openMenu(w);
    expect(w.get('[data-testid="menu-open"]').attributes("disabled")).toBeUndefined();
  });

  it("disables Save and Save As while no file is open", async () => {
    const w = mountApp();
    await flushPromises();
    await openMenu(w);
    expect(w.get('[data-testid="menu-save"]').attributes("disabled")).toBeDefined();
    expect(w.get('[data-testid="menu-saveAs"]').attributes("disabled")).toBeDefined();
    expect(w.get('[data-testid="menu-new"]').attributes("disabled")).toBeUndefined();
    expect(w.get('[data-testid="menu-open"]').attributes("disabled")).toBeUndefined();
  });

  it("leaves Save enabled for a file that has never been written", async () => {
    // A never-saved file is always savable even when untouched — there is no
    // path on disk yet, so Save means Save As.
    const w = mountApp();
    await flushPromises();
    await newFrom(w, "document");
    await openMenu(w);
    expect(w.get('[data-testid="menu-save"]').attributes("disabled")).toBeUndefined();
    expect(w.get('[data-testid="menu-saveAs"]').attributes("disabled")).toBeUndefined();
  });

  it("shows the open file's name and its unsaved marker", async () => {
    const w = mountApp();
    await flushPromises();
    await newFrom(w, "document");
    expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.xml$/);
    expect(w.find('[title="Unsaved changes"]').exists()).toBe(false);

    w.findComponent({ name: "DocumentEditor" }).vm.$emit("update:dirty", true);
    await flushPromises();
    expect(w.find('[title="Unsaved changes"]').exists()).toBe(true);
  });

  it("brings the editor back when a file command is chosen from Settings", async () => {
    const w = mountApp();
    await flushPromises();
    await openMenu(w);
    await w.get('[data-testid="menu-settings"]').trigger("click");
    await flushPromises();
    expect((w.findComponent(EditorHost).element as HTMLElement).style.display).toBe("none");

    await newFrom(w, "code");
    expect((w.findComponent(EditorHost).element as HTMLElement).style.display).not.toBe("none");
    expect(w.find('[data-testid="view-title"]').exists()).toBe(false);
    expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.txt$/);
  });
});

describe("keyboard shortcuts behind a view", () => {
  it("tells the editor when it is not on screen", async () => {
    // The host stays mounted behind Settings so the buffer survives, which
    // leaves its editor holding a live window keydown listener. The flag is
    // what stops Ctrl+S in Settings saving a file nobody is looking at.
    const w = mountApp();
    await flushPromises();
    await newFrom(w, "deck");
    expect(w.findComponent({ name: "PresentationEditor" }).props("active")).toBe(true);

    await openMenu(w);
    await w.get('[data-testid="menu-settings"]').trigger("click");
    await flushPromises();
    expect(w.findComponent({ name: "PresentationEditor" }).props("active")).toBe(false);
  });
});

describe("the export command", () => {
  it("arrives with the sheet, which offers CSV, and leaves with it", async () => {
    const w = mountApp();
    await flushPromises();
    await newFrom(w, "sheet");
    expect(w.findComponent({ name: "SheetEditor" }).exists()).toBe(true);
    await openMenu(w);
    expect(w.get('[data-testid="menu-export"]').text()).toContain("CSV");
    await openMenu(w); // close

    await newFrom(w, "markdown");
    await openMenu(w);
    expect(w.find('[data-testid="menu-export"]').exists()).toBe(false);
  });

  it("arrives with a drawing, which offers PNG", async () => {
    const w = mountApp();
    await flushPromises();
    await newFrom(w, "sketch");
    expect(w.findComponent({ name: "SketchEditor" }).exists()).toBe(true);
    expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.svg$/);
    await openMenu(w);
    expect(w.get('[data-testid="menu-export"]').text()).toContain("PNG");
  });

  it("is absent while the editor on screen offers none", async () => {
    // Export is per-editor. An entry that was always there and always inert
    // would be worse than none.
    const w = mountApp();
    await flushPromises();
    await openMenu(w);
    expect(w.find('[data-testid="menu-export"]').exists()).toBe(false);

    await openMenu(w); // close
    for (const kind of ["document", "deck"]) {
      await newFrom(w, kind);
      await openMenu(w);
      expect(w.find('[data-testid="menu-export"]').exists(), kind).toBe(false);
      await openMenu(w); // close
    }
  });
});
