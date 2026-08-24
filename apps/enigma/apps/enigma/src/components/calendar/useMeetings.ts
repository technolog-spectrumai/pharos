// Meeting-scheduling orchestrator — create/invite/RSVP/edit/cancel + reminders,
// plus doodle-style polls (propose slots → vote yes/ifneedbe/no → organizer
// confirms a winner, which auto-creates a regular meeting).
//
// Invites, ballots and poll snapshots ride the p2p chat's MLS-encrypted channel
// via the `onSync`/`sendSync` seam (`meeting_*` inner types), exactly like
// file-share signaling. The chat log only gets a plain system_info notice
// ("X invited you to …"); the actual RSVP/voting happens in the Calendar tab.
// Every profile persists its own copy of the meeting + poll lists in the
// encrypted kv store (namespace "meetings" — protasius seals the values at
// rest, nothing extra to do here).
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
import { calendarActionId, formatTime, getMeetingReminderMins, kvGet, kvPut } from "rakotis";
import { chargeMana } from "../mana/useMana";
import type { ChatChannel } from "rakotis";
import { i18n } from "../../i18n";
import {
  applyRemoteInvite,
  applyRemotePoll,
  pollExpired,
  reminderDue,
  wireFromMeeting,
  wireFromPoll,
  type Meeting,
  type MeetingDraft,
  type MeetingPoll,
  type MeetingPollWire,
  type MeetingWire,
  type PollDraft,
  type PollVoteChoice,
  type RsvpStatus,
} from "./meetingModel";

const KV_NS = "meetings";
const KV_SCOPE = "default";
const KV_KEY = ""; // whole list under one key (kv has no enumeration; p2p:rooms precedent)
const KV_KEY_POLLS = "polls"; // the doodle polls, same fixed-key scheme

// Reminder tick granularity (implementation detail). The user-facing lead time
// is the Settings kv value, re-read every tick so changes apply live.
const REMINDER_TICK_MS = 30_000;

const _isTauri = (): boolean =>
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

export function useMeetings(channel: ChatChannel) {
  const meetings = ref<Meeting[]>([]);
  const polls = ref<MeetingPoll[]>([]);

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
    try {
      const raw = await kvGet(KV_NS, KV_SCOPE, KV_KEY_POLLS);
      polls.value = raw ? (JSON.parse(raw) as MeetingPoll[]) : [];
    } catch {
      polls.value = [];
    }
  }

  async function persist() {
    await kvPut(KV_NS, KV_SCOPE, KV_KEY, JSON.stringify(meetings.value)).catch(() => {});
  }

  async function persistPolls() {
    await kvPut(KV_NS, KV_SCOPE, KV_KEY_POLLS, JSON.stringify(polls.value)).catch(() => {});
  }

  function byId(id: string): Meeting | undefined {
    return meetings.value.find((m) => m.id === id);
  }

  function pollById(id: string): MeetingPoll | undefined {
    return polls.value.find((p) => p.id === id);
  }

  /** Nav attention dot: invites awaiting my response. Self-clearing — derived
   *  purely from RSVP state, so answering (or the meeting passing) clears it. */
  const pendingInviteCount = computed(
    () =>
      meetings.value.filter(
        (m) => m.status === "scheduled" && !m.mine && m.myRsvp === "pending" && m.end > Date.now(),
      ).length,
  );

  /** Open polls awaiting my ballot. Like pendingInviteCount, Date.now() in a
   *  computed doesn't self-refresh the instant a deadline passes — accepted. */
  const pendingPollCount = computed(
    () =>
      polls.value.filter(
        (p) =>
          p.status === "open" &&
          !p.mine &&
          !pollExpired(p, Date.now()) &&
          !(p.myVotes && Object.keys(p.myVotes).length),
      ).length,
  );

  /** Everything awaiting a response — drives the Calendar nav dot. */
  const attentionCount = computed(() => pendingInviteCount.value + pendingPollCount.value);

  // ── organizer actions ─────────────────────────────────────────────────────

  async function create(
    draft: MeetingDraft,
    // confirmPoll pre-generates the id (so the poll close can reference it and
    // travel first) and passes ballot-derived attendees.
    opts?: { attendees?: Meeting["attendees"]; id?: string },
  ): Promise<Meeting> {
    const now = new Date().toISOString();
    const invitesRoom = !!draft.roomSlug;
    const meeting: Meeting = {
      id: opts?.id ?? crypto.randomUUID(),
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
      attendees: opts?.attendees ?? seedAttendees(draft.roomSlug),
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
    await billShare();
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
    await billShare();
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
    await billShare();
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
    await billShare();
  }

  // ── polls (doodle-style slot voting) ──────────────────────────────────────

  async function createPoll(draft: PollDraft): Promise<MeetingPoll> {
    const now = new Date().toISOString();
    const poll: MeetingPoll = {
      id: crypto.randomUUID(),
      title: draft.title.trim(),
      description: draft.description,
      location: draft.location,
      slots: draft.slots.map((s) => ({ id: crypto.randomUUID(), start: s.start, end: s.end })),
      organizer: selfName(),
      organizerDevice: selfDevice(),
      roomSlug: draft.roomSlug,
      roomName: draft.roomName,
      status: "open",
      votes: {},
      deadline: draft.deadline,
      mine: true,
      needsBroadcast: true,
      rev: 1,
      createdAt: now,
      updatedAt: now,
    };
    polls.value = [...polls.value, poll];
    await persistPolls();
    await flushOutbox();
    await billShare();
    return poll;
  }

  /** Cast/change my vote on one slot. The organizer's own ballot travels as a
   *  snapshot update (rev bump); everyone else's as a meeting_poll_vote. */
  async function votePoll(id: string, slotId: string, choice: PollVoteChoice) {
    const p = pollById(id);
    if (!p || p.status !== "open" || pollExpired(p, Date.now())) return;
    if (!p.slots.some((s) => s.id === slotId)) return;
    p.myVotes = { ...(p.myVotes ?? {}), [slotId]: choice };
    p.votes[selfName()] = {
      votes: { ...p.myVotes },
      votedAt: new Date().toISOString(),
      device: selfDevice(),
    };
    if (p.mine) p.rev += 1;
    p.updatedAt = new Date().toISOString();
    p.needsBroadcast = true;
    await persistPolls();
    await flushOutbox();
    await billShare();
  }

  /** Organizer picks the winning slot: close the poll and auto-create the
   *  meeting there. Allowed after the deadline (that's the point of it).
   *  Ballots pre-seed the roster: yes → accepted, ifneedbe → pending,
   *  no → declined; non-voters stay pending (roster-limited to the open room).
   *  The poll is closed and persisted BEFORE create() so the outbox flush
   *  (polls first) sends meeting_poll_close ahead of the meeting_invite. */
  async function confirmPoll(id: string, slotId: string): Promise<Meeting | undefined> {
    const p = pollById(id);
    if (!p || !p.mine || p.status !== "open") return;
    const slot = p.slots.find((s) => s.id === slotId);
    if (!slot) return;

    const attendees = seedAttendees(p.roomSlug);
    for (const [name, ballot] of Object.entries(p.votes)) {
      if (name === selfName()) continue;
      const choice = ballot.votes[slotId];
      if (!choice) continue;
      attendees[name] = {
        status: choice === "yes" ? "accepted" : choice === "no" ? "declined" : "pending",
        respondedAt: ballot.votedAt,
        device: ballot.device,
      };
    }

    const meetingId = crypto.randomUUID();
    p.status = "closed";
    p.chosenSlotId = slotId;
    p.meetingId = meetingId;
    p.rev += 1;
    p.updatedAt = new Date().toISOString();
    p.needsBroadcast = true;
    await persistPolls();

    return create(
      {
        title: p.title,
        description: p.description,
        location: p.location,
        start: slot.start,
        end: slot.end,
        roomSlug: p.roomSlug,
        roomName: p.roomName,
      },
      { attendees, id: meetingId },
    );
  }

  async function cancelPoll(id: string) {
    const p = pollById(id);
    if (!p || !p.mine || p.status !== "open") return;
    p.status = "cancelled";
    p.rev += 1;
    p.updatedAt = new Date().toISOString();
    p.needsBroadcast = true;
    await persistPolls();
    await flushOutbox();
    await billShare();
  }

  /** Local-only removal of a closed/cancelled poll — no protocol message. */
  async function removePollLocal(id: string) {
    polls.value = polls.value.filter((p) => p.id !== id);
    await persistPolls();
  }

  // ── Privacy MANA ────────────────────────────────────────────────────────────
  // Calendar traffic is billed at exactly the encrypted-message rate for the
  // room's transport. Scheduling "Tuesday 3pm" must not be cheaper than typing
  // it: to a relay the two are the same event — something was sent, this big, to
  // these peers. There is no `.plain` lane to price, because `sendSync` encrypts
  // or throws and `canSendTo` additionally gates on MLS being ready.
  //
  // ONCE PER USER ACTION, and only from the seven functions a tap reaches.
  // Deliberately NOT inside `flushOutbox`: that also runs from the MLS-ready
  // watcher and from `rebroadcastRoom` when the participant list grows, and
  // billing those would drain the meter for frames nobody initiated — which
  // would break the rule that the meter moves by exactly the number the button
  // showed. `confirmPoll` is absent for the same reason in reverse: it delegates
  // to `create`, so it is billed there, once, even though it emits two frames.
  async function billShare(): Promise<void> {
    // A meeting with no room is local-only — nothing goes on a wire, so nothing
    // is charged. The room's OWN transport decides the lane, not the global Tor
    // preference: a room created before the switch was flipped is still on the
    // transport it was created with.
    if (!channel.currentRoom.value) return;
    // Never let a charge break the thing it is measuring. MANA is advisory: a
    // meeting that was created must stay created even if the ledger write, the
    // policy lookup or the transport flag misbehaves.
    try {
      await chargeMana(calendarActionId(channel.currentRoomIsTor?.value === true));
    } catch {
      /* the action already happened; the meter simply misses it */
    }
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

  async function sendPollSnapshot(p: MeetingPoll) {
    await channel.sendSync("meeting_poll", {
      ...wireFromPoll(p),
      fromName: selfName(),
      fromDevice: selfDevice(),
    });
  }

  async function sendBallot(p: MeetingPoll) {
    if (!p.myVotes || !Object.keys(p.myVotes).length) return;
    await channel.sendSync("meeting_poll_vote", {
      pollId: p.id,
      votes: { ...p.myVotes },
      votedAt: p.votes[selfName()]?.votedAt ?? new Date().toISOString(),
      fromName: selfName(),
      fromDevice: selfDevice(),
    });
  }

  async function sendPollClose(p: MeetingPoll) {
    await channel.sendSync("meeting_poll_close", {
      pollId: p.id,
      rev: p.rev,
      chosenSlotId: p.chosenSlotId,
      meetingId: p.meetingId,
      fromName: selfName(),
      fromDevice: selfDevice(),
    });
  }

  async function sendPollCancel(p: MeetingPoll) {
    await channel.sendSync("meeting_poll_cancel", {
      pollId: p.id,
      rev: p.rev,
      fromName: selfName(),
      fromDevice: selfDevice(),
    });
  }

  let flushing = false;
  /** Send every pending outbox item addressed to the currently open room.
   *  Polls flush FIRST: a poll close must precede the invite of the meeting it
   *  created, so receivers can suppress the duplicate chat notice. */
  async function flushOutbox() {
    if (flushing || !channel.currentRoom.value) return;
    flushing = true;
    try {
      let pollsDirty = false;
      for (const p of polls.value) {
        if (!p.needsBroadcast || !canSendTo(p.roomSlug)) continue;
        try {
          if (p.mine) {
            if (p.status === "cancelled") await sendPollCancel(p);
            else if (p.status === "closed") await sendPollClose(p);
            else await sendPollSnapshot(p);
          } else {
            await sendBallot(p);
          }
          p.needsBroadcast = false;
          pollsDirty = true;
        } catch {
          /* stays in the outbox for the next trigger */
        }
      }
      if (pollsDirty) await persistPolls();

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

  /** Presence catch-up: re-send the organizer's future meetings + polls of the
   *  open room so late joiners / reconnecting members learn about them.
   *  Receivers upsert idempotently (stale revs are dropped), so duplicates are
   *  harmless. Polls first (close-before-invite, same reason as flushOutbox). */
  async function rebroadcastRoom() {
    const slug = channel.currentRoom.value?.slug;
    if (!slug || !canSendTo(slug)) return;
    const now = Date.now();
    for (const p of polls.value) {
      if (!p.mine || p.roomSlug !== slug) continue;
      const latestEnd = Math.max(...p.slots.map((s) => s.end));
      if (latestEnd <= now) continue; // every proposed time is in the past
      try {
        if (p.status === "cancelled") await sendPollCancel(p);
        // Open polls re-send even past their deadline (peers need the poll to
        // derive its "voting ended" state); closed snapshots carry the close
        // info for members who never saw the poll at all.
        else await sendPollSnapshot(p);
      } catch {
        /* next presence event retries */
      }
    }
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
        // A meeting born from a poll already announced itself via the poll's
        // close notice — the close normally arrives first (polls flush before
        // meetings). Caveat: a late joiner may get the invite before (or
        // without) the poll snapshot; then the invite notice simply shows.
        const fromPoll = polls.value.some((p) => p.meetingId === merged.id);
        if (!existing && merged.myRsvp === "pending" && !fromPoll) {
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
      case "meeting_poll": {
        const wire = payload as unknown as MeetingPollWire;
        if (!wire.pollId || !Array.isArray(wire.slots) || wire.slots.length < 2) return;
        const existing = pollById(wire.pollId);
        const merged = applyRemotePoll(existing, wire, selfName());
        if (!merged) return; // stale / duplicate / foreign — silently dropped
        // A voter's un-sent ballot survives snapshot upserts.
        if (existing?.needsBroadcast) merged.needsBroadcast = true;
        polls.value = existing
          ? polls.value.map((p) => (p.id === merged.id ? merged : p))
          : [...polls.value, merged];
        await persistPolls();
        if (!existing && merged.status === "open") {
          channel.postSystemNotice(t("pollCreatedNotice", { name: from, title: merged.title }));
        }
        break;
      }
      case "meeting_poll_vote": {
        const p = pollById(payload.pollId as string);
        // Late ballots (closed poll or past deadline) are dropped, like stale revs.
        if (!p || p.status !== "open" || pollExpired(p, Date.now())) return;
        const incoming = payload.votes as Record<string, PollVoteChoice> | undefined;
        if (!incoming || typeof incoming !== "object") return;
        const votedAt = (payload.votedAt as string) || new Date().toISOString();
        const prev = p.votes[from];
        if (prev && prev.votedAt >= votedAt) return; // last-write-wins
        const validSlots = new Set(p.slots.map((s) => s.id));
        const votes: Record<string, PollVoteChoice> = {};
        for (const [slotId, choice] of Object.entries(incoming)) {
          if (validSlots.has(slotId) && (choice === "yes" || choice === "ifneedbe" || choice === "no")) {
            votes[slotId] = choice;
          }
        }
        if (!Object.keys(votes).length) return;
        p.votes[from] = { votes, votedAt, device: payload.fromDevice as string };
        await persistPolls();
        break;
      }
      case "meeting_poll_close": {
        const p = pollById(payload.pollId as string);
        if (!p || p.mine) return;
        const rev = payload.rev as number;
        if (payload.fromDevice !== p.organizerDevice || !(rev > p.rev)) return;
        p.status = "closed";
        p.rev = rev;
        p.chosenSlotId = payload.chosenSlotId as string;
        p.meetingId = payload.meetingId as string;
        p.updatedAt = new Date().toISOString();
        p.needsBroadcast = false; // a pending ballot for it is moot
        await persistPolls();
        channel.postSystemNotice(t("pollClosedNotice", { name: from, title: p.title }));
        break;
      }
      case "meeting_poll_cancel": {
        const p = pollById(payload.pollId as string);
        if (!p || p.mine) return;
        const rev = payload.rev as number;
        if (payload.fromDevice !== p.organizerDevice || !(rev > p.rev)) return;
        p.status = "cancelled";
        p.rev = rev;
        p.updatedAt = new Date().toISOString();
        p.needsBroadcast = false;
        await persistPolls();
        channel.postSystemNotice(t("pollCancelledNotice", { name: from, title: p.title }));
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
      const when = formatTime(m.start);
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
    polls, pendingPollCount, attentionCount,
    createPoll, votePoll, confirmPoll, cancelPoll, removePollLocal,
    reload, flushOutbox,
    // exposed for tests
    reminderTick, stop,
  };
}

export type Meetings = ReturnType<typeof useMeetings>;
