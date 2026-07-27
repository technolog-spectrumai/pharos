// The shared map layer — pure derivation, no Vue/Tauri imports.
//
// What room members shared is ALREADY stored: every map card lives in the chat
// timeline, which is room-scoped (cleared + restored from the sealed chat:log
// on every room entry) and replicates to linked devices. So the layer is a
// projection of that timeline, not a second copy of the coordinates — a shadow
// store would duplicate shared locations outside the sealed log's lifecycle,
// and would have to re-implement expiry, room scoping and replication.
//
// Lives app-side rather than in rakotis because it needs the timeline's
// `Message` shape (rakotis' mapModel cannot import useChatChannel — that would
// be a cycle) — the pure-model convention used across the app.

import {
  coveredByAny,
  isLocationLive,
  type MapLocationShare,
  type MapPinShare,
  type MapRegionManifest,
  type MapShare,
} from "rakotis";

/** Marker/row budget. A busy room can hold thousands of cards; past this the
 *  NEWEST win. If it ever bites, the migration is a GeoJSON circle layer — the
 *  derivation below is unaffected. */
export const SHARED_LAYER_MAX_ITEMS = 200;

export type SharedKind = "pin" | "loc";

/** The structural subset of `Message` this module needs — so tests build plain
 *  objects and never construct a chat channel. */
export interface TimelineLike {
  id: string;
  user: string;
  self: boolean;
  map?: MapShare;
}

export interface SharedItem {
  /** The message id: sender-minted, stable across reload/replication, and the
   *  key the marker diff uses. */
  key: string;
  kind: SharedKind;
  sender: string;
  self: boolean;
  /** The sender's timestamp for a location; 0 for pins/routes (they don't age). */
  at: number;
  /** THE SAME OBJECT as `message.map` — reference identity is what lets the
   *  "Open in Maps" handoff find an item already on the layer. */
  share: MapPinShare | MapLocationShare;
  /** Some imported region covers it, so it can actually be drawn. */
  covered: boolean;
}

export interface DeriveOpts {
  now: number;
  regions: readonly MapRegionManifest[];
  ttlMs?: number;
}

/** Region offers are download cards, never overlays — this also narrows the
 *  union for everything below. */
function isOverlayShare(
  share: MapShare,
): share is MapPinShare | MapLocationShare {
  return share.type !== "map_region";
}

function kindOf(share: MapPinShare | MapLocationShare): SharedKind {
  if (share.type === "map_pin") return "pin";
  return "loc";
}

/** Project the open room's timeline onto the shared layer. */
export function deriveSharedLayer(
  msgs: readonly TimelineLike[],
  opts: DeriveOpts,
): SharedItem[] {
  const out: SharedItem[] = [];
  const seen = new Set<string>();

  for (const msg of msgs) {
    const share = msg.map;
    if (!share || !isOverlayShare(share)) continue;
    // pushMessage already dedupes by id; this also covers a restore/merge race.
    if (seen.has(msg.id)) continue;

    if (share.type === "map_loc" && !isLocationLive(share, opts.now, opts.ttlMs)) continue;

    const covered = coveredByAny(opts.regions, share.lat, share.lng);

    seen.add(msg.id);
    out.push({
      key: msg.id,
      kind: kindOf(share),
      sender: msg.user,
      self: msg.self,
      at: share.type === "map_loc" ? share.at : 0,
      share,
      covered,
    });
  }

  // Timeline order is oldest-first, so the newest survive the cap.
  return out.length > SHARED_LAYER_MAX_ITEMS ? out.slice(-SHARED_LAYER_MAX_ITEMS) : out;
}

/** Display name for an item (a location may carry no label). */
export function sharedItemName(item: SharedItem, fallbackLocName: string): string {
  if (item.share.type === "map_loc") return item.share.label || fallbackLocName;
  return item.share.name;
}
