// Friends: the pairing code, the check code both phones show, and the list kept
// in the vault.
import { describe, it, expect, beforeEach, vi } from "vitest";

const kv = new Map<string, string>();
vi.mock("rakotis", async (orig) => ({
  ...(await orig<typeof import("rakotis")>()),
  kvGet: async (ns: string, scope: string, k: string) => kv.get(`${ns}/${scope}/${k}`) ?? null,
  kvPut: async (ns: string, scope: string, k: string, v: string) => void kv.set(`${ns}/${scope}/${k}`, v),
}));

import {
  addFriend, checkCode, decodePairing, encodePairing, friends, isDeviceId, loadFriends, removeFriend,
} from "../../src/stores/friends";

const ANN = "a".repeat(64);
const BEN = "b".repeat(64);

beforeEach(async () => {
  kv.clear();
  await loadFriends(true);
});

describe("the pairing code", () => {
  it("carries the device id and the name, Polish letters included", () => {
    const code = encodePairing(ANN, "Zażółć Ania");
    expect(code.startsWith("enigma27-friend:1:")).toBe(true);
    expect(decodePairing(code)).toEqual({ id: ANN, name: "Zażółć Ania" });
  });

  it("accepts a bare device id, and refuses anything else", () => {
    expect(decodePairing(BEN.toUpperCase())).toEqual({ id: BEN, name: "" });
    expect(decodePairing("hello")).toBeNull();
    expect(decodePairing("enigma27-friend:1:short:QQ")).toBeNull();
    expect(isDeviceId("z".repeat(64))).toBe(false);
  });
});

describe("the check code", () => {
  it("is the same on both phones and differs for another pair", async () => {
    const ab = await checkCode(ANN, BEN);
    expect(ab).toMatch(/^\d{4} \d{4} \d{4}$/);
    expect(await checkCode(BEN, ANN)).toBe(ab);
    expect(await checkCode(ANN, "c".repeat(64))).not.toBe(ab);
  });
});

describe("the list", () => {
  it("is kept in the vault, renames a known friend instead of doubling it, and forgets on remove", async () => {
    await addFriend(BEN, "Ben");
    await addFriend(ANN, "Ann");
    expect(friends.value.map((f) => f.name)).toEqual(["Ann", "Ben"]);
    await addFriend(ANN, "Ania");
    expect(friends.value).toHaveLength(2);
    // A fresh load reads back what was saved.
    await loadFriends(true);
    expect(friends.value.find((f) => f.id === ANN)?.name).toBe("Ania");
    await removeFriend(BEN);
    await loadFriends(true);
    expect(friends.value.map((f) => f.id)).toEqual([ANN]);
  });

  it("drops a saved entry that is not a device id", async () => {
    kv.set("friends/default/list", JSON.stringify([{ id: "junk", name: "X", addedAt: 1 }, { id: ANN, name: "Ann", addedAt: 1 }]));
    await loadFriends(true);
    expect(friends.value.map((f) => f.id)).toEqual([ANN]);
  });
});
