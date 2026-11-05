// Contacts — saved peers (device id + display name), used to address personal
// invitations. Pairing (Pharos Stage 4.2) will fill and use this list.
//
// Stored as one JSON array under the encrypted kv (same single-key pattern as
// the `p2p:rooms` list — the kv API has no key enumeration by design).

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
