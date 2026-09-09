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
  opts: { me?: string; store?: BoardStore | null; boardId?: () => string } = {},
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
    error.value = collabErrorKey(message) ?? persistErrorKey(message) ?? message;
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

  // ── the engine side ────────────────────────────────────────────────────────

  /** May this user's UNDO touch a shape? An edit may touch anything; undo may
   *  touch only what this user was the last to write. */
  function mayTouch(id: string, reason: CommitReason): boolean {
    return reason !== "history" || (lastWriter.get(id) ?? me) === me;
  }

  /** The commit observer: diff the engine's new list against the CRDT, turn
   *  the difference into ops, answer with the merged view. */
  function onCommit(_prev: Shape[], next: Shape[], reason: CommitReason): Shape[] {
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
      await store.save(boardId(), JSON.stringify(documentBody()));
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

  /** Restore what was stored for this board, MERGED rather than replacing, so
   *  a board drawn on since the last write keeps that work. */
  async function restore(): Promise<boolean> {
    if (!store || !sketch) return false;
    try {
      const raw = await store.load(boardId());
      if (!raw) return false;
      applySnapshot(JSON.parse(raw) as SnapshotBody);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  async function sendSnapshot() {
    if (!sketch) return;
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
      setBoard(frame.Welcome.width, frame.Welcome.height);
      sketch.applyRemote([]);
      phase.value = "live";
      return;
    }
    if ("Snapshot" in frame) {
      applySnapshot(JSON.parse(fromBytes(frame.Snapshot.bytes)) as SnapshotBody);
      if (phase.value === "pairing") phase.value = "live";
      return;
    }
    if ("Op" in frame) {
      applyOp(JSON.parse(fromBytes(frame.Op.bytes)) as Op);
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
    if (s && store && phase.value === "idle") s.observeCommits(onCommit);
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
      seed();
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
    restore,
    saveNow,
    host,
    join,
    accept,
    leave,
  };
}

export type CollabSession = ReturnType<typeof createCollabSession>;
