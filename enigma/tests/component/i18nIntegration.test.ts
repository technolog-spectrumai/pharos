import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { i18n, setLocale } from "../../src/i18n";

// A throwaway component that leans on the globally-injected $t.
const Probe = defineComponent({
  template: `<div><span class="s">{{ $t('nav.chat') }}</span><span class="t">{{ $t('chat.create') }}</span></div>`,
});

beforeEach(() => {
  localStorage.clear();
  i18n.global.locale.value = "en";
});

describe("i18n plugin integration", () => {
  it("renders English by default", () => {
    const w = mount(Probe, { global: { plugins: [i18n] } });
    expect(w.get(".s").text()).toBe("Groups");
    expect(w.get(".t").text()).toBe("Create");
  });

  it("reactively re-renders when the locale switches to Polish", async () => {
    const w = mount(Probe, { global: { plugins: [i18n] } });
    setLocale("pl");
    await w.vm.$nextTick();
    expect(w.get(".s").text()).toBe("Grupy");
    expect(w.get(".t").text()).toBe("Utwórz");
  });
});
