// An in-memory stand-in for the Rust transport: two `CollabTransport`s wired
// back to back, so two sessions can be driven against each other in one test
// with no Tauri and no network.
//
// It models what crates/collab ENFORCES, not how it is built — the same
// observable rules, so a session that passes here behaves the same over the
// real thing:
//
//   * a ticket admits ONE joiner; a second is refused to the host as
//     `ticket_spent` and never hears back;
//   * the joiner's frames are DROPPED until the host has sent `Welcome`;
//   * the host's frames always reach the joiner, who believes only the host;
//   * committed frames (`Op`, `Snapshot`) are stamped with a per-sender
//     sequence, and a receiver that sees a gap gets `lagged` first — exactly
//     the Rust `SeqTracker`;
//   * `close()` sends `Bye`, then the other side sees `peer_down`, and the
//     closing side sees `closed`.
//
// Delivery is QUEUED, not immediate, and `settle()` drains it. That keeps a
// test deterministic and lets it interleave two peers' actions on purpose.
import type { CollabEvent, CollabTransport, WireFrame } from "../../src/collab/transport";

export const HOST_ID = "host-endpoint";
export const JOINER_ID = "joiner-endpoint";
/** What both sides show: derived from the two ids the same way on each. */
export const SAS = "482913";

type Handler = (e: CollabEvent) => void;

export interface FakeNet {
  host: CollabTransport;
  joiner: CollabTransport;
  /** Deliver everything queued, in order, including what that delivery itself
   *  queues, until nothing is left. Awaits microtasks between rounds so a
   *  session's `await transport.send()` continuations run too. */
  settle(): Promise<void>;
  /** Drop the next `n` frames sent by anyone — a lossy topic. */
  lose(n: number): void;
  /** The other side vanishes without `Bye` (a crash, a dead link). */
  vanish(side: "host" | "joiner"): void;
  /** Every frame that was actually delivered, for assertions on the wire. */
  delivered: Array<{ to: "host" | "joiner"; frame: WireFrame }>;
}

export function makeFakeNet(): FakeNet {
  let hostHandler: Handler | null = null;
  let joinerHandler: Handler | null = null;
  let issued: string | null = null;
  let consumedBy: string | null = null;
  let welcomed = false;
  let toLose = 0;
  let seqFromHost = 0;
  let seqFromJoiner = 0;
  let seenFromHost = 0;
  let seenFromJoiner = 0;
  const queue: Array<() => void> = [];
  const delivered: FakeNet["delivered"] = [];

  function stamp(frame: WireFrame, seq: number): WireFrame {
    if (typeof frame === "string") return frame;
    if ("Op" in frame) return { Op: { ...frame.Op, seq } };
    if ("Snapshot" in frame) return { Snapshot: { ...frame.Snapshot, seq } };
    return frame;
  }
  function seqOf(frame: WireFrame): number | null {
    if (typeof frame === "string") return null;
    if ("Op" in frame) return frame.Op.seq;
    if ("Snapshot" in frame) return frame.Snapshot.seq;
    return null;
  }

  function deliver(to: "host" | "joiner", from: string, frame: WireFrame) {
    const handler = to === "host" ? hostHandler : joinerHandler;
    if (!handler) return;
    if (toLose > 0) {
      toLose--;
      return;
    }
    queue.push(() => {
      const seq = seqOf(frame);
      if (seq !== null) {
        const seen = to === "host" ? seenFromJoiner : seenFromHost;
        if (seq > seen + 1) handler({ kind: "lagged" });
        if (to === "host") seenFromJoiner = Math.max(seenFromJoiner, seq);
        else seenFromHost = Math.max(seenFromHost, seq);
      }
      delivered.push({ to, frame });
      handler({ kind: "frame", from, frame });
    });
  }

  function emit(to: "host" | "joiner", e: CollabEvent) {
    const handler = to === "host" ? hostHandler : joinerHandler;
    if (handler) queue.push(() => handler(e));
  }

  const host: CollabTransport = {
    async host(onEvent) {
      hostHandler = onEvent;
      issued = `ticket-${Math.random().toString(36).slice(2, 8)}`;
      return issued;
    },
    async join() {
      throw new Error("no_session: the host side does not join");
    },
    async send(frame) {
      if (!hostHandler) throw new Error("no_session: not paired");
      if (typeof frame !== "string" && "Welcome" in frame) welcomed = true;
      const stamped = stamp(frame, seqOf(frame) !== null ? ++seqFromHost : 0);
      if (consumedBy) deliver("joiner", HOST_ID, stamped);
    },
    async close() {
      if (consumedBy) {
        deliver("joiner", HOST_ID, "Bye");
        emit("joiner", { kind: "peer_down", peer: HOST_ID });
      }
      emit("host", { kind: "closed" });
      hostHandler = null;
    },
    async status() {
      return { active: hostHandler !== null, endpoint_id: HOST_ID };
    },
  };

  const joiner: CollabTransport = {
    async host() {
      throw new Error("no_session: the joiner side does not host");
    },
    async join(ticket, onEvent) {
      if (ticket !== issued) throw new Error("bad_ticket: damaged");
      joinerHandler = onEvent;
      emit("joiner", { kind: "peer_up", peer: HOST_ID });
      emit("host", { kind: "peer_up", peer: JOINER_ID });
      if (consumedBy && consumedBy !== JOINER_ID) {
        emit("host", { kind: "refused", peer: JOINER_ID, reason: "ticket_spent: someone has already joined with this code" });
      } else {
        consumedBy = JOINER_ID;
        emit("host", { kind: "admitted", peer: JOINER_ID, sas: SAS });
      }
      return { sas: SAS };
    },
    async send(frame) {
      if (!joinerHandler) throw new Error("no_session: not paired");
      const stamped = stamp(frame, seqOf(frame) !== null ? ++seqFromJoiner : 0);
      // The gate: nothing from the joiner is believed before Welcome.
      if (welcomed) deliver("host", JOINER_ID, stamped);
    },
    async close() {
      if (welcomed) deliver("host", JOINER_ID, "Bye");
      emit("host", { kind: "peer_down", peer: JOINER_ID });
      emit("joiner", { kind: "closed" });
      joinerHandler = null;
    },
    async status() {
      return { active: joinerHandler !== null, endpoint_id: JOINER_ID };
    },
  };

  return {
    host,
    joiner,
    delivered,
    async settle() {
      for (let round = 0; round < 50; round++) {
        // Let awaiting sends resolve before looking at the queue.
        for (let i = 0; i < 5; i++) await Promise.resolve();
        if (!queue.length) return;
        while (queue.length) queue.shift()!();
      }
      throw new Error("the bus never settled — a frame loop?");
    },
    lose(n) {
      toLose += n;
    },
    vanish(side) {
      if (side === "joiner") {
        joinerHandler = null;
        emit("host", { kind: "peer_down", peer: JOINER_ID });
      } else {
        hostHandler = null;
        emit("joiner", { kind: "peer_down", peer: HOST_ID });
      }
    },
  };
}
