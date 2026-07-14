// Meeting-scheduling orchestrator — create/invite/RSVP/edit/cancel + reminders.
//
// Invites ride the p2p chat's MLS-encrypted channel via the `onSync`/`sendSync`
// seam (`meeting_*` inner types), exactly like file-share signaling. The chat
// log only gets a plain system_info notice ("X invited you to …"); the actual
// RSVP happens in the Calendar tab. Every profile persists its own copy of the
// meeting list in the encrypted kv store (namespace "meetings" — protasius
// seals the value at rest, nothing extra to do here).
//
// Delivery model: `sendSync` reaches only the *currently connected* members of
// the *open* room, so meetings carry an outbox flag (`needsBroadcast`) that is
// flushed when the room's MLS session becomes ready, and the organizer
// re-broadcasts its future meetings whenever the participant list grows
// (late joiners and reconnecting members catch up; upserts are rev-guarded and
// idempotent). Residual gap, accepted for v1: an invitee who is never online
// at the same time as the organizer never learns about the meeting.
//
// Trust model: cooperative — see meetingModel.ts.

import { computed, ref, watch } from "vue";
import { getMeetingReminderMins, kvGet, kvPut } from "rakotis";
import type { ChatChannel } from "rakotis";
import { i18n } from "../../i18n";
import {
  applyRemoteInvite,
  reminderDue,
  wireFromMeeting,
  type Meeting,
  type MeetingDraft,
  type MeetingWire,
  type RsvpStatus,
} from "./meetingModel";

const KV_NS = "meetings";
const KV_SCOPE = "default";
const KV_KEY = ""; // whole list under one key (kv has no enumeration; p2p:rooms precedent)

// Reminder tick granularity (implementation detail). The user-facing lead time
// is the Settings kv value, re-read every tick so changes apply live.
const REMINDER_TICK_MS = 30_000;

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

export function useMeetings(channel: ChatChannel) {
  const meetings = ref<Meeting[]>([]);

  // vue-i18n's `global.t` is a union of Composer/VueI18n overloads that TS
  // can't call directly — pin the (key, named-params) overload we use.
  const translate = i18n.global.t as (key: string, params?: Record<string, unknown>) => string;
  const t = (key: string, params?: Record<string, unknown>) =>
    translate(`calendar.${key}`, params ?? {});

  const selfName = () => channel.currentUserName.value;
  const selfDevice = () => channel.mlsIdentity.value;

  // ── persistence (encrypted kv) ────────────────────────────────────────────
  async function reload() {
    try {
      const raw = await kvGet(KV_NS, KV_SCOPE, KV_KEY);
      meetings.value = raw ? (JSON.parse(raw) as Meeting[]) : [];
    } catch {
      meetings.value = [];
    }
  }

  async function persist() {
    await kvPut(KV_NS, KV_SCOPE, KV_KEY, JSON.stringify(meetings.value)).catch(() => {});
  }

  function byId(id: string): Meeting | undefined {
    return meetings.value.find((m) => m.id === id);
  }

  /** Nav attention dot: invites awaiting my response. Self-clearing — derived
   *  purely from RSVP state, so answering (or the meeting passing) clears it. */
  const pendingInviteCount = computed(
    () =>
      meetings.value.filter(
        (m) => m.status === "scheduled" && !m.mine && m.myRsvp === "pending" && m.end > Date.now(),
      ).length,
  );

  // ── organizer actions ─────────────────────────────────────────────────────

  async function create(draft: MeetingDraft): Promise<Meeting> {
    const now = new Date().toISOString();
    const invitesRoom = !!draft.roomSlug;
    const meeting: Meeting = {
      id: crypto.randomUUID(),
      title: draft.title.trim(),
      description: draft.description,
      location: draft.location,
      start: draft.start,
      end: draft.end,
      organizer: selfName(),
      organizerDevice: selfDevice(),
      roomSlug: draft.roomSlug,
      roomName: draft.roomName,
      status: "scheduled",
      // Pre-seed pending rows for the members visible right now (the roster is
      // only known for the open room); others appear as their responses arrive.
      attendees: seedAttendees(draft.roomSlug),
      mine: true,
      reminded: false,
      needsBroadcast: invitesRoom,
      rev: 1,
      createdAt: now,
      updatedAt: now,
    };
    meetings.value = [...meetings.value, meeting];
    await persist();
    await flushOutbox();
    return meeting;
  }

  function seedAttendees(roomSlug: string): Meeting["attendees"] {
    const out: Meeting["attendees"] = {};
    if (!roomSlug || roomSlug !== channel.currentRoom.value?.slug) return out;
    for (const p of channel.participants.value) {
      if (p.type !== "human" || p.name === selfName()) continue;
      out[p.name] = { status: "pending", device: p.id };
    }
    return out;
  }

  async function update(id: string, draft: Omit<MeetingDraft, "roomSlug" | "roomName">) {
    const m = byId(id);
    if (!m || !m.mine || m.status !== "scheduled") return;
    const startChanged = m.start !== draft.start;
    m.title = draft.title.trim();
    m.description = draft.description;
    m.location = draft.location;
    m.start = draft.start;
    m.end = draft.end;
    m.rev += 1;
    m.updatedAt = new Date().toISOString();
    if (startChanged) m.reminded = false; // a rescheduled meeting re-reminds
    if (m.roomSlug) m.needsBroadcast = true;
    await persist();
    await flushOutbox();
  }

  async function cancel(id: string) {
    const m = byId(id);
    if (!m || !m.mine || m.status !== "scheduled") return;
    m.status = "cancelled";
    m.rev += 1;
    m.updatedAt = new Date().toISOString();
    if (m.roomSlug) m.needsBroadcast = true;
    await persist();
    await flushOutbox();
  }

  /** Local-only removal (e.g. clear a cancelled/past entry) — no protocol message. */
  async function removeLocal(id: string) {
    meetings.value = meetings.value.filter((m) => m.id !== id);
    await persist();
  }

  // ── invitee action ────────────────────────────────────────────────────────

  async function respond(id: string, status: Exclude<RsvpStatus, "pending">) {
    const m = byId(id);
    if (!m || m.mine || m.status !== "scheduled") return;
    m.myRsvp = status;
    m.attendees[selfName()] = {
      status,
      respondedAt: new Date().toISOString(),
      device: selfDevice(),
    };
    m.needsBroadcast = true; // invitee outbox: RSVP pending send
    await persist();
    await flushOutbox();
  }

  // ── protocol: sending ─────────────────────────────────────────────────────

  function canSendTo(roomSlug: string): boolean {
    return (
      !!roomSlug &&
      roomSlug === channel.currentRoom.value?.slug &&
      channel.mlsStatus.value === "ready"
    );
  }

  async function sendSnapshot(m: Meeting, type: "meeting_invite" | "meeting_update") {
    await channel.sendSync(type, {
      ...wireFromMeeting(m, [] /* whole room */),
      fromName: selfName(),
      fromDevice: selfDevice(),
    });
  }

  async function sendCancel(m: Meeting) {
    await channel.sendSync("meeting_cancel", {
      meetingId: m.id,
      rev: m.rev,
      fromName: selfName(),
      fromDevice: selfDevice(),
    });
  }

  async function sendResponse(m: Meeting) {
    if (!m.myRsvp || m.myRsvp === "pending") return;
    await channel.sendSync("meeting_response", {
      meetingId: m.id,
      status: m.myRsvp,
      respondedAt: m.attendees[selfName()]?.respondedAt ?? new Date().toISOString(),
      fromName: selfName(),
      fromDevice: selfDevice(),
    });
  }

  let flushing = false;
  /** Send every pending outbox item addressed to the currently open room. */
  async function flushOutbox() {
    if (flushing || !channel.currentRoom.value) return;
    flushing = true;
    try {
      let dirty = false;
      for (const m of meetings.value) {
        if (!m.needsBroadcast || !canSendTo(m.roomSlug)) continue;
        try {
          if (m.mine) {
            if (m.status === "cancelled") await sendCancel(m);
            else await sendSnapshot(m, m.rev === 1 ? "meeting_invite" : "meeting_update");
          } else {
            await sendResponse(m);
          }
          m.needsBroadcast = false;
          dirty = true;
        } catch {
          /* stays in the outbox for the next trigger */
        }
      }
      if (dirty) await persist();
    } finally {
      flushing = false;
    }
  }

  /** Presence catch-up: re-send the organizer's future meetings of the open
   *  room so late joiners / reconnecting members learn about them. Receivers
   *  upsert idempotently (stale revs are dropped), so duplicates are harmless. */
  async function rebroadcastRoom() {
    const slug = channel.currentRoom.value?.slug;
    if (!slug || !canSendTo(slug)) return;
    const now = Date.now();
    for (const m of meetings.value) {
      if (!m.mine || m.roomSlug !== slug || m.end <= now) continue;
      try {
        if (m.status === "scheduled") await sendSnapshot(m, "meeting_invite");
        else await sendCancel(m); // offline members must learn of cancellations too
      } catch {
        /* next presence event retries */
      }
    }
  }

  watch(channel.mlsStatus, (s) => {
    if (s === "ready") void flushOutbox();
  });
  watch(
    () => channel.participants.value.length,
    (n, o) => {
      if (n > (o ?? 0)) {
        void flushOutbox();
        void rebroadcastRoom();
      }
    },
  );

  // ── protocol: receiving ───────────────────────────────────────────────────

  channel.onSync(async (type, payload, sender) => {
    if (!type.startsWith("meeting_")) return; // not ours
    if (payload.fromDevice === selfDevice()) return; // self-echo guard
    const from = (payload.fromName as string) || sender;

    switch (type) {
      case "meeting_invite":
      case "meeting_update": {
        const wire = payload as unknown as MeetingWire;
        if (!wire.meetingId || !Number.isFinite(wire.start) || !Number.isFinite(wire.end)) return;
        const existing = byId(wire.meetingId);
        const merged = applyRemoteInvite(existing, wire, selfName());
        if (!merged) return; // stale / duplicate / foreign — silently dropped
        // An invitee's un-sent RSVP survives snapshot upserts.
        if (existing?.needsBroadcast) merged.needsBroadcast = true;
        meetings.value = existing
          ? meetings.value.map((m) => (m.id === merged.id ? merged : m))
          : [...meetings.value, merged];
        await persist();
        if (!existing && merged.myRsvp === "pending") {
          channel.postSystemNotice(t("invitedNotice", { name: from, title: merged.title }));
        } else if (existing) {
          channel.postSystemNotice(t("updatedNotice", { name: from, title: merged.title }));
        }
        break;
      }
      case "meeting_response": {
        const m = byId(payload.meetingId as string);
        if (!m || m.status !== "scheduled") return;
        const status = payload.status as RsvpStatus;
        if (status !== "accepted" && status !== "declined") return;
        m.attendees[from] = {
          status,
          respondedAt: (payload.respondedAt as string) || new Date().toISOString(),
          device: payload.fromDevice as string,
        };
        await persist();
        break;
      }
      case "meeting_cancel": {
        const m = byId(payload.meetingId as string);
        if (!m || m.mine) return;
        const rev = payload.rev as number;
        if (payload.fromDevice !== m.organizerDevice || !(rev > m.rev)) return;
        m.status = "cancelled";
        m.rev = rev;
        m.updatedAt = new Date().toISOString();
        m.needsBroadcast = false; // a pending RSVP for it is moot
        await persist();
        channel.postSystemNotice(t("cancelledNotice", { name: from, title: m.title }));
        break;
      }
    }
  });

  // ── reminders (local OS notification, lead time from Settings) ────────────

  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;

  async function reminderTick() {
    if (tickInFlight) return; // a slow kv write must not overlap the next tick
    tickInFlight = true;
    try {
      const lead = await getMeetingReminderMins();
      if (lead === 0) return; // 0 = reminders off
      const now = Date.now();
      const due = meetings.value.filter((m) => reminderDue(m, now, lead));
      if (!due.length) return;
      // Mark + persist BEFORE notifying: a crash mid-notify must not double-fire.
      for (const m of due) m.reminded = true;
      await persist();
      for (const m of due) await notifyMeeting(m);
    } finally {
      tickInFlight = false;
    }
  }

  async function notifyMeeting(m: Meeting) {
    if (!_isTauri()) return;
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      if (!ok) return;
      const when = new Date(m.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      sendNotification({
        title: t("reminderTitle", { title: m.title }),
        body: m.location ? t("reminderBodyAt", { when, location: m.location }) : t("reminderBody", { when }),
      });
    } catch {
      /* notification failure must not break the tick */
    }
  }

  function start() {
    if (!tickTimer) tickTimer = setInterval(() => void reminderTick(), REMINDER_TICK_MS);
  }
  function stop() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  void reload();
  start();

  return {
    meetings, pendingInviteCount,
    create, update, cancel, respond, removeLocal,
    reload, flushOutbox,
    // exposed for tests
    reminderTick, stop,
  };
}

export type Meetings = ReturnType<typeof useMeetings>;
