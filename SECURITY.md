# Pharos — threat model

Pharos sends short text messages between friends who paired in person (or
over a channel they trust), over Tor, end-to-end encrypted with MLS. Proteus,
an optional server a friend runs (often on a Raspberry Pi), keeps messages for
friends who are offline and helps friends find each other again.

## What we protect

| Asset | Protected by |
|---|---|
| Message contents | MLS (RFC 9420, Ferrozine's rotor), per friendship; padded to 512 / 2048 / 8192 bytes before encryption |
| Who talks to whom | Tor onion services on both ends; per-friendship rendezvous onions that change weekly; Proteus sees random-looking ids |
| Friendship secrets, device key, history | The vault (protasius: Argon2id passphrase, XChaCha20-Poly1305), locked on idle |
| What Proteus stores | End-to-end sealed by Enigma, then sealed again with Proteus' master key; ids and tokens stored as keyed hashes |

## Who can learn what

**A network observer** (your ISP, a Wi-Fi operator) sees that you use Tor, and
how much. Not whom you talk to, not when a particular friend is online.

**Tor relays** see what any onion-service traffic shows: a guard sees you; no
relay sees both ends. Each friendship's onion changes every week
(`pharos-rendezvous`), so an onion seen this week cannot be linked to the next
by its address.

**A friend** learns what you send them, your name and device fingerprint, the
Proteus address on your card, when you are online (their dials to your
rendezvous onion succeed or not), and your clock roughly (send times are
shown). They cannot see your other friends: each friendship has its own onion,
MLS group, mailbox and directory record.

**Your Proteus' operator** (you, or a friend who runs it for you) sees, per
mailbox id: how many messages arrive, their padded size, when they arrive and
when they are fetched — that is, roughly when you are online, and how many
friends write to you (one mailbox per friendship). They do not see contents,
names, fingerprints or which mailbox belongs to which friend: ids and tokens
are HKDF outputs of the friendship secret. They can drop or delay messages
(the sender sees "left on Proteus", never "delivered"), and they can refuse
service. They cannot forge messages (MLS) or pairings (signed cards).

**Someone who takes Proteus' disk** gets the database: row counts and sizes.
Every value is sealed with `master.key`; ids and tokens are keyed hashes. With
the key too (on the same unencrypted SD card) they get what the operator
sees. Hence `proteus check` and [proteus/docs/disk-encryption.md](proteus/docs/disk-encryption.md).

**Someone who takes your unlocked device** has everything; locked, they need
the passphrase (Argon2id). A panic code wipes the vault.

## A Proteus' page and code

Anyone who has a Proteus' onion address can open its page in Tor Browser and
use it: the address is its only access control, as it is for the API (friends
learn it from your contact card anyway). The page shows nothing the address
does not already give — the address itself, the name its operator chose, and
the same address as a QR code — and it is made once, at start, from those two
things, with no input from visitors. It runs no script and loads nothing from
elsewhere. A code passed on as a picture can be swapped for another Proteus'
code; whoever hands it to you should be someone you trust, and the address
inside it is checked (a typo fails its checksum), not authenticated.

## Pairing (D1)

A card is signed by the device key, expires after 7 days, and carries a
one-time token and a fresh MLS key package. The reply is signed, bound to the
card's fingerprint, and carries the MLS welcome, which opens only for that key
package. **Compare fingerprints** (six groups of four letters) in person or on
a call: a card passed through an untrusted channel could be swapped, and
signatures cannot tell you whose key it is. A reply left on Proteus under the
card's token is taken once.

## Limits and known gaps

- **Fetch timing.** Enigma fetches its mailboxes and retries its outbox every
  60 seconds while running, so Proteus learns when you are online. A random
  schedule would blur it; it is not implemented.
- **Message count per mailbox** is visible to Proteus (padding hides sizes, not counts). No cover traffic.
- **Out-of-order delivery.** MLS tolerates a small window of reordering; a
  message that arrives both directly and through Proteus opens once and the
  copy is dropped.
- **No forward secrecy for the rendezvous derivation**: whoever learns a
  friendship secret can compute that friendship's past and future onions and
  mailbox ids (not past message keys, which MLS ratchets).
- **One device per identity.** No multi-device sync.
- **Groups** (the second tab) is Vesper's room chat over a captain relay; its
  model is Vesper's (`enigma/technology.md`), not this document's.
- **Privacy HP** (Vesper's meter of privacy cost) is still present; whether to keep it is decision PD9.

## Hostile input

Checked by tests: frames over 64 KiB are refused before allocation; malformed
envelopes, other wire versions and over-long texts are refused on decode;
non-zero padding is refused; a replayed or reflected MLS message does not
open; a frame that does not open ends the connection; cards that are expired,
tampered, for someone else or one's own are refused; Proteus refuses wrong
tokens, full mailboxes, too many mailboxes, oversized bodies, bad ids,
rate-limited ids; a full disk fails the request and leaves the database
intact.

## Reporting

Write to the maintainers privately before publishing.
