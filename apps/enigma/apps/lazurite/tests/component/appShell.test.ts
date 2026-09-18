import { beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import App from "../../src/App.vue";
import { KIND_FILES, NEW_FILE_KINDS } from "../../src/kinds";
import { i18n } from "../../src/i18n";
import { useWorkspace } from "petalite/files";

// The shell after the tabs: one editor host that picks its editor from the
// file, a start screen when there is none, and Security and Settings behind
// the menu rather than on the top bar.
function mountApp() {
  return mount(App, {
    global: { plugins: [i18n, createPinia()], stubs: { teleport: true } },
  });
}

/** `v-show` is a `display: none` on the element. Read directly: `isVisible()`
 *  only answers for a wrapper attached to the document. */
function shown(w: ReturnType<typeof mountApp>, testid: string): boolean {
  return (w.get(`[data-testid="${testid}"]`).element as HTMLElement).style.display !== "none";
}

async function openMenu(w: ReturnType<typeof mountApp>) {
  await w.get('[data-testid="app-menu"]').trigger("click");
}

beforeEach(() => {
  localStorage.clear();
  i18n.global.locale.value = "en";
  useWorkspace().root.value = "/home/u/work";
});

describe("the shell", () => {
  it("has no editor tabs, and no Security or Settings on the top bar", async () => {
    const w = mountApp();
    await flushPromises();
    expect(w.findAll('[data-testid^="nav-"]')).toHaveLength(0);
    expect(w.find("nav").exists()).toBe(false);
  });

  it("opens on the start screen, with no editor chosen for a file nobody opened", async () => {
    const w = mountApp();
    await flushPromises();
    expect(w.find('[data-testid="start"]').exists()).toBe(true);
    for (const name of ["DocumentEditor", "PresentationEditor", "TextEditor"]) {
      expect(w.findComponent({ name }).exists(), name).toBe(false);
    }
    // No file, so no name to show and no unsaved marker to draw.
    expect(w.find('[data-testid="file-name"]').exists()).toBe(false);
    // The three ways out of it.
    for (const kind of NEW_FILE_KINDS) {
      expect(w.find(`[data-testid="start-new-${kind.kind}"]`).exists(), kind.kind).toBe(true);
    }
    expect(w.find('[data-testid="start-open"]').exists()).toBe(true);
    expect(w.find('[data-testid="start-search"]').exists()).toBe(true);
  });

  it("puts the workspace first on the start screen: named when open, explained when not", async () => {
    const w = mountApp();
    await flushPromises();
    expect(w.get('[data-testid="start-workspace-name"]').text()).toBe("work");
    expect(w.get('[data-testid="start-workspace-pick"]').text()).toContain("Change folder");
    expect(w.get('[data-testid="start-open"]').attributes("disabled")).toBeUndefined();

    useWorkspace().root.value = "";
    await flushPromises();
    expect(w.get('[data-testid="start-workspace-none"]').text()).toBe("No workspace open");
    expect(w.get('[data-testid="start-workspace"]').text()).toContain("nothing is imported, copied or uploaded");
    expect(w.get('[data-testid="start-workspace-pick"]').text()).toContain("Choose a folder");
    // The browser build opens through a file input and needs no workspace…
    expect(w.get('[data-testid="start-open"]').attributes("disabled")).toBeUndefined();
    w.unmount();

    // …the desktop has nowhere to open from without one.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      const d = mountApp();
      await flushPromises();
      expect(d.get('[data-testid="start-open"]').attributes("disabled")).toBeDefined();
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it("mounts the editor the new file's kind needs, from the start screen", async () => {
    const w = mountApp();
    await flushPromises();
    await w.get('[data-testid="start-new-deck"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-testid="start"]').exists()).toBe(false);
    expect(w.findComponent({ name: "PresentationEditor" }).exists()).toBe(true);
    expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.pxml$/);
  });

  it("reaches Settings from the menu and workspace security from the pane, and comes back to the same file", async () => {
    const w = mountApp();
    await flushPromises();
    await w.get('[data-testid="start-new-document"]').trigger("click");
    await flushPromises();
    const doc = w.findComponent({ name: "DocumentEditor" });
    const uid = (doc.vm as unknown as { $: { uid: number } }).$.uid;

    const open = {
      settings: async () => {
        await openMenu(w);
        await w.get('[data-testid="menu-settings"]').trigger("click");
      },
      security: async () => {
        await w.get('[data-testid="files-security"]').trigger("click");
      },
    };
    for (const view of ["security", "settings"] as const) {
      await open[view]();
      await flushPromises();
      const component = view === "security" ? "WorkspaceSecurity" : "SettingsView";
      expect(w.findComponent({ name: component }).exists(), view).toBe(true);
      expect(w.get('[data-testid="view-title"]').text()).toContain(view === "security" ? "Workspace security" : "Settings");
      // The file is not on screen, so neither is its name…
      expect(w.find('[data-testid="file-name"]').exists()).toBe(false);
      // …nor the files panel, which has nothing to hand a settings page.
      expect(shown(w, "files-panel")).toBe(false);

      await w.get('[data-testid="view-close"]').trigger("click");
      await flushPromises();
      // The SAME editor instance: a look at Settings does not cost the buffer.
      const again = w.findComponent({ name: "DocumentEditor" }).vm as unknown as { $: { uid: number } };
      expect(again.$.uid).toBe(uid);
      expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.xml$/);
    }
  });

  it("does not mount a view before it is asked for", async () => {
    const w = mountApp();
    await flushPromises();
    expect(w.findComponent({ name: "WorkspaceSecurity" }).exists()).toBe(false);
    expect(w.findComponent({ name: "SettingsView" }).exists()).toBe(false);
  });

  it("turns the files panel on and puts the cursor in the notes search from the start screen", async () => {
    localStorage.setItem("zinnia:files", "0");
    const w = mountApp();
    await flushPromises();
    expect(shown(w, "files-panel")).toBe(false);
    await w.get('[data-testid="start-search"]').trigger("click");
    await flushPromises();
    expect(shown(w, "files-panel")).toBe(true);
    expect(localStorage.getItem("zinnia:files")).toBe("1");
  });
});

describe("the kind table", () => {
  it("gives each kind an extension and a translated filter name and default name", () => {
    for (const locale of ["en", "pl"] as const) {
      i18n.global.locale.value = locale;
      for (const spec of Object.values(KIND_FILES)) {
        expect(spec.extensions.length).toBeGreaterThan(0);
        expect(i18n.global.t(spec.filterKey)).not.toBe(spec.filterKey);
        expect(i18n.global.t(spec.untitledKey)).not.toBe(spec.untitledKey);
      }
      for (const item of NEW_FILE_KINDS) {
        expect(i18n.global.t(item.labelKey), `${item.labelKey} in ${locale}`).not.toBe(item.labelKey);
      }
    }
    i18n.global.locale.value = "en";
  });

  it("offers New for every kind there is", () => {
    expect(NEW_FILE_KINDS.map((k) => k.kind).sort()).toEqual(Object.keys(KIND_FILES).sort());
  });
});
