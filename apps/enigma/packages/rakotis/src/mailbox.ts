// Offline delivery through a server's room mailbox — an option of the shared room engine
// (`useChatChannel({ mailbox })`), off in Enigma, which has no server. Teutates turns it on:
// its co-op server keeps a mailbox per sphere, and a member who was away reads what came while
// the app was closed. The wire format is Demio's (belisario dev_coop_4, stage 4.1), so Demio,
// Teutates and any rakotis app read the same mailbox:
//
//   {"kind":"demio-room","room":<slug>,"frame":<the frame's JSON text>}
//
// Frames that go there: sealed messages and commits (Demio's), and — Teutates' addition —
// key packages and Welcomes, so someone away can be let in. `{"kind":"teutates-chat-node",
// "room","node"}` tells the others this device's endpoint id, to dial it directly.
//
// The place in the mailbox (a cursor and the ids seen) is kept per room, so a restart neither
// loses nor repeats a frame.

/** The envelope's kind; other kinds in the same mailbox (a co-op's log) are skipped. */
export const MAILBOX_KIND = "demio-room";
/** An endpoint id for a room. */
export const NODE_KIND = "teutates-chat-node";
/** The server's page size. */
export const MAILBOX_PAGE = 100;
const SEEN_MAX = 4000;

/** What the engine needs of a server: post a body, read what came after an id (one page). */
export interface ChatMailbox {
  post(body: Record<string, unknown>): Promise<void>;
  /** `room` is the room being caught up, for a server with a mailbox per room. */
  fetch(after: number, room?: string): Promise<{ id: number; body: string }[]>;
  /** How often the room catches up while open (ms; default 30 s). */
  everyMs?: number;
}

/** FNV-1a, 2×32 bits: a local id for a frame that carries no `msg_id` (never on the wire). */
function hash(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `h${a.toString(16)}${b.toString(16)}`;
}

/** The id of a frame that goes through the mailbox, null for the rest (presence of the
 *  transport, resets, plaintext). */
export function frameId(frame: string): string | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(frame);
  } catch {
    return null;
  }
  switch (v?.type) {
    case "mls_app":
    case "mls_commit":
      return typeof v.msg_id === "string" && v.msg_id ? v.msg_id : hash(frame);
    case "mls_key_package":
    case "mls_welcome":
      return hash(frame);
    default:
      return null;
  }
}

/** The mailbox envelope of an outgoing frame, if it is one that goes there. */
export function envelope(room: string, frame: string): Record<string, unknown> | null {
  return frameId(frame) ? { kind: MAILBOX_KIND, room, frame } : null;
}

/** A room's place in the mailbox. */
export interface MailboxPlace {
  seen: string[];
  /** null until the first catch-up of a fresh room (older frames are not for it). */
  cursor: number | null;
}

export const freshPlace = (): MailboxPlace => ({ seen: [], cursor: null });

/** Notes a frame's id; whether it is new. */
export function note(place: MailboxPlace, frame: string): boolean {
  const id = frameId(frame);
  if (!id || place.seen.includes(id)) return false;
  place.seen.push(id);
  if (place.seen.length > SEEN_MAX) place.seen.splice(0, place.seen.length - SEEN_MAX);
  return true;
}

/** What arrived for `room` since the cursor and was not seen yet, and the endpoints posted
 *  for it. The first call of a fresh room only moves the cursor to the end. */
export async function catchUp(place: MailboxPlace, mb: ChatMailbox, room: string): Promise<{ frames: string[]; nodes: string[] }> {
  const deliver = place.cursor !== null;
  let after = place.cursor ?? 0;
  const frames: string[] = [];
  const nodes: string[] = [];
  for (;;) {
    const page = await mb.fetch(after, room);
    for (const m of page) {
      after = Math.max(after, m.id);
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(m.body);
      } catch {
        continue;
      }
      if (v?.room !== room) continue;
      if (v.kind === NODE_KIND) {
        if (typeof v.node === "string" && !nodes.includes(v.node)) nodes.push(v.node);
        continue;
      }
      if (v.kind !== MAILBOX_KIND || typeof v.frame !== "string") continue;
      if (note(place, v.frame) && deliver) frames.push(v.frame);
    }
    if (page.length < MAILBOX_PAGE) break;
  }
  place.cursor = after;
  return { frames, nodes };
}

/** A server's mailbox in memory, ids from 1 (tests, demos). */
export class MemMailbox implements ChatMailbox {
  bodies: string[] = [];
  down = false;
  async post(body: Record<string, unknown>): Promise<void> {
    if (this.down) throw new Error("the server does not answer");
    this.bodies.push(JSON.stringify(body));
  }
  async fetch(after: number): Promise<{ id: number; body: string }[]> {
    if (this.down) throw new Error("the server does not answer");
    return this.bodies
      .map((body, i) => ({ id: i + 1, body }))
      .filter((m) => m.id > after)
      .slice(0, MAILBOX_PAGE);
  }
}

// ── threads (an option of the shared engine) ─────────────────────────────────────────────

/** The `#tags` of a text (lower case), as Demio's and Teutates' threads read them. */
export function tagsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_-]+)/gu)) out.push(m[2].toLowerCase());
  return out;
}

/** Whether a text mentions a name (`@Name`, any case). */
export function mentionsName(text: string, name: string): boolean {
  const n = name.trim();
  return !!n && text.toLowerCase().includes(`@${n.toLowerCase()}`);
}

/** Inline files up to this size go in a sealed message (Demio's `INLINE_MAX`). */
export const INLINE_MAX = 256 * 1024;
