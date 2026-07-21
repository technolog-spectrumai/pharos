import { describe, it, expect, vi } from "vitest";
import { createIdleWatcher } from "../../src/idleLock";

// The watcher is deliberately clock-injected and tick-driven: it compares wall
// clock timestamps rather than trusting a timer to fire, so a suspended machine
// still locks on the first tick after it wakes. These pin that behaviour.

function harness(timeoutMs: number, isBusy: () => boolean = () => false) {
  let clock = 1_000;
  const onLock = vi.fn();
  const watcher = createIdleWatcher({ timeoutMs, onLock, isBusy, now: () => clock });
  return {
    watcher,
    onLock,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("idleLock — createIdleWatcher", () => {
  it("locks once the timeout elapses, and only once", () => {
    const h = harness(60_000);

    h.advance(59_000);
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();

    h.advance(1_000);
    h.watcher.tick();
    h.watcher.tick();
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
    expect(h.watcher.locked).toBe(true);
  });

  it("activity restarts the countdown", () => {
    const h = harness(60_000);

    h.advance(50_000);
    h.watcher.touch();
    h.advance(50_000); // 100s total, but only 50s since the last activity
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();

    h.advance(10_000);
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
  });

  it("a timeout of 0 disables locking entirely", () => {
    const h = harness(0);
    h.advance(24 * 60 * 60_000);
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();
    expect(h.watcher.remaining()).toBeNull();
  });

  it("busy work defers the lock, and the full timeout runs again afterwards", () => {
    let busy = true;
    const h = harness(60_000, () => busy);

    h.advance(120_000); // a long call: well past the deadline
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();

    busy = false; // call ends — the countdown starts over, not fires immediately
    h.advance(30_000);
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();

    h.advance(30_000);
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
  });

  it("a clock jump past the deadline (machine slept) locks on the next tick", () => {
    const h = harness(15 * 60_000);
    h.advance(6 * 60 * 60_000); // suspended for six hours: no ticks happened
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
  });

  it("changing the timeout restarts the countdown from now", () => {
    const h = harness(60_000);
    h.advance(59_000);

    h.watcher.setTimeoutMs(120_000);
    h.advance(61_000); // past the OLD deadline, not the new one
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();
    expect(h.watcher.remaining()).toBe(59_000);

    h.advance(59_000);
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
  });
});
