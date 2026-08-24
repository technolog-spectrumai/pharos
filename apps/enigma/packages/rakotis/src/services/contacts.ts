// Contacts — saved peers (iroh NodeId + display name) for the Contacts tab.
//
// A contact is the durable P2P handle of a person you paired with: their stable
// NodeId (shared as text/QR, like a room ticket). With DHT discovery on
// (technology.md §12), contacts get "recently online" presence — the freshness of the
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


export interface NickClaim {
  node_id: string;
  /** The display form the claimant published — a CLAIM, not verified identity. */
  name: string;
  /** Unix seconds when the claim was last published. */
  ts: number;
}

/** Search the DHT nickname directory. Every result is a claim (anyone can
 *  publish any name) — the UI must show NodeId fingerprints. Requires the DHT
 *  toggle; errors and the browser fallback resolve to []. */
export async function dhtFindNick(nick: string): Promise<NickClaim[]> {
  if (!isTauri() || !nick.trim()) return [];
  try {
    return await invoke<NickClaim[]>("dht_find_nick", { nick });
  } catch {
    return [];
  }
}
