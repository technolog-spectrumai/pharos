import { describe, it, expect, vi } from "vitest";
import { createIdleWatcher, createHideWatcher } from "../../src/idleLock";

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

// ── Pre-lock warning ─────────────────────────────────────────────────────────

function warnHarness(timeoutMs: number, isBusy: () => boolean = () => false) {
  let clock = 1_000;
  const onLock = vi.fn();
  const onWarn = vi.fn();
  const watcher = createIdleWatcher({ timeoutMs, onLock, onWarn, isBusy, now: () => clock });
  return {
    watcher,
    onLock,
    onWarn,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("idleLock — pre-lock warning", () => {
  it("warns once on entering the window, with the true remaining time", () => {
    const h = warnHarness(10 * 60_000); // window = min(30s, timeout/3) = 30s

    h.advance(10 * 60_000 - 35_000);
    h.watcher.tick();
    expect(h.onWarn).not.toHaveBeenCalled();

    h.advance(10_000); // remaining 25s — inside the window
    h.watcher.tick();
    h.watcher.tick();
    expect(h.onWarn).toHaveBeenCalledTimes(1);
    expect(h.onWarn).toHaveBeenCalledWith(25_000);
    expect(h.watcher.warned).toBe(true);
    expect(h.onLock).not.toHaveBeenCalled();
  });

  it("a short timeout shrinks the window to a third", () => {
    const h = warnHarness(60_000); // window = 20s, not 30s

    h.advance(35_000); // remaining 25s — outside the 20s window
    h.watcher.tick();
    expect(h.onWarn).not.toHaveBeenCalled();

    h.advance(5_000); // remaining 20s — the window edge
    h.watcher.tick();
    expect(h.onWarn).toHaveBeenCalledTimes(1);
  });

  it("activity clears the warning, and a later idle period warns again", () => {
    const h = warnHarness(60_000);

    h.advance(45_000);
    h.watcher.tick();
    expect(h.onWarn).toHaveBeenCalledTimes(1);

    h.watcher.touch();
    expect(h.watcher.warned).toBe(false);

    h.advance(45_000);
    h.watcher.tick();
    expect(h.onWarn).toHaveBeenCalledTimes(2);
    expect(h.onLock).not.toHaveBeenCalled();
  });

  it("busy clears the warning and the full countdown runs before the next one", () => {
    let busy = false;
    const h = warnHarness(60_000, () => busy);

    h.advance(45_000);
    h.watcher.tick();
    expect(h.onWarn).toHaveBeenCalledTimes(1);

    busy = true;
    h.advance(1_000);
    h.watcher.tick(); // busy hold: countdown and warning both reset
    expect(h.watcher.warned).toBe(false);
    busy = false;

    h.advance(39_000); // remaining 21s — not yet back in the 20s window
    h.watcher.tick();
    expect(h.onWarn).toHaveBeenCalledTimes(1);

    h.advance(2_000); // remaining 19s
    h.watcher.tick();
    expect(h.onWarn).toHaveBeenCalledTimes(2);
  });

  it("a clock jump straight past the deadline locks without a pointless warning", () => {
    const h = warnHarness(15 * 60_000);
    h.advance(6 * 60 * 60_000); // suspended: no tick ever landed in the window
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
    expect(h.onWarn).not.toHaveBeenCalled();
  });

  it("changing the timeout clears the warning; timeout 0 never warns", () => {
    const h = warnHarness(60_000);
    h.advance(45_000);
    h.watcher.tick();
    expect(h.watcher.warned).toBe(true);

    h.watcher.setTimeoutMs(120_000);
    expect(h.watcher.warned).toBe(false);

    h.watcher.setTimeoutMs(0);
    h.advance(24 * 60 * 60_000);
    h.watcher.tick();
    expect(h.onWarn).toHaveBeenCalledTimes(1); // only the first one, ever
  });
});

// ── Heartbeat (feeds the Rust-side lock watchdog) ────────────────────────────

describe("idleLock — heartbeat", () => {
  function beatHarness(isBusy: () => boolean = () => false) {
    let clock = 1_000;
    const onHeartbeat = vi.fn();
    const watcher = createIdleWatcher({
      timeoutMs: 15 * 60_000,
      onLock: vi.fn(),
      onHeartbeat,
      isBusy,
      now: () => clock,
    });
    return {
      watcher,
      onHeartbeat,
      advance(ms: number) {
        clock += ms;
      },
    };
  }

  it("beats on the first activity, then throttles to one per 30s", () => {
    const h = beatHarness();

    h.watcher.touch();
    expect(h.onHeartbeat).toHaveBeenCalledTimes(1);

    h.advance(10_000);
    h.watcher.touch();
    h.advance(10_000);
    h.watcher.touch(); // 20s since the beat — still throttled
    expect(h.onHeartbeat).toHaveBeenCalledTimes(1);

    h.advance(10_000);
    h.watcher.touch(); // 30s — throttle open again
    expect(h.onHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("a busy hold also beats — Rust must not fire mid-call", () => {
    let busy = true;
    const h = beatHarness(() => busy);

    h.watcher.tick();
    expect(h.onHeartbeat).toHaveBeenCalledTimes(1);

    h.advance(31_000);
    h.watcher.tick();
    expect(h.onHeartbeat).toHaveBeenCalledTimes(2);
  });
});

// ── Lock on hide ─────────────────────────────────────────────────────────────

function hideHarness(enabled = true, isBusy: () => boolean = () => false) {
  let clock = 1_000;
  const onLock = vi.fn();
  const watcher = createHideWatcher({
    graceMs: 30_000,
    enabled,
    onLock,
    isBusy,
    now: () => clock,
  });
  return {
    watcher,
    onLock,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("idleLock — createHideWatcher", () => {
  it("locks once the grace passes while hidden, and only once", () => {
    const h = hideHarness();
    h.watcher.setHidden(true);

    h.advance(29_000);
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();

    h.advance(1_000);
    h.watcher.tick();
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
    expect(h.watcher.locked).toBe(true);
  });

  it("becoming visible before the grace resets it; re-hiding starts over", () => {
    const h = hideHarness();
    h.watcher.setHidden(true);
    h.advance(25_000);
    h.watcher.tick();
    h.watcher.setHidden(false);

    h.advance(60_000);
    h.watcher.tick(); // visible — no countdown at all
    expect(h.onLock).not.toHaveBeenCalled();

    h.watcher.setHidden(true); // grace restarts from here
    h.advance(29_000);
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();
    h.advance(1_000);
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
  });

  it("disabled: never locks; enabling mid-hide runs a fresh grace, not an insta-lock", () => {
    const h = hideHarness(false);
    h.watcher.setHidden(true);
    h.advance(60 * 60_000);
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();

    h.watcher.setEnabled(true); // an hour hidden already — grace starts NOW
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();

    h.advance(30_000);
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
  });

  it("busy holds the grace off, and it runs in full once busy ends", () => {
    let busy = true;
    const h = hideHarness(true, () => busy);
    h.watcher.setHidden(true);

    h.advance(120_000); // a long call, minimized
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();

    busy = false;
    h.advance(29_000);
    h.watcher.tick();
    expect(h.onLock).not.toHaveBeenCalled();

    h.advance(1_000);
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
  });

  it("a clock jump while hidden (slept minimized) locks on the first tick after", () => {
    const h = hideHarness();
    h.watcher.setHidden(true);
    h.advance(8 * 60 * 60_000); // minimized overnight, timers suspended
    h.watcher.tick();
    expect(h.onLock).toHaveBeenCalledTimes(1);
  });

  it("never hidden: ticks forever without locking", () => {
    const h = hideHarness();
    for (let i = 0; i < 100; i++) {
      h.advance(60_000);
      h.watcher.tick();
    }
    expect(h.onLock).not.toHaveBeenCalled();
  });
});
