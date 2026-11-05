// Auto-lock: after N minutes with no user activity the vault re-locks and the app
// returns to the passphrase gate (App.vue wires this; `vault_lock` does the
// Rust-side teardown and the caller reloads the webview so nothing decrypted is
// left in JS memory).
//
// Two layers so the policy is testable without a DOM:
//   • createIdleWatcher — pure logic over an injected clock. Wall-clock based on
//     purpose: a `setTimeout` never fires while the machine is asleep, so a laptop
//     suspended for an hour would come back UNLOCKED. Comparing timestamps on each
//     tick locks it the moment the lid opens instead.
//   • useIdleLock — the same watcher plus DOM listeners and an interval tick.
//
// The same split covers the opt-in "lock when hidden" policy (createHideWatcher /
// useHideLock below): window minimized → a short grace → lock.
//
// Only local input counts as activity. A message arriving from a peer is not the
// user being present, so remote events deliberately do NOT reset the countdown.
//
// The watcher also feeds the Rust-side lock watchdog (vault.rs): a throttled
// heartbeat on every countdown restart — activity or busy-hold — so Rust can
// re-lock on its own if this webview is killed, frozen, or backgrounded.

export interface IdleWatcherOptions {
  /** Inactivity before locking, ms. `<= 0` disables the watcher entirely. */
  timeoutMs: number;
  /** Called once when the deadline passes. */
  onLock: () => void;
  /** Called once per idle period when `remaining()` enters the warning window
   *  (min(30 s, timeout/3)) — the pre-lock countdown toast. */
  onWarn?: (remainingMs: number) => void;
  /** Throttled sign-of-life for the Rust watchdog: fired whenever the countdown
   *  baseline advances, at most once per `heartbeatMs`. */
  onHeartbeat?: () => void;
  /** Heartbeat throttle, ms. */
  heartbeatMs?: number;
  /** While true the countdown is held off (live call / in-flight transfer). */
  isBusy?: () => boolean;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface IdleWatcher {
  /** Record user activity — restarts the countdown (and clears a warning). */
  touch(): void;
  /** Evaluate the deadline; fires `onLock` at most once. */
  tick(): void;
  /** Change the timeout at runtime (Settings edit); also restarts the countdown. */
  setTimeoutMs(ms: number): void;
  /** ms until the deadline, or `null` when disabled/already fired. */
  remaining(): number | null;
  readonly locked: boolean;
  /** Whether the current idle period has already fired `onWarn`. */
  readonly warned: boolean;
}

/** The warning window: never more than this, never more than a third of the
 *  timeout (a 1-minute auto-lock gets a 20 s warning, not half of itself). */
const WARN_MAX_MS = 30_000;
const warnWindow = (timeoutMs: number) => Math.min(WARN_MAX_MS, timeoutMs / 3);

const HEARTBEAT_MS = 30_000;

export function createIdleWatcher(opts: IdleWatcherOptions): IdleWatcher {
  const now = opts.now ?? (() => Date.now());
  const isBusy = opts.isBusy ?? (() => false);
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  let timeoutMs = opts.timeoutMs;
  let last = now();
  // -Infinity so the very first sign of life beats immediately, whatever the clock.
  let lastBeat = Number.NEGATIVE_INFINITY;
  let locked = false;
  let warned = false;

  // The countdown baseline just advanced — tell Rust, throttled.
  const beat = () => {
    if (!opts.onHeartbeat) return;
    if (now() - lastBeat < heartbeatMs) return;
    lastBeat = now();
    opts.onHeartbeat();
  };

  return {
    get locked() {
      return locked;
    },
    get warned() {
      return warned;
    },
    touch() {
      last = now();
      warned = false;
      beat();
    },
    setTimeoutMs(ms: number) {
      timeoutMs = ms;
      last = now();
      warned = false;
    },
    remaining() {
      if (timeoutMs <= 0 || locked) return null;
      return Math.max(0, timeoutMs - (now() - last));
    },
    tick() {
      if (timeoutMs <= 0 || locked) return;
      // Busy work (a call, a transfer) counts as presence: hold the deadline off
      // and let the full timeout run again once it finishes, rather than locking
      // the instant it does.
      if (isBusy()) {
        last = now();
        warned = false;
        beat();
        return;
      }
      const idleFor = now() - last;
      // Lock before warn: a clock jump straight past the deadline (suspend)
      // should fire `onLock` alone, never a pointless warning first.
      if (idleFor >= timeoutMs) {
        locked = true;
        opts.onLock();
        return;
      }
      if (opts.onWarn && !warned && timeoutMs - idleFor <= warnWindow(timeoutMs)) {
        warned = true;
        opts.onWarn(timeoutMs - idleFor);
      }
    },
  };
}

/** Events that count as "the user is here". Passive + stamp-only, so even
 *  `mousemove` costs one assignment. */
const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

/** Longest gap between deadline checks. A short timeout tightens it (timeout/4)
 *  so a 1-minute auto-lock doesn't overshoot by a quarter of itself. 10 s also
 *  guarantees `onWarn` lands with most of its 30 s window still ahead. */
const MAX_TICK_MS = 10_000;

export interface IdleLockHandle {
  /** Update the timeout after a Settings change (ms; `<= 0` disables). */
  setTimeoutMs(ms: number): void;
  /** ms until the deadline (the warning toast polls this for its display). */
  remaining(): number | null;
  /** Whether the current idle period is inside the warning window. */
  readonly warned: boolean;
  /** Detach listeners and stop ticking. */
  stop(): void;
}

// The app shell owns exactly one watcher (App.vue). Settings edits reach it
// through `applyIdleLockMins` instead of a store or an event bus — one setter,
// no polling, and a no-op in the browser build where nothing started a watcher.
let active: IdleLockHandle | null = null;

/** Push a new Settings value (minutes; 0 = off) to the running watcher. */
export function applyIdleLockMins(mins: number): void {
  active?.setTimeoutMs(mins * 60_000);
}

/** Start watching for inactivity. Returns a handle; call `stop()` on teardown. */
export function useIdleLock(opts: IdleWatcherOptions): IdleLockHandle {
  const watcher = createIdleWatcher(opts);
  const touch = () => watcher.touch();
  for (const ev of ACTIVITY_EVENTS) {
    window.addEventListener(ev, touch, { passive: true });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let period = 0;
  const startTimer = (timeoutMs: number) => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    period = 0;
    if (timeoutMs <= 0) return;
    // Inside the warning window, tick every second instead: the countdown is on
    // screen, so a coarse tick would freeze it on its last number for seconds
    // and land the lock itself that far past the user's deadline.
    const base = Math.max(1_000, Math.min(MAX_TICK_MS, timeoutMs / 4));
    const run = () => {
      watcher.tick();
      const want = watcher.warned ? Math.min(1_000, base) : base;
      if (want !== period) {
        period = want;
        if (timer !== null) clearInterval(timer);
        timer = setInterval(run, want);
      }
    };
    period = base;
    timer = setInterval(run, base);
  };
  startTimer(opts.timeoutMs);

  const handle: IdleLockHandle = {
    setTimeoutMs(ms: number) {
      watcher.setTimeoutMs(ms);
      startTimer(ms);
    },
    remaining() {
      return watcher.remaining();
    },
    get warned() {
      return watcher.warned;
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, touch);
      if (active === handle) active = null;
    },
  };
  active = handle;
  return handle;
}

// ── Lock on hide (opt-in) ────────────────────────────────────────────────────
// Minimize / hide the window and, after a short grace, the vault locks. Same
// pure-logic/DOM split as above. The grace is mechanics, not policy — it forgives
// an accidental minimize and the spurious hidden flaps some compositors emit —
// so it is a constant, not a Settings knob. `visibilitychange` is the signal on
// purpose: minimizing fires it everywhere, while alt-tabbing away does not (the
// window is still composited), which is exactly the wanted line. A live call or
// transfer holds the lock off — minimizing during a call is normal usage.

const HIDE_GRACE_MS = 30_000;
const HIDE_TICK_MS = 5_000;

export interface HideWatcherOptions {
  /** Hidden this long → lock. `<= 0` disables. */
  graceMs: number;
  /** The Settings opt-in knob. */
  enabled: boolean;
  /** Called once when the grace passes while hidden. */
  onLock: () => void;
  /** While true the grace is held off (live call / in-flight transfer). */
  isBusy?: () => boolean;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface HideWatcher {
  /** Report a visibility change; `true` starts the grace from now. */
  setHidden(hidden: boolean): void;
  /** Flip the knob; enabling mid-hide restarts the grace (never insta-locks). */
  setEnabled(on: boolean): void;
  /** Evaluate the grace; fires `onLock` at most once. */
  tick(): void;
  readonly locked: boolean;
}

export function createHideWatcher(opts: HideWatcherOptions): HideWatcher {
  const now = opts.now ?? (() => Date.now());
  const isBusy = opts.isBusy ?? (() => false);
  let enabled = opts.enabled;
  let hidden = false;
  let hiddenSince = 0;
  let locked = false;

  return {
    get locked() {
      return locked;
    },
    setHidden(h: boolean) {
      hidden = h;
      if (h) hiddenSince = now();
    },
    setEnabled(on: boolean) {
      enabled = on;
      hiddenSince = now();
    },
    tick() {
      if (!enabled || locked || !hidden || opts.graceMs <= 0) return;
      if (isBusy()) {
        hiddenSince = now();
        return;
      }
      if (now() - hiddenSince >= opts.graceMs) {
        locked = true;
        opts.onLock();
      }
    },
  };
}

export interface HideLockHandle {
  /** Push a Settings toggle to the running watcher. */
  setEnabled(on: boolean): void;
  /** Detach the listener and stop ticking. */
  stop(): void;
}

// Same single-owner pattern as `active` above.
let activeHide: HideLockHandle | null = null;

/** Push the Settings toggle to the running hide watcher. */
export function applyLockOnHide(on: boolean): void {
  activeHide?.setEnabled(on);
}

/** Start watching for the window being hidden. Call `stop()` on teardown. */
export function useHideLock(opts: {
  enabled: boolean;
  onLock: () => void;
  isBusy?: () => boolean;
}): HideLockHandle {
  const watcher = createHideWatcher({ ...opts, graceMs: HIDE_GRACE_MS });

  // The interval only runs while hidden — zero steady-state cost. Hidden webviews
  // may throttle or suspend timers entirely, so on the way back to visible we
  // tick BEFORE clearing the hidden flag: a machine minimized overnight locks the
  // instant the window is restored, before anything decrypted repaints.
  let timer: ReturnType<typeof setInterval> | null = null;
  const onVisibility = () => {
    if (document.hidden) {
      watcher.setHidden(true);
      if (timer === null) timer = setInterval(() => watcher.tick(), HIDE_TICK_MS);
    } else {
      watcher.tick();
      watcher.setHidden(false);
      if (timer !== null) clearInterval(timer);
      timer = null;
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  // Sample the current state too: nothing fires an event for a window that is
  // ALREADY hidden when the watcher starts (minimize during the unlock's key
  // derivation, say), and without this it would stay unhidden until the next
  // hide — the exposure the setting exists to prevent.
  onVisibility();

  const handle: HideLockHandle = {
    setEnabled(on: boolean) {
      watcher.setEnabled(on);
    },
    stop() {
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (activeHide === handle) activeHide = null;
    },
  };
  activeHide = handle;
  return handle;
}
