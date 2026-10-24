# Ferrozine: what each layer protects

| Threat | Defence | Test |
|---|---|---|
| A relay, a gossip neighbor or the network reads the data | Every chunk and room message is MLS ciphertext (rotor, PURE_CIPHERTEXT); QUIC is a second, independent layer | `tests/network.rs` (no plaintext on the wire), `pair` tests |
| Someone who learned `{address, offer id}` fetches the file | The host serves only the KeyPackage whose commitment arrived over the authenticated group channel; refused before any metadata leaves | `a_downloader_with_another_keypackage_is_refused…`, `an_offer_nobody_authorized…` |
| A modified chunk | MLS authentication refuses it; the partial file is removed | `a_flipped_byte_…` (every position, incl. the AEAD tag) |
| Reordered, replayed or dropped chunks | The kind and sequence number are inside the sealed plaintext; MLS refuses replays | `a_swapped_pair_of_chunks_is_refused`, `a_dropped_chunk_is_refused` |
| A truncated transfer | Byte and chunk counts are checked against the header on every transfer; with integrity on, the chain root in the trailer too | `a_stream_cut_before_the_end…`, `a_missing_trailer…` |
| A forged message makes a debug build panic | openmls's decrypt `debug_assert!` is caught where the release build returns an error; same result in every profile | `a_flipped_byte_anywhere_in_a_chunk_is_an_error_never_a_panic` |
| Memory exhaustion by a large length prefix | Frames are bounded before allocation; the receiver refuses chunk sizes beyond its limits and bytes beyond the announced size | `frame` tests, `a_header_announcing_chunks_beyond_the_limits…` |
| A message from outside a room's group | It does not open with the group's session | `a_room_carries_mls_sealed_messages…` |
| Linking one transfer to the next | Ephemeral endpoint identities by default | — |

Not covered by ferrozine:

- **Who is in a room.** Membership is the app's MLS group and its admission
  flow; landing on a gossip topic grants nothing.
- **Address privacy.** A direct connection reveals each side's IP to the
  other; `Relays::Hosted` also reveals endpoint ids to n0's relays. An app
  that must hide IPs (Enigma's Tor-only profiles) must not use ferrozine.
- **Metadata.** File names, sizes and MIME types are in the host's header,
  inside QUIC but before the MLS channel exists; the authorization check runs
  first, so only the authorized peer receives them.
