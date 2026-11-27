import { describe, it, expect, vi } from "vitest";
import { beaconMailbox } from "../../src/beaconMailbox";

function fake() {
  const boxes: Record<string, string[]> = {}; // mailbox id → bodies
  const invoke = vi.fn(async (cmd: string, a: any): Promise<any> => {
    if (cmd === "mls_mailbox") return { id: `box${a.weekOffset}`, token: "t", week: 0 };
    if (cmd === "beacon_post") { (boxes[a.id] ??= []).push(a.body); return; }
    if (cmd === "beacon_fetch") return (boxes[a.id] ?? []).map((body, i) => ({ seq: i + 1, body })).filter((m) => m.seq > a.after);
  });
  return { boxes, invoke };
}

describe("beaconMailbox", () => {
  it("does nothing for a room without a Beacon", async () => {
    const f = fake();
    const mb = beaconMailbox({ invoke: f.invoke as any, beaconFor: () => undefined, identity: () => "me" });
    await mb.post({ room: "r", frame: "x" });
    expect(await mb.fetch(0, "r")).toEqual([]);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("posts to this week's mailbox and reads both weeks, each frame once", async () => {
    const f = fake();
    const mb = beaconMailbox({ invoke: f.invoke as any, beaconFor: () => "b.onion", identity: () => "me", random: () => 1 });
    f.boxes.box1 = ["old"];
    await mb.post({ room: "r", frame: "new" });
    const first = await mb.fetch(0, "r");
    expect(f.boxes.box0).toEqual(["new"]); // the room's name never reaches Beacon
    expect(first.map((m) => JSON.parse(m.body))).toEqual([{ kind: "demio-room", room: "r", frame: "old" }, { kind: "demio-room", room: "r", frame: "new" }]);
    expect(first[1].id).toBeGreaterThan(first[0].id);
    expect(await mb.fetch(first[1].id, "r")).toEqual([]);
  });
});

describe("beaconMailbox — dummy reads", () => {
  it("sometimes also reads a random mailbox that is not ours", async () => {
    const f = fake();
    const mb = beaconMailbox({ invoke: f.invoke as any, beaconFor: () => "b.onion", identity: () => "me", random: () => 0 });
    await mb.fetch(0, "r");
    const ids = f.invoke.mock.calls.filter((c) => c[0] === "beacon_fetch").map((c) => (c[1] as any).id);
    expect(ids.some((id: string) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
    expect(ids).toContain("box0");
  });
});
