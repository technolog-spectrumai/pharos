# Enigma DHT discovery — implementation plan & record (`TODO(dht-rdv)`)

Companion to `serverless_plan.md` and `tor.md`. This documents **Kademlia-based
peer discovery over the BitTorrent Mainline DHT**: ticketless room join by a
shareable *room code*, plus the **Contacts** tab (saved peers + presence). It is
the reference for what is being built and why.

## Context

Enigma's iroh transport is serverless except for one third-party dependency:
n0's public relay + discovery (pkarr/DNS) baked into `presets::N0`. First
contact additionally requires a QR *ticket* embedding the creator's
`EndpointAddr`s. This work adds a second, fully community-run discovery path —
the **Mainline DHT** (the BitTorrent Kademlia, ~10M nodes, bootstrap via
well-known community nodes, no infrastructure of ours or n0's) — so that:

1. A room can be joined **without a ticket**, from a short *room code* shared
   out of band (the ticket/QR flow stays unchanged alongside).
2. A **Contacts** tab (next to Chat/Files/Settings) holds saved peers
   (NodeId + display name) with DHT-based "recently online" presence and an
   invite-to-room action.

### Confirmed design decisions

1. **Mainline DHT, not libp2p, not a private overlay.** iroh 0.98 ships native
   Mainline support (`address-lookup-pkarr-dht` feature → `DhtAddressLookup`),
   and the `mainline` crate gives direct BEP44 access for the room rendezvous
   records. A private Kademlia among enigma users only would have a hard
   bootstrap problem at small scale; libp2p would mean a second network stack.
2. **"Server-free" = no infra the user (or we) run.** Community Mainline
   bootstrap nodes are acceptable. **n0 relays stay** (`RelayMode::Default`)
   for NAT hole-punching — DHT-discovered NodeIds still dial through iroh's
   normal path, relays included.
3. **Opt-in toggle, default off.** kv `p2p:settings/dht_discovery` ("on"/"off").
   Off ⇒ behavior is byte-for-byte today's: no mainline socket, identical
   endpoint builder chain.
4. **The gossip topic derivation does not change** (`blake3(room_name)`).
   DHT-joiners, ticket-joiners, and reconnect-by-NodeId all land on the same
   topic — no room splits.
5. **MLS still gates membership.** The DHT only introduces *transport*
   connections; group admission remains the existing
   `mls_key_package` → `addMember` → `mls_welcome` exchange over the topic.

### Why not `distributed-topic-tracker`

Evaluated and rejected: its last iroh-0.98-compatible release (0.3.2) is a
version dead-end (0.3.4+ requires iroh ≥ 1.0), and it derives its own gossip
`TopicId`, which would split rooms between DHT-joiners and ticket-joiners
(decision 4). Its *record scheme* is sound, so we borrow the ideas —
time-bucketed derived signing keys, multi-writer single-key records, publish
jitter, read current+previous window, back-off when enough records exist —
directly on the `mainline` crate (~200 lines in `p2p_dht.rs`).

---

## Protocol

### Room secret & room code

- On room creation with discovery on (or on demand for an existing hosted
  room): `room_secret: [u8;32]` = `iroh::SecretKey::generate().to_bytes()`.
  **Never derived from the room name** — an attacker must not be able to
  squat/enumerate rendezvous points from guessable names.
- **Room code** = `base32_nopad(0x44 ‖ postcard { name, secret })`, lowercase.
  Tag byte `0x44` ('D') joins the existing family (`IROH_TAG 0x49`,
  `TOR_TAG 0x54`) so the one join field routes any pasted/scanned code by
  sniffing.
- The secret persists in the vault (ns `dht`, key `room_secret_{room_id}`).
  Creators and code-joiners hold it — *any* online holder keeps the room
  discoverable. Ticket-joiners don't (RoomInfo offers a code only where the
  secret exists).

### Key derivation (blake3), hourly buckets

```
bucket      = floor(unix_seconds / 3600)
signing_key = ed25519 SigningKey from blake3::derive_key("enigma/dht/room-sign/v1", secret ‖ bucket_le)
enc_key     =                       blake3::derive_key("enigma/dht/room-enc/v1",  secret ‖ bucket_le)
salt        = b"enigma-room-v1"   (constant — the signing key itself rotates)
```

Readers query bucket `b` and `b−1`, so records stay findable across the
boundary. One-hour rotation (vs. distributed-topic-tracker's one minute) keeps
Android battery/DHT churn low while still bounding linkability of the
rendezvous point over time.

### Rendezvous record (BEP44 mutable item, ≤ 1000 B; ours ≈ 200 B)

```
plaintext = postcard { v: 1, node_id: [u8;32], peers: Vec<[u8;32]> (≤4), ts: u64 }
value     = nonce(12 B random) ‖ ChaCha20-Poly1305(enc_key, nonce, plaintext)
item      = MutableItem::new(signing_key, value, seq = unix_seconds, salt)
```

- `node_id` = the publisher's iroh EndpointId; `peers` = up to 4 of its
  currently-connected gossip neighbors (one record bootstraps several dials).
- **Multi-writer under one shared key:** every secret-holder signs with the
  same bucket-derived key; DHT storage nodes keep the highest `seq` they see,
  and a `get_mutable` streams the scatter of values held across nodes. Readers
  decrypt everything, dedupe NodeIds, and drop records with `ts` older than
  two buckets.
- Encryption hides room membership (NodeIds) from DHT observers; the derived
  signing key means only secret-holders can write records storage nodes accept.

### Nickname directory (Contacts "Find people")

An opt-in, serverless *name → NodeId* directory. The user sets a public
nickname and a "findable" toggle (Contacts tab; kv `dht_nick_publish` /
`dht_nickname`, default off); while the app runs with DHT on, a claim record
is announced every `dht_room_publish_secs`.

```
normalized  = nick.trim().to_lowercase()          (exact spelling is the key)
signing_key = ed25519 from blake3::derive_key("enigma/dht/nick-sign/v1", normalized)
enc_key     =              blake3::derive_key("enigma/dht/nick-enc/v1",  normalized)
salt        = b"enigma-nick-v1"
plaintext   = postcard{ v:1, node_id, name (display form, ≤64 chars), ts }
```

Unlike room keys, nickname keys are **static** — lookups must always land;
freshness comes from `ts` (claims older than the 2 h window are ignored) and
BEP44 expiry (~1–2 h), so **you are findable only while the app is publishing**.
Records are sealed with the nick-derived key: a DHT crawler can't harvest the
directory — you must already know the name you're searching.

**Claims, not identities.** A serverless namespace has no registry: anyone can
publish any name. Search results therefore list every fresh claimant with its
NodeId fingerprint, deduped per NodeId (freshest kept); verification is
out-of-band (compare codes) and the direct-invite handshake authenticates the
NodeId cryptographically anyway. Known limitation: colliding claimants race on
BEP44 `seq` per storage node, so a heavily-squatted name may shadow some
claimants — an accepted property of the honest-claims model.

### Presence (Contacts)

iroh's `DhtAddressLookup` already publishes every enabled node's pkarr record
under its own public key (= NodeId) with iroh's default ~1 h republish. So
presence needs no record type of ours: fetch the most recent mutable item for
the contact's NodeId and compare its timestamp against ~2× the republish
window ⇒ "recently online" (honest granularity: ~1 hour). Presence is only
meaningful between peers who both enabled the toggle.

### Cadences — all user-settable, never hardcoded (see `CONVENTIONS.md` §3)

| kv `p2p:settings` key | default | clamp | consumer |
| --- | --- | --- | --- |
| `dht_discovery` ("on"/"off") | off | — | endpoint build + all DHT paths |
| `dht_room_publish_secs` | 600 | 60–3600 | room publisher loop (±20 % jitter; skips a round when ≥5 fresh third-party records are visible) |
| `dht_presence_poll_secs` | 300 | 60–3600 | Contacts presence poll (frontend `setInterval`) |

### Failure modes

- **Toggle off** → no mainline socket, no publisher tasks, builder chain
  identical to today.
- **DHT unreachable / UDP blocked** → iroh races all address lookups in
  parallel (`AddressLookupServices`), so NodeId dials silently fall back to n0
  DNS/relay; ticket joins are unaffected; join-by-code surfaces the existing
  connect-timeout UX (`chat.joinTimeout`, window ≤ 2×N). A `dht_status`
  command (`{ enabled, bootstrapped }`) feeds status lines in Settings and
  Contacts.
- **Vault locked / setting unreadable from Rust** → treated as off for that
  bind.
- **Android**: one extra UDP socket, client mode only (never `server_mode()`);
  the room publisher runs only while a room is open; presence polling lives in
  the webview and suspends with it.

### Toggle plumbing

The setting lives in the same encrypted kv the frontend writes
(`p2p:settings/dht_discovery`); Rust reads it directly from protasius at
`ensure_started` time via a non-command `vault::kv_get_raw` helper — one source
of truth, no flag-threading through every `realtime_*` command. The endpoint is
built once, so flipping the toggle invokes `dht_apply` → existing
`p2p_iroh::shutdown` (same pattern as the airplane-mode switch); the next
realtime command lazily re-binds with the new setting.

---

## Threat notes

- **The room code is a bearer credential.** Any holder can connect at the
  transport level *and* will be auto-admitted by the current MLS flow — the
  exact trust model of a leaked QR ticket today, minus the address-staleness
  expiry a ticket has. Future work: an admission-approval UI before
  `addMember`.
- **Rendezvous linkability** is bounded by the hourly key rotation: a DHT
  observer who does not hold the secret sees opaque signed blobs under a key
  that changes every hour and cannot correlate members across buckets from the
  records alone (their transport addresses are, as always on a DHT, visible to
  the nodes they talk to).
- **Publishing your NodeId record** (`DhtAddressLookup`) announces "this
  NodeId is online" to anyone who knows the NodeId. The default `AddrFilter`
  publishes relay addresses only (not direct IPs). This is the presence
  feature's data source — and the privacy cost of enabling the toggle.
- **Topic collision on `blake3(name)`** is unchanged from today: a stranger
  who guesses a room *name* can subscribe to the topic but sees only MLS
  ciphertext and is never admitted; the room *code*'s secret is unguessable.
- **Relays remain** in the path for NAT traversal (decision 2); relay
  operators see ciphertext QUIC, as today.

## Implementation map

| Piece | Where |
| --- | --- |
| Rendezvous + presence engine (derivations, record codec, publisher, resolver) | `apps/enigma/src-tauri/src/p2p_dht.rs` (new) |
| Endpoint wiring (`DhtAddressLookup`), room code, join-by-code, publisher lifecycle | `apps/enigma/src-tauri/src/p2p_iroh.rs` |
| Command routing (`realtime_join_room` third arm) + `dht_*` commands | `apps/enigma/src-tauri/src/realtime.rs`, registered in `lib.rs` |
| Raw kv read for Rust-side settings | `apps/enigma/src-tauri/src/vault.rs` (`kv_get_raw`) |
| Settings getters/setters (defaults + clamps) | `packages/rakotis/src/services/appStorage.ts` |
| Contacts store (kv ns `contacts`) | `packages/rakotis/src/services/contacts.ts` (new) |
| Settings toggle + cadence fields + status | `apps/enigma/src/views/EnigmaConfigView.vue` |
| Contacts tab | `apps/enigma/src/views/EnigmaContactsView.vue` (new) + router + `App.vue` nav |
| Direct room invites (offer/accept over a dedicated ALPN on the main endpoint; the payload carries a fresh ticket + the DHT room code) | `apps/enigma/src-tauri/src/p2p_invite.rs` + `useRoomInvites.ts` |

New crates: `mainline = "6"` (async), `chacha20poly1305 = "0.10"`; iroh gains
feature `address-lookup-pkarr-dht`. Known cost when enabled: two mainline UDP
sockets (iroh's internal lookup node + our `AsyncDht`) — acceptable; revisit if
iroh exposes its instance.

Deferred (future work): deterministic pairwise DM rooms from Contacts;
admission-approval UI; consolidating the two mainline sockets.
