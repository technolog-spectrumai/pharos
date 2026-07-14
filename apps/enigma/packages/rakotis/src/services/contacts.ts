// Contacts — saved peers (iroh NodeId + display name) for the Contacts tab.
//
// A contact is the durable P2P handle of a person you paired with: their stable
// NodeId (shared as text/QR, like a room ticket). With DHT discovery on
// (dht.md), contacts get "recently online" presence — the freshness of the
// address record every DHT-enabled peer publishes about itself.
//
// Stored as one JSON array under the encrypted kv (same single-key pattern as
// the `p2p:rooms` list — the kv API has no key enumeration by design).

import { isTauri, invoke } from "./tauri";
import { kvGet, kvPut } from "./localDb";

export interface ContactEntry {
  /** The contact's stable iroh NodeId (z-base-32 string) — the identity key. */
  nodeId: string;
  name: string;
  /** Unix ms when the contact was added. */
  addedAt: number;
  /** Unix ms when presence last saw them online (never cleared — "last seen"). */
  lastSeen?: number;
}

const NS = "contacts";
const SCOPE = "default";
const KEY = "";

export async function listContacts(): Promise<ContactEntry[]> {
  try {
    const raw = await kvGet(NS, SCOPE, KEY);
    return raw ? (JSON.parse(raw) as ContactEntry[]) : [];
  } catch {
    return [];
  }
}

async function persist(contacts: ContactEntry[]): Promise<void> {
  await kvPut(NS, SCOPE, KEY, JSON.stringify(contacts)).catch(() => {});
}

/** Add or update (by NodeId); new contacts go to the top. Returns the new list. */
export async function upsertContact(entry: ContactEntry): Promise<ContactEntry[]> {
  const contacts = await listContacts();
  const i = contacts.findIndex((c) => c.nodeId === entry.nodeId);
  if (i === -1) contacts.unshift(entry);
  else contacts[i] = { ...contacts[i], ...entry };
  await persist(contacts);
  return contacts;
}

export async function renameContact(nodeId: string, name: string): Promise<ContactEntry[]> {
  const contacts = await listContacts();
  const entry = contacts.find((c) => c.nodeId === nodeId);
  if (entry) {
    entry.name = name;
    await persist(contacts);
  }
  return contacts;
}

export async function removeContact(nodeId: string): Promise<ContactEntry[]> {
  const contacts = (await listContacts()).filter((c) => c.nodeId !== nodeId);
  await persist(contacts);
  return contacts;
}

/** Record a presence sighting (keeps "last seen" across restarts). */
export async function touchContact(nodeId: string, lastSeen: number): Promise<ContactEntry[]> {
  const contacts = await listContacts();
  const entry = contacts.find((c) => c.nodeId === nodeId);
  if (entry) {
    entry.lastSeen = lastSeen;
    await persist(contacts);
  }
  return contacts;
}

// ── DHT-backed lookups (Tauri only; browser fallback degrades gracefully) ──────

export interface ContactPresence {
  node_id: string;
  online: boolean;
}

/** "Recently online" per contact NodeId (~1 h granularity — the cadence of the
 *  DHT address records). Requires the DHT toggle on; errors resolve to []. */
export async function dhtPresence(nodeIds: string[]): Promise<ContactPresence[]> {
  if (!isTauri() || nodeIds.length === 0) return [];
  try {
    return await invoke<ContactPresence[]>("dht_presence", { nodeIds });
  } catch {
    return [];
  }
}

/** Mint/show the ticketless-join code for a saved room (invite-a-contact flow).
 *  Null while the DHT toggle is off. */
export async function dhtRoomCode(room: string, name: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>("dht_room_code", { room, name });
  } catch {
    return null;
  }
}
