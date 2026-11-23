// The Tor indicator in the app bar: what it says for each state Rust reports,
// and that it opens the Tor card in Settings.
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import { i18n } from "../../src/i18n";
import TorIndicator from "../../src/components/TorIndicator.vue";
import { torState } from "../../src/stores/tor";

(i18n.global.locale as any).value = "en";

async function mountIt() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/:any(.*)*", component: { render: () => null } }] });
  await router.push("/chat");
  const w = mount(TorIndicator, { global: { plugins: [i18n, router], stubs: { "font-awesome-icon": true } } });
  return { w, router };
}

describe("TorIndicator", () => {
  it.each([
    ["on", "Tor on"],
    ["starting", "Tor starting…"],
    ["off", "Tor off"],
    ["error", "Tor error"],
  ] as const)("says %s as “%s”", async (state, text) => {
    torState.value = state;
    const { w } = await mountIt();
    expect(w.text()).toContain(text);
    expect(w.get("[data-testid=tor-indicator]").attributes("data-state")).toBe(state);
  });

  it("opens the Tor card in Settings", async () => {
    torState.value = "on";
    const { w, router } = await mountIt();
    await w.get("button").trigger("click");
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe("/config?tab=connections"));
  });
});
