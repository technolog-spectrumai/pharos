// Friends: the devices this one has paired with.
//
// A friend is another phone's device id (its Ed25519 public key as 64 hex
// digits, see src-tauri/src/device.rs) and the name it introduced itself with.
// Pairing is two QR scans, one each way: each phone shows a pairing code with
// its device id and name, and keeps what it scanned. Both then show the same
// check code, made from the two device ids, to read out loud: if the numbers
// match, nobody swapped a code on the way (it matters when codes travel through
// a messenger instead of a camera).
//
// What a friend is for: an invitation sealed to them, which only their phone can
// open (RoomShareCard, "a friend"). Pairing gives nobody access to anything.
//
// Kept in the vault (kv "friends"), so the list is encrypted at rest and wiped by
// the panic code like everything else. Module state rather than Pinia, for the
// same reason as tabs.ts: plain refs the views read live.

import { ref } from "vue";
import { kvGet, kvPut } from "rakotis";

export interface Friend {
  /** The friend's device id: 64 hex digits. */
  id: string;
  name: string;
  /** When we paired, epoch ms. */
  addedAt: number;
}

const NS = "friends";
const PREFIX = "enigma27-friend:1:";

export const friends = ref<Friend[]>([]);
let loaded = false;

export async function loadFriends(force = false): Promise<Friend[]> {
  if (loaded && !force) return friends.value;
  try {
    const raw = await kvGet(NS, "default", "list");
    const list = raw ? (JSON.parse(raw) as Friend[]) : [];
    friends.value = list.filter((f) => isDeviceId(f.id));
  } catch {
    friends.value = [];
  }
  loaded = true;
  return friends.value;
}

async function save(): Promise<void> {
  await kvPut(NS, "default", "list", JSON.stringify(friends.value));
}

/** Add a friend, or rename one we already have. */
export async function addFriend(id: string, name: string): Promise<Friend> {
  await loadFriends();
  const clean = name.trim().slice(0, 80) || id.slice(0, 8);
  const existing = friends.value.find((f) => f.id === id);
  if (existing) {
    existing.name = clean;
    friends.value = [...friends.value];
    await save();
    return existing;
  }
  const f: Friend = { id, name: clean, addedAt: Date.now() };
  friends.value = [...friends.value, f].sort((a, b) => a.name.localeCompare(b.name));
  await save();
  return f;
}

export async function removeFriend(id: string): Promise<void> {
  friends.value = friends.value.filter((f) => f.id !== id);
  await save();
}

export function isDeviceId(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

// ── the pairing code ────────────────────────────────────────────────────────
// `enigma27-friend:1:<device id>:<name, base64url of UTF-8>`. Not a secret: it
// says who you are, nothing more.

function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): string {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodePairing(id: string, name: string): string {
  return `${PREFIX}${id}:${b64url(name.trim().slice(0, 80))}`;
}

/** The device id and name in a pairing code, or null for anything else. A bare
 *  device id (64 hex digits) is accepted too, with no name. */
export function decodePairing(text: string): { id: string; name: string } | null {
  const t = text.trim();
  if (isDeviceId(t.toLowerCase())) return { id: t.toLowerCase(), name: "" };
  if (!t.startsWith(PREFIX)) return null;
  const [id, name = ""] = t.slice(PREFIX.length).split(":");
  if (!isDeviceId(id)) return null;
  try {
    return { id, name: unb64url(name).slice(0, 80) };
  } catch {
    return { id, name: "" };
  }
}

/** Twelve digits both phones compute from the two device ids, in any order:
 *  "0123 4567 8901". The same on both screens means both kept the right code. */
export async function checkCode(a: string, b: string): Promise<string> {
  const [x, y] = [a, b].sort();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`enigma27-pair:${x}:${y}`)));
  let n = 0n;
  for (const byte of digest.slice(0, 6)) n = (n << 8n) | BigInt(byte);
  const digits = (n % 10n ** 12n).toString().padStart(12, "0");
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
}
