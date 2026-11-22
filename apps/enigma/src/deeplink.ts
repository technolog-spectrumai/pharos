// enigma:// links (Belisario step 12). Teutates' chat lives here now: it opens the co-op's room
//
//   enigma://room/<room name>[/<#tag>][?to=<name>&quote=<text>]
//
// The room is one this device already has (by its name, e.g. `teutates-<tribe id>`); it is
// opened and the Chat tab shown. A room not here yet: the Chat tab opens and says so. The tag,
// `to` and `quote` make a draft (`#tag @to quote`), offered to the shower (not yet typed in).
import type { P2pRoomEntry } from "rakotis";

export interface EnigmaLink {
  room: string;
  tag: string | null;
  to: string | null;
  quote: string | null;
}

export function parseEnigmaLink(url: string): EnigmaLink | null {
  const m = /^enigma:\/\/room\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:\?(.*))?$/.exec(url.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[3] ?? "");
  const room = decodeURIComponent(m[1]);
  if (!room) return null;
  return { room, tag: m[2] ? decodeURIComponent(m[2]) : null, to: q.get("to"), quote: q.get("quote") };
}

/** What the link puts in the composer: `#tag @to quote`. */
export function draftOf(l: EnigmaLink): string {
  return [l.tag ? `#${l.tag}` : "", l.to ? `@${l.to}` : "", l.quote ?? ""].filter(Boolean).join(" ");
}

export interface Opener {
  rooms: () => P2pRoomEntry[];
  open: (entry: P2pRoomEntry) => Promise<void>;
  /** Shows the Chat tab; `missing` names a room this device does not have. */
  show: (draft: string, missing: string | null) => void;
}

/** Opens what a link names; `false` when it is not an Enigma link. */
export async function openLink(url: string, o: Opener): Promise<boolean> {
  const l = parseEnigmaLink(url);
  if (!l) return false;
  const entry = o.rooms().find((r) => r.name === l.room || r.room === l.room);
  if (entry) await o.open(entry);
  o.show(draftOf(l), entry ? null : l.room);
  return true;
}
