import { describe, it, expect } from "vitest";
import {
  listContacts,
  upsertContact,
  renameContact,
  removeContact,
  touchContact,
  dhtPresence,
  dhtRoomCode,
} from "../../src/services/contacts";

// Contacts are one JSON array under the encrypted kv (same single-key pattern
// as `p2p:rooms` — the kv API has no key enumeration). Under vitest there is no
// Tauri runtime, so the kv falls back to localStorage (cleared per test by the
// global setup) and the DHT-backed lookups degrade to empty results.

const A = { nodeId: "a".repeat(64), name: "Alice", addedAt: 1000 };
const B = { nodeId: "b".repeat(64), name: "Bob", addedAt: 2000 };

describe("contacts service — CRUD over the kv store", () => {
  it("starts empty and returns [] on garbage payloads", async () => {
    expect(await listContacts()).toEqual([]);
    localStorage.setItem("enigma:db:contacts:default:", "not json");
    expect(await listContacts()).toEqual([]);
  });

  it("upsert adds new contacts to the top and merges by nodeId", async () => {
    await upsertContact(A);
    let contacts = await upsertContact(B);
    expect(contacts.map((c) => c.name)).toEqual(["Bob", "Alice"]);

    // Same nodeId ⇒ merge in place, no duplicate row, position kept.
    contacts = await upsertContact({ ...A, name: "Alice II" });
    expect(contacts).toHaveLength(2);
    expect(contacts[1].name).toBe("Alice II");
    expect(contacts[1].addedAt).toBe(1000);
  });

  it("rename and touch update one contact and persist", async () => {
    await upsertContact(A);
    await renameContact(A.nodeId, "Alicja");
    await touchContact(A.nodeId, 5555);
    const [contact] = await listContacts();
    expect(contact.name).toBe("Alicja");
    expect(contact.lastSeen).toBe(5555);

    // Unknown nodeIds are a silent no-op, not an error.
    await renameContact("missing", "X");
    await touchContact("missing", 1);
    expect(await listContacts()).toHaveLength(1);
  });

  it("remove drops exactly the matching contact", async () => {
    await upsertContact(A);
    await upsertContact(B);
    const contacts = await removeContact(A.nodeId);
    expect(contacts.map((c) => c.nodeId)).toEqual([B.nodeId]);
    expect(await listContacts()).toHaveLength(1);
  });
});

describe("contacts service — DHT lookups degrade gracefully in the browser", () => {
  it("presence resolves to [] without the Tauri runtime (and for empty input)", async () => {
    expect(await dhtPresence([A.nodeId])).toEqual([]);
    expect(await dhtPresence([])).toEqual([]);
  });

  it("room-code minting resolves to null without the Tauri runtime", async () => {
    expect(await dhtRoomCode("room-id", "general")).toBeNull();
  });
});
