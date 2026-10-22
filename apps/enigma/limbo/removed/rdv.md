# Cloud rendezvous v1 — your faros server as an optional peer directory (rdv.md)

Status: **REMOVED 2026-08-15** (branch `cleanup_1408`, commits `49e235e` /
`6e5664f`). Implemented 2026-07-26; address publishing withdrawn 2026-07-27
(D3/D4/D5); the rest deleted with the Cloud feature — see
[cloud.md](cloud.md). The full D1–D13 log is preserved in git at
`6e5664f:rdv.md`.

## What it was

With the user's own faros server configured and logged in, the server acted as a
**name and mailbox directory**: it mapped a faros username to the NodeIds behind
it (`/aster/resolve`) and held HPKE-sealed room invites until the recipient
collected them (`/aster/invite`, `/aster/invites`). It never learned *where* a
device could be reached — the relay publisher and the stacked iroh
`AddressLookup` were deleted on 2026-07-27, which removed the last periodic
server traffic in the app. The whole module rode cloud.rs's transport, session
and gates; it added no login and no second server URL. It was optional by
contract: no server, cloud off, logged out, offline or a non-aster server all
degraded silently to the manual ticket flow.

Two surfaces sat on top of it: Contacts' "search my server", which prefilled the
same code-validated add-contact modal the DHT search used, and the Cloud tab's
Invites panel, which minted a room and left one sealed copy of the ticket per
recipient **device**. It mattered most in Tor-exclusive mode, where iroh is torn
down and a room could otherwise only be shared by hand-carrying a QR:
registration published only a NodeId derived from the vault key, so it worked
with no transport at all.

## What was deleted

`aster.rs` (register / resolve / invite mailbox / fan-out) and `invite_seal.rs`
(HPKE seal + envelope signature) from Rust; the Invites panel, the recipient
picker and `useRecipientPicker.ts`; the Contacts server-search block; the
inline Rust tests, `recipientPicker.test.ts` and `cloudInvites.test.ts`.

Already gone since 2026-07-27, and not revived: the `p2p_iroh.rs` publisher
wiring, the `rdv_publish` toggle and its Settings card, the rakotis
`get/setRdvPublish` accessors, `tests/unit/rdv.test.ts`.

## What replaced it

Nothing for offline delivery. Room invites are out-of-band only: QR code,
copyable ticket, or DHT room code. Non-Tor profiles keep the direct P2P invite
over `enigma/invite/0` and DHT nickname search; Tor-exclusive profiles are back
to hand-carrying a ticket, which is exactly the gap sealed invites existed to
close.

Note the two DHT decisions from this doc are **not** part of the removal and
still stand: `discovery_enabled` and `nick_publish_enabled` return false in
Tor-exclusive mode (gated at the source in `p2p_dht.rs`, so a nickname claim
cannot publish a relay address the profile deliberately is not using), and
Contacts hides the dead surfaces while Settings keeps the toggle visible but
disabled with the reason.

## If it ever comes back

- **The ticket is a bearer credential, so it must be sealed.** MLS admission is
  automatic (no approval UI), and a Tor ticket never rotates because
  `create_room` is idempotent. A plaintext invite sitting on a server therefore
  hands that server the room. `invite_seal.rs` sealed to the recipient's NodeId
  (Ed25519→X25519, DHKEM-X25519/HKDF-SHA256/ChaCha20Poly1305 — the openmls
  primitive already vendored) **and signed the envelope**, because HPKE base
  mode is anonymous while the direct invite gets sender authenticity free from
  QUIC. `info` domain-separated the context; the AAD bound recipient ‖ sender ‖
  expiry, so an invite could not be re-addressed or have its expiry stretched.
  Expiry was enforced twice — server TTL and `exp` inside the AAD — because the
  underlying ticket has no expiry of its own.
- **The flagged weakness, worth remembering.** When you invite someone *by
  username*, their NodeId comes from the directory, so an actively malicious
  server can substitute its own key and read **that one invite**. It cannot read
  past or future ones it did not target, and it cannot join the room without the
  ticket it thereby obtains — but one is enough. This is why the trade-off was
  stated in-product beside the picker, and why the safe alternative was named
  there rather than assumed: an invite sent to a **saved contact** whose NodeId
  was verified out-of-band never passes through the directory and is not exposed
  to it. Any successor that addresses invites by a server-supplied identifier
  inherits this exactly, and must not hide it.
- **Registration was transport-independent on purpose.** `POST /aster/device`
  published a NodeId and nothing else — no relay URL, no refresh cadence, no
  continuous online signal — which is what let it work in Tor-exclusive mode and
  what kept "the server never learns where you are" true. The server still
  learned "this NodeId belongs to this account" and a `last_seen` bump on tab
  open; that was the whole residual disclosure, and it was event-driven.
