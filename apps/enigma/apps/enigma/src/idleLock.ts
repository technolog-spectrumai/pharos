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
// Only local input counts as activity. A message arriving from a peer is not the
// user being present, so remote events deliberately do NOT reset the countdown.

export interface IdleWatcherOptions {
  /** Inactivity before locking, ms. `<= 0` disables the watcher entirely. */
  timeoutMs: number;
  /** Called once when the deadline passes. */
  onLock: () => void;
  /** While true the countdown is held off (live call / in-flight transfer). */
  isBusy?: () => boolean;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface IdleWatcher {
  /** Record user activity — restarts the countdown. */
  touch(): void;
  /** Evaluate the deadline; fires `onLock` at most once. */
  tick(): void;
  /** Change the timeout at runtime (Settings edit); also restarts the countdown. */
  setTimeoutMs(ms: number): void;
  /** ms until the deadline, or `null` when disabled/already fired. */
  remaining(): number | null;
  readonly locked: boolean;
}

export function createIdleWatcher(opts: IdleWatcherOptions): IdleWatcher {
  const now = opts.now ?? (() => Date.now());
  const isBusy = opts.isBusy ?? (() => false);
  let timeoutMs = opts.timeoutMs;
  let last = now();
  let locked = false;

  return {
    get locked() {
      return locked;
    },
    touch() {
      last = now();
    },
    setTimeoutMs(ms: number) {
      timeoutMs = ms;
      last = now();
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
        return;
      }
      if (now() - last < timeoutMs) return;
      locked = true;
      opts.onLock();
    },
  };
}

/** Events that count as "the user is here". Passive + stamp-only, so even
 *  `mousemove` costs one assignment. */
const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

/** Longest gap between deadline checks. A short timeout tightens it (timeout/4)
 *  so a 1-minute auto-lock doesn't overshoot by a quarter of itself. */
const MAX_TICK_MS = 15_000;

export interface IdleLockHandle {
  /** Update the timeout after a Settings change (ms; `<= 0` disables). */
  setTimeoutMs(ms: number): void;
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
  const startTimer = (timeoutMs: number) => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (timeoutMs <= 0) return;
    timer = setInterval(() => watcher.tick(), Math.max(1_000, Math.min(MAX_TICK_MS, timeoutMs / 4)));
  };
  startTimer(opts.timeoutMs);

  const handle: IdleLockHandle = {
    setTimeoutMs(ms: number) {
      watcher.setTimeoutMs(ms);
      startTimer(ms);
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
