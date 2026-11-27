// Transport-agnostic shared DTOs — NOT crypto. A P2P room has no server yet
// still has participants; the roster is sourced from MLS group membership, but
// the shape stays generic so chat code stays consistent without coupling to any
// crypto/MLS internals.

export interface Participant {
  /** Stable identity: the device id (MLS credential). With linked devices this
   *  is the user's representative leaf id (the bare id when present). */
  id?: string;
  name: string;
  avatar_url: string;
  type: "human" | "ai_agent";
  /** Another member with a live link to this device right now (false: away,
   *  or their onion is not reachable yet). Unset for ourselves. */
  linked?: boolean;
  /** All MLS leaf ids grouped into this roster row (present when the user has
   *  more than one linked device in the room). */
  leafIds?: string[];
  /** Convenience: leafIds.length when > 1 (the "2 devices" roster badge). */
  deviceCount?: number;
}

/** A chat room as the UI sees it. P2P rooms synthesize this locally (slug = the
 *  BLAKE3 of the room name); the numeric `id` is vestigial and always 0. */
export interface Room {
  id: number;
  name: string;
  slug: string;
  participant_count: number;
  created_at: string;
  is_participant?: boolean;
  participants?: Participant[];
}
