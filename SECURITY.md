# Pharos — threat model

Pharos is two things with two models. **Enigma27**, the client, runs small
group chats over Tor: every member hosts an onion service per room and links
to every other member, and every message is sealed with MLS. **Beacon**, the
optional server, keeps room mailboxes for Enigma27 and lets invitations wait
while the inviter is offline (Part 1b); it also serves the older friend
protocol (Part 2). The wire formats are in [PROTOCOL.md](PROTOCOL.md).

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
to find where the service is (guard discovery). Beacon's onion lives for years,
and in Enigma27 every member hosts a stable onion for every room, so both are
exposed to this. arti is built with the `vanguards` feature and both run
**full vanguards** (Beacon: `pharos_tor::Vanguards::Full`; Enigma27: set
explicitly in `mesh.rs`, as arti 0.43 does not yet choose full mode for onion
services itself): the second and third hops of onion circuits come from small
sets (4 L2 relays kept 1–12 days, 8 L3 relays kept 1–48 hours), so such a relay
sees a vanguard, not the guard. The sets and guards are kept in arti's state
directory and survive restarts (Beacon: `tor-state` in its data folder;
Enigma27: sealed into the profile's vault while the app is stopped). It narrows
guard discovery; it does not hide you from your guard, nor from a global
observer.

**A member of a room** learns, for every other member: its onion for that
room, its display name, and its device id (the Ed25519 public key that is
also its MLS identity); what it sends; and the timing and size of every
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

Closed since the first cut (root [todo.md](todo.md), Stages 7 and 8):

- **Padding (7.1).** Every frame is padded with spaces to 512 B, 2 KiB, 8 KiB
  or a multiple of 32 KiB before it is sent.
- **Sealed sender (7.2).** The outer frame is only `{type:"mls_app", ciphertext}`;
  who sent it, their name and the message id are inside the MLS ciphertext.
- **Timing (7.4).** While a room is open, every link carries a padded frame in
  every slot (30 s, 90 s on Android, ±20 %): a real one, or a dummy the other
  side drops. When you type is hidden from someone watching a link; that the
  room is open is not.
- **Member onions.** Anyone with a member's onion can still open a Tor
  connection to it (Tor client authorisation is optional and on Beacon only,
  8.A3), but is refused at the room handshake unless it is a signed member.

And:

- **Reset requests are signed.** `mls_reset_request` makes a member throw away
  its MLS state for the room and start a new group of one. It is obeyed only
  when signed by the device key of a current member of the group, and made
  within five minutes; anything else is ignored. A member who resets still
  needs a new invitation to get back in (rooms refuse key packages from the
  mesh).
- **Identities are device keys.** A member's MLS identity is its device id, the
  Ed25519 public key it signs with. At redemption the inviter checks that the
  key package names the same device that signed the challenge. Names are
  self-chosen labels; Friends' 12-digit check code is the way to know a device
  is the person you think. Group management (who removes a member who left) is
  app convention, not enforced by MLS.
- **Links only from members.** A member's onion accepts a room link only when
  the dialler signs it (both onions and the time) with a device key that is in
  the room's MLS group; anyone else is refused at the handshake and gets
  nothing, not even padded frames. A newcomer who has just been let in may be
  refused for a moment by members who have not yet processed the commit, and
  is linked when they have.
- **Invitations.** Without a Beacon the inviter must be online, with the room
  open. With one, the redemption waits at the room's Beacon (see Part 1b).
- **One device per identity.** No multi-device sync.
- **Forward secrecy** is MLS's within an epoch; epochs advance only on adds and
  removes (no periodic self-update).

## Hostile input

Frames over 16 MiB are refused before allocation; a frame that is not JSON is
ignored; a room Hello without the dialler's onion is dropped; a key package
from the mesh is ignored; a download without the right secret is refused, and
a file whose size or BLAKE3 does not match is not kept; an invitation with a
bad signature, proof, state, recipient or expiry is refused with a code.

# Part 1b — Beacon for Enigma27 rooms (Stage 8)

A room can have a Beacon (Settings → Connections → Your Beacon; rooms created
after that use it). Every frame then goes over the mesh **and** into the room's
mailbox on Beacon, so members who were never online at the same time still get
each other's messages. Beacon is never needed: if it is down, the mesh carries on.

**Beacon learns:** that a mailbox exists; how many frames arrive and when, and
their padded size; when it is read (blurred, below); the volume and uptime of
the whole server. **It does not learn** which room a mailbox belongs to, who
is in it, who posted or read a frame, or anything inside a frame:

- The mailbox id and token come from the MLS exporter for the current epoch
  and the week number (8.B1). Only members at that epoch can compute them; they
  change with every member added or removed and every week, so mailboxes of the
  same room cannot be linked to each other by Beacon. Beacon stores keyed
  hashes of both.
- Posts carry only the sealed frame; the room's name never leaves the phone.
- Every request to Beacon goes on its own Tor circuit (an isolated arti
  client), so two posts, or a post and a read, cannot be tied to one phone.
- Reads come at random (exponential gaps around 30 s), and half of them come
  with a dummy read of a mailbox that does not exist.
- Beacon holds each new frame back for a random 0–10 s before handing it out.
- A frame arriving both ways opens once: frames we sent and frames from the
  mesh are noted, so Beacon's copy is dropped before MLS sees it.

**What is not hidden:** a room's total volume per week (one mailbox), a frame's
send time in clear (`ts`, which Beacon knows anyway as the post time), and that
some phone is posting. Dummy frames are not posted to Beacon (they would fill
mailboxes); a mailbox keeps up to 2000 frames / 32 MiB for 14 days.

**Invitations through Beacon (8.C4).** A ticket for a room with a Beacon names
it. If the inviter's phone does not answer, the redemption is sealed with a key
from the ticket's capability and left at Beacon; the inviter's phone answers
it when it comes back, with the same checks as a live redemption. Only holders
of the ticket can find those mailboxes or open what is in them. The challenge
is chosen by the redeemer, since nobody is there to choose it live: a captured
request replayed later still admits only the same device, and an invitation is
spent after one admission. The newcomer waits up to 30 minutes.

**Only my phones (8.A3, optional).** With `restricted_discovery: true`, only
phones whose key was added with `beacon allow` can find Beacon's onion at all.
Beacon cannot tell which allowed phone opened its descriptor. Adding a phone
takes seconds to minutes; removing one is not immediate. A member without a key
stays on the mesh.

**Tested:** frames are padded and dummies recognised; mailbox ids differ per
direction, redeemer and week; sealed invitation drops open only with the
capability and the right label; Beacon's database holds no ids, tokens or
contents in the clear; held-back frames are never skipped by a cursor; the
mesh works with Beacon unreachable (the engine queues posts and retries).
**Not yet:** a run over the real Tor network.

# Part 2 — Beacon and the friend protocol

Beacon, an optional server a friend runs (often on a Raspberry Pi), keeps
messages for friends who are offline and helps friends find each other again.
It serves the friend protocol (PROTOCOL.md, Part B), which the earlier friend
client spoke; Enigma27 uses Beacon's mailboxes as Part 1b describes, not this
protocol.

**A friend** (in the friend protocol) learns what you send them, your name and
device fingerprint, the Beacon address on your card, when you are online (their
dials to your rendezvous onion succeed or not), and your clock roughly. Each
friendship has its own onion, which changes weekly (`pharos-rendezvous`), its
own MLS group, mailbox and directory record, so a friend cannot see your other
friends.

**Your Beacon's operator** (you, or a friend who runs it for you) sees, per
mailbox id: how many messages arrive, their padded size, when they arrive and
when they are fetched — that is, roughly when you are online, and how many
friends write to you (one mailbox per friendship). They do not see contents,
names, fingerprints or which mailbox belongs to which friend: ids and tokens
are HKDF outputs of the friendship secret. They can drop or delay messages
(the sender sees "left on Beacon", never "delivered"), and they can refuse
service. They cannot forge messages (MLS) or pairings (signed cards).

**Someone who takes Beacon's disk** gets the database: row counts and sizes.
Every value is sealed with `master.key`; ids and tokens are keyed hashes. With
the key too (on the same unencrypted SD card) they get what the operator
sees. Hence `beacon check` and [beacon/docs/disk-encryption.md](beacon/docs/disk-encryption.md).

### Beacon's page and code

Anyone who has a Beacon's onion address can open its page in Tor Browser and
use it: the address is its only access control, as it is for the API (friends
learn it from your contact card anyway). The page shows nothing the address
does not already give — the address itself, the name its operator chose, and
the same address as a QR code — and it is made once, at start, from those two
things, with no input from visitors. It runs no script and loads nothing from
elsewhere. A code passed on as a picture can be swapped for another Beacon's
code; whoever hands it to you should be someone you trust, and the address
inside it is checked (a typo fails its checksum), not authenticated.

### Pairing (D1)

A card is signed by the device key, expires after 7 days, and carries a
one-time token and a fresh MLS key package. The reply is signed, bound to the
card's fingerprint, and carries the MLS welcome, which opens only for that key
package. **Compare fingerprints** (six groups of four letters) in person or on
a call: a card passed through an untrusted channel could be swapped, and
signatures cannot tell you whose key it is. A reply left on Beacon under the
card's token is taken once.

### Limits and known gaps (friend protocol)

- **Fetch timing.** The friend client fetched its mailboxes and retried its
  outbox every 60 seconds while running, so Beacon learns when you are online. A random
  schedule would blur it; it is not implemented.
- **Message count per mailbox** is visible to Beacon (padding hides sizes, not counts). No cover traffic.
- **Out-of-order delivery.** MLS tolerates a small window of reordering; a
  message that arrives both directly and through Beacon opens once and the
  copy is dropped.
- **No forward secrecy for the rendezvous derivation**: whoever learns a
  friendship secret can compute that friendship's past and future onions and
  mailbox ids (not past message keys, which MLS ratchets).
- **One device per identity.** No multi-device sync.

### Hostile input (Beacon and the friend protocol)

Checked by tests: frames over 64 KiB are refused before allocation; malformed
envelopes, other wire versions and over-long texts are refused on decode;
non-zero padding is refused; a replayed or reflected MLS message does not
open; a frame that does not open ends the connection; cards that are expired,
tampered, for someone else or one's own are refused; Beacon refuses wrong
tokens, full mailboxes, too many mailboxes, oversized bodies, bad ids,
rate-limited ids; a full disk fails the request and leaves the database
intact.

## Reporting

Write to the maintainers privately before publishing.
