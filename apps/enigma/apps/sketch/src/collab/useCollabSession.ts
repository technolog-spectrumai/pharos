// A collaboration session: one board, two peers, a transport between them.
//
// This is the bridge between the sketch engine and the CRDT. The engine keeps
// its plain shape list — the canvas, the toolbar and the file format all read
// that — and this session keeps a `SketchCrdt` beside it as the state the two
// peers actually agree on. Every committed local change is diffed against the
// CRDT and becomes operations on the wire; every remote operation is merged
// into the CRDT and the engine is shown the result. The shape list is thus a
// PROJECTION of the CRDT for as long as a session runs, and goes back to being
// itself when it ends — with the merged drawing still on the board, so either
// peer can save it through the ordinary path.
//
// Three rules from the plan, each enforced here:
//
//   * The document leaves the host only after a human said yes. `accept()` is
//     what sends `Welcome` and then the snapshot; Rust drops the peer's frames
//     until that `Welcome`, and nothing here sends a shape before it.
//   * Undo reverts only what you were the last to touch. An edit may delete
//     the peer's shape (that is a decision); Ctrl+Z may not resurrect or remove
//     what the peer did. `lastWriter` is the memory that makes the difference.
//   * `lagged` is answered, not logged. Gossip dropped frames; the peer is
//     asked for a snapshot, and the merge — never a replace — puts the board
//     back together without losing what was drawn meanwhile.
//
// Authorship lives in the CRDT's metadata and never in the `.svg`; the file
// format is untouched. The background colour is a separate last-writer-wins
// register because it is document state, not a shape. The background IMAGE
// is not synchronised at all: a data URL of up to 9 MB has no place in a
// gossip message, and the peer sees a plain board where the host sees a photo.
import { ref, watch, type Ref, type WatchStopHandle } from "vue";
import type { Shape } from "wisteria/sketchModel";
import type { CommitReason, LiveStroke, Sketch } from "wisteria/useSketch";
import {
  clearAll,
  deleteShapes,
  emptyCrdt,
  liveShapes,
  makeClock,
  mergeSnapshot,
  SKETCH_WIRE_V,
  truncateSnapshot,
  upsertShape,
  type SketchCrdt,
  type SnapshotWire,
  type WireShape,
} from "wisteria/sketchCrdt";
import { persistErrorKey, type BoardStore } from "./persist";
import { documentErrorKey, type BoardDoc, type Committed } from "./document";
import {
  collabErrorKey,
  fromBytes,
  PROTO_V,
  toBytes,
  type CollabEvent,
  type CollabTransport,
  type WireFrame,
} from "./transport";

/** Where a session is.
 *    idle     — nothing running
 *    hosting  — the ticket is on screen, nobody has scanned it yet
 *    pairing  — a peer is admitted; both screens show the auth string, and the
 *               host has not yet tapped Accept (the joiner waits here too)
 *    live     — the snapshot has gone over; both boards converge from here */
export type Phase = "idle" | "hosting" | "pairing" | "live";
export type Role = "host" | "joiner";

/** One operation, as it travels inside `Frame::Op`. JSON, because both ends
 *  are this same code and a shape is JSON already. */
type Op =
  | { k: "up"; e: WireShape }
  | { k: "del"; ids: string[]; at: number; by: string }
  | { k: "clr"; at: number; by: string }
  | { k: "bg"; color: string | null; at: number; by: string };

/** The background colour as a last-writer-wins register. */
interface BgRegister {
  color: string | null;
  at: number;
  by: string;
}

/** What `Frame::Snapshot` carries. */
interface SnapshotBody {
  snap: SnapshotWire;
  bg: BgRegister;
}

/** Live strokes and cursors go out at most this often. Enough for a stroke
 *  to look continuous on the other screen; low enough that a fast hand does
 *  not turn into a hundred frames a second. */
export const LIVE_HZ = 20;
const LIVE_MS = 1000 / LIVE_HZ;

/** Below the transport's 1 MiB cap with room for the IPC's number-array
 *  encoding. A board that does not fit is sent newest-first and flagged. */
export const MAX_SNAPSHOT_BYTES = 700_000;

/** A change-rate limiter: the first change goes out at once, later ones wait
 *  for the tick and only the LATEST is sent. `flush` bypasses the wait for a
 *  value that must not lag — the end of a stroke. */
function throttle<T>(send: (v: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { v: T } | null = null;
  const fire = () => {
    timer = null;
    if (pending) {
      const { v } = pending;
      pending = null;
      send(v);
      timer = setTimeout(fire, ms);
    }
  };
  return {
    push(v: T) {
      if (timer) {
        pending = { v };
        return;
      }
      send(v);
      timer = setTimeout(fire, ms);
    },
    flush(v: T) {
      pending = null;
      if (timer) clearTimeout(timer);
      timer = null;
      send(v);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/** Strip a Vue proxy and share nothing with the engine's array. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** yrs updates are binary and the store's surface is text.
 *
 *  Base64 rather than a number array: a 123 KB update is ~164 KB base64 and
 *  ~500 KB as JSON digits, and this is the one place the document is written
 *  repeatedly. Chunked because `String.fromCharCode(...bytes)` on a large
 *  array overflows the call stack. */
const B64_CHUNK = 8192;

export function bytesToB64(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    out += String.fromCharCode(...bytes.slice(i, i + B64_CHUNK));
  }
  return btoa(out);
}

export function b64ToBytes(text: string): number[] {
  const raw = atob(text);
  const out = new Array<number>(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function same(a: Shape, b: Shape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** How long after the last change the board is written.
 *
 *  A whole drag, a burst of erases and a paste all settle into ONE write. The
 *  store batches and fsyncs once per call — 19.5 µs batched against 3.4 ms
 *  fsynced per key, measured — so the debounce is not about the cost of a
 *  write, it is about not doing two hundred of them for one gesture. */
export const SAVE_DEBOUNCE_MS = 500;

export function createCollabSession(
  transport: CollabTransport,
  opts: {
    me?: string;
    store?: BoardStore | null;
    boardId?: () => string;
    /** The yrs board in Rust. When present the document lives THERE and the
     *  in-memory CRDT below is not used: ops on the wire are yrs updates and
     *  the merge is the library's.
     *
     *  Injected rather than imported so this file has no Tauri dependency —
     *  the same reason the transport and the store are. A build without the
     *  `document` Cargo feature passes null and keeps the older path, which is
     *  what every existing test exercises. */
    doc?: BoardDoc | null;
  } = {},
) {
  /** This peer's author id — the LWW tie-break and the undo boundary. Random
   *  per session rather than the endpoint id, which is not known until the
   *  transport is up and would tie authorship to a network identity. */
  const me = opts.me ?? crypto.randomUUID();

  const phase = ref<Phase>("idle");
  const role = ref<Role | null>(null);
  /** The ticket text while hosting — what the QR shows. */
  const ticket = ref<string | null>(null);
  /** The six digits both screens must agree on. */
  const sas = ref<string | null>(null);
  const peer = ref<string | null>(null);
  const peerOnline = ref(false);
  /** A catalogue key (`collab.errors.*`) or a raw message; null when fine. */
  const error = ref<string | null>(null);
  /** The last snapshot received did not fit and the oldest shapes are missing. */
  const truncated = ref(false);

  let sketch: Sketch | null = null;
  let crdt: SketchCrdt = emptyCrdt();
  const clock = makeClock();
  /** id → the author who last upserted, deleted or cleared it. What undo is
   *  allowed to touch. */
  let lastWriter = new Map<string, string>();
  /** id → first createdAt seen, so an undo that resurrects a shape keeps its
   *  place in the paint order rather than jumping to the top. */
  let created = new Map<string, number>();
  /** id → the shape as the board last knew it, for the yrs path.
   *
   *  The old path could diff against `crdt.entries` because the CRDT was right
   *  here; the board is a round trip away, so what it holds is mirrored as it
   *  is written. Only used to decide WHAT CHANGED — never as a source of
   *  truth for what to draw, which is always the board's answer. */
  let lastSeen = new Map<string, Shape>();
  let bg: BgRegister = { color: null, at: 0, by: "" };
  /** The peer we sent `Welcome` to. A reconnecting holder is admitted again
   *  by Rust and accepted again here without a second human confirmation —
   *  same endpoint, same auth string already compared. */
  let acceptedPeer: string | null = null;
  /** Set while a remote value is being written into the engine, so the
   *  watcher that turns local writes into ops does not echo it back. */
  let applying = false;
  let stops: WatchStopHandle[] = [];
  let liveOut: ReturnType<typeof throttle<LiveStroke | null>> | null = null;
  let cursorOut: ReturnType<typeof throttle<{ x: number; y: number } | null>> | null = null;

  function fail(err: unknown) {
    const message = (err as Error)?.message ?? String(err);
    // Two catalogues reach this: the transport's and the store's. A prefix in
    // neither is shown verbatim, because a filesystem message names the actual
    // problem better than "something failed" would.
    error.value =
      collabErrorKey(message) ?? persistErrorKey(message) ?? documentErrorKey(message) ?? message;
  }

  async function send(frame: WireFrame) {
    try {
      await transport.send(frame);
    } catch (err) {
      fail(err);
    }
  }

  function sendOp(op: Op) {
    return send({ Op: { seq: 0, bytes: toBytes(JSON.stringify(op)) } });
  }

  /** A yrs update on the wire.
   *
   *  The frame is the same `Frame::Op` the JSON ops used — `crates/collab`
   *  moves opaque bytes and does not care which they are — so the transport,
   *  the sequence tracking and the resync logic are untouched by the change of
   *  document. */
  function sendUpdate(update: number[]) {
    return send({ Op: { seq: 0, bytes: update } });
  }

  /** Push a change into the yrs board and broadcast whatever it produced.
   *
   *  Failures surface and are otherwise swallowed: a board that cannot reach
   *  Rust is a broken app, but dropping the peer or freezing the canvas would
   *  make it worse than it needs to be. */
  function commitToBoard(change: () => Promise<Committed>) {
    if (!yboard || !sketch) return Promise.resolve();
    return queueBoard(() => runCommit(change));
  }

  async function runCommit(change: () => Promise<Committed>) {
    if (!yboard || !sketch) return;
    try {
      const answer = await change();
      showBoard(answer);
      if (answer.update) await sendUpdate(answer.update);
      scheduleSave();
    } catch (err) {
      applying = false;
      fail(err);
    }
  }

  /** Put the board's answer on screen.
   *
   *  The background travels HERE rather than as its own op: it is document
   *  state the board already holds, and a peer's background has no other way
   *  to arrive — `applyRemote` moves shapes and nothing else. `applying`
   *  guards the watcher so writing it back does not echo as a new local
   *  change. */
  function showBoard(answer: Committed) {
    if (!sketch) return;
    applying = true;
    sketch.applyRemote(answer.shapes);
    if (sketch.doc.value.background !== answer.background) {
      sketch.doc.value.background = answer.background;
    }
    applying = false;
    if (answer.width > 0 && answer.height > 0) setBoard(answer.width, answer.height);
  }

  // ── the engine side ────────────────────────────────────────────────────────

  /** May this user's UNDO touch a shape? An edit may touch anything; undo may
   *  touch only what this user was the last to write. */
  function mayTouch(id: string, reason: CommitReason): boolean {
    return reason !== "history" || (lastWriter.get(id) ?? me) === me;
  }

  /** The commit observer, yrs edition.
   *
   *  Answers SYNCHRONOUSLY with the engine's own list and reconciles with the
   *  board afterwards, because `observeCommits` must return the shapes to draw
   *  now and the board is a round trip away. That is not a compromise on
   *  convergence: what the peer receives, and what is written to disk, is
   *  whatever the board says once the write lands. The only thing the local
   *  screen does is show the user's own edit immediately, which it must.
   *
   *  What the old path needed and this does not: a hybrid logical clock, a
   *  `created` map to hold paint order across a resurrect, and `lastWriter` as
   *  a separate structure — yrs keeps the order in its array, stamps its own
   *  Lamport clocks, and `authorOfShape` reads authorship back off the board.
   *
   *  The one thing still tracked here is the UNDO boundary: `mayTouch` is
   *  policy about who may revert what, not a CRDT concern, so it stays.
   */
  function onCommitYrs(next: Shape[], reason: CommitReason): Shape[] {
    const known = lastSeen;
    const nextIds = new Set(next.map((s) => s.id));

    if (reason === "clear" && known.size > 0) {
      for (const id of known.keys()) lastWriter.set(id, me);
      lastSeen = new Map();
      void commitToBoard(() => yboard!.clear());
      return next;
    }

    const gone = [...known.keys()].filter((id) => !nextIds.has(id) && mayTouch(id, reason));
    const changed = next.filter((sh) => {
      const before = known.get(sh.id);
      return (!before || !same(before, sh)) && mayTouch(sh.id, reason);
    });
    if (!gone.length && !changed.length) return next;

    for (const id of gone) {
      lastWriter.set(id, me);
      lastSeen.delete(id);
    }
    for (const sh of changed) {
      lastWriter.set(sh.id, me);
      lastSeen.set(sh.id, plain(sh));
    }

    // Deletes and edits go as ONE update when both happened, so the peer never
    // renders a half-applied gesture.
    void commitToBoard(async () => {
      if (gone.length) {
        const r = await yboard!.remove(gone);
        if (!changed.length) return r;
      }
      return yboard!.putMany(changed.map((sh) => plain(sh)));
    });
    return next;
  }

  /** The commit observer: diff the engine's new list against the CRDT, turn
   *  the difference into ops, answer with the merged view. */
  function onCommit(_prev: Shape[], next: Shape[], reason: CommitReason): Shape[] {
    if (yboard) return onCommitYrs(next, reason);
    const ops: Op[] = [];
    const nextIds = new Set(next.map((s) => s.id));

    if (reason === "clear" && crdt.entries.length > 0) {
      // A clear is one register, not N tombstones — and it voids whatever the
      // peer drew before it, which is what "clear the board" means.
      const at = clock.now();
      for (const e of crdt.entries) lastWriter.set(e.shape.id, me);
      clearAll(crdt, at);
      ops.push({ k: "clr", at, by: me });
    } else {
      const gone = crdt.entries
        .map((e) => e.shape.id)
        .filter((id) => !nextIds.has(id) && mayTouch(id, reason));
      if (gone.length) {
        const at = clock.now();
        deleteShapes(crdt, gone, at);
        for (const id of gone) lastWriter.set(id, me);
        ops.push({ k: "del", ids: gone, at, by: me });
      }
      for (const s of next) {
        const cur = crdt.entries.find((e) => e.shape.id === s.id);
        if (cur && same(cur.shape, s)) continue;
        if (!mayTouch(s.id, reason)) continue;
        const at = clock.now();
        const e: WireShape = {
          shape: plain(s),
          meta: { author: me, createdAt: cur?.meta.createdAt ?? created.get(s.id) ?? at, updatedAt: at },
        };
        if (upsertShape(crdt, e)) {
          lastWriter.set(s.id, me);
          created.set(s.id, e.meta.createdAt);
          ops.push({ k: "up", e });
        }
      }
    }
    // Outside a session there is nobody to send to; `send` no-ops and the
    // ops still land in the CRDT, which is what gets written.
    for (const op of ops) void sendOp(op);
    if (ops.length) scheduleSave();
    return liveShapes(crdt);
  }

  function bgWins(next: BgRegister): boolean {
    return next.at > bg.at || (next.at === bg.at && next.by > bg.by);
  }

  /** Merge a yrs update from a peer or the store.
   *
   *  Always a merge, never a replace — anything drawn while the update was in
   *  flight survives. The old path had to implement that property by hand in
   *  `applySnapshot`; here it is what the library does.
   *
   *  Authorship is NOT carried in the update. The old ops named an author on
   *  every shape because the CRDT needed one to break ties; yrs breaks ties on
   *  its own client ids, so the only remaining use for authorship is the undo
   *  boundary — and for that, "the peer touched it" is exactly right. */
  async function applyUpdate(update: number[]) {
    if (!yboard || !sketch) return;
    try {
      const before = new Set(lastSeen.keys());
      const answer = await yboard.apply(update);
      const { shapes } = answer;
      showBoard(answer);
      const now = new Map<string, Shape>();
      for (const sh of shapes) now.set(sh.id, sh);
      // Whatever the peer's update changed is theirs for undo purposes.
      for (const [id, sh] of now) {
        const was = lastSeen.get(id);
        if (!was || !same(was, sh)) lastWriter.set(id, peer.value ?? "peer");
      }
      for (const id of before) if (!now.has(id)) lastWriter.set(id, peer.value ?? "peer");
      lastSeen = now;
      // The peer's stroke has landed as a shape; the preview has done its job.
      const live = sketch.peerLive.value;
      if (live && now.has(live.id)) sketch.peerLive.value = null;
      scheduleSave();
    } catch (err) {
      applying = false;
      fail(err);
    }
  }

  function applyOp(op: Op) {
    if (!sketch) return;
    switch (op.k) {
      case "up": {
        clock.observe(op.e.meta.updatedAt);
        clock.observe(op.e.meta.createdAt);
        if (upsertShape(crdt, op.e)) lastWriter.set(op.e.shape.id, op.e.meta.author);
        if (!created.has(op.e.shape.id)) created.set(op.e.shape.id, op.e.meta.createdAt);
        // The peer's stroke has landed as a shape; the preview has done its job.
        if (sketch.peerLive.value?.id === op.e.shape.id) sketch.peerLive.value = null;
        break;
      }
      case "del":
        clock.observe(op.at);
        deleteShapes(crdt, op.ids, op.at);
        for (const id of op.ids) lastWriter.set(id, op.by);
        break;
      case "clr":
        clock.observe(op.at);
        for (const e of crdt.entries) if (e.meta.createdAt <= op.at) lastWriter.set(e.shape.id, op.by);
        clearAll(crdt, op.at);
        break;
      case "bg":
        clock.observe(op.at);
        if (bgWins(op)) {
          bg = { color: op.color, at: op.at, by: op.by };
          applying = true;
          sketch.doc.value.background = op.color;
          applying = false;
        }
        return; // no shape changed
    }
    sketch.applyRemote(liveShapes(crdt));
    // A peer's change is as much a reason to write as our own.
    scheduleSave();
  }

  function setBoard(width: number, height: number) {
    if (!sketch) return;
    if (sketch.envelope.value.width === width && sketch.envelope.value.height === height) return;
    sketch.envelope.value = { ...sketch.envelope.value, width, height };
  }

  // ── the board on disk ──────────────────────────────────────────────────
  // Only the DOCUMENT is written: the same `SnapshotBody` that goes on the
  // wire, carrying the shapes, the tombstones, the clear cutoff, the board
  // size and the background colour. Nothing else may be stored — no group key,
  // no ticket, no endpoint or author id — because the MLS layer declines to
  // persist a group key and the transport keeps its identity ephemeral on
  // purpose, and writing either here would quietly reverse both.
  const store = opts.store ?? null;
  /** The yrs board in Rust, or null to use the in-memory CRDT above.
   *
   *  Everything about it is asynchronous, which is why the commit observer
   *  below still answers synchronously from the local CRDT and reconciles
   *  afterwards: `observeCommits` must return the board to draw NOW, and a
   *  round trip to Rust cannot happen inside it. */
  let yboard = opts.doc ?? null;
  /** Board work, run strictly in the order it was queued.
   *
   *  `onFrame` is synchronous — the transport hands frames over one at a time
   *  and cannot await — while every board call is a round trip. Firing them
   *  off with `void` lets a later frame's write land before an earlier one's,
   *  and the failure is silent: a `reset` from `Welcome` overtaking the
   *  `Snapshot` that follows it wipes the board the joiner just received, with
   *  no error anywhere. Found exactly that way.
   *
   *  So everything that touches the board goes through here, and ordering is a
   *  property of the session rather than of how fast Rust answers. */
  let boardWork: Promise<unknown> = Promise.resolve();
  function queueBoard(job: () => Promise<unknown>): Promise<unknown> {
    boardWork = boardWork.then(job, job);
    return boardWork;
  }
  const boardId = opts.boardId ?? (() => "current");
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** The document as it would go on the wire, which is also how it is stored. */
  function documentBody(): SnapshotBody {
    return {
      snap: {
        v: SKETCH_WIRE_V,
        entries: crdt.entries,
        tombs: Object.entries(crdt.tombstones),
        clearedAt: crdt.clearedAt,
        truncated: false,
        width: sketch?.boardW.value ?? 0,
        height: sketch?.boardH.value ?? 0,
      },
      // Read from the board rather than from `bg`, which is only maintained
      // while a session is running — its watcher lives in `hook()`. Outside a
      // session the board itself is the truth, and inside one the two agree.
      bg: sketch ? { ...bg, color: sketch.doc.value.background } : bg,
    };
  }

  async function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!store || !sketch) return;
    try {
      // With a yrs board the stored bytes ARE the document — the same update a
      // peer would receive, base64'd because the store's surface is text. No
      // re-encoding between the CRDT and the disk, which is the whole reason
      // the document lives in Rust beside the store.
      // Captured before the await: `yboard` can be reassigned by
      // `useDocument`, so the closure must hold the board this save is about.
      const doc = yboard;
      const body = doc
        ? JSON.stringify({ y: bytesToB64((await queueBoard(() => doc.snapshot())) as number[]) })
        : JSON.stringify(documentBody());
      await store.save(boardId(), body);
    } catch (err) {
      // A failed autosave must not take the session down with it — the board
      // is still on screen and still shared. Surfaced, not swallowed.
      fail(err);
    }
  }

  /** Ask for a save; the last request in a burst is the one that lands. */
  function scheduleSave() {
    if (!store) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void saveNow(), SAVE_DEBOUNCE_MS);
  }

  /** Adopt a document backend after construction.
   *
   *  The app probes for the `document` Cargo feature asynchronously and the
   *  session is created at import time, so the handle arrives late. Refused
   *  once a session is running: swapping the document under a live peer would
   *  leave the two boards sharing no history, and every subsequent update
   *  would land in the gap. Nothing calls it that late — the probe settles
   *  before the editor has mounted — and this is what makes that a rule rather
   *  than an assumption. */
  function useDocument(next: BoardDoc | null): boolean {
    if (phase.value !== "idle") return false;
    yboard = next;
    lastSeen = new Map();
    return true;
  }

  /** Restore what was stored for this board, MERGED rather than replacing, so
   *  a board drawn on since the last write keeps that work. */
  async function restore(): Promise<boolean> {
    if (!store || !sketch) return false;
    try {
      const raw = await store.load(boardId());
      if (!raw) return false;
      const parsed = JSON.parse(raw) as SnapshotBody | { y: string };
      if (yboard && "y" in parsed) {
        await queueBoard(() => applyUpdate(b64ToBytes(parsed.y)));
        return true;
      }
      if ("y" in parsed) return false; // a yrs board with no yrs to read it
      applySnapshot(parsed);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  async function sendSnapshot() {
    if (!sketch) return;
    const board = yboard;
    if (board) {
      // The whole board as one update. Not truncated, and it cannot need to
      // be: 1000 shapes encode to ~123 KB where the JSON snapshot had to be
      // cut at 700 KB — which is why `truncated` and its warning are dead on
      // this path.
      //
      // Queued like everything else, so a joiner is sent the board INCLUDING
      // whatever `seed()` was still writing when the snapshot was asked for.
      try {
        const bytes = (await queueBoard(() => board.snapshot())) as number[];
        await send({
          Snapshot: {
            seq: 0,
            width: sketch.boardW.value,
            height: sketch.boardH.value,
            bytes,
          },
        });
      } catch (err) {
        fail(err);
      }
      return;
    }
    const tombs = Object.entries(crdt.tombstones);
    const cut = truncateSnapshot(crdt.entries, tombs, crdt.clearedAt, MAX_SNAPSHOT_BYTES);
    const width = sketch.boardW.value;
    const height = sketch.boardH.value;
    const body: SnapshotBody = {
      snap: { v: SKETCH_WIRE_V, entries: cut.entries, tombs: cut.tombs, clearedAt: crdt.clearedAt, truncated: cut.truncated, width, height },
      bg,
    };
    await send({ Snapshot: { seq: 0, width, height, bytes: toBytes(JSON.stringify(body)) } });
  }

  function applySnapshot(body: SnapshotBody) {
    if (!sketch) return;
    const { snap } = body;
    if (snap.v !== SKETCH_WIRE_V) {
      error.value = "collab.errors.bad_version";
      return;
    }
    clock.observe(snap.clearedAt);
    for (const [, at] of snap.tombs) clock.observe(at);
    for (const e of snap.entries) {
      clock.observe(e.meta.updatedAt);
      if (!created.has(e.shape.id)) created.set(e.shape.id, e.meta.createdAt);
    }
    mergeSnapshot(crdt, snap);
    // Whatever the snapshot says about a shape, its sender last wrote it —
    // close enough for the undo boundary, and exact for a fresh joiner.
    for (const e of snap.entries) if (!lastWriter.has(e.shape.id)) lastWriter.set(e.shape.id, e.meta.author);
    truncated.value = snap.truncated;
    if (bgWins(body.bg)) {
      bg = body.bg;
      applying = true;
      sketch.doc.value.background = bg.color;
      applying = false;
    }
    setBoard(snap.width, snap.height);
    sketch.applyRemote(liveShapes(crdt));
  }

  /** Take the engine's current board into the CRDT as this user's work — the
   *  host's starting point, in the paint order the file had. */
  function seed() {
    if (!sketch) return;
    const board = yboard;
    if (board) {
      const shapes = sketch.doc.value.shapes.map((sh) => plain(sh));
      for (const sh of shapes) {
        lastWriter.set(sh.id, me);
        lastSeen.set(sh.id, sh);
      }
      void queueBoard(async () => {
        try {
          await board.setSize(sketch!.boardW.value, sketch!.boardH.value);
          await board.setBackground(sketch!.doc.value.background);
          if (shapes.length) await board.putMany(shapes);
        } catch (err) {
          fail(err);
        }
      });
      return;
    }
    for (const s of sketch.doc.value.shapes) {
      const at = clock.now();
      const e: WireShape = { shape: plain(s), meta: { author: me, createdAt: at, updatedAt: at } };
      upsertShape(crdt, e);
      lastWriter.set(s.id, me);
      created.set(s.id, at);
    }
    bg = { color: sketch.doc.value.background, at: clock.now(), by: me };
  }

  function hook() {
    if (!sketch) return;
    const s = sketch;
    s.observeCommits(onCommit);
    liveOut = throttle<LiveStroke | null>(
      (v) => void send({ Live: { bytes: toBytes(JSON.stringify(v)) } }),
      LIVE_MS,
    );
    cursorOut = throttle<{ x: number; y: number } | null>(
      (v) => void send(v ? { Cursor: { x: v.x, y: v.y } } : { Cursor: { x: -1, y: -1 } }),
      LIVE_MS,
    );
    stops = [
      watch(
        () => s.doc.value.background,
        (color) => {
          if (applying) return;
          const board = yboard;
          if (board) {
            void commitToBoard(() => board.setBackground(color));
            return;
          }
          bg = { color, at: clock.now(), by: me };
          void sendOp({ k: "bg", ...bg });
        },
        { flush: "sync" },
      ),
      // Deep: a stroke grows by pushing points into the same object.
      watch(
        s.selfLive,
        (live) => {
          if (!live) liveOut?.flush(null); // the end of a stroke must not lag
          else liveOut?.push(plain(live));
        },
        // Sync, not pre-flush: a stroke is a burst of pushes into one object,
        // and the throttle — not Vue's scheduler — is what sets the rate.
        { deep: true, flush: "sync" },
      ),
      watch(s.pointer, (p) => cursorOut?.push(p ? { x: p.x, y: p.y } : null), { flush: "sync" }),
    ];
  }

  function unhook() {
    sketch?.observeCommits(null);
    for (const stop of stops) stop();
    stops = [];
    liveOut?.stop();
    cursorOut?.stop();
    liveOut = cursorOut = null;
  }

  function reset() {
    unhook();
    if (sketch) {
      sketch.peerLive.value = null;
      sketch.peerCursor.value = null;
    }
    crdt = emptyCrdt();
    lastWriter = new Map();
    created = new Map();
    lastSeen = new Map();
    bg = { color: null, at: 0, by: "" };
    acceptedPeer = null;
    phase.value = "idle";
    role.value = null;
    ticket.value = null;
    sas.value = null;
    peer.value = null;
    peerOnline.value = false;
    truncated.value = false;
  }

  // ── the transport side ─────────────────────────────────────────────────────

  function onFrame(frame: WireFrame) {
    if (!sketch) return;
    if (frame === "Resync") {
      void sendSnapshot();
      return;
    }
    if (frame === "Bye") {
      peerOnline.value = false;
      sketch.peerLive.value = null;
      sketch.peerCursor.value = null;
      return;
    }
    if ("Welcome" in frame) {
      // The host said yes. Our board becomes the host's: what was here is
      // replaced by the snapshot that follows, which the panel warned about.
      if (frame.Welcome.proto !== PROTO_V) {
        error.value = "collab.errors.bad_version";
        return;
      }
      crdt = emptyCrdt();
      lastWriter = new Map();
      created = new Map();
      lastSeen = new Map();
      const fresh = yboard;
      if (fresh) void queueBoard(() => fresh.reset().catch(fail));
      setBoard(frame.Welcome.width, frame.Welcome.height);
      sketch.applyRemote([]);
      phase.value = "live";
      return;
    }
    if ("Snapshot" in frame) {
      if (yboard) {
        setBoard(frame.Snapshot.width, frame.Snapshot.height);
        void queueBoard(() => applyUpdate(frame.Snapshot.bytes));
      } else {
        applySnapshot(JSON.parse(fromBytes(frame.Snapshot.bytes)) as SnapshotBody);
      }
      if (phase.value === "pairing") phase.value = "live";
      return;
    }
    if ("Op" in frame) {
      if (yboard) void queueBoard(() => applyUpdate(frame.Op.bytes));
      else applyOp(JSON.parse(fromBytes(frame.Op.bytes)) as Op);
      return;
    }
    if ("Live" in frame) {
      sketch.peerLive.value = JSON.parse(fromBytes(frame.Live.bytes)) as LiveStroke | null;
      return;
    }
    if ("Cursor" in frame) {
      const { x, y } = frame.Cursor;
      sketch.peerCursor.value = x < 0 ? null : { x, y };
      return;
    }
    // Hello never reaches here: the gate consumes it.
  }

  function onEvent(e: CollabEvent) {
    switch (e.kind) {
      case "peer_up":
        peer.value ??= e.peer;
        if (e.peer === peer.value) peerOnline.value = true;
        break;
      case "peer_down":
        if (e.peer === peer.value) {
          peerOnline.value = false;
          if (sketch) {
            sketch.peerLive.value = null;
            sketch.peerCursor.value = null;
          }
        }
        break;
      case "admitted":
        peer.value = e.peer;
        peerOnline.value = true;
        sas.value = e.sas;
        error.value = null;
        // A reconnect: the same endpoint we already accepted. Rust re-admits it
        // and we re-send Welcome + snapshot without asking the human twice.
        if (acceptedPeer === e.peer) void accept();
        else phase.value = "pairing";
        break;
      case "refused":
        error.value = collabErrorKey(e.reason) ?? e.reason;
        break;
      case "frame":
        if (e.from === peer.value) onFrame(e.frame);
        break;
      case "lagged":
        // Frames were dropped. Ask for the board; the merge keeps ours.
        void send("Resync");
        break;
      case "closed":
        reset();
        break;
    }
  }

  // ── the API ────────────────────────────────────────────────────────────────

  /** Whether a drawing is bound. Read by the panel — a Share button with no
   *  board behind it can only fail — and by the ownership tests, which cannot
   *  probe this through `host()` because the real transport needs Tauri. */
  const attached = ref(false);

  /** Bind to the drawing on screen. A new drawing (New, Open) ENDS a running
   *  session: the board the peer paired with is gone, and silently carrying
   *  the pairing over to another file would share something nobody agreed to.
   *
   *  Detaching goes through `detach`, which is by IDENTITY. Vue's keyed
   *  remount currently tears the old editor down before mounting the new one
   *  (verified), so an unconditional detach happens to be safe today — but it
   *  is safe by accident, and the opposite order is what Vue does for
   *  `<Transition>` and what a future refactor could reintroduce. Detaching
   *  only what you still own costs one comparison and cannot go wrong either
   *  way. */
  function attach(s: Sketch | null) {
    if (s === sketch) return;
    if (phase.value !== "idle") void leave();
    unhook();
    sketch = s;
    attached.value = s !== null;
    // Autosave does NOT wait for a session. `hook()` installs the commit
    // observer when pairing starts, which would mean a drawing nobody is
    // sharing never gets written — and a solo drawing is the common case. With
    // a store present the observer goes on at attach, and `hook()` re-installs
    // the same one when a session begins.
    if (s && (store || yboard) && phase.value === "idle") s.observeCommits(onCommit);
    // With a yrs board the document must START as what is on screen. `host()`
    // seeds too, but a drawing opened from a file is edited long before anyone
    // pairs — and an edit diffed against an EMPTY board would send the peer an
    // update that adds one shape to a document missing every other one.
    if (s && yboard) {
      void queueBoard(() => yboard!.reset());
      lastSeen = new Map();
      seed();
    }
  }

  /** Release `s`, but only if it is still the bound drawing. See `attach`. */
  function detach(s: Sketch | null) {
    if (s !== null && s !== sketch) return; // a later editor already took over
    attach(null);
  }

  async function host() {
    if (!sketch || phase.value !== "idle") return;
    error.value = null;
    try {
      role.value = "host";
      // The yrs board was seeded at attach and has been taking edits since;
      // seeding again would re-put every shape for no reason.
      if (!yboard) seed();
      hook();
      ticket.value = await transport.host(onEvent);
      phase.value = "hosting";
    } catch (err) {
      fail(err);
      reset();
    }
  }

  async function join(text: string) {
    if (!sketch || phase.value !== "idle") return;
    error.value = null;
    try {
      role.value = "joiner";
      hook();
      const reply = await transport.join(text.trim(), onEvent);
      sas.value = reply.sas;
      phase.value = "pairing";
    } catch (err) {
      fail(err);
      reset();
    }
  }

  /** The host's yes. Sends `Welcome` — which is what lets the peer's frames
   *  through on the Rust side — and only THEN the document. */
  async function accept() {
    if (!sketch || role.value !== "host" || !peer.value) return;
    acceptedPeer = peer.value;
    await send({ Welcome: { proto: PROTO_V, width: sketch.boardW.value, height: sketch.boardH.value } });
    await sendSnapshot();
    phase.value = "live";
  }

  async function leave() {
    if (phase.value === "idle") return;
    // Before the session state goes: a pending debounce would otherwise lose
    // whatever was drawn in the last half second.
    await saveNow();
    try {
      await transport.close();
    } catch {
      /* already gone */
    }
    reset();
  }

  return {
    me,
    phase: phase as Readonly<Ref<Phase>>,
    role,
    ticket,
    sas,
    peer,
    peerOnline,
    error,
    truncated,
    attached,
    attach,
    detach,
    useDocument,
    restore,
    saveNow,
    host,
    join,
    accept,
    leave,
  };
}

export type CollabSession = ReturnType<typeof createCollabSession>;
