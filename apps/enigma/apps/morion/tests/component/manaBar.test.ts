import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import App from "../../src/App.vue";
import { i18n } from "../../src/i18n";
import { manaStatus, refreshMana, type ManaStatus } from "../../src/security/mana";

// The Security Mana bar in the header. Rust (mocked) answers where it stands;
// what is pinned is what the bar shows of that, when it asks again, where it
// leads, and the responsive classes that keep it from crowding the centred
// mark.
let status: ManaStatus | null;
function makeStatus(over: Partial<ManaStatus> = {}): ManaStatus {
  return {
    max: 100, level: 72.6, drainPerHour: 1.5, regenPerHour: 1, netPerHour: -0.5,
    plainFiles: 3, plainBytes: 150 * 1024, exhausted: false, top: [], truncated: false, deep: false, kept: true, ...over,
  };
}
const invoke = vi.fn(async (cmd: string) => {
  if (cmd === "mana_status") {
    if (!status) throw "no_workspace: choose a workspace folder first";
    return status;
  }
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: [string]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

enableAutoUnmount(afterEach);

function mountApp() {
  return mount(App, { global: { plugins: [i18n, createPinia()], stubs: { teleport: true } } });
}
async function settle() {
  for (let i = 0; i < 6; i++) await flushPromises();
}
const calls = () => invoke.mock.calls.filter(([c]) => c === "mana_status").length;

beforeEach(() => {
  status = makeStatus();
  manaStatus.value = null;
  invoke.mockClear();
  localStorage.clear();
  i18n.global.locale.value = "en";
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the Security Mana bar", () => {
  it("shows the level as one progress bar in the right half, and which way it is going", async () => {
    const w = mountApp();
    await settle();
    const bar = w.get('[data-testid="header-right"] [data-testid="mana-bar"]');
    const meter = bar.get('[data-testid="mana-bar-meter"]');
    expect(meter.element.tagName).toBe("PROGRESS");
    expect((meter.element as HTMLProgressElement).value).toBe(72.6);
    expect((meter.element as HTMLProgressElement).max).toBe(100);
    expect(meter.attributes("aria-label")).toBe("Security Mana");
    expect(bar.attributes("title")).toBe(
      "Security Mana: 72.6 of 100. Plain files use 1.5 an hour; 1 comes back an hour. Opens workspace security.");
    expect(bar.attributes("data-level")).toBe("ok");
    expect(bar.attributes("data-trend")).toBe("down");
    expect(bar.get('[data-testid="mana-bar-value"]').text()).toBe("72");
  });

  it("warns at a quarter or below, says so at zero, and shows no arrow when it cannot move", async () => {
    status = makeStatus({ level: 20 });
    const w = mountApp();
    await settle();
    expect(w.get('[data-testid="mana-bar"]').attributes("data-level")).toBe("low");
    expect(w.get('[data-testid="mana-bar-meter"]').attributes("data-level")).toBe("low");

    status = makeStatus({ level: 0, exhausted: true, drainPerHour: 5, netPerHour: -4 });
    await refreshMana();
    await settle();
    const bar = w.get('[data-testid="mana-bar"]');
    expect(bar.attributes("data-level")).toBe("empty");
    expect(bar.attributes("data-trend")).toBe("flat");
    expect(w.find('[data-testid="mana-bar-trend"]').exists()).toBe(false);
    expect(bar.attributes("title")).toContain("advice, not a lock");

    status = makeStatus({ level: 40, drainPerHour: 0.2, netPerHour: 0.8 });
    await refreshMana();
    await settle();
    expect(w.get('[data-testid="mana-bar"]').attributes("data-trend")).toBe("up");
  });

  it("asks again each minute and when the window comes back — nothing ticks in Rust", async () => {
    vi.useFakeTimers();
    const w = mountApp();
    await vi.advanceTimersByTimeAsync(0);
    await settle();
    expect(w.get('[data-testid="mana-bar-value"]').text()).toBe("72");

    status = makeStatus({ level: 71.9 });
    const before = calls();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(before + 1);
    await settle();
    expect(w.get('[data-testid="mana-bar-value"]').text()).toBe("71");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(calls()).toBe(before + 2);
  });

  it("opens workspace security when clicked", async () => {
    const w = mountApp();
    await settle();
    await w.get('[data-testid="mana-bar"]').trigger("click");
    await settle();
    expect(w.find('[data-testid="workspace-security"]').exists()).toBe(true);
    expect(w.get('[data-testid="view-title"]').text()).toContain("Workspace security");
  });

  it("is absent without a workspace to count, and off the desktop", async () => {
    status = null;
    const w = mountApp();
    await settle();
    expect(w.find('[data-testid="mana-bar"]').exists()).toBe(false);

    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    status = makeStatus();
    manaStatus.value = null;
    invoke.mockClear();
    const web = mountApp();
    await settle();
    expect(web.find('[data-testid="mana-bar"]').exists()).toBe(false);
    expect(calls()).toBe(0);
  });

  it("gives way as the window narrows: the number from lg, the droplet and arrow from sm, the bar shrinks", async () => {
    const w = mountApp();
    await settle();
    expect(w.get('[data-testid="mana-bar-value"]').classes()).toEqual(expect.arrayContaining(["hidden", "lg:inline"]));
    expect(w.get('[data-testid="mana-bar-icon"]').classes()).toEqual(expect.arrayContaining(["hidden", "sm:inline-flex"]));
    expect(w.get('[data-testid="mana-bar-trend"]').classes()).toEqual(expect.arrayContaining(["hidden", "sm:inline-flex"]));
    expect(w.get('[data-testid="mana-bar-track"]').classes())
      .toEqual(expect.arrayContaining(["w-10", "sm:w-16", "lg:w-24", "min-w-6", "shrink"]));
    expect(w.get('[data-testid="mana-bar"]').classes()).toEqual(expect.arrayContaining(["min-w-0", "shrink"]));
  });
});
