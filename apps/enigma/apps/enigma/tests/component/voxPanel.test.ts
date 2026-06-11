import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import VoxPanel from "../../src/components/VoxPanel.vue";
import { i18n } from "../../src/i18n";

// Force a known locale so the assertions are stable.
(i18n.global.locale as any).value = "en";

describe("VoxPanel", () => {
  beforeEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
  });

  it("shows the desktop-only notice when not running under Tauri", () => {
    const wrapper = mount(VoxPanel, {
      props: { darkMode: true },
      global: { plugins: [i18n] },
    });
    expect(wrapper.text()).toContain("Voice calls are available");
  });
});
