# Pharos protocols

Two protocols live in this repository:

- **Part A — Enigma27's mesh**: what members of an Enigma27 room say to each
  other over Tor. The reference is the code: `apps/enigma/src-tauri/src/mesh.rs`
  (links, framing), `invite_ticket.rs` and `invite_redeem.rs` (invitations),
  `files.rs` (downloads), and `packages/rakotis/src/useChatChannel.ts` (the MLS
  messages inside the frames).
- **Part B — the friend protocol, version 1, which Beacon serves**: what the
  earlier Pharos friend client said to a friend and to Beacon. Enigma27 does not
  speak it; Beacon keeps it for a later room mailbox. The reference is
  `crates/pharos-wire`, `pharos-seal`, `pharos-rendezvous`, `pharos-id` and
  `beacon/src/api.rs`. Test vectors are in `pharos-rendezvous` (`test_vectors`).
  Its sections keep their numbers (§1–§5), as other documents link to them.
- **Part C — stage b2**: apps attach to one Beacon over a signed client link
  and only Beacons mesh. Part A's frames and invitations ride on it unchanged.

# Part A — Enigma27's mesh

## A1. Links

Every member hosts one onion service per room (arti, full vanguards; virtual
port `network.onion_port`, 9999, in `build_config.yaml`). The onion's key is
kept per profile under a nickname derived from the room name
(`enigma_` ‖ the first 16 hex digits of BLAKE3(name)), so the address is the
same every launch. A room's id (its *slug*) is BLAKE3(name) in hex.

A member keeps one link (a Tor stream) to every other member it knows of.
Both ends may dial; if two links to the same member exist, both keep the one
dialled by the smaller onion address (string order), and drop the other. A
dialler with no link retries after 5 s, doubling to at most 2 min. A frame for
a member with no link waits in that member's outbox (at most 256 frames, the
oldest dropped first) and goes, in order, when the link comes up. Nobody
forwards frames: each sender writes its frame down each of its own links.

## A2. Framing and handshake

A frame is `len: u32 little-endian ‖ UTF-8 JSON`, at most
`network.max_frame_bytes` (16 MiB); a larger length is refused before the body
is read. All members must agree on the cap.

The dialler sends one `Hello`; the host answers `Ready` and then routes the
stream by `kind`:

```
Hello { name: String (display name; rooms only, may be empty),
        peer_id: String (a random per-profile id),
        kind?: "room" | "redeem" | "file"   (absent = "room"),
        onion?: String (the dialler's own onion for this room; rooms only),
        device?: String (rooms: the dialler's device id = its MLS identity),
        ts?: u64 (rooms: unix seconds),
        sig?: String (rooms: hex Ed25519 by the device key over
                      "enigma27-link\0" ‖ host onion ‖ "\0" ‖ dialler onion ‖ "\0" ‖ ts) }
Ready { ok: bool }
```

- **`room`** — a member's link. `onion` is required; a Hello without it, or
  with the host's own, is dropped. The host answers `ok: false` and closes
  unless `sig` is good, `ts` is within 15 minutes of its clock, and `device`
  is in its MLS group for the room. From then on both ends write room frames
  (A3) in both directions.
- **`redeem`** — an invitation redemption (A4).
- **`file`** — one file download (A5).

The handshake read times out after `tor_handshake_timeout_secs` (30 s); each
write after `tor_write_timeout_secs` (20 s), and a failed write drops the link
and puts the frame back in the outbox.

## A3. Room frames

Each room frame is one JSON object with a `type`. The content of every
message is an MLS (RFC 9420) message in the room's group, ciphersuite
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (OpenMLS 0.7, pure-ciphertext
wire format), base64 in the JSON.

| `type` | Carries |
|---|---|
| `mls_app` | `ciphertext` (an MLS application message) and nothing else: sealed sender |
| `cover` | nothing: a dummy, sent in any cover slot without a real frame and dropped by the reader |
| `mls_commit` | `commit` (MLS commit) |
| `mls_welcome` | `welcome`, `target` |
| `mls_key_package` | `key_package`, `device_id`, `user` (refused by Enigma27: rooms admit only by invitation) |
| `mls_reset_request` | `device_id`, `reset_id`, `ts` (ms), `sig` (hex Ed25519 by `device_id` over `enigma27-reset\0` ‖ room ‖ `\0` ‖ reset_id ‖ `\0` ‖ ts); obeyed only from a current member, within 5 minutes |

Inside an `mls_app` ciphertext is JSON with its own `type`, a `msg_id` and
`from: {id, name}` (the sender, hidden from everyone outside the group): `text`
(`text`), `image_message` (a JPEG data URL), `voice_message` (WAV), `presence`
(`device_id`, `name`, `onion`, and `beacon` if the room has one — how members
learn each other's onions and the room's Beacon), `leave`, `room_closed` (sent
by the room's creator when it deletes the room), `file_offer` / `file_accept`
(A5). There are no pictures: each device draws a member's icon from the first
letter of their name.

**Padding.** Every frame is padded with trailing spaces (JSON ignores them) to
512 B, 2 KiB, 8 KiB, or the next multiple of 32 KiB, before it is written.

**Cover traffic.** While a room is open each link gets a frame every 30 s
(90 s on Android), ±20 %: a real one if one went out in that slot, otherwise
`{"type":"cover"}` padded to 512 B.

## A4. Invitations

An invitation is `base32-nopad-lowercase(0x4E ‖ 0x02 ‖ kind ‖ body)` (format 2; format 1 had no `beacon` and is refused):

```
kind 0x50 'P' → body = gervasius::seal_to(recipient_x25519, aad, postcard(InviteBody))
kind 0x47 'G' → body = postcard(InviteBody)          (a cleartext bearer code)
aad = [0x4E, 0x02, kind]

InviteBody { invite_id: [u8; 16], capability: [u8; 32],
             inviter: String (device id: Ed25519 public key, 64 hex digits),
             onion: String (the inviter's onion for the room; no IP),
             issued_at: u64, expires_at: u64 (Unix ms; advisory),
             beacon: Option<String> (the room's Beacon onion, if any) }
```

A personal invitation is sealed to the recipient's device id, through its
X25519 twin. The redeemer dials `onion` with `Hello{kind:"redeem"}`:

```
inviter  → redeemer : { v: 1, challenge: hex(32 random bytes) }
redeemer → inviter  : { v: 1, invite_id, node_id: device id, sig: Ed25519(device key, challenge),
                        proof: BLAKE3-keyed(capability, invite_id ‖ challenge ‖ node_id),
                        key_package: base64 MLS KeyPackage, name }
inviter  → redeemer : { v: 1, ok, code, welcome, room_name, peers: [every member's onion] }
```

The inviter checks the signature, the record's state and expiry (its own
clock), the recipient, and the proof, then adds the key package to the group
and answers. A refusal carries only a code (`INVITE_*`).

**Through Beacon** (when the inviter does not answer and the ticket names a
Beacon). With `m = capability ‖ invite_id`:

```
request mailbox : id = BLAKE3-derive("enigma27 invite drop request id", m),
                  token = BLAKE3-derive("enigma27 invite drop request token", m)
reply mailbox   : the same with "reply" and m ‖ node_id (one per redeemer)
seal            : XChaCha20-Poly1305, key = BLAKE3-derive("enigma27 invite drop key", m),
                  aad = "request" | "reply"; base64(nonce24 ‖ ciphertext)
redeemer → request mailbox : seal({ challenge: hex(32 random bytes, chosen by the redeemer),
                                    req: the request frame above })
inviter  → reply mailbox   : seal(the reply frame above)
```

The inviter's phone reads the request mailboxes of its open invitations every
45–65 s and decides exactly as for a live redemption; the redeemer reads its
reply mailbox every 20 s for up to 30 minutes.

## A4b. Room mailboxes on Beacon

A room with a Beacon also posts every frame (except `cover`) to its mailbox,
with Beacon's mailbox API (Part B §5). For week `w = ⌊unix seconds / 604800⌋`:

```
secret = MLS exporter(label "enigma27/beacon/mailbox", context = w as u64 big-endian, 32 bytes)
id     = hex(BLAKE3-derive("enigma27 beacon mailbox id", secret))
token  = hex(BLAKE3-derive("enigma27 beacon mailbox token", secret))
```

The body is the frame's JSON text, nothing else. The id moves with every
epoch and every week; readers read this week's and last week's mailbox at
exponentially distributed times around 30 s, half of the time together with a
read of a random id. Every request uses a fresh Tor circuit. A frame already
seen (sent by us, or received over the mesh) is skipped.

## A5. Files

The offer and the answer travel as MLS messages in the room; only the bytes
use the stream. The receiver makes a random 32-byte secret and sends
`file_accept { offerId, commitment: BLAKE3(secret) }`. It then dials the
sender's onion with `Hello{kind:"file"}` and sends `{ offer_id, secret }`. If
BLAKE3(secret) matches, the sender clears the authorisation (one download per
acceptance), answers `{ ok, code, size, hash: BLAKE3 of the file }` and streams
the raw bytes; the receiver keeps the file only if size and hash match. The
bytes are protected by Tor's end-to-end onion encryption, not by MLS.

# Part B — the friend protocol (Beacon's)

What two friend clients said to each other and to Beacon.

## 1. Identity

- **Device key**: Ed25519. **Fingerprint**: the first 16 bytes of SHA-256 over
  the 32-byte public key. Shown as the first 24 base32 characters in six
  groups of four. The MLS identity is the fingerprint in lower-case hex.

## 2. Pairing (D1)

**Card** (`pharos-card:` + base32, no padding, case and whitespace ignored, of
the postcard encoding of):

```
ContactCard { body: CardBody, sig: [u8; 64] }
CardBody { v: u8 = 1, name: String (1–64 chars), device: [u8; 32],
           key_package: Vec<u8> (MLS KeyPackage message), beacon: Option<String> (onion),
           pairing_token: [u8; 16], issued_secs: u64 }
```

`sig` is Ed25519 by `device` over postcard(`body`). A card is refused if older
than 7 days or more than an hour in the future.

**Reply** (`pharos-reply:` + base32 of postcard):

```
PairReply { body: ReplyBody, sig: [u8; 64] }
ReplyBody { card: ContactCard (the scanner's; key_package empty, token zero),
            to_fingerprint: [u8; 16], welcome: Vec<u8> (MLS Welcome) }
```

`sig` is by `body.card.body.device` over postcard(`body`); `to_fingerprint`
must be the receiver's. The scanner creates an MLS group, adds the card's key
package, and sends the welcome. If the card names a Beacon, the reply is
`PUT /v1/pairing/{hex(pairing_token)}` there; otherwise it is shown.

**Friendship secret**: right after the group is formed, both take the MLS
exporter secret with label `pharos/friendship/v1`, empty context, 32 bytes,
and keep it for the friendship's life.

## 3. Derivations (D2)

HKDF-SHA256, salt `pharos/rendezvous/v1`, IKM the friendship secret, `info` the
concatenation below (`fp` 16 bytes; `week` u64 big-endian; `week =
floor(unix_seconds / 604800)`):

| Output | info | Length |
|---|---|---|
| rendezvous seed of host `fp` | `onion` ‖ fp ‖ week | 32 |
| mailbox id of owner `fp` | `mailbox-id` ‖ fp | 32 |
| mailbox token | `mailbox-token` ‖ fp | 32 |
| directory id | `directory-id` ‖ fp ‖ week | 32 |
| directory key | `directory-key` ‖ fp | 32 |
| directory token | `directory-token` ‖ fp | 32 |

The rendezvous seed is an Ed25519 secret key. Its onion is the Tor v3 address
of its public key: base32(pk ‖ SHA3-256(".onion checksum" ‖ pk ‖ 0x03)[..2] ‖
0x03), lower case, `.onion`. The host serves it on virtual port 80. A dialer
tries this week, then last week, then next week.

## 4. Messages

**Envelope** (postcard):

```
Envelope { v: u8 = 1, id: [u8; 16] (random), sent_ms: u64, body: Body }
Body = Text(String) | Ack(Vec<[u8; 16]>) | Mls(Vec<u8>) | Ping | Image { mime: String, data: Vec<u8> }
```

Text is trimmed, 1–1000 Unicode scalar values; refused on decode otherwise.
An image is WebP, JPEG or PNG (its first bytes must match its `mime`), at most
192 KiB, sent whole in one message; anything else is refused on decode.

**Padding**, before encryption: `len: u32 BE ‖ bytes ‖ zeros` to 512, 2048 or
8192 bytes, or a multiple of 32768 beyond; non-zero padding is refused.

**Sealing**: an MLS application message in the friendship's group (ciphersuite MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519, OpenMLS 0.7).

**Frames** on a stream: `len: u32 BE ‖ bytes`, at most 262144 bytes (room for a sealed image).

**Direct session**: the dialer connects to the friend's rendezvous onion and
sends frames. For each frame that opens to a Text, the host answers with one
frame: a sealed `Ack([id])`. A frame that does not open ends the session. An
idle session closes after 120 s.

## 5. Beacon (M3, D5)

HTTP/1.1 over its onion. Ids and tokens are lower-case hex; a token goes in
`Authorization: Bearer`.

| Method and path | Auth | Body → answer |
|---|---|---|
| `GET /v1/health` | – | `{"ok":true,"service":"beacon","version":…}` |
| `PUT /v1/mailbox/{id}` | token | sealed message → 201 `{"seq":n}`; the first PUT sets the token |
| `GET /v1/mailbox/{id}?after=n` | token | → `{"messages":[{"seq":n,"blob":base64}]}`, ≤ 100 |
| `POST /v1/mailbox/{id}/ack?upto=n` | token | → `{"removed":k}` |
| `PUT /v1/record/{id}` | token | sealed record → 204; the first PUT sets the token |
| `GET /v1/record/{id}` | – | → the record, or 404 |
| `PUT /v1/pairing/{token}` | – | reply → 201, or 409 if used |
| `GET /v1/pairing/{token}` | – | → the reply once, then 404 |

Errors: 400 bad id, 401 no token, 403 wrong token, 404, 409, 413 too large,
429 rate limited, 507 full. Defaults: messages ≤ 256 KiB, 2000 and 32 MiB per mailbox,
kept 14 days; records ≤ 2 KiB, 15 days; pairing replies ≤ 48 KiB, 7 days; 60
requests per minute per id.

A sender leaves messages for friend `F` in the mailbox `mailbox id(F)` on F's
Beacon; F fetches it, opens each blob as a friendship message, acknowledges
to Beacon up to the last seq, and owes the sender an `Ack`.

**Its page and its code.** On its onion, outside `/v1/`, Beacon serves a
static page for people (no JavaScript, no SVG, `Content-Security-Policy:
default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`): `/` in
English, `/pl` in Polish, `/beacon-qr.png` (the code as a QR image) and
`/beacon.txt` (the code as text). `beacon code` prints the same code and QR
in a terminal. The **Beacon code** is `pharos-beacon:` + base32 (no padding,
prefix and payload in any case) of the postcard encoding of

```
BeaconCode { v: u8 = 1, onion: [u8; 32] (the onion's ed25519 identity key), name: String (1–64 chars) }
```

The address is derived from `onion` (§3), so a code cannot carry a mistyped
one. Enigma also takes a bare v3 address; it checks its checksum and version.

**Directory record**: XChaCha20-Poly1305 under the directory key, associated
data `pharos/directory/v1`, nonce (24 bytes) ‖ ciphertext, of the JSON
`{"beacon": onion | null, "at": unix_seconds}`. The owner files it under
`directory id(owner, week)` and `week + 1` on its current and previous
Beacon addresses. A friend reads this week's, then last week's.

# Part C — Stage b2: apps attach to a Beacon, Beacons mesh

From stage b2 apps no longer mesh. Each device attaches to **one** Beacon (its
own, or a friend's) over a *client link*; per room, only Beacons keep links to
each other (the *Beacon mesh*). MLS stays on the devices: every frame a Beacon
carries is the same sealed room frame as in A3. The reference is the code:
`crates/beacon-node/src/proto.rs` (hellos, ops), `relay.rs` (the Beacon side),
`queue.rs` (what it keeps), `link.rs` (streams), `crates/enigma-client` (the
device side), `beacon/src/lib.rs` (`route_conn`) and `beacon/src/relay_store.rs`.

## C1. Where links arrive

Client links and Beacon links go to the Beacon's existing onion, on the same
virtual port as its HTTP API (80). A Beacon reads the first 4 bytes of every
stream: a link starts with a frame length (A2: u32 little-endian, at most
16 MiB, so the fourth byte is `0x00`); HTTP starts with an ASCII method
(`GET `, `PUT `, `POST`), whose fourth byte never is. Links go to the relay,
everything else to the HTTP API (Part B §5 and A4b, unchanged). A Beacon run by
an app in the same process ("Enable Beacon") is attached to without Tor,
through an in-process pipe, with the same bytes.

Framing, padding (512 B / 2 KiB / 8 KiB / 32 KiB multiples) and cover (a frame
per slot of 30 s ±20 %) are as in A2/A3, on both kinds of link. Cover is
`{"op":"cover"}` on a client link and `{"type":"cover"}` on a Beacon link.

## C2. Route ids

A Beacon knows a room only by its **route id**:

```
route = hex(BLAKE3-derive_key("enigma27 b2 room route v1", slug))      slug as in A1
```

Every member derives it from the slug, so they agree; the slug (and so the
room's name) never reaches a Beacon.

## C3. Client link

```
device → Beacon : { "kind": "client", "device": 64-hex Ed25519 id,
                    "ts": unix seconds,
                    "sig": hex Ed25519 by the device over
                           "enigma27-client\0" ‖ beacon onion ‖ "\0" ‖ ts }
Beacon → device : { "ok": bool }                               (A2's Ready)
```

The Beacon answers `ok:false` and closes unless the signature is good for *its
own* onion and `ts` is within 15 minutes of its clock (and fewer than
`relay.max_clients` devices are attached). A second link of the same device
replaces the first. Then both sides write JSON ops:

| client → Beacon | |
|---|---|
| `{op:"join", room, peers:[onion]}` | be a member of `room` here; `peers` are the Beacons of the room's other members (replaces the last list; the Beacon's own onion is dropped). Delivers what was kept, then live. Idempotent. |
| `{op:"close", room}` | stop live delivery on this link (the room is not open on the device); still a member, frames are kept |
| `{op:"leave", room}` | no longer a member here: the queue is dropped (the room was deleted) |
| `{op:"send", room, frame, n}` | a sealed frame; answered `{op:"sent", n}` (or `refused`) |
| `{op:"ack", room, upto}` | frames up to `upto` arrived: the Beacon drops them |
| `{op:"redeem", id, inviter_device, home, payload, n}` | C6 |
| `{op:"redeem_answer", id, payload, n}` | C6 |

| Beacon → client | |
|---|---|
| `{op:"frame", room, seq, frame}` | a frame; `seq` grows per (device, room) |
| `{op:"status", room, linked:[onion], local}` | the room's Beacon links now, and how many other clients of this Beacon are in it and online |
| `{op:"sent", n}` / `{op:"refused", n, why}` | the op `n` was taken / refused |
| `{op:"redeem", id, from, home, payload}`, `{op:"redeem_answer", id, payload}` | C6 |

The device keeps every op with an `n` until it is answered and sends it again
after a reconnect (the Beacon drops a frame it has seen, C5); it ignores a
`frame` whose `seq` it already had, and acks every frame. It redials with
backoff (5 s doubling to 2 min) and on every new link re-sends `join` for its
open rooms.

## C4. Beacon mesh

Per room a Beacon keeps one link to every Beacon listed in its clients' `peers`
for that room, and none to any other:

```
Beacon → Beacon : { "kind": "beacon", "onion": dialler onion, "node": 64-hex Ed25519 node key,
                    "room": route, "ts": unix seconds,
                    "sig": hex Ed25519 by the node key over
                           "enigma27-beacon\0" ‖ listener onion ‖ "\0" ‖ dialler onion ‖ "\0" ‖ room ‖ "\0" ‖ ts }
listener        : { "ok": bool }
```

The listener refuses unless the signature and time are good, **one of its own
clients in `room` listed `onion`**, and the node key is the one it first saw
for that onion (pinned on first use). The node key is the Beacon's own (32
random bytes, sealed with its master key in `node.key`). Both ends may dial;
both keep the link dialled by the smaller onion (as A1). Redial: 5 s doubling
to 2 min. A frame for a listed Beacon with no link waits in its outbox (256
frames, oldest dropped first). On a Beacon link each frame is a room frame (A3).

A Beacon must accept the newcomer's Beacon before any frame of the newcomer
(its presence) can arrive, so the inviter's device lists the newcomer's Beacon
at admission (`home` in C6; `Engine::admit_invited_via`).

## C5. Routing and queues

- A frame from a client goes to every other member of the room on this Beacon
  and down every Beacon link of the room (or into its outbox).
- A frame from a Beacon goes to members on this Beacon only: nothing is
  forwarded twice, so there are no loops, whatever the shape of the mesh.
- A frame already seen in the room is dropped (BLAKE3 of the frame, the last
  4096 per room).
- For every member (device, room) the Beacon keeps each frame until it is
  acked: at most 2000 frames / 32 MiB (oldest dropped first) for 14 days
  (`relay.*` in `config.yaml`). Memberships, queues, held messages, routes and
  pins are in `relay.sqlite`, under keyed hashes and sealed with the master
  key like the mailbox store; memberships survive a restart and are re-dialled.
  The mailbox API of A4b / Part B is unchanged beside it.

## C6. Invitations through the inviter's Beacon

The invitation's `onion` (A4) is now the inviter's home Beacon. The redeemer
attaches to that Beacon as a client (its own home link if it is the same
Beacon, else a link of its own, kept until the answer comes, up to 30 minutes)
and sends `{op:"redeem", id, inviter_device, home, payload, n}`: `id` is 16–64
hex digits it chose, `home` its own home Beacon, `payload` opaque to the
Beacon. The Beacon remembers `id → (redeemer, inviter)` for a day and hands
`{op:"redeem", id, from, home, payload}` to the inviter's device, now or when it
next attaches (`from` is the redeemer's id from its signed hello). Only the
inviter may answer: `{op:"redeem_answer", id, payload, n}` goes to the
redeemer, now or when it next attaches. The payloads carry A4's request and
reply frames (the redeemer chooses the challenge, as for a drop, and may seal
them with the drop key); every check of A4 (signature, capability proof, key
package identity, state, expiry) stays between the two devices. The inviter
lists `home` for the room at admission (C4).

## C7. Presence

A member's `onion` in presence (A3) is now its home Beacon's onion: the
transport's `create_room` / `join_room` return it, and `set_peers` hands the
other members' Beacons to the client link as the room's `peers`. Members on the
same Beacon share an onion; the roster shows them linked while the Beacon
reports other local members online (`local > 0`).
