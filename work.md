# Pharos — engineering journal

## The request (the owner, 2026-11-05)

A new project, **Pharos** ("a lighthouse in the dark"): short messages over
Tor, encrypted with Ferrozine. Fork Belisario keeping only Enigma, with its
code history, and cut it down to short messages via Tor. The server is
**Proteus** (axum, slim, must run on a Raspberry Pi); the client is
**Nautes** (Rust, Tauri), built from Enigma's code.

Chosen from the earlier analysis (Belisario session, 2026-11-05):

- **D1** exchange once, out of band: the first contact is a QR code or text card.
- **D2** rendezvous onions derived after pairing, to keep finding each other.
- **D5** a directory onion on the Pi.
- **M3** the Raspberry Pi as the always-on member: a mailbox for offline friends.

## Proteus is optional (the owner, 2026-11-05)

"In theory, Nautes should work without Proteus, but Proteus should make
things easier." So:

| | Without Proteus | With Proteus |
|---|---|---|
| First contact | D1: QR or text card | the same |
| Reaching a friend | D2: rendezvous onions, direct | the same, first choice |
| Friend offline | the message waits in a local outbox (sealed, in the vault) and is retried while Nautes runs; it arrives when both are online at once | left in the friend's mailbox (M3), fetched when they come online |
| Friend lost (new device, onion changed) | pair again (D1) | found again through the directory (D5) |

Nothing in Nautes requires a Proteus address: pairing works without one, and
a Proteus can be added to a friendship later (a new contact-card field
exchanged over the sealed channel). Tests cover both modes (5.2).

## Stage 1 — Fork and cut down

**1.1 (done 2026-11-05).** `git filter-repo` over Belisario's `dev_halo26`
(2,149 commits) kept these paths with their history (1,049 commits):
`apps/enigma/`, `crates/ferrozine/`, `crates/rotor/`,
`vendor/zirconium/crates/rotor/gervasius/`, `packages/petalite/`,
`packages/calendula/`, `scripts/`, `LICENSE`. Authors and dates are kept.
The tree still has Belisario's layout, so nothing builds yet (no root
workspace); 1.2 fixes that.

**1.2 Layout.** `nautes/` (from `apps/enigma/`), `proteus/`, `crates/`
(ferrozine, rotor, gervasius, the new pharos-* crates), `packages/` (petalite,
calendula), one root `Cargo.toml` workspace and `package.json` workspaces.
Moves are done with `git mv`, so history follows.

**1.3 Cut.** Removed, not hidden behind features:
- iroh transport (`p2p_iroh.rs`) and the Mainline DHT (`p2p_dht*.rs`);
- calls (`vox.rs`), file transfer (`file_xfer.rs`), calendar, the editions
  (Standard / Professional), `limbo/`;
- the invite variants not needed for D1.

Kept: arti (`tor.rs`, `p2p_tor.rs`), MLS and the encrypted vault, the chat UI
core, petalite, i18n EN/PL. "Privacy HP" (the cost of exposing actions) is
worth keeping for presence and directory publishing; decision PD9.

**1.4 Rename.** Bundle id, product name, words, icons. Enigma's remaining
tests must pass before Stage 2 starts.

**1.5 Scripts and CI.** A `tests.sh` per part; a GitHub workflow running cargo
and vitest on push.

### Stage 1 done — notes (2026-11-05)

- Cut: iroh/DHT/gossip, vox (calls, audio), file transfer, calendar, contacts tab, invites over iroh, `limbo/`, editions/feature flags except `pin_unlock`. Tor is always on (`default_use_tor` = true; no switch).
- Composer is text-only with a length counter; the cap is `policy.maxMessageChars` (1000) in `nautes/src/config/app.ts`. Proteus must enforce the same cap (Stage 3).
- Renamed: crate `nautes` / `nautes_lib`, bundle id `com.spectrumaipl.nautes`, views `Nautes*View`, assets `assets/nautes/`, storage keys `nautes:*`. Icons are still Enigma's artwork (new art: Stage 6).
- Leftovers for later stages:
  - `packages/rakotis/src/useChatChannel.ts` still has iroh-shaped branches (ticket/peer paths); rewrite in Stage 4.
  - `nautes/src-tauri/privacy_hp.yaml` keeps clearnet/DHT entries that nothing charges any more; decide with PD9.
  - Tab-visibility tests were removed with the tabs (only Chat is left).
  - `nautes/dromon.yaml` and `scripts/tests_lib.sh` are Belisario build-driver leftovers, unused.
- Scripts: root `tests.sh` (`js` | `rust`), root `run_dev.sh [profile]`, `.github/workflows/ci.yml`.
- Results: nautes vitest 437, rakotis 444, petalite 186, calendula 16, vue-tsc clean, `cargo test` nautes + crates pass.

## Stage 2 — Shared core

**2.1 `pharos-wire`.** Enigma's Tor framing (4-byte length prefix) with a
binary body (Borsh or CBOR instead of JSON), a version byte, and message kinds:
`Deliver`, `Ack`, `MailboxPut`, `MailboxFetch`, `DirectoryPut`,
`DirectoryGet`. Every frame has a hard size cap. Short messages: proposed
1,000 characters of text (PD7).

**2.2 `pharos-seal`.** "Encrypted with Ferrozine" means Ferrozine's sealed
rooms: MLS through rotor (OpenMLS). Ferrozine is built on iroh, which cannot
run over Tor (QUIC/UDP; Tor carries streams only), so the sealing part is
used without iroh: a feature that leaves iroh out of Ferrozine, or a small
crate taken from it. A friendship is a two-member MLS group; a small group is
an MLS group (PD8). Forward secrecy and post-compromise security come from MLS.

**2.3 `pharos-tor`.** From `p2p_tor.rs`: arti client with a per-profile
state directory (stable onion identities), hosting onion services, dialing,
per-frame write timeouts, handshake read caps. Used by Nautes and Proteus.

**2.4 `pharos-rendezvous` (D2).** At pairing, the two friends agree a
friendship secret (from the MLS group's exporter secret). Each week:
`seed = HKDF(secret, "pharos/rendezvous/v1" || year || week)`, an Ed25519 key
from the seed, and its v3 `.onion` address. Both compute the same address; the
friend who "owns" the direction hosts it (two addresses per friendship, one
per side, so each hosts its own). Clock skew: the current and the previous
week are tried. Test vectors pin the derivation.

**2.5 Identity.** A device key (Ed25519) and its fingerprint, shown on both
sides at pairing. Heliodor (Belisario's identity system) is left for later,
to keep this small (PD10).

### Stage 2 done — notes

- `pharos-wire`: `Envelope { v, id, sent_ms, body: Text | Ack | Mls | Ping }` (postcard); text cap 1000 characters, checked on both encode and decode; padding to 512 / 2048 / 8192 bytes (32 KiB multiples for MLS handshakes) inside the seal; u32 frames capped at 64 KiB, refused before allocation.
- `pharos-seal`: `Friendship` over rotor's MLS (start / join / seal / open / export / import); the friendship secret is the MLS exporter at pairing (`pharos/friendship/v1`), stored, since it changes with each epoch. `seal_labelled` / `open_labelled`: XChaCha20-Poly1305 with the label as associated data (directory records, Proteus at rest).
- `pharos-rendezvous`: HKDF-SHA256 (salt `pharos/rendezvous/v1`) from the friendship secret: weekly onion key per host, mailbox id and token, directory id (weekly), key and token. Dial candidates: this week, last week, next week. Test vectors pinned.
- `pharos-tor`: arti start / host (arti's own key) / host_with_key (`experimental-api`'s `launch_onion_service_with_hsid`) / dial with timeout. Test: the onion arti publishes for a derived key equals pharos-rendezvous' address.
- `pharos-id` (2.5, a fifth crate): ed25519 device key, fingerprint (SHA-256, 16 bytes; shown as six groups of four), signed `ContactCard` (name, device key, MLS key package, optional Proteus onion, one-time pairing token, 7-day expiry) and `PairReply` (the scanner's card + MLS welcome, bound to the card it answers), as `pharos-card:` / `pharos-reply:` base32 text for QR or paste.


**3.1 Slim axum over arti.** Proteus never listens on a clearnet port: arti
hosts its onion service, and each incoming onion stream is served by
hyper/axum as a connection (axum's `serve` on a custom stream source). Small
dependency set: axum without the macros feature, `tower` limits, tokio with
only `rt` + `net` + `time`; no TLS (Tor's onion transport is already end to
end). Target: idle memory under 64 MB on a Pi 4.

**3.2 Mailbox (M3).** A mailbox is an opaque id (random, 32 bytes) that only
its owner and the friends it was given to know. Proteus stores sealed blobs
per mailbox, padded to fixed sizes, until the owner fetches and acknowledges
them or they expire (proposed 14 days). Quotas per mailbox. Proteus is
"always on" but **not an MLS member**: it holds no keys and cannot read a
message. (M3's "always-on member" is met as a member of the protocol, not of
the encrypted groups; PD3.)

**3.3 Directory (D5).** A record says "this friendship's current onion is X",
sealed so only that friend can open it, signed by the publisher, stored under
a lookup id derived from the friendship secret (so Proteus cannot tell who it
belongs to), with an expiry. Used when the rendezvous onion is not answering
(new device, moved state).

**3.4 Access.** Capability tokens: a mailbox's write token is given to
friends at pairing, its read token stays with the owner. Rate limits per
token and in total; size caps; all requests over Tor, so no IP addresses are
seen or logged.

**3.5 Storage.** One SQLite file (bundled, WAL), with a schema version, an
expiry sweep and a `proteus backup` command. A full disk refuses new puts
with a reason; nothing else breaks.

**3.6 Raspberry Pi.** A cross-compiled aarch64 binary
(`aarch64-unknown-linux-gnu`), a systemd unit with hardening (DynamicUser,
ProtectSystem, a state directory), a config file (quotas, expiries), an
install guide. arti's state lives under the state directory; its keys are the
Proteus onion identity and are backed up with it.

### 3.7 At rest (the owner, 2026-11-05: "like in s3-like buckets of Zirkel")

Three layers, as Zirkelite does it (zirkelite `docs/security.md`, `src/diskcrypt.rs`, `docs/disk-encryption.md`):
1. End to end: what Nautes leaves on Proteus is already sealed (MLS / the friendship key), like Zirkel's encrypted buckets.
2. A master key: `master.key` beside the config, mode 0600, refused if group or others can read it. Every stored value (mailbox blob, token hash, directory record) is sealed with XChaCha20-Poly1305 under a label naming its table and row, so a value moved to another row does not open. The database alone gives away counts and sizes, not contents. Back up the database and the key separately.
3. The disk: `proteus check` reads `/proc/self/mountinfo` and `/sys/dev/block` and says whether the data folder is on dm-crypt (encrypted / not encrypted / unknown); `serve` warns at start unless encrypted. A guide for LUKS on the Pi's SD card or a USB disk.


**4.1 The window.** From Enigma's chat: friends, a conversation, a compose
box with the length cap, delivery state (sent directly, left on Proteus,
delivered, read), settings (Proteus address, passphrase, language, theme).

**4.2 Pairing (D1).** A contact card: device fingerprint, an MLS key package,
the first rendezvous parameters, the Proteus onion address and a mailbox
write token. Shown as a QR code and as text; both sides confirm the
fingerprint (a short code read aloud).

**4.3 Friendship (D2).** For each friend, host this week's own rendezvous
onion and dial theirs when there is something to send or a presence check
is due. Delivery is direct when both are online.

**4.4 Offline (M3).** If the friend's onion does not answer within a timeout,
the sealed message goes to their mailbox on Proteus. Nautes fetches its own
mailbox on start and on a randomised schedule, and acknowledges what it read.

**4.5 Directory (D5).** On start and when its onion changes, Nautes publishes
sealed records for its friends; when a friend's rendezvous onion fails, it
looks them up.

**4.6 Local state.** Enigma's vault: encrypted at rest behind a passphrase.
Notifications for new messages.

### Stage 4 done — notes

- The engine is a crate, `crates/pharos-node`, so it is tested without a window: `Node<N: Net>` with `TorNet` (arti, `pharos-tor`) in the app and `MemNet` (in-process streams, plus routing an "onion" to a loopback Proteus) in tests. Its whole state is one postcard `State`, saved by the app in the vault (`pharos/state`) on every `Event::Changed`.
- Pairing: each shown card carries its own MLS key package and a one-time token, kept as a pending entry for a week. Scanning a card starts the MLS group and gives a `PairReply`; it is left on the card owner's Proteus under the token when the card names one (the owner's `poll_pairings` takes it), and otherwise shown as a QR / text. A welcome opens only for the key package it was made for, so a reply is matched to its card by trying the pending entries.
- Direct: per friend, this week's rendezvous onion (key from the friendship secret and *our* fingerprint); dialling tries this week, last week, next week. One frame per message; every text is answered by a sealed `Ack` on the same connection.
- Offline: the outbox keeps `Queued` messages and retries each round (60 s). If the friend's card or directory record names a Proteus, the message goes to their mailbox instead (`OnProteus`) and becomes `Delivered` when their acknowledgement arrives (directly, or through *our* mailbox). Acknowledgements we owe ride with the next delivery.
- Directory: when we set or change our Proteus, a sealed `{proteus, at}` record goes, per friend, to the current and previous Proteus for this week and the next; a friend's `lookup` follows it to the new address.
- Nautes: `src-tauri/src/pharos.rs` (commands `pharos_*`, events `pharos://message|status|friends`, a notification that says who wrote but not what), started after unlock, stopped on lock. Its own arti instance in `profiles/<p>/pharos-tor/` (rendezvous keys are derived, so nothing there is secret beyond the vault). `NautesFriendsView.vue` is the first tab: friends, a conversation with statuses, a 1000-character composer, pairing (QR, copy, paste, camera), name and Proteus.
- Enigma's rooms remain as the second tab, "Groups" (small groups over the captain relay). Two arti clients run while both are in use; merging them is a later cleanup.
- Tests: pharos-node 7 end-to-end (without Proteus; weekly rotation and clock skew; mailbox, pairing drop-off and acks with a real Proteus; directory move; restart from a snapshot; hostile cards, replies, frames); `friendsView.test.ts` 5.


**5.1 Threat model.** What each party learns:
- **Tor** sees nothing of content and no addresses beyond its circuits.
- **Proteus** sees mailbox ids, blob sizes (padded) and timing, never content
  or who is who.
- **A friend** sees what you send them.
- **A stolen device**: the vault behind a passphrase.

Fetch on a randomised schedule and pad blobs to limit timing and size
signals.

**5.2 Tests.**
- Rust unit tests and protocol vectors (rendezvous, wire).
- Proteus over an in-memory transport (no Tor) for speed.
- Nautes vitest.
- One end-to-end run over real Tor (slow; on demand).

**5.3 Hostile inputs.** Oversized and malformed frames, replayed blobs,
token guessing, quota abuse, a full disk.

## Stage 6 — Release

**6.1** PROTOCOL.md (wire, rendezvous derivation, Proteus API), README,
technology.md, THIRD_PARTY.md.

**6.2** Nautes: Linux .deb / .rpm, Windows; Android later (arti works there
but is heavy on battery). Proteus: aarch64 binary and a .deb for Raspberry Pi
OS.

## Decisions for the owner (PD1–PD10)

- **PD1.** Fork with history via `git filter-repo` (done, 1.1).
- **PD2.** One repository, three parts: `nautes/`, `proteus/`, `crates/`.
- **PD3.** Proteus is always on, but not a member of any encrypted group: it
  never has keys (M3 as "member of the protocol").
- **PD4.** Proteus is reachable only as an onion service; no clearnet port.
- **PD5.** D1 then D2: pairing by QR or text, then rendezvous onions rotating
  weekly, two per friendship (one per side).
- **PD6.** D5 directory records sealed per friend, under lookup ids Proteus
  cannot link to people.
- **PD7.** Short means short: 1,000 characters of text, no attachments.
- **PD8.** 1:1 first; small groups (MLS groups, up to about a dozen) as a
  later step.
- **PD9.** Keep Enigma's "Privacy HP" for exposing actions (presence,
  publishing), or drop it to stay minimal.
- **PD10.** Device keys only for now; Heliodor identities later if wanted.
- **PD11 (the owner).** Nautes works without Proteus; Proteus is an optional
  helper for offline delivery and for finding friends again.
