// Friends (Pharos 1:1): thin wrappers over the `pharos_*` commands (src-tauri/src/pharos.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Status = "Queued" | "OnProteus" | "Delivered" | "Received";

export interface Me {
  name: string;
  fingerprint: string;
  id: string;
  proteus: string | null;
}
export interface Friend {
  id: string;
  name: string;
  fingerprint: string;
  proteus: string | null;
  last_seen_secs: number | null;
}
export interface Msg {
  id: string;
  friend: string;
  /** Empty for a picture. */
  text: string;
  sent_ms: number;
  status: Status;
  image?: { mime: string; bytes: number } | null;
}
export interface Scan {
  friend: string;
  name: string;
  /** Show this back to the friend: it could not be left on their Proteus. */
  reply: string | null;
}

export const start = (name?: string) => invoke<Me>("pharos_start", { name: name ?? null });
export const me = () => invoke<Me>("pharos_me");
export const setName = (name: string) => invoke<Me>("pharos_set_name", { name });
/** `text`: a Proteus code (`pharos-proteus:…`, from its page) or its .onion address; empty for none. */
export const setProteus = (text: string | null) => invoke<Me>("pharos_set_proteus", { text });
export const card = () => invoke<string>("pharos_card");
export const scan = (text: string) => invoke<Scan>("pharos_scan", { text });
export const accept = (text: string) => invoke<string>("pharos_accept", { text });
export const friends = () => invoke<Friend[]>("pharos_friends");
export const messages = (friend: string) => invoke<Msg[]>("pharos_messages", { friend });
export const send = (friend: string, text: string) => invoke<string>("pharos_send", { friend, text });
/** A picture, already made small enough (friends/shrink.ts); `data` is base64. */
export const sendImage = (friend: string, mime: string, data: string) =>
  invoke<string>("pharos_send_image", { friend, mime, data });
/** A picture message's bytes, as a data URL to show. */
export async function imageUrl(id: string): Promise<string> {
  const r = await invoke<{ mime: string; data: string }>("pharos_image", { id });
  return `data:${r.mime};base64,${r.data}`;
}
export const remove = (friend: string) => invoke<void>("pharos_remove", { friend });
export const sync = () => invoke<void>("pharos_sync");

/** Live updates from the engine; returns one function that stops all three. */
export async function onEvents(h: {
  message: (m: Msg) => void;
  status: (s: { id: string; status: Status }) => void;
  friends: () => void;
}): Promise<UnlistenFn> {
  const u = await Promise.all([
    listen<Msg>("pharos://message", (e) => h.message(e.payload)),
    listen<{ id: string; status: Status }>("pharos://status", (e) => h.status(e.payload)),
    listen("pharos://friends", () => h.friends()),
  ]);
  return () => u.forEach((f) => f());
}

/** "pharos-card:…", "pharos-reply:…" or "pharos-proteus:…": what a scanned or
 *  pasted text is. Any case: a QR reader may upper-case it all. */
export function kindOf(text: string): "card" | "reply" | "proteus" | null {
  const t = text.trim().toLowerCase();
  if (t.startsWith("pharos-card:")) return "card";
  if (t.startsWith("pharos-reply:")) return "reply";
  if (t.startsWith("pharos-proteus:")) return "proteus";
  return null;
}
