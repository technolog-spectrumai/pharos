// Room moderation model — pure helpers shared by the chat channel and the UI.
//
// Moderation is captain-authoritative and cooperative (like all group management
// here — see technology.md §9): the elected captain (lowest live MLS id, the same
// rule as the MLS admin) broadcasts mute/kick/meta messages over the encrypted
// seam, every member validates the sender against its own locally-elected captain
// and applies the state. Enforcement is client-side: muted senders' messages are
// dropped on receive and blocked on send; a kicked (banned) identity is removed
// from the MLS group and refused re-admission by whoever is admin.

import { t } from "../i18n/chatText";

/** id → mute-expiry epoch ms. Expired entries are pruned lazily. */
export type MuteMap = Record<string, number>;

/** Room-rules length cap (chars) — keeps the meta broadcast + notices small. */
export const RULES_MAX_CHARS = 2000;

/** Mute-duration presets offered by the UI, in minutes. */
export const MUTE_PRESETS_MIN = [5, 60, 24 * 60] as const;

/** Longest accepted mute: 30 days (guards against nonsense timestamps). */
export const MUTE_MAX_MS = 30 * 24 * 3600_000;

export function clampRules(text: string): string {
  const t = text.trim();
  return t.length > RULES_MAX_CHARS ? t.slice(0, RULES_MAX_CHARS) : t;
}

/** The member's active mute expiry, or null when not muted / already expired. */
export function activeMuteUntil(mutes: MuteMap, id: string, now: number): number | null {
  const until = mutes[id];
  return typeof until === "number" && until > now ? until : null;
}

/** Validate + clamp a mute expiry coming off the wire (or from the UI). */
export function sanitizeMuteUntil(until: unknown, now: number): number | null {
  if (typeof until !== "number" || !Number.isFinite(until)) return null;
  if (until <= now) return null;
  return Math.min(until, now + MUTE_MAX_MS);
}

/** Drop expired entries. Returns the same object when nothing changed (cheap
 *  identity check for callers that persist on change). */
export function pruneMutes(mutes: MuteMap, now: number): MuteMap {
  const expired = Object.keys(mutes).filter((id) => !activeMuteUntil(mutes, id, now));
  if (!expired.length) return mutes;
  const next = { ...mutes };
  for (const id of expired) delete next[id];
  return next;
}

/**
 * "4h 05m" / "12m" / "45s" — compact remaining-time label for mute badges.
 *
 * The unit suffixes are translated: Polish abbreviates hours as "godz." and puts a
 * space before its units, so a hard-coded "h" read as English inside an otherwise
 * Polish badge. They go through the chat translator seam because this module is in
 * rakotis, which holds no catalog of its own (see ../i18n/chatText.ts).
 */
export function formatRemaining(untilMs: number, now: number): string {
  const left = Math.max(0, untilMs - now);
  const mins = Math.ceil(left / 60_000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m
      ? t("chat.dur.hoursMinutes", "{h}h {m}m", { h, m: String(m).padStart(2, "0") })
      : t("chat.dur.hours", "{h}h", { h });
  }
  if (mins > 1) return t("chat.dur.minutes", "{m}m", { m: mins });
  return t("chat.dur.seconds", "{s}s", { s: Math.max(1, Math.ceil(left / 1000)) });
}
