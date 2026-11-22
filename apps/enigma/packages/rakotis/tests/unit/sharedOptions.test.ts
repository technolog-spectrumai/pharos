// The shared room engine's options (technology.md §"Shared room engine") — what Teutates added
// and Enigma leaves off: admission by a certified roster, a server mailbox for whoever is away,
// a session kept across restarts, re-key on leave, #tag threads and @mentions, inline files.
// Several channels in one process on the engine's fakes (fakes.ts): an in-memory gossip hub,
// an MLS stand-in, a kv per device.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatChannel, type ChatChannelOptions } from "../../src/useChatChannel";
import { MemHub, MlsWorld, fakeMls, memKv } from "../../src/fakes";
import { MemMailbox, frameId, tagsOf, mentionsName } from "../../src/mailbox";
import { userPartOf } from "../../src/chatHistoryModel";

const ROOM = "teutates-ab12";
const id = (who: string) => `did:${who}#dev-${(who + "aaaaaaaa").slice(0, 8)}`;

let hub: MemHub, world: MlsWorld, mb: MemMailbox, certified: Set<string>;
const kvs = new Map<string, ReturnType<typeof memKv>>();

function device(who: string, extra: ChatChannelOptions = {}) {
  if (!kvs.has(who)) kvs.set(who, memKv());
  const ch = useChatChannel({
    transport: hub.transport(who),
    crypto: fakeMls(world),
    storage: kvs.get(who),
    openAdmission: true,
    admissionCheck: (d) => certified.has(userPartOf(String(d.device_id))),
    keepSession: true,
    mayFound: () => who === "alice",
    mailbox: mb,
    threads: true,
    inlineFiles: true,
    rosterNotices: true,
    ...extra,
  });
  ch.mlsIdentity.value = id(who);
  ch.currentUserName.value = who[0].toUpperCase() + who.slice(1);
  return ch;
}
type Ch = ReturnType<typeof device>;
const settle = async (ms = 6000) => { for (let i = 0; i < ms / 500; i++) await vi.advanceTimersByTimeAsync(500); };
async function open(ch: Ch) {
  await ch.joinByNode(ROOM, []);
  await settle();
}
const texts = (ch: Ch) => ch.messages.value.filter((m) => m.participant_type === "human").map((m) => m.content);

beforeEach(() => {
  vi.useFakeTimers();
  hub = new MemHub();
  world = new MlsWorld();
  mb = new MemMailbox();
  certified = new Set(["did:alice", "did:bob", "did:carol"]);
  kvs.clear();
});
afterEach(() => vi.useRealTimers());

describe("the shared engine's options", () => {
  it("lets a certified device in off the topic, refuses an uncertified one, and they talk", async () => {
    const alice = device("alice");
    await open(alice);
    expect(alice.mlsStatus.value).toBe("ready"); // the founder opens the group alone
    const bob = device("bob");
    await open(bob);
    expect(bob.mlsStatus.value).toBe("ready");
    const eve = device("eve");
    await open(eve);
    await settle(25_000);
    expect(eve.mlsStatus.value).toBe("key_exchange");
    await bob.sendMessage("hello #gardens @Alice");
    await settle(1000);
    const got = alice.messages.value.find((m) => m.content.startsWith("hello"))!;
    expect(got.tags).toEqual(["gardens"]);
    expect(got.mention).toBe(true);
    expect(got.deviceId).toBe(id("bob"));
    expect(texts(eve).some((t) => t.startsWith("hello"))).toBe(false);
  });

  it("a member away gets what came meanwhile from the mailbox, after a restart, with its group kept", async () => {
    const alice = device("alice");
    await open(alice);
    let bob = device("bob");
    await open(bob);
    expect(bob.mlsStatus.value).toBe("ready");
    hub.setOnline("bob", false);
    bob.leaveParticipant(); // the app closes (no "leave" goes out: it is offline)
    await alice.sendMessage("while you were away");
    await settle(1000);
    expect(mb.bodies.some((b) => JSON.parse(b).kind === "demio-room")).toBe(true);
    hub.setOnline("bob", true);
    localStorage.clear(); // the chat log is per device (the test's devices share a localStorage)
    bob = device("bob"); // the app opens again: the same vault, a fresh process
    await open(bob);
    expect(bob.mlsStatus.value).toBe("ready");
    const m = bob.messages.value.find((x) => x.content === "while you were away");
    expect(m?.viaMailbox).toBe(true);
    // And once only, though the mailbox is read again.
    await bob.catchUpMailbox();
    expect(texts(bob).filter((t) => t === "while you were away")).toHaveLength(1);
  });

  it("a newcomer is let in through the mailbox while the leader was away", async () => {
    const alice = device("alice");
    await open(alice);
    hub.setOnline("alice", false);
    const bob = device("bob");
    await open(bob); // nobody online: his key package waits in the mailbox
    expect(bob.mlsStatus.value).toBe("key_exchange");
    hub.setOnline("alice", true);
    await alice.catchUpMailbox(); // alice adds him; the Welcome goes to the mailbox too
    hub.setOnline("bob", false);
    hub.setOnline("bob", true);
    await bob.catchUpMailbox();
    await settle(1000);
    expect(bob.mlsStatus.value).toBe("ready");
  });

  it("re-keys when someone leaves the roster: the leader removes them, they read no more", async () => {
    const alice = device("alice");
    await open(alice);
    const bob = device("bob");
    await open(bob);
    const carol = device("carol");
    await open(carol);
    expect(carol.mlsStatus.value).toBe("ready");
    certified.delete("did:carol");
    expect(await bob.enforceRoster([...certified])).toBe(0); // not the leader
    expect(await alice.enforceRoster([...certified])).toBe(1);
    await settle(1000);
    expect(carol.removed.value).toBe(true);
    expect(bob.messages.value.some((m) => m.content.includes("keys were changed"))).toBe(true);
    await alice.sendMessage("after carol");
    await settle(1000);
    expect(texts(bob)).toContain("after carol");
    expect(texts(carol)).not.toContain("after carol");
  });

  it("carries a small file inline and refuses a big one", async () => {
    const alice = device("alice");
    await open(alice);
    const bob = device("bob");
    await open(bob);
    await alice.sendFile("budget.csv", btoa("a,b\n1,2"), "#gardens the budget");
    await settle(1000);
    const f = bob.messages.value.find((m) => m.type === "file_message")!;
    expect(f.file?.name).toBe("budget.csv");
    expect(atob(f.file!.data)).toBe("a,b\n1,2");
    expect(f.tags).toEqual(["gardens"]);
    await expect(alice.sendFile("big.bin", "A".repeat(400 * 1024), "")).rejects.toThrow(/256 KiB/);
  });

  it("is off for Enigma: a room with no options refuses gossip key packages and posts nothing", async () => {
    const plain = useChatChannel({ transport: hub.transport("x"), crypto: fakeMls(world), storage: memKv() });
    plain.mlsIdentity.value = "x";
    await plain.joinByNode(ROOM, []);
    await settle();
    expect(mb.bodies).toEqual([]);
    expect(plain.messages.value.some((m) => m.tags)).toBe(false);
  });
});

describe("mailbox and thread helpers", () => {
  it("frames have ids; tags and mentions read as Demio's", () => {
    expect(frameId(JSON.stringify({ type: "mls_app", msg_id: "m1" }))).toBe("m1");
    expect(frameId(JSON.stringify({ type: "mls_welcome", welcome: "x" }))).toMatch(/^h/);
    expect(frameId(JSON.stringify({ type: "presence" }))).toBeNull();
    expect(tagsOf("hi #gardens and #Solar-2, not a#b")).toEqual(["gardens", "solar-2"]);
    expect(mentionsName("thanks @ann kowalska!", "Ann Kowalska")).toBe(true);
  });
});
