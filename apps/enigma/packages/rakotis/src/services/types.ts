// Transport-agnostic shared DTOs — NOT crypto. A P2P room has no server yet
// still has participants; the roster is sourced from MLS group membership, but
// the shape stays generic so chat code stays consistent without coupling to any
// crypto/MLS internals.

export interface Participant {
  /** Stable identity: the device id (MLS credential). */
  id?: string;
  name: string;
  avatar_url: string;
  type: "human" | "ai_agent";
  /** True for the elected onion captain (host/relay) — Tor rooms only. */
  isCaptain?: boolean;
}

/** A chat room as the UI sees it. P2P rooms synthesize this locally (slug = the
 *  iroh-gossip topic id); the numeric `id` is vestigial and always 0. */
export interface Room {
  id: number;
  name: string;
  slug: string;
  participant_count: number;
  created_at: string;
  is_participant?: boolean;
  participants?: Participant[];
}
