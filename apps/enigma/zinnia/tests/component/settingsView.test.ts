import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import SettingsView from "../../src/views/SettingsView.vue";
import { DEFAULT_PALETTE, SYSTEM_ROLES } from "../../src/systemColors";
import { i18n } from "../../src/i18n";

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

  it("offers exactly the five roles, both modes each", () => {
    const w = mountSettings();
    for (const role of SYSTEM_ROLES) {
      expect(w.find(`[data-testid="role-${role}"]`).exists(), role).toBe(true);
      expect(w.find(`[data-testid="color-${role}-light"]`).exists(), `${role} light`).toBe(true);
      expect(w.find(`[data-testid="color-${role}-dark"]`).exists(), `${role} dark`).toBe(true);
    }
    expect(w.findAll('input[type="color"]')).toHaveLength(SYSTEM_ROLES.length * 2);
  });

  it("never offers body text as a control", () => {
    // It is shown as a fact — a swatch and a sentence — and there must be no
    // input for it: black-on-light / white-on-dark is what every document's
    // legibility rests on.
    const w = mountSettings();
    expect(w.find('[data-testid="primary-text"]').exists()).toBe(true);
    expect(w.find('[data-testid="color-text-light"]').exists()).toBe(false);
    expect(w.find('[data-testid="color-primaryText-light"]').exists()).toBe(false);
  });

  it("publishes a picked colour as a custom property and persists it", async () => {
    const w = mountSettings();
    const input = w.get('[data-testid="color-accent-dark"]');
    (input.element as HTMLInputElement).value = "#123456";
    await input.trigger("input");

    // Published for the dark mode slot only — the light one is untouched.
    expect(document.documentElement.style.getPropertyValue("--sys-accent-dark")).toBe("#123456");
    expect(document.documentElement.style.getPropertyValue("--sys-accent-light"))
      .toBe(DEFAULT_PALETTE.accent.light);
    expect(JSON.parse(localStorage.getItem("zinnia:systemColors")!).accent.dark).toBe("#123456");
  });

  it("cannot be handed a non-colour through the widget", async () => {
    // `<input type="color">` coerces anything it does not understand to
    // #000000 before the event fires, so junk never reaches the handler by
    // this route — asserted here so nobody later reads the validation in
    // onPick as dead code and deletes it. The path where an invalid value CAN
    // genuinely arrive is stored JSON, and normalizePalette is tested for it
    // in tests/unit/systemColors.test.ts.
    const w = mountSettings();
    const input = w.get('[data-testid="color-success-light"]');
    (input.element as HTMLInputElement).value = "not-a-colour";
    expect((input.element as HTMLInputElement).value).toBe("#000000");
    await input.trigger("input");
    expect(document.documentElement.style.getPropertyValue("--sys-success-light")).toBe("#000000");
  });

  it("restores every default at once", async () => {
    const w = mountSettings();
    const input = w.get('[data-testid="color-mute-light"]');
    (input.element as HTMLInputElement).value = "#010203";
    await input.trigger("input");
    expect(document.documentElement.style.getPropertyValue("--sys-mute-light")).toBe("#010203");

    await w.get('[data-testid="colors-reset"]').trigger("click");
    expect(document.documentElement.style.getPropertyValue("--sys-mute-light"))
      .toBe(DEFAULT_PALETTE.mute.light);
  });
});
