import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "../../src/views/SettingsView.vue";
import { DEFAULT_PALETTE, SYSTEM_ROLES } from "petalite/theme";
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

describe("SettingsView — what a file may bring with it", () => {
  beforeEach(async () => {
    localStorage.clear();
    i18n.global.locale.value = "en";
    const { useMarkupSafety } = await import("../../src/security/useMarkupSafety");
    const m = useMarkupSafety();
    for (const k of ["isolate", "blockStyles", "blockScripts"] as const) m.set(k, false);
  });

  it("offers all three switches, every one of them off", () => {
    const w = mountSettings();
    for (const which of ["isolate", "blockStyles", "blockScripts"]) {
      const box = w.get(`[data-testid="switch-${which}"]`);
      expect((box.element as HTMLInputElement).checked, which).toBe(false);
    }
  });

  it("flips each switch independently, and remembers it", async () => {
    const { useMarkupSafety } = await import("../../src/security/useMarkupSafety");
    const w = mountSettings();
    const m = useMarkupSafety();

    await w.get('[data-testid="switch-blockScripts"]').setValue(true);
    expect(m.blockScripts.value).toBe(true);
    expect(localStorage.getItem("zinnia:blockScripts")).toBe("1");
    // Its neighbours are untouched — three switches, not one tri-state.
    expect(m.isolate.value).toBe(false);
    expect(m.blockStyles.value).toBe(false);

    // …and back off again, because a switch that only goes one way is a trap.
    await w.get('[data-testid="switch-blockScripts"]').setValue(false);
    expect(m.blockScripts.value).toBe(false);
    expect(localStorage.getItem("zinnia:blockScripts")).toBe("0");
  });

  it("says what each switch costs, not only what it buys", async () => {
    // The reason these are switches rather than defaults is that they cost
    // something, and the notes have to say so.
    const w = mountSettings();
    const text = w.get('[data-testid="markup-safety"]').text();
    expect(text).toContain("Costs a little to draw");
    expect(text).toContain("will come out plain");
  });
});
