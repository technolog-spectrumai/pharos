import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../../src/i18n";
import PeerRequestModal from "../../src/components/peers/PeerRequestModal.vue";
import PeerLinksPanel from "../../src/components/peers/PeerLinksPanel.vue";
import PeerRequestForm from "../../src/components/peers/PeerRequestForm.vue";
import PeerBoardPanel from "../../src/components/peers/PeerBoardPanel.vue";
import { usePeersStore } from "../../src/stores/peers";
import type { PeerBoard, PeerGrant } from "rakotis";

// The peer-link UI in the jsdom shell: no Tauri runtime, so every invoke fails
// and the store's own calls no-op. What's pinned here is the consent surface —
// the accepter grants what IT ticks (not what was asked for), the revoke confirm
// keeps saying that their copy stays theirs, and the two request directions are
// independent. Those are the claims the feature's safety rests on.
//
// The fake peerSync uses plain `{ value }` holders (vi.hoisted runs before
// imports, so vue's ref() is unavailable); tests set state before mount.

const { fakeSync } = vi.hoisted(() => {
  const holder = <T>(value: T) => ({ value });
  return {
    fakeSync: {
      grants: holder<unknown[]>([]),
      liveGrants: holder<unknown[]>([]),
      lastSyncAt: holder(0),
      refresh: async () => {},
      start: async () => {},
      stop: () => {},
      scopeCalls: [] as { nodeId: string; scopes: string[] }[],
      revokeCalls: [] as string[],
      setMyScopes(nodeId: string, scopes: string[]) {
        fakeSync.scopeCalls.push({ nodeId, scopes });
        return Promise.resolve();
      },
      revoke(nodeId: string) {
        fakeSync.revokeCalls.push(nodeId);
        return Promise.resolve();
      },
      // The peer board's whole storage surface: loadBoard/putBoard, nothing else.
      // Deep-copied on both ends so a test can never accidentally assert against
      // an object the component still holds a reference to.
      boards: {} as Record<string, unknown>,
      putCalls: [] as { nodeId: string; board: unknown }[],
      loadBoard(nodeId: string) {
        const b = fakeSync.boards[nodeId];
        return Promise.resolve(b ? JSON.parse(JSON.stringify(b)) : null);
      },
      putBoard(nodeId: string, board: unknown) {
        const copy = JSON.parse(JSON.stringify(board));
        fakeSync.boards[nodeId] = copy;
        fakeSync.putCalls.push({ nodeId, board: copy });
        return Promise.resolve();
      },
    },
  };
});

vi.mock("../../src/stores/chat", () => ({
  useChatStore: () => ({
    peerSync: fakeSync,
    peersEnabled: true,
    setPeerSources: () => {},
    meetings: null,
    p2p: { currentUserName: { value: "alice" }, p2pRooms: { value: [] } },
  }),
}));

const GRANT: PeerGrant = {
  v: 1,
  peerNodeId: "b".repeat(64),
  peerName: "Bob",
  linkKey: `${"a".repeat(43)}=`,
  roomName: "plink-abc",
  safetyNumber: "1234567890123456",
  myScopes: ["calendar"],
  theirScopes: ["board", "card"],
  initiator: true,
  createdAt: 1_700_000_000_000,
  rev: 1,
};

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  localStorage.clear();
  fakeSync.grants.value = [];
  fakeSync.liveGrants.value = [];
  fakeSync.scopeCalls.length = 0;
  fakeSync.revokeCalls.length = 0;
  fakeSync.boards = {};
  fakeSync.putCalls.length = 0;
  pinia = createPinia();
  setActivePinia(pinia);
  i18n.global.locale.value = "en";
});

const GLOBAL = () => ({ plugins: [i18n, pinia], stubs: { teleport: true } });

function incomingRequest() {
  const store = usePeersStore();
  store.incoming = {
    requestId: "req-1",
    fromNodeId: "c".repeat(64),
    fromName: "Bob",
    want: ["calendar", "history"],
    offered: ["card"],
    safetyNumber: "1234567890123456",
  };
  return store;
}

describe("PeerRequestModal", () => {
  it("shows who is asking, the safety number and the continuous-sharing warning", async () => {
    const store = incomingRequest();
    const wrapper = mount(PeerRequestModal, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();
    expect(store.incoming).not.toBeNull();

    const text = wrapper.text();
    expect(text).toContain("Bob wants to set up a peer link with you.");
    expect(text).toContain("1234 5678 9012 3456");
    expect(text).toContain("keeps syncing to them until you revoke");
    // Asked-for scopes are tickable; offered ones are read-only chips.
    expect(text).toContain("Chat history");
    expect(text).toContain("Contact card");
    expect(wrapper.findAll("input[type=checkbox]")).toHaveLength(2);
  });

  it("accepts only the ticked scopes, defaulting to everything asked for", async () => {
    const store = incomingRequest();
    const respond = vi.spyOn(store, "respond").mockResolvedValue();
    const wrapper = mount(PeerRequestModal, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();

    const boxes = wrapper.findAll("input[type=checkbox]");
    expect(boxes.every((b) => (b.element as HTMLInputElement).checked)).toBe(true);
    await boxes[1].setValue(false); // untick "history"

    const accept = wrapper.findAll("button").find((b) => b.text().includes("Accept"))!;
    await accept.trigger("click");
    expect(respond).toHaveBeenCalledWith(true, ["calendar"]);
  });

  it("declines with an empty grant", async () => {
    const store = incomingRequest();
    const respond = vi.spyOn(store, "respond").mockResolvedValue();
    const wrapper = mount(PeerRequestModal, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();

    const decline = wrapper.findAll("button").find((b) => b.text() === "Decline")!;
    await decline.trigger("click");
    expect(respond).toHaveBeenCalledWith(false, []);
  });
});

describe("PeerLinksPanel", () => {
  it("shows the empty state with no links", async () => {
    const wrapper = mount(PeerLinksPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();
    expect(wrapper.text()).toContain("No peer links yet");
  });

  it("renders both directions and the safety number for a live link", async () => {
    fakeSync.grants.value = [GRANT];
    fakeSync.liveGrants.value = [GRANT];
    const wrapper = mount(PeerLinksPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain("Bob");
    expect(text).toContain("You share");
    expect(text).toContain("They share");
    expect(text).toContain("1234 5678 9012 3456");
  });

  it("delegates a scope change to the store", async () => {
    fakeSync.grants.value = [GRANT];
    fakeSync.liveGrants.value = [GRANT];
    const wrapper = mount(PeerLinksPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();

    await wrapper.findAll("button").find((b) => b.text() === "Change what you share")!.trigger("click");
    const boxes = wrapper.findAll("input[type=checkbox]");
    expect(boxes).toHaveLength(4); // one per PEER_SCOPES entry
    await boxes[2].setValue(true); // add "board"
    await flushPromises();
    expect(fakeSync.scopeCalls).toEqual([{ nodeId: GRANT.peerNodeId, scopes: ["calendar", "board"] }]);
  });

  it("says plainly that revoking does not take back what already synced", async () => {
    fakeSync.grants.value = [GRANT];
    fakeSync.liveGrants.value = [GRANT];
    const wrapper = mount(PeerLinksPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();

    await wrapper.findAll("button").find((b) => b.text().includes("Revoke"))!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Everything already synced stays on their device");

    await wrapper.findAll("button").find((b) => b.text() === "Revoke link")!.trigger("click");
    await flushPromises();
    expect(fakeSync.revokeCalls).toEqual([GRANT.peerNodeId]);
  });

  it("offers the board only on a link that actually carries the board scope", async () => {
    const noBoard: PeerGrant = { ...GRANT, myScopes: [], theirScopes: ["card"] };
    fakeSync.grants.value = [noBoard];
    fakeSync.liveGrants.value = [noBoard];
    const wrapper = mount(PeerLinksPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();
    expect(wrapper.findAll("button").some((b) => b.text() === "Open board")).toBe(false);
    wrapper.unmount();
  });

  it("opens the per-link board from the link row", async () => {
    // GRANT has board in theirScopes, so the surface is offered.
    fakeSync.grants.value = [GRANT];
    fakeSync.liveGrants.value = [GRANT];
    usePeersStore().myNodeId = "a".repeat(64);
    const wrapper = mount(PeerLinksPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();

    await wrapper.findAll("button").find((b) => b.text() === "Open board")!.trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("Board with Bob");
    expect(wrapper.text()).toContain("belongs to this link alone");
    wrapper.unmount();
  });

  it("lists a revoked link greyed out instead of dropping it", async () => {
    fakeSync.grants.value = [{ ...GRANT, revokedAt: 1_700_000_500_000 }];
    fakeSync.liveGrants.value = [];
    const wrapper = mount(PeerLinksPanel, { props: { darkMode: false }, global: GLOBAL() });
    await flushPromises();
    expect(wrapper.text()).toContain("Revoked links");
    expect(wrapper.html()).toContain("opacity-40");
  });
});

// ── the per-link board ────────────────────────────────────────────────────────
// Everything pinned here is a convergence property, not a look. The board has no
// captain and no room (peer.md P8), so the ONLY thing that makes two edited
// copies agree is the per-item {counter, author} clock and the tombstone rule:
// a delete that removes the row instead of marking it is a delete the peer
// re-undoes forever, and an edit that forgets to bump is an edit that never
// leaves this device.

const MY_NODE = "a".repeat(64);
const THEIR_NODE = GRANT.peerNodeId;

const BOARD_GRANT: PeerGrant = { ...GRANT, myScopes: ["board"], theirScopes: ["board"] };

function seededBoard(): PeerBoard {
  return {
    v: 1,
    columns: [
      { id: "c0", title: "To Do", key: "V" },
      { id: "c1", title: "Done", key: "l" },
    ],
    cards: [
      {
        id: "card-1",
        columnId: "c0",
        title: "Buy milk",
        description: "semi-skimmed",
        key: "V",
        author: "Bob",
        done: false,
        clock: { c: 3, by: THEIR_NODE },
      },
      {
        id: "card-2",
        columnId: "c0",
        title: "Old thing",
        description: "",
        key: "l",
        author: "Bob",
        done: false,
        clock: { c: 9, by: THEIR_NODE },
        deleted: true,
      },
    ],
    columnsClock: { c: 4, by: THEIR_NODE },
  };
}

async function mountBoard(grant: PeerGrant = BOARD_GRANT, board: PeerBoard | null = seededBoard()) {
  const store = usePeersStore();
  store.myNodeId = MY_NODE;
  if (board) fakeSync.boards[grant.peerNodeId] = board;
  const wrapper = mount(PeerBoardPanel, {
    props: { grant, darkMode: false },
    global: GLOBAL(),
  });
  await flushPromises();
  return wrapper;
}

/** The board handed to the last putBoard call — i.e. what was persisted AND
 *  broadcast, since putBoard is both. */
function lastPut(): PeerBoard {
  return fakeSync.putCalls[fakeSync.putCalls.length - 1].board as PeerBoard;
}

function cardOf(board: PeerBoard, id: string) {
  return board.cards.find((c) => c.id === id)!;
}

async function clickText(wrapper: ReturnType<typeof mount>, text: string) {
  await wrapper.findAll("button").find((b) => b.text() === text)!.trigger("click");
  await flushPromises();
}

async function clickTitle(wrapper: ReturnType<typeof mount>, title: string) {
  await wrapper.find(`button[title="${title}"]`).trigger("click");
  await flushPromises();
}

describe("PeerBoardPanel", () => {
  it("renders the stored columns and live cards, never a tombstone", async () => {
    const wrapper = await mountBoard();
    const text = wrapper.text();
    expect(text).toContain("Board with Bob");
    expect(text).toContain("To Do");
    expect(text).toContain("Done");
    expect(text).toContain("Buy milk");
    expect(text).not.toContain("Old thing");
    wrapper.unmount();
  });

  it("seeds the room board's default columns when there is nothing stored", async () => {
    const wrapper = await mountBoard(BOARD_GRANT, null);
    expect(wrapper.text()).toContain("To Do");
    expect(wrapper.text()).toContain("In Progress");
    // A seed is memory-only: it must not broadcast a columns document that could
    // out-tiebreak the peer's real columns just because our NodeId sorts lower.
    expect(fakeSync.putCalls).toHaveLength(0);
    wrapper.unmount();
  });

  it("stamps a card edit with a bumped counter authored by MY nodeId", async () => {
    const wrapper = await mountBoard();
    await clickTitle(wrapper, "Edit card");
    await wrapper.find("input[type=text]").setValue("Buy oat milk");
    await clickText(wrapper, "Save");

    const card = cardOf(lastPut(), "card-1");
    expect(card.title).toBe("Buy oat milk");
    // c: 3 → 4, and the author becomes us — the tiebreak key must be OUR id, not
    // the id of whoever last touched the card.
    expect(card.clock).toEqual({ c: 4, by: MY_NODE });
    wrapper.unmount();
  });

  it("keeps a deleted card as a tombstone instead of dropping it", async () => {
    const wrapper = await mountBoard();
    await clickTitle(wrapper, "Edit card");
    await clickText(wrapper, "Delete card");

    const board = lastPut();
    // The row survives — removing it would let the peer's stale copy win by
    // simply still existing, and the delete would never converge.
    expect(board.cards.map((c) => c.id).sort()).toEqual(["card-1", "card-2"]);
    const card = cardOf(board, "card-1");
    expect(card.deleted).toBe(true);
    expect(card.clock).toEqual({ c: 4, by: MY_NODE });
    // …and it disappears from the rendered board all the same.
    expect(wrapper.text()).not.toContain("Buy milk");
    wrapper.unmount();
  });

  it("adds a card with a fresh counter and no wall clock anywhere", async () => {
    const wrapper = await mountBoard();
    await clickText(wrapper, "Add card");
    await wrapper.find("input[type=text]").setValue("Call the plumber");
    await clickText(wrapper, "Add");

    const board = lastPut();
    const added = board.cards.find((c) => c.title === "Call the plumber")!;
    expect(added.clock).toEqual({ c: 1, by: MY_NODE });
    expect(added.columnId).toBe("c0");
    // Nothing timestamp-shaped rides along: the counter is the whole design.
    expect(JSON.stringify(added)).not.toMatch(/1[6-9]\d{11}/);
    wrapper.unmount();
  });

  it("refuses a card with no title", async () => {
    const wrapper = await mountBoard();
    await clickText(wrapper, "Add card");
    await clickText(wrapper, "Add");
    expect(wrapper.text()).toContain("A card needs a title.");
    expect(fakeSync.putCalls).toHaveLength(0);
    wrapper.unmount();
  });

  it("moves a card between columns with a bumped clock", async () => {
    const wrapper = await mountBoard();
    await clickTitle(wrapper, "Move one column right");

    const card = cardOf(lastPut(), "card-1");
    expect(card.columnId).toBe("c1");
    expect(card.clock).toEqual({ c: 4, by: MY_NODE });
    wrapper.unmount();
  });

  it("bumps columnsClock — not a card clock — when a column is added", async () => {
    const wrapper = await mountBoard();
    await clickText(wrapper, "Add column");
    await wrapper.find("input[type=text]").setValue("Blocked");
    await clickTitle(wrapper, "Save");

    const board = lastPut();
    expect(board.columns.map((c) => c.title)).toEqual(["To Do", "Done", "Blocked"]);
    expect(board.columnsClock).toEqual({ c: 5, by: MY_NODE });
    // Columns travel as one document; the cards' own histories are untouched.
    expect(cardOf(board, "card-1").clock).toEqual({ c: 3, by: THEIR_NODE });
    wrapper.unmount();
  });

  it("bumps columnsClock when a column is renamed", async () => {
    const wrapper = await mountBoard();
    await clickTitle(wrapper, "Rename column");
    await wrapper.find("input[type=text]").setValue("Backlog");
    await clickTitle(wrapper, "Save");

    const board = lastPut();
    expect(board.columns[0].title).toBe("Backlog");
    expect(board.columnsClock).toEqual({ c: 5, by: MY_NODE });
    wrapper.unmount();
  });

  it("deleting a column moves its cards rather than losing them, bumping both clocks", async () => {
    const wrapper = await mountBoard();
    await clickTitle(wrapper, "Delete column");
    expect(wrapper.text()).toContain("they move to “Done”");
    await clickText(wrapper, "Delete column");

    const board = lastPut();
    expect(board.columns.map((c) => c.id)).toEqual(["c1"]);
    expect(board.columnsClock).toEqual({ c: 5, by: MY_NODE });
    const moved = cardOf(board, "card-1");
    expect(moved.columnId).toBe("c1");
    expect(moved.deleted).toBeUndefined();
    // A move IS a real card edit, so the card's own clock advances too.
    expect(moved.clock).toEqual({ c: 4, by: MY_NODE });
    wrapper.unmount();
  });

  it("says so when the board scope is one-way, instead of failing quietly", async () => {
    const wrapper = await mountBoard({ ...BOARD_GRANT, myScopes: [] });
    expect(wrapper.text()).toContain("your changes stay on this device");
    wrapper.unmount();
  });

  it("says so when neither side shares the board", async () => {
    const wrapper = await mountBoard({ ...BOARD_GRANT, myScopes: [], theirScopes: [] });
    expect(wrapper.text()).toContain("this is a local board");
    wrapper.unmount();
  });

  it("refuses to write anything while this device's own nodeId is unknown", async () => {
    const store = usePeersStore();
    store.myNodeId = "";
    fakeSync.boards[THEIR_NODE] = seededBoard();
    const wrapper = mount(PeerBoardPanel, {
      props: { grant: BOARD_GRANT, darkMode: false },
      global: GLOBAL(),
    });
    await flushPromises();
    // A clock with an empty author fails validateLClock, which would make the
    // whole stored board unreadable — so the editor goes read-only and says why.
    expect(wrapper.text()).toContain("can't be signed");
    expect(wrapper.find('button[title="Edit card"]').exists()).toBe(false);
    expect(fakeSync.putCalls).toHaveLength(0);
    wrapper.unmount();
  });

  it("picks up a remote change on the next poll", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = await mountBoard();
      const remote = seededBoard();
      remote.cards[0] = { ...remote.cards[0], title: "Buy kefir", clock: { c: 8, by: THEIR_NODE } };
      fakeSync.boards[THEIR_NODE] = remote;
      await vi.advanceTimersByTimeAsync(5000);
      await flushPromises();
      expect(wrapper.text()).toContain("Buy kefir");
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PeerRequestForm", () => {
  const PROPS = { darkMode: false, nodeId: "d".repeat(64), name: "Bob" };

  it("refuses an empty request", async () => {
    const store = usePeersStore();
    const request = vi.spyOn(store, "request").mockResolvedValue();
    const wrapper = mount(PeerRequestForm, { props: PROPS, global: GLOBAL() });
    await flushPromises();

    await wrapper.findAll("button").find((b) => b.text().includes("Send request"))!.trigger("click");
    await flushPromises();
    expect(request).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Pick at least one thing");
  });

  it("keeps the two directions independent", async () => {
    const store = usePeersStore();
    const request = vi.spyOn(store, "request").mockResolvedValue();
    const wrapper = mount(PeerRequestForm, { props: PROPS, global: GLOBAL() });
    await flushPromises();

    const boxes = wrapper.findAll("input[type=checkbox]");
    expect(boxes).toHaveLength(8); // four scopes, twice — want and give
    await boxes[0].setValue(true); // want: calendar
    await boxes[7].setValue(true); // give: card
    await wrapper.findAll("button").find((b) => b.text().includes("Send request"))!.trigger("click");
    await flushPromises();
    expect(request).toHaveBeenCalledWith(PROPS.nodeId, ["calendar"], ["card"]);
  });

  it("disables sending with a reason in airplane mode (never hides it)", async () => {
    localStorage.setItem("enigma:offline", "on");
    const wrapper = mount(PeerRequestForm, { props: PROPS, global: GLOBAL() });
    await flushPromises();
    expect(wrapper.text()).toContain("Offline — all network connections are blocked.");
    const send = wrapper.findAll("button").find((b) => b.text().includes("Send request"))!;
    expect(send.attributes("disabled")).toBeDefined();
  });

  it("surfaces the browser-fallback error as translated copy", async () => {
    const store = usePeersStore();
    const wrapper = mount(PeerRequestForm, { props: PROPS, global: GLOBAL() });
    await flushPromises();
    store.outgoing = "error";
    store.outgoingError = "peers.unavailable";
    await flushPromises();
    expect(wrapper.text()).toContain("Peer sync needs the desktop/mobile app.");
  });
});
