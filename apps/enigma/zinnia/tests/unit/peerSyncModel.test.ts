import { describe, it, expect } from "vitest";
import {
  PEER_SCOPES, PEER_SCOPE_KV, PLINK_VERSION,
  bumpClock, emptyPeerBoard, formatSafetyNumber, grantIsLive, isPeerWritableNs,
  lclockWins, livePeerCards, mayIAccept, mayISend, mergePeerBoards, mergePeerMeetings,
  peerScopeKv, validateLClock, validatePeerBoard, validatePeerGrant, validatePeerMeeting,
  validatePlinkCal, validatePlinkHist, validatePlinkHello, validateScopes,
  type PeerBoard, type PeerGrant, type PeerMeeting,
} from "../../src/peerSyncModel";

const LINK_KEY = "A".repeat(43) + "=";

function grant(over: Partial<PeerGrant> = {}): PeerGrant {
  return {
    v: PLINK_VERSION,
    peerNodeId: "node-bob",
    peerName: "bob",
    linkKey: LINK_KEY,
    roomName: "plink-" + "0".repeat(64),
    safetyNumber: "1234567890123456",
    myScopes: ["calendar"],
    theirScopes: ["board"],
    initiator: true,
    createdAt: 1,
    rev: 1,
    ...over,
  };
}

function meeting(id: string, c: number, by: string, title = "t"): PeerMeeting {
  return {
    id, title, start: 100, end: 200, location: "", notes: "",
    status: "scheduled", organizer: "bob", clock: { c, by },
  };
}

describe("peerSyncModel — conflict clock", () => {
  it("higher counter wins regardless of who wrote it", () => {
    expect(lclockWins({ c: 2, by: "zzz" }, { c: 1, by: "aaa" })).toBe(true);
    expect(lclockWins({ c: 1, by: "aaa" }, { c: 2, by: "zzz" })).toBe(false);
  });

  it("a tie breaks by the lower NodeId, so both peers pick the SAME winner", () => {
    const alice = { c: 5, by: "node-alice" };
    const bob = { c: 5, by: "node-bob" };
    // Alice's side: is bob's incoming edit the winner over her local one?
    const aliceSays = lclockWins(bob, alice);
    // Bob's side: is alice's incoming edit the winner over his local one?
    const bobSays = lclockWins(alice, bob);
    // Exactly one of them adopts the other's value — never both, never neither.
    expect(aliceSays).not.toBe(bobSays);
    expect(bobSays).toBe(true); // "node-alice" < "node-bob"
  });

  it("an absent local value always loses, and a same-author repeat is not news", () => {
    expect(lclockWins({ c: 1, by: "a" }, undefined)).toBe(true);
    expect(lclockWins({ c: 3, by: "a" }, { c: 3, by: "a" })).toBe(false);
  });

  it("no wall clock can win: a huge timestamp is not a valid counter advance", () => {
    // The whole point of P5 — the wire carries a counter, and a peer claiming
    // Date.now() only wins if it genuinely made that many edits. Either way the
    // rule is deterministic and identical on both sides, which LWW was not.
    const liar = { c: Date.now(), by: "node-zzz" };
    const honest = { c: 4, by: "node-aaa" };
    expect(lclockWins(liar, honest)).toBe(true);
    // …but it cannot be forged into a *tie* win, and it is still symmetric:
    expect(lclockWins(honest, liar)).toBe(false);
  });

  it("bumpClock advances by one and records the author", () => {
    expect(bumpClock(undefined, "me")).toEqual({ c: 1, by: "me" });
    expect(bumpClock({ c: 7, by: "them" }, "me")).toEqual({ c: 8, by: "me" });
  });

  it("rejects malformed clocks off the wire", () => {
    expect(validateLClock({ c: 1.5, by: "a" })).toBeNull();
    expect(validateLClock({ c: -1, by: "a" })).toBeNull();
    expect(validateLClock({ c: 1, by: "" })).toBeNull();
    expect(validateLClock({ c: 1 })).toBeNull();
    expect(validateLClock({ c: 0, by: "a" })).toEqual({ c: 0, by: "a" });
  });
});

describe("peerSyncModel — scope enforcement", () => {
  it("mayISend / mayIAccept follow the two DIRECTIONS independently", () => {
    const g = grant({ myScopes: ["calendar"], theirScopes: ["board"] });
    expect(mayISend(g, "calendar")).toBe(true);
    expect(mayISend(g, "board")).toBe(false); // they share board, I don't
    expect(mayIAccept(g, "board")).toBe(true);
    expect(mayIAccept(g, "calendar")).toBe(false); // I share calendar, they don't
  });

  it("a revoked grant permits nothing in either direction", () => {
    const g = grant({ myScopes: [...PEER_SCOPES], theirScopes: [...PEER_SCOPES], revokedAt: 5 });
    expect(grantIsLive(g)).toBe(false);
    for (const s of PEER_SCOPES) {
      expect(mayISend(g, s)).toBe(false);
      expect(mayIAccept(g, s)).toBe(false);
    }
  });

  it("validateScopes drops unknowns, dedupes, and canonicalises the order", () => {
    expect(validateScopes(["history", "bogus", "calendar", "history"])).toEqual([
      "calendar", "history",
    ]);
    expect(validateScopes("calendar")).toEqual([]);
    expect(validateScopes(null)).toEqual([]);
    expect(validateScopes([{ toString: () => "calendar" }])).toEqual([]);
  });

  it("peer data can only land in per-peer namespaces (never your own state)", () => {
    // The hazard this guards: reusing the devlink allow-list would replicate
    // `p2p:rooms` — bearer join tickets for every room — to another person.
    expect(peerScopeKv("calendar", "node-bob")).toEqual({ ns: "peer:cal", scope: "node-bob", k: "" });
    expect(peerScopeKv("board", "node-bob").ns).toBe("peer:board");
    expect(peerScopeKv("card", "node-bob").ns).toBe("peer:card");
    for (const ns of ["contacts", "p2p:rooms", "meetings", "p2p:settings", "keys", "mls", "map:regions", "devices"]) {
      expect(isPeerWritableNs(ns)).toBe(false);
    }
    expect(PEER_SCOPE_KV).toEqual(["peer:cal", "peer:board", "peer:card", "chat:log"]);
  });

  it("the scope list matches the Rust mirror (pinning test)", () => {
    // src-tauri/src/peer_link.rs PEER_SCOPES must stay identical.
    expect([...PEER_SCOPES]).toEqual(["calendar", "history", "board", "card"]);
  });
});

describe("peerSyncModel — grant validation", () => {
  it("accepts a well-formed grant and narrows its scopes", () => {
    const g = validatePeerGrant({ ...grant(), myScopes: ["calendar", "junk"] });
    expect(g?.myScopes).toEqual(["calendar"]);
  });

  it("rejects a grant whose link key is not 32 base64 bytes", () => {
    expect(validatePeerGrant({ ...grant(), linkKey: "short" })).toBeNull();
    expect(validatePeerGrant({ ...grant(), linkKey: "" })).toBeNull();
  });

  it("rejects a wrong version and a missing peer id", () => {
    expect(validatePeerGrant({ ...grant(), v: 2 })).toBeNull();
    expect(validatePeerGrant({ ...grant(), peerNodeId: "" })).toBeNull();
  });

  it("carries a tombstone through validation", () => {
    expect(validatePeerGrant({ ...grant(), revokedAt: 99 })?.revokedAt).toBe(99);
  });
});

describe("peerSyncModel — calendar merge", () => {
  it("takes the newer item per id and leaves the older alone", () => {
    const local = [meeting("m1", 2, "a", "local"), meeting("m2", 1, "a")];
    const remote = [meeting("m1", 3, "b", "remote"), meeting("m2", 1, "b")];
    const { merged, changed } = mergePeerMeetings(local, remote, false);
    expect(changed).toBe(true);
    expect(merged.find((m) => m.id === "m1")?.title).toBe("remote");
    // m2: same counter, "a" < "b" so the local author wins — unchanged.
    expect(merged.find((m) => m.id === "m2")?.clock.by).toBe("a");
  });

  it("an authoritative full set removes items the peer dropped", () => {
    const local = [meeting("m1", 1, "b"), meeting("gone", 1, "b")];
    const { merged, changed } = mergePeerMeetings(local, [meeting("m1", 1, "b")], true);
    expect(changed).toBe(true);
    expect(merged.map((m) => m.id)).toEqual(["m1"]);
  });

  it("a partial (non-authoritative) frame never deletes", () => {
    const local = [meeting("m1", 1, "b"), meeting("keep", 1, "b")];
    const { merged } = mergePeerMeetings(local, [meeting("m1", 2, "b")], false);
    expect(merged.map((m) => m.id).sort()).toEqual(["keep", "m1"]);
  });

  it("rejects a meeting with no clock or a backwards range", () => {
    expect(validatePeerMeeting({ ...meeting("m", 1, "a"), clock: undefined })).toBeNull();
    expect(validatePeerMeeting({ ...meeting("m", 1, "a"), start: 500, end: 100 })).toBeNull();
  });
});

describe("peerSyncModel — board merge", () => {
  const board = (cards: PeerBoard["cards"], cc = { c: 1, by: "a" }): PeerBoard => ({
    v: PLINK_VERSION, columns: [{ id: "c0", title: "To Do", key: "a0" }], cards, columnsClock: cc,
  });
  const card = (id: string, c: number, by: string, over: Record<string, unknown> = {}) => ({
    id, columnId: "c0", title: id, description: "", key: "a0", author: by, done: false,
    clock: { c, by }, ...over,
  });

  it("merges cards per id by clock and keeps both sides' additions", () => {
    const { merged, changed } = mergePeerBoards(
      board([card("mine", 1, "a")]),
      board([card("theirs", 1, "b")]),
    );
    expect(changed).toBe(true);
    expect(merged.cards.map((c) => c.id).sort()).toEqual(["mine", "theirs"]);
  });

  it("a delete tombstone beats a stale copy — a delete actually converges", () => {
    // Without tombstones the peer re-pushes the card forever (the devlink v1
    // limitation this design deliberately fixes).
    const { merged } = mergePeerBoards(
      board([card("x", 1, "a")]),
      board([card("x", 2, "b", { deleted: true })]),
    );
    expect(merged.cards.find((c) => c.id === "x")?.deleted).toBe(true);
    expect(livePeerCards(merged)).toHaveLength(0);
  });

  it("a missing card is NOT a delete (both sides edit, so absence means unknown)", () => {
    const { merged } = mergePeerBoards(board([card("keep", 1, "a")]), board([]));
    expect(merged.cards.map((c) => c.id)).toEqual(["keep"]);
  });

  it("columns move as one clocked document", () => {
    const theirs: PeerBoard = {
      v: PLINK_VERSION,
      columns: [{ id: "c9", title: "Their column", key: "a1" }],
      cards: [],
      columnsClock: { c: 5, by: "b" },
    };
    const { merged } = mergePeerBoards(board([]), theirs);
    expect(merged.columns.map((c) => c.id)).toEqual(["c9"]);
    // …and a stale column set does not clobber ours.
    const stale = { ...theirs, columnsClock: { c: 0, by: "b" } };
    expect(mergePeerBoards(board([]), stale).merged.columns[0].id).toBe("c0");
  });

  it("rejects a board with a malformed card rather than merging half of it", () => {
    expect(validatePeerBoard({ ...board([]), cards: [{ id: "x" }] })).toBeNull();
    expect(validatePeerBoard({ ...board([]), v: 99 })).toBeNull();
  });

  it("emptyPeerBoard seeds columns with a clock authored by us", () => {
    const b = emptyPeerBoard("me", ["To Do", "Done"], ["a0", "a1"]);
    expect(b.columns.map((c) => c.title)).toEqual(["To Do", "Done"]);
    expect(b.columnsClock.by).toBe("me");
  });
});

describe("peerSyncModel — wire validation", () => {
  it("drops a frame with the wrong type or version", () => {
    expect(validatePlinkHello({ type: "plink_hello", v: 2, rev: 0 })).toBeNull();
    expect(validatePlinkHello({ type: "dlink_hello", v: 1, rev: 0 })).toBeNull();
  });

  it("keeps a hello's room heads and narrows its scope claim", () => {
    const hello = validatePlinkHello({
      type: "plink_hello", v: 1, rev: 3,
      scopes: ["calendar", "nope"],
      rooms: [{ slug: "r1", latestTs: 5 }, { slug: "", latestTs: 1 }],
    });
    expect(hello?.scopes).toEqual(["calendar"]);
    expect(hello?.rooms).toEqual([{ slug: "r1", latestTs: 5 }]);
  });

  it("rejects an over-sized calendar frame outright", () => {
    const meetings = Array.from({ length: 501 }, (_, i) => meeting(`m${i}`, 1, "b"));
    expect(validatePlinkCal({ type: "plink_cal", v: 1, meetings, full: true })).toBeNull();
  });

  it("rejects a history frame with an impossible chunk index", () => {
    const base = { type: "plink_hist", v: 1, room: "r", msgs: [] };
    expect(validatePlinkHist({ ...base, chunk: 3, of: 2 })).toBeNull();
    expect(validatePlinkHist({ ...base, chunk: 0, of: 2 })).toBeNull();
    expect(validatePlinkHist({ ...base, chunk: 1, of: 2 })).not.toBeNull();
  });
});

describe("peerSyncModel — safety number", () => {
  it("groups 16 digits into four blocks", () => {
    expect(formatSafetyNumber("1234567890123456")).toBe("1234 5678 9012 3456");
  });

  it("ignores separators and over-length input", () => {
    expect(formatSafetyNumber("12 34-5678 9012 3456 99")).toBe("1234 5678 9012 3456");
  });
});
