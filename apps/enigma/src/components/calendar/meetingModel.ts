// Meeting scheduling — pure data model + helpers (no Vue/Tauri imports).
//
// A Meeting is a fixed-time event created by one room member (the organizer)
// and broadcast to the room over the chat channel's MLS-encrypted sync seam
// (`meeting_*` inner types — see useMeetings.ts). Every profile keeps its own
// copy in the encrypted kv store; RSVP statuses flow back as `meeting_response`
// messages and accumulate in `attendees`.
//
// Trust model: authorization for edit/cancel anchors on `organizerDevice` (the
// creator's MLS identity), carried inside the ciphertext. That authenticates
// "some member of the MLS group" — membership, not authorship — so a malicious
// member could forge it. Cooperative trust, same posture as presence/file_offer.

export type MeetingStatus = "scheduled" | "cancelled";
export type RsvpStatus = "pending" | "accepted" | "declined";

export interface MeetingAttendee {
  status: RsvpStatus;
  respondedAt?: string; // ISO timestamp of the last RSVP
  device?: string;      // responder's MLS identity if known (informational)
}

export interface Meeting {
  id: string;
  title: string;
  description: string;
  location: string;           // free text, may be ""
  start: number;              // epoch ms; invariant end > start
  end: number;
  organizer: string;          // display name (room-scoped identity)
  organizerDevice: string;    // creator's MLS identity — edit/cancel authorization anchor
  roomSlug: string;           // room whose members were invited; "" = local-only
  roomName: string;           // display fallback if the room entry is later forgotten
  status: MeetingStatus;
  attendees: Record<string, MeetingAttendee>; // keyed by display name
  myRsvp?: RsvpStatus;        // invitee-local: my own status (absent on organizer copies)
  mine: boolean;              // local flag: this profile created the meeting (never sent)
  reminded?: boolean;         // local flag: OS reminder fired for the current start (never sent)
  needsBroadcast?: boolean;   // outbox flag (never sent): organizer — snapshot/cancel
                              // pending broadcast; invitee — RSVP pending send
  rev: number;                // edit revision, starts at 1; receivers drop stale/foreign revs
  createdAt: string;          // ISO
  updatedAt: string;          // ISO
}

/** The invite/update snapshot as it travels inside the MLS ciphertext.
 *  `fromName`/`fromDevice` ride inside the payload (the outer envelope's sender
 *  fields are plaintext on the wire). `invited` empty ⇒ the whole room. */
export interface MeetingWire {
  meetingId: string;
  title: string;
  description: string;
  location: string;
  start: number;
  end: number;
  organizer: string;
  organizerDevice: string;
  roomSlug: string;
  roomName: string;
  status: MeetingStatus;
  attendees: Record<string, MeetingAttendee>;
  invited: string[];
  rev: number;
  createdAt: string;
  updatedAt: string;
  fromName: string;
  fromDevice: string;
}

// ── create/edit form ──────────────────────────────────────────────────────────

export interface MeetingDraft {
  title: string;
  description: string;
  location: string;
  start: number;
  end: number;
  roomSlug: string;
  roomName: string;
}

/** i18n error key under `calendar.*`, or null when the draft is valid. */
export function validateMeetingDraft(draft: Pick<MeetingDraft, "title" | "start" | "end">): string | null {
  if (!draft.title.trim()) return "titleRequired";
  if (!Number.isFinite(draft.start) || !Number.isFinite(draft.end)) return "timeRequired";
  if (draft.end <= draft.start) return "endBeforeStart";
  return null;
}

// ── calendar math (native Date, local time) ───────────────────────────────────

/** 6×7 month grid of day Dates, Monday-first, padded with adjacent-month days. */
export function monthGrid(anchor: Date): Date[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7; // days shown before the 1st (Monday-first)
  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(new Date(first.getFullYear(), first.getMonth(), 1 - lead + w * 7 + d));
    }
    weeks.push(week);
  }
  return weeks;
}

/** Local-time day bucket, "YYYY-MM-DD". */
export function dayKey(d: Date | number): string {
  const dt = typeof d === "number" ? new Date(d) : d;
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${m}-${day}`;
}

/** Meetings starting on the given day, earliest first. */
export function meetingsOnDay(meetings: Meeting[], key: string): Meeting[] {
  return meetings.filter((m) => dayKey(m.start) === key).sort((a, b) => a.start - b.start);
}

/** Scheduled meetings not yet over (in-progress included), soonest first. */
export function upcoming(meetings: Meeting[], now: number, limit = 5): Meeting[] {
  return meetings
    .filter((m) => m.status === "scheduled" && m.end > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, limit);
}

// ── protocol helpers ──────────────────────────────────────────────────────────

/** The wire snapshot of a meeting (local-only flags stripped). `fromName`/
 *  `fromDevice` are appended by the sender. */
export function wireFromMeeting(m: Meeting, invited: string[] = []): Omit<MeetingWire, "fromName" | "fromDevice"> {
  return {
    meetingId: m.id,
    title: m.title,
    description: m.description,
    location: m.location,
    start: m.start,
    end: m.end,
    organizer: m.organizer,
    organizerDevice: m.organizerDevice,
    roomSlug: m.roomSlug,
    roomName: m.roomName,
    status: m.status,
    attendees: m.attendees,
    invited,
    rev: m.rev,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/** Apply an incoming `meeting_invite`/`meeting_update` snapshot.
 *
 *  Idempotent, rev-guarded upsert: returns the merged Meeting to store, or
 *  null when the message must be dropped (stale rev, foreign sender for a
 *  known meeting, or it targets a meeting we organize). Local flags (`mine`,
 *  `myRsvp`, `reminded`) survive; `reminded` resets when the start moved so a
 *  rescheduled meeting re-reminds. */
export function applyRemoteInvite(
  existing: Meeting | undefined,
  wire: MeetingWire,
  selfName: string,
): Meeting | null {
  if (existing) {
    if (existing.mine) return null; // nobody edits the organizer's own copy remotely
    if (wire.rev <= existing.rev) return null; // stale or duplicate
    if (wire.fromDevice !== existing.organizerDevice) return null; // foreign sender
  }

  const invitesMe = wire.invited.length === 0 || wire.invited.includes(selfName);
  // First sight seeds my RSVP from the organizer's roster: a meeting created
  // from a poll carries my ballot-derived status (yes-voters arrive accepted).
  const myRsvp =
    existing?.myRsvp ?? (invitesMe ? (wire.attendees[selfName]?.status ?? "pending") : undefined);

  // The organizer's snapshot is authoritative for the roster — except my own
  // row, where my local response wins (it may not have reached the organizer).
  const attendees: Record<string, MeetingAttendee> = { ...wire.attendees };
  if (myRsvp && myRsvp !== "pending") {
    attendees[selfName] = { ...attendees[selfName], status: myRsvp };
  }

  return {
    id: wire.meetingId,
    title: wire.title,
    description: wire.description,
    location: wire.location,
    start: wire.start,
    end: wire.end,
    organizer: wire.organizer,
    organizerDevice: wire.organizerDevice,
    roomSlug: wire.roomSlug,
    roomName: wire.roomName,
    status: wire.status,
    attendees,
    myRsvp,
    mine: false,
    reminded: existing && existing.start === wire.start ? existing.reminded : false,
    rev: wire.rev,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
  };
}

/** Whether the reminder notification should fire now (caller handles lead = 0
 *  = off). Fires once per start time (`reminded` resets on reschedule), never
 *  for cancelled or declined meetings, and not after the meeting ended. */
export function reminderDue(m: Meeting, now: number, leadMins: number): boolean {
  return (
    m.status === "scheduled" &&
    !m.reminded &&
    m.myRsvp !== "declined" &&
    now >= m.start - leadMins * 60_000 &&
    now < m.end
  );
}

// ── polls (doodle-style slot voting) ──────────────────────────────────────────
//
// A MeetingPoll proposes several time slots for one meeting; room members vote
// yes / ifneedbe / no per slot, and the organizer confirms a winner — which
// closes the poll and auto-creates a regular Meeting at that slot. Expiry of
// the optional voting deadline is a pure function of the stored timestamp
// (`pollExpired`) — no auto-close message, every peer derives it locally.

export type PollStatus = "open" | "closed" | "cancelled";
export type PollVoteChoice = "yes" | "ifneedbe" | "no";

export interface PollSlot {
  id: string;
  start: number; // epoch ms; invariant end > start
  end: number;
}

export interface PollBallot {
  votes: Record<string, PollVoteChoice>; // keyed by slot id
  votedAt: string;                       // ISO; last-write-wins on receive
  device?: string;                       // voter's MLS identity if known
}

export interface MeetingPoll {
  id: string;
  title: string;
  description: string;
  location: string;
  slots: PollSlot[];                  // invariant: length >= 2
  organizer: string;
  organizerDevice: string;            // close/cancel authorization anchor (same trust model as meetings)
  roomSlug: string;                   // required — voting needs peers, no local-only polls
  roomName: string;
  status: PollStatus;
  votes: Record<string, PollBallot>;  // keyed by display name
  deadline?: number;                  // epoch ms; expiry pure-derived, see pollExpired
  chosenSlotId?: string;              // set on close
  meetingId?: string;                 // the auto-created Meeting (set on close)
  myVotes?: Record<string, PollVoteChoice>; // local: my ballot (also mirrored into votes)
  mine: boolean;                      // local flag: this profile created the poll (never sent)
  needsBroadcast?: boolean;           // outbox flag (never sent): organizer — snapshot/close/
                                      // cancel pending broadcast; voter — ballot pending send
  rev: number;                        // edit revision, starts at 1; receivers drop stale/foreign revs
  createdAt: string;                  // ISO
  updatedAt: string;                  // ISO
}

/** The poll snapshot as it travels inside the MLS ciphertext. Carries the full
 *  vote map (organizer-authoritative) plus close state, so late joiners catch
 *  up from a single re-broadcast. */
export interface MeetingPollWire {
  pollId: string;
  title: string;
  description: string;
  location: string;
  slots: PollSlot[];
  organizer: string;
  organizerDevice: string;
  roomSlug: string;
  roomName: string;
  status: PollStatus;
  votes: Record<string, PollBallot>;
  deadline?: number;
  chosenSlotId?: string;
  meetingId?: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
  fromName: string;
  fromDevice: string;
}

export interface PollDraft {
  title: string;
  description: string;
  location: string;
  slots: Array<{ start: number; end: number }>;
  roomSlug: string;
  roomName: string;
  deadline?: number;
}

/** i18n error key under `calendar.*`, or null when the draft is valid. */
export function validatePollDraft(draft: PollDraft): string | null {
  if (!draft.title.trim()) return "titleRequired";
  if (draft.slots.length < 2) return "needTwoSlots";
  for (const s of draft.slots) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.end <= s.start) {
      return "slotTimeInvalid";
    }
  }
  if (!draft.roomSlug) return "roomRequired";
  if (draft.deadline !== undefined && !Number.isFinite(draft.deadline)) return "deadlineInvalid";
  return null;
}

export interface SlotTally {
  slotId: string;
  yes: number;
  ifneedbe: number;
  no: number;
}

/** Per-slot vote counts, best-first: yes desc, then ifneedbe desc, then the
 *  earlier slot (start asc) as the tiebreaker. */
export function tallyPoll(poll: MeetingPoll): SlotTally[] {
  const bySlot = new Map<string, SlotTally>(
    poll.slots.map((s) => [s.id, { slotId: s.id, yes: 0, ifneedbe: 0, no: 0 }]),
  );
  for (const ballot of Object.values(poll.votes)) {
    for (const [slotId, choice] of Object.entries(ballot.votes)) {
      const t = bySlot.get(slotId);
      if (t) t[choice] += 1;
    }
  }
  const startOf = new Map(poll.slots.map((s) => [s.id, s.start]));
  return [...bySlot.values()].sort(
    (a, b) =>
      b.yes - a.yes ||
      b.ifneedbe - a.ifneedbe ||
      (startOf.get(a.slotId) ?? 0) - (startOf.get(b.slotId) ?? 0),
  );
}

/** Pure expiry: true iff a voting deadline is set and has passed. */
export function pollExpired(poll: MeetingPoll, now: number): boolean {
  return poll.deadline !== undefined && now > poll.deadline;
}

/** The wire snapshot of a poll (local-only flags stripped). `fromName`/
 *  `fromDevice` are appended by the sender. */
export function wireFromPoll(p: MeetingPoll): Omit<MeetingPollWire, "fromName" | "fromDevice"> {
  return {
    pollId: p.id,
    title: p.title,
    description: p.description,
    location: p.location,
    slots: p.slots,
    organizer: p.organizer,
    organizerDevice: p.organizerDevice,
    roomSlug: p.roomSlug,
    roomName: p.roomName,
    status: p.status,
    votes: p.votes,
    deadline: p.deadline,
    chosenSlotId: p.chosenSlotId,
    meetingId: p.meetingId,
    rev: p.rev,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Apply an incoming `meeting_poll` snapshot.
 *
 *  Idempotent, rev-guarded upsert mirroring applyRemoteInvite: returns the
 *  merged poll to store, or null when the message must be dropped (stale rev,
 *  foreign sender for a known poll, or it targets a poll we organize). The
 *  organizer's vote map is authoritative EXCEPT my own row — my local ballot
 *  wins (it may not have reached the organizer yet). `myVotes` survives. */
export function applyRemotePoll(
  existing: MeetingPoll | undefined,
  wire: MeetingPollWire,
  selfName: string,
): MeetingPoll | null {
  if (existing) {
    if (existing.mine) return null; // nobody edits the organizer's own copy remotely
    if (wire.rev <= existing.rev) return null; // stale or duplicate
    if (wire.fromDevice !== existing.organizerDevice) return null; // foreign sender
  }

  const myVotes = existing?.myVotes;
  const votes: Record<string, PollBallot> = { ...wire.votes };
  if (myVotes && Object.keys(myVotes).length) {
    votes[selfName] = {
      votes: { ...myVotes },
      votedAt: existing?.votes[selfName]?.votedAt ?? new Date().toISOString(),
      device: existing?.votes[selfName]?.device,
    };
  }

  return {
    id: wire.pollId,
    title: wire.title,
    description: wire.description,
    location: wire.location,
    slots: wire.slots,
    organizer: wire.organizer,
    organizerDevice: wire.organizerDevice,
    roomSlug: wire.roomSlug,
    roomName: wire.roomName,
    status: wire.status,
    votes,
    deadline: wire.deadline,
    chosenSlotId: wire.chosenSlotId,
    meetingId: wire.meetingId,
    myVotes,
    mine: false,
    rev: wire.rev,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt,
  };
}
