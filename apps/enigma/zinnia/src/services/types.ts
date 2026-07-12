// Transport-agnostic shared DTOs. These are server/transport response shapes —
// NOT crypto. A P2P room (Enigma) has no server yet still has participants; the
// roster is sourced from MLS group membership or the server, but the shape is the
// same. Rakotis imports `Participant` as a type so chat code stays consistent
// without coupling Euclid to any crypto/MLS internals.

export interface Participant {
  /** Stable identity: the device id (MLS credential) for P2P; may be omitted for
   *  server-provided participants, where `name` is used as the key. */
  id?: string;
  name: string;
  /** SSO username — used to resolve this member's iroh gossip NodeId from aster so a
   *  P2P room can be opened without a ticket. Empty/absent for people with no account. */
  username?: string;
  avatar_url: string;
  type: "human" | "ai_agent";
}
