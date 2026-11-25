// The room's Beacon mailbox (stage 8.B3), in the shape the room engine's mailbox
// option takes (rakotis/mailbox.ts). Each room's mailbox id and token come from the
// MLS exporter (`mls_mailbox`, 8.B1) and move with every commit and every week, so
// this keeps its own place per mailbox and hands the engine one running count.
// Rooms without a Beacon (all of them until 8.C) do nothing here.
import type { ChatMailbox } from "rakotis";

// The engine's envelope names the room; Beacon gets only the sealed frame, and the
// envelope is put back together here on the way in.
const KIND = "demio-room";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
interface Box { id: string; token: string; week: number }
interface Posted { seq: number; body: string }

export interface BeaconMailboxDeps {
  invoke: Invoke;
  /** The room's Beacon onion, or nothing. */
  beaconFor(room: string): string | undefined;
  /** Our MLS identity in the room. */
  identity(): string;
}

export function beaconMailbox(deps: BeaconMailboxDeps): ChatMailbox {
  const cursors = new Map<string, number>(); // mailbox id → last seq read
  let count = 0;
  const box = (room: string, weekOffset: number) =>
    deps.invoke<Box>("mls_mailbox", { room, identity: deps.identity(), weekOffset });

  return {
    everyMs: 30_000,
    async post(body) {
      const room = typeof body.room === "string" ? body.room : "";
      const onion = room && deps.beaconFor(room);
      if (!onion) return;
      const b = await box(room, 0);
      if (typeof body.frame !== "string") return;
      await deps.invoke("beacon_post", { onion, id: b.id, token: b.token, body: body.frame });
    },
    async fetch(after, room) {
      const onion = room && deps.beaconFor(room);
      if (!room || !onion) return [];
      count = Math.max(count, after);
      const out: { id: number; body: string }[] = [];
      // Last week's mailbox first: what was posted just before the week turned.
      for (const offset of [1, 0]) {
        let b: Box;
        try { b = await box(room, offset); } catch { continue; } // no group yet
        for (;;) {
          const from = cursors.get(b.id) ?? 0;
          const page = await deps.invoke<Posted[]>("beacon_fetch", { onion, id: b.id, token: b.token, after: from });
          for (const m of page) {
            cursors.set(b.id, Math.max(cursors.get(b.id) ?? 0, m.seq));
            out.push({ id: ++count, body: JSON.stringify({ kind: KIND, room, frame: m.body }) });
          }
          if (page.length < 100) break;
        }
      }
      return out;
    },
  };
}
