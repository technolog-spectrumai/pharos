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
| A peer that connects and sends nothing, holding resources (and keeping `transfers_active` true) for ever | The request must arrive within 30 s; at most 16 connections are served at once; a transfer counts as active only once authorized | `a_connection_that_never_sends_its_request…`, `connections_beyond_the_cap…` |
| A failed download destroys a file the user already had at that path | Only a file this transfer created is removed on failure | `a_download_that_fails_before_writing_leaves_an_existing_file_alone` |
| A verified file thrown away because the final ack could not be delivered | The ack and stream close are best-effort once the file is verified | `a_verified_file_is_kept_when_its_ack_cannot_be_delivered` |
| Someone else uses a ticket (link / QR) | A ticket is the authorization, so it must reach only the intended person. One holder at a time is admitted (checked and marked under one lock); a successful transfer withdraws the offer, so it works once; a failed one leaves it claimable, so a retry works | `a_ticket_holder_fetches_the_file_and_the_ticket_then_stops_working`, `of_two_simultaneous_ticket_holders…`, `while_a_ticket_transfer_runs…`, `a_ticket_transfer_cut_short_can_be_retried…` |
| A ticket used after its expiry because the machine slept | The deadline is checked on the wall clock at admission, not by a timer | `a_ticket_past_its_wall_clock_deadline_is_refused` |
| One peer holding every serving slot (the address is in the ticket) | At most 2 connections per remote endpoint, 16 in all | `one_peer_cannot_hold_more_than_its_share_of_serving_slots` |
| A ticket claim replayed for another KeyPackage | The claim is keyed-BLAKE3 over the offer *and* the KeyPackage commitment | `a_claim_is_bound_to_secret_offer_and_keypackage` |
| A wrong guess burns a real ticket | Failed claims change nothing | `a_wrong_secret_or_no_claim_is_refused` |
| Linking one transfer to the next | Ephemeral endpoint identities by default | — |

Not covered by ferrozine:

- **Whether an offer id exists.** An unknown offer is refused at once, a known
  but unauthorized one after the authorization wait, so timing tells them
  apart. Offer ids are random UUIDs (122 bits), so the answer is useless
  without already knowing the id; making unknown offers wait too would let a
  prober hold serving slots for the full wait.

- **Who is in a room.** Membership is the app's MLS group and its admission
  flow; landing on a gossip topic grants nothing.
- **Address privacy.** A direct connection reveals each side's IP to the
  other; `Relays::Hosted` also reveals endpoint ids to n0's relays. An app
  that must hide IPs (Enigma's Tor-only profiles) must not use ferrozine.
- **Metadata.** File names, sizes and MIME types are in the host's header,
  inside QUIC but before the MLS channel exists; the authorization check runs
  first, so only the authorized peer receives them.
