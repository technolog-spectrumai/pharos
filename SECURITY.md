# Pharos — threat model

Pharos is two things with two models. **Enigma27**, the client, runs small
group chats over Tor: every member hosts an onion service per room and links
to every other member, and every message is sealed with MLS. **Sotha**, the
optional server, serves the older friend protocol (mailbox, directory,
pairing drop-off); Enigma27 does not use it yet. Part 1 is Enigma27, part 2 is
Sotha. The wire formats are in [PROTOCOL.md](PROTOCOL.md).

# Part 1 — Enigma27

## What we protect

| Asset | Protected by |
|---|---|
| Message contents (text, images, voice notes, presence, file offers) | MLS (RFC 9420, OpenMLS via `rotor_core`), one group per room, ciphersuite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` |
| File contents | Tor's end-to-end onion encryption on a stream to the sender's onion; one download per acceptance (a secret committed over MLS); BLAKE3 of the whole file checked before it is kept |
| Where you are (your IP) | Always Tor. Every member is reached only at its onion; there is no direct connection, no relay server and no discovery service |
| Who is in a room | Known to its members. Members' onions travel only inside MLS (presence) and in the redemption answer |
| Keys, MLS state, history, Tor state | The vault: protasius per profile, Argon2id passphrase, XChaCha20-Poly1305; locked on idle; arti's state sealed into it when the app stops |

## Who can learn what

**A network observer** (your ISP, a Wi-Fi operator) sees that you use Tor,
when, and how much. Not which rooms, not whom you talk to.

**Tor relays** see what any onion-service traffic shows: your guard sees you;
no relay sees both ends, and nothing a relay sees links you to a room. Each
room has its own onion per device, so the onions you host for two rooms
cannot be linked by their addresses.

**Vanguards.** An onion service that lives long at one address can be made to
build circuits on demand: an attacker connects to it again and again, running
relays of their own, until one of theirs is picked as the hop next to the
service's guard; from there they learn the guard and can watch or pressure it
to find where the service is (guard discovery). Sotha's onion lives for years,
and in Enigma27 every member hosts a stable onion for every room, so both are
exposed to this. arti is built with the `vanguards` feature and both run
**full vanguards** (Sotha: `pharos_tor::Vanguards::Full`; Enigma27: set
explicitly in `mesh.rs`, as arti 0.43 does not yet choose full mode for onion
services itself): the second and third hops of onion circuits come from small
sets (4 L2 relays kept 1–12 days, 8 L3 relays kept 1–48 hours), so such a relay
sees a vanguard, not the guard. The sets and guards are kept in arti's state
directory and survive restarts (Sotha: `tor-state` in its data folder;
Enigma27: sealed into the profile's vault while the app is stopped). It narrows
guard discovery; it does not hide you from your guard, nor from a global
observer.

**A member of a room** learns, for every other member: its onion for that
room, its display name and picture, its MLS identity (the profile name) and,
for an inviter, its device id; what it sends; and the timing and size of every
frame it receives. A member who has the room's MLS state can read the room
until it is removed from the group. Members see each other's onions, not IPs.

**Anyone who knows one member's onion for a room** — a former member, or
whoever photographed a general invitation, which carries the inviter's onion
in the clear — can connect to it. Links are not authenticated below MLS (no
Tor client authorisation yet), so such a connection is accepted as a link and
receives what that member sends: MLS ciphertext, which it cannot open, with
the sender fields that ride outside it (MLS identity, display name, picture,
message ids), and their timing and sizes. It cannot read or forge messages.
See the known gaps below for what it can disturb.

**Someone holding an invitation** learns the inviter's device id and the
inviter's onion for the room (a personal invitation is sealed to its
recipient's device id; a general one is cleartext). Redeeming it needs the
inviter online, a valid proof of the capability, and, for a personal one, a
signature by the recipient's device key. The inviter decides expiry on its own
clock and can revoke an invitation; each is spent once.

**Someone who takes your unlocked device** has everything; locked, they need
the passphrase (Argon2id, 64 MiB, t=3, p=4). A PIN re-opens a session only
while the app runs; it is never an at-rest secret. A panic code, entered at the
unlock prompt, wipes every profile and looks like an ordinary unlock.

## Messages at rest

Each profile has one protasius store: keys in the clear, values sealed with
XChaCha20-Poly1305 under a random DEK, each bound to its key (AAD
`protasius:v1:` ‖ key). The DEK is wrapped by the passphrase (Argon2id) in
`vault.json`, beside a slot for the panic code. History is kept in sealed
`chat:log` segments per room, capped at 500 messages by default (Settings,
50–5000). MLS state is kept per (room, identity) in namespace `mls` and survives
reopening a room. arti's state (onion keys, guards, vanguard sets) is
plaintext on disk only while the app runs: on lock or exit it is sealed into
the vault and the directory removed. A crash leaves it on disk until the next
clean stop.

## Limits and known gaps

Open, in root [todo.md](todo.md) Stage 7:

- **No padding (7.1).** Frame sizes show what was sent (a text, an image, a
  voice note) to every link and to a Tor relay that can count cells.
- **Sender fields in the clear (7.2).** The MLS identity, display name,
  picture and message id of `mls_app` frames are outside the ciphertext, so
  anyone linked (see above) sees them.
- **Timing (7.4).** No cover traffic: when you write, and when you are online,
  shows to whoever is linked.
- **No Tor client authorisation (part of 7.3).** Anyone with a member's onion
  can fetch its descriptor and connect.

And:

- **Unauthenticated reset.** `mls_reset_request` is a plaintext frame that
  makes a member throw away its MLS state for the room and start a new group
  of one; anyone linked can send it, and the room's "reset encryption" button
  sends it too. Since rooms refuse key packages from the mesh, a reset member
  cannot get back in without a new invitation. Key packages from the mesh are
  refused, and no plaintext message is ever shown.
- **Self-asserted identities.** The MLS credential is the profile name; there
  is no safety-number check. Group management (who removes a member who left)
  is app convention, not enforced by MLS.
- **The inviter must be online**, with the room open, for an invitation to be
  redeemed. No store-and-forward.
- **One device per identity.** No multi-device sync.
- **Forward secrecy** is MLS's within an epoch; epochs advance only on adds and
  removes (no periodic self-update).

## Hostile input

Frames over 16 MiB are refused before allocation; a frame that is not JSON is
ignored; a room Hello without the dialler's onion is dropped; a key package
from the mesh is ignored; a download without the right secret is refused, and
a file whose size or BLAKE3 does not match is not kept; an invitation with a
bad signature, proof, state, recipient or expiry is refused with a code.

# Part 2 — Sotha and the friend protocol

Sotha, an optional server a friend runs (often on a Raspberry Pi), keeps
messages for friends who are offline and helps friends find each other again.
It serves the friend protocol (PROTOCOL.md, Part B), which the earlier friend
client spoke; Enigma27 does not talk to it yet.

**A friend** (in the friend protocol) learns what you send them, your name and
device fingerprint, the Sotha address on your card, when you are online (their
dials to your rendezvous onion succeed or not), and your clock roughly. Each
friendship has its own onion, which changes weekly (`pharos-rendezvous`), its
own MLS group, mailbox and directory record, so a friend cannot see your other
friends.

**Your Sotha's operator** (you, or a friend who runs it for you) sees, per
mailbox id: how many messages arrive, their padded size, when they arrive and
when they are fetched — that is, roughly when you are online, and how many
friends write to you (one mailbox per friendship). They do not see contents,
names, fingerprints or which mailbox belongs to which friend: ids and tokens
are HKDF outputs of the friendship secret. They can drop or delay messages
(the sender sees "left on Sotha", never "delivered"), and they can refuse
service. They cannot forge messages (MLS) or pairings (signed cards).

**Someone who takes Sotha's disk** gets the database: row counts and sizes.
Every value is sealed with `master.key`; ids and tokens are keyed hashes. With
the key too (on the same unencrypted SD card) they get what the operator
sees. Hence `sotha check` and [sotha/docs/disk-encryption.md](sotha/docs/disk-encryption.md).

### Sotha's page and code

Anyone who has a Sotha's onion address can open its page in Tor Browser and
use it: the address is its only access control, as it is for the API (friends
learn it from your contact card anyway). The page shows nothing the address
does not already give — the address itself, the name its operator chose, and
the same address as a QR code — and it is made once, at start, from those two
things, with no input from visitors. It runs no script and loads nothing from
elsewhere. A code passed on as a picture can be swapped for another Sotha's
code; whoever hands it to you should be someone you trust, and the address
inside it is checked (a typo fails its checksum), not authenticated.

### Pairing (D1)

A card is signed by the device key, expires after 7 days, and carries a
one-time token and a fresh MLS key package. The reply is signed, bound to the
card's fingerprint, and carries the MLS welcome, which opens only for that key
package. **Compare fingerprints** (six groups of four letters) in person or on
a call: a card passed through an untrusted channel could be swapped, and
signatures cannot tell you whose key it is. A reply left on Sotha under the
card's token is taken once.

### Limits and known gaps (friend protocol)

- **Fetch timing.** The friend client fetched its mailboxes and retried its
  outbox every 60 seconds while running, so Sotha learns when you are online. A random
  schedule would blur it; it is not implemented.
- **Message count per mailbox** is visible to Sotha (padding hides sizes, not counts). No cover traffic.
- **Out-of-order delivery.** MLS tolerates a small window of reordering; a
  message that arrives both directly and through Sotha opens once and the
  copy is dropped.
- **No forward secrecy for the rendezvous derivation**: whoever learns a
  friendship secret can compute that friendship's past and future onions and
  mailbox ids (not past message keys, which MLS ratchets).
- **One device per identity.** No multi-device sync.

### Hostile input (Sotha and the friend protocol)

Checked by tests: frames over 64 KiB are refused before allocation; malformed
envelopes, other wire versions and over-long texts are refused on decode;
non-zero padding is refused; a replayed or reflected MLS message does not
open; a frame that does not open ends the connection; cards that are expired,
tampered, for someone else or one's own are refused; Sotha refuses wrong
tokens, full mailboxes, too many mailboxes, oversized bodies, bad ids,
rate-limited ids; a full disk fails the request and leaves the database
intact.

## Reporting

Write to the maintainers privately before publishing.
