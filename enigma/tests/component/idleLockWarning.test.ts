// The pre-lock countdown toast. It reads the idle watcher rather than keeping
// its own clock — `remaining()` is wall-clock based, so a throttled timer can't
// skew the number — and it gets out of the way the moment the watcher stops
// warning (any activity clears `warned`), or when the lock is off altogether.
// The watcher itself is covered in tests/unit/idleLock.test.ts; here it is a
// hand-driven stand-in, and the 250 ms poll runs on fake timers.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "../../src/i18n";
import IdleLockWarning from "../../src/components/IdleLockWarning.vue";
import type { IdleLockHandle } from "../../src/idleLock";

(i18n.global.locale as unknown as { value: string }).value = "en";

let state: { remaining: number | null; warned: boolean };
let polls: number;
const handle: IdleLockHandle = {
  setTimeoutMs: () => {},
  remaining: () => {
    polls += 1;
    return state.remaining;
  },
  get warned() {
    return state.warned;
  },
  stop: () => {},
};

beforeEach(() => {
  vi.useFakeTimers();
  state = { remaining: 9_000, warned: true };
  polls = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Mounted and through its first poll, which runs in onMounted and re-renders. */
async function mountToast() {
  const w = mount(IdleLockWarning, { props: { handle }, global: { plugins: [i18n] } });
  await w.vm.$nextTick();
  return w;
}
const body = (w: Awaited<ReturnType<typeof mountToast>>) => w.find("p.text-xs").text();

describe("IdleLockWarning", () => {
  it("counts down in whole seconds, rounding up", async () => {
    state.remaining = 8_001;
    const w = await mountToast();
    expect(w.attributes("role")).toBe("alert");
    expect(w.text()).toContain("Auto-lock imminent");
    expect(body(w)).toBe("Locking in 9 s — move the mouse or press a key to stay unlocked.");

    state.remaining = 4_000;
    await vi.advanceTimersByTimeAsync(250);
    expect(body(w)).toContain("Locking in 4 s");
  });

  it("never shows 0 s while the lock has not happened yet", async () => {
    state.remaining = 120;
    const w = await mountToast();
    expect(body(w)).toContain("Locking in 1 s");
    state.remaining = 0;
    await vi.advanceTimersByTimeAsync(250);
    expect(body(w)).toContain("Locking in 1 s");
  });

  it("closes itself once activity clears the warning", async () => {
    const w = await mountToast();
    await vi.advanceTimersByTimeAsync(500);
    expect(w.emitted("close")).toBeUndefined();

    state.warned = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("closes at once when the idle lock is off (no deadline to count to)", async () => {
    state.remaining = null;
    const w = await mountToast();
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("Stay unlocked closes it without waiting for the next poll", async () => {
    const w = await mountToast();
    await w.find("button").trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("stops polling once it is gone", async () => {
    const w = await mountToast();
    await vi.advanceTimersByTimeAsync(1_000);
    const before = polls;
    w.unmount();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls).toBe(before);
  });
});
