// User-tunable settings for meeting-reminder notifications.
//
// The "horizon" is how many minutes ahead of a meeting's start time the reminder
// fires. It's a purely local preference (no server round-trip), persisted in
// localStorage so it survives reloads — mirroring how the UI locale is stored.

const HORIZON_KEY = "enigma:reminder-horizon-min";

export const DEFAULT_HORIZON_MIN = 15;
export const MIN_HORIZON_MIN = 1;
export const MAX_HORIZON_MIN = 1440; // 24 h

/** Clamp to [MIN, MAX] minutes, rounded to whole minutes. Non-finite → default. */
export function clampHorizon(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HORIZON_MIN;
  return Math.min(MAX_HORIZON_MIN, Math.max(MIN_HORIZON_MIN, Math.round(n)));
}

/** Minutes-before-start for a reminder; DEFAULT_HORIZON_MIN when unset/invalid. */
export function getReminderHorizonMin(): number {
  try {
    const raw = localStorage.getItem(HORIZON_KEY);
    if (raw == null) return DEFAULT_HORIZON_MIN;
    return clampHorizon(Number(raw));
  } catch {
    return DEFAULT_HORIZON_MIN;
  }
}

/** Persist the horizon (clamped). Returns the value actually stored. */
export function setReminderHorizonMin(min: number): number {
  const v = clampHorizon(min);
  try {
    localStorage.setItem(HORIZON_KEY, String(v));
  } catch {
    /* storage unavailable */
  }
  return v;
}
