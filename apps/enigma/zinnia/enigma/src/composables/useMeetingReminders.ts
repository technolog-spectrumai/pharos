// Meeting reminders — fires a native OS notification ahead of an upcoming event.
//
// Events are the P2P-synced "events" domain (same source EventsView reads). This
// watcher lives at the app shell so reminders work no matter which screen is open:
//   • refresh()  pulls the event list (API → falls back to the y_store cache offline)
//   • tick()     every ½ minute, picks events whose start is within the user's horizon
//                (config setting) and pushes one notification each.
// Already-fired reminders are remembered in localStorage so a meeting pings once,
// keyed by id+start so a rescheduled event re-pings. The notification itself goes
// through tauri-plugin-notification on desktop/mobile, with a Web Notification
// fallback for plain-browser dev.

import { onMounted, onUnmounted } from "vue";
import { i18n } from "../i18n";
import { api, type EnigmaEvent } from "../services/api";
import * as yStore from "../services/yStore";
import { getReminderHorizonMin } from "../services/reminderSettings";

const EVENTS_DOC = "events";

// Re-evaluate the look-ahead window this often (pure in-memory, no network).
const TICK_MS = 30_000;
// Pull a fresh event list this often (network; falls back to the y_store cache).
const REFRESH_MS = 5 * 60_000;
// Don't re-notify for meetings that started more than this long ago — and the
// horizon's lower bound, so a reminder still fires if its tick lands just after start.
const GRACE_MS = 60_000;
const PRUNE_MS = 60 * 60_000; // forget fired reminders an hour after the meeting started.

const NOTIFIED_KEY = "enigma:reminder-notified";

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

const _t = i18n.global.t as unknown as (key: string, named?: Record<string, unknown>) => string;

/** Stable per-reminder key — id + start, so a rescheduled event pings again. */
export function reminderKey(e: { id: string; start_time: string }): string {
  return `${e.id}@${e.start_time}`;
}

/**
 * Pure selection of which events are due for a reminder *right now*: start time is
 * within the look-ahead `horizonMs`, hasn't already passed by more than `graceMs`,
 * and hasn't been notified yet. Exported for unit testing.
 */
export function dueReminders(
  events: readonly EnigmaEvent[],
  nowMs: number,
  horizonMs: number,
  notified: ReadonlySet<string>,
  graceMs = GRACE_MS,
): EnigmaEvent[] {
  return events.filter((e) => {
    const start = Date.parse(e.start_time);
    if (Number.isNaN(start)) return false;
    const delta = start - nowMs;
    return delta <= horizonMs && delta >= -graceMs && !notified.has(reminderKey(e));
  });
}

/** Human-readable reminder body, e.g. "Starts in 15 min · 2:00 PM". */
export function reminderBody(e: EnigmaEvent, nowMs: number): string {
  const start = Date.parse(e.start_time);
  const mins = Math.round((start - nowMs) / 60_000);
  const time = Number.isNaN(start)
    ? ""
    : new Date(start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const lead = mins <= 0 ? _t("reminders.now") : _t("reminders.inMinutes", { mins });
  return time ? `${lead} · ${time}` : lead;
}

async function fireNotification(title: string, body: string): Promise<void> {
  if (_isTauri()) {
    try {
      const m = await import("@tauri-apps/plugin-notification");
      let granted = await m.isPermissionGranted();
      if (!granted) granted = (await m.requestPermission()) === "granted";
      if (granted) m.sendNotification({ title, body });
    } catch {
      /* plugin unavailable */
    }
    return;
  }
  // Plain-browser dev fallback.
  try {
    if (typeof Notification === "undefined") return;
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm === "granted") new Notification(title, { body });
  } catch {
    /* ignore */
  }
}

function loadNotified(): Map<string, number> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY);
    if (!raw) return new Map();
    return new Map(Object.entries(JSON.parse(raw) as Record<string, number>));
  } catch {
    return new Map();
  }
}

function saveNotified(m: Map<string, number>): void {
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch {
    /* storage unavailable */
  }
}

/** App-shell watcher that fires meeting reminders. Call once (e.g. from App.vue). */
export function useMeetingReminders() {
  let events: EnigmaEvent[] = [];
  const notified = loadNotified();
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    try {
      const res = await api.getEvents();
      events = await yStore.persist<EnigmaEvent>(EVENTS_DOC, "events", res.events);
    } catch {
      events = (await yStore.cached<EnigmaEvent>(EVENTS_DOC, "events")) ?? events;
    }
  }

  async function tick() {
    const now = Date.now();
    const horizonMs = getReminderHorizonMin() * 60_000;
    const due = dueReminders(events, now, horizonMs, new Set(notified.keys()));

    for (const e of due) {
      notified.set(reminderKey(e), Date.parse(e.start_time));
      await fireNotification(e.title || _t("reminders.fallbackTitle"), reminderBody(e, now));
    }

    // Forget reminders for meetings that started well in the past, so the store
    // doesn't grow without bound.
    let changed = due.length > 0;
    for (const [key, startMs] of notified) {
      if (startMs < now - PRUNE_MS) {
        notified.delete(key);
        changed = true;
      }
    }
    if (changed) saveNotified(notified);
  }

  function onImported() {
    void refresh();
  }

  onMounted(() => {
    void (async () => {
      await refresh();
      await tick();
    })();
    tickTimer = setInterval(() => void tick(), TICK_MS);
    refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
    window.addEventListener("datasync:imported", onImported);
  });

  onUnmounted(() => {
    if (tickTimer) clearInterval(tickTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    window.removeEventListener("datasync:imported", onImported);
  });
}
