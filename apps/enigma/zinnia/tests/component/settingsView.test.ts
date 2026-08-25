import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "../../src/views/SettingsView.vue";
import { DEFAULT_PALETTE, SYSTEM_ROLES } from "../../src/systemColors";
import { i18n } from "../../src/i18n";

const openDialog = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => openDialog(...a),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ size: 0, mtime: null })),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

function mountSettings() {
  return mount(SettingsView, {
    global: {
      plugins: [i18n],
      stubs: { "font-awesome-icon": true },
    },
  });
}

describe("SettingsView — the system palette", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("style");
  });

  it("offers exactly the five roles, one colour each", () => {
    const w = mountSettings();
    for (const role of SYSTEM_ROLES) {
      expect(w.find(`[data-testid="role-${role}"]`).exists(), role).toBe(true);
      expect(w.find(`[data-testid="color-${role}"]`).exists(), `${role} input`).toBe(true);
    }
    // One per role, not two: a role is one colour that reads on both papers.
    expect(w.findAll('input[type="color"]')).toHaveLength(SYSTEM_ROLES.length);
  });

  it("never offers body text as a control", () => {
    // It is shown as a fact — a swatch and a sentence — and there must be no
    // input for it: black-on-light / white-on-dark is what every document's
    // legibility rests on.
    const w = mountSettings();
    expect(w.find('[data-testid="primary-text"]').exists()).toBe(true);
    expect(w.find('[data-testid="color-text"]').exists()).toBe(false);
    expect(w.find('[data-testid="color-primaryText"]').exists()).toBe(false);
  });

  it("publishes a picked colour as a custom property and persists it", async () => {
    const w = mountSettings();
    const input = w.get('[data-testid="color-accent"]');
    (input.element as HTMLInputElement).value = "#123456";
    await input.trigger("input");

    expect(document.documentElement.style.getPropertyValue("--sys-accent")).toBe("#123456");
    // Exactly what was picked — stored and published without conversion, which
    // is what lets a file keep the colour it was saved with.
    expect(JSON.parse(localStorage.getItem("zinnia:systemColors")!).accent).toBe("#123456");
    // Its neighbours are untouched.
    expect(document.documentElement.style.getPropertyValue("--sys-mute"))
      .toBe(DEFAULT_PALETTE.mute);
  });

  it("cannot be handed a non-colour through the widget", async () => {
    // `<input type="color">` coerces anything it does not understand to
    // #000000 before the event fires, so junk never reaches the handler by
    // this route — asserted here so nobody later reads the validation in
    // onPick as dead code and deletes it. The path where an invalid value CAN
    // genuinely arrive is stored JSON, and normalizePalette is tested for it
    // in tests/unit/systemColors.test.ts.
    const w = mountSettings();
    const input = w.get('[data-testid="color-success"]');
    (input.element as HTMLInputElement).value = "not-a-colour";
    expect((input.element as HTMLInputElement).value).toBe("#000000");
    await input.trigger("input");
    expect(document.documentElement.style.getPropertyValue("--sys-success")).toBe("#000000");
  });

  it("restores every default at once", async () => {
    const w = mountSettings();
    const input = w.get('[data-testid="color-mute"]');
    (input.element as HTMLInputElement).value = "#010203";
    await input.trigger("input");
    expect(document.documentElement.style.getPropertyValue("--sys-mute")).toBe("#010203");

    await w.get('[data-testid="colors-reset"]').trigger("click");
    expect(document.documentElement.style.getPropertyValue("--sys-mute")).toBe(DEFAULT_PALETTE.mute);
  });
});

describe("SettingsView — the workspace folder", () => {
  beforeEach(async () => {
    localStorage.clear();
    openDialog.mockReset();
    i18n.global.locale.value = "en";
    const { useWorkspace } = await import("../../src/files/useWorkspace");
    useWorkspace().clearRoot();
  });

  it("says there is no workspace before one is chosen", () => {
    const w = mountSettings();
    expect(w.get('[data-testid="workspace-none"]').text()).toBe("No workspace yet.");
    expect(w.find('[data-testid="workspace-path"]').exists()).toBe(false);
    // Nothing to forget yet, so nothing offers to.
    expect(w.find('[data-testid="workspace-forget"]').exists()).toBe(false);
  });

  it("never offers a typed path", async () => {
    // A typed path gets no dialog grant, so it would be remembered and then
    // refuse to read. The picker is the only way in, deliberately.
    const { useWorkspace } = await import("../../src/files/useWorkspace");
    useWorkspace().root.value = "/home/u/work";
    const w = mountSettings();
    expect(w.findAll('input[type="text"]')).toHaveLength(0);
    expect(w.get('[data-testid="workspace-path"]').text()).toBe("/home/u/work");
  });

  it("forgets the folder without pretending the grant is gone", async () => {
    const { useWorkspace } = await import("../../src/files/useWorkspace");
    const workspace = useWorkspace();
    workspace.root.value = "/home/u/work";
    localStorage.setItem("zinnia:workspace", JSON.stringify({ root: "/home/u/work" }));
    const w = mountSettings();

    await w.get('[data-testid="workspace-forget"]').trigger("click");
    expect(workspace.root.value).toBe("");
    expect(localStorage.getItem("zinnia:workspace")).toBe(null);
    expect(w.get('[data-testid="workspace-none"]').exists()).toBe(true);
  });

  it("shows why a remembered folder is not readable", async () => {
    const { useWorkspace } = await import("../../src/files/useWorkspace");
    const workspace = useWorkspace();
    workspace.root.value = "/home/u/work";
    workspace.unreadable.value = true;
    const w = mountSettings();
    expect(w.get('[data-testid="workspace-unreadable"]').text()).toContain("Choose it again");
  });
});
