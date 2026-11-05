# Pharos protocol, version 1

What two Enigma say to each other and to Proteus. The reference is the code:
`crates/pharos-wire`, `pharos-seal`, `pharos-rendezvous`, `pharos-id`,
`pharos-node`, and `proteus/src/api.rs`. Test vectors are in
`pharos-rendezvous` (`test_vectors`).

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
           key_package: Vec<u8> (MLS KeyPackage message), proteus: Option<String> (onion),
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
package, and sends the welcome. If the card names a Proteus, the reply is
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
Body = Text(String) | Ack(Vec<[u8; 16]>) | Mls(Vec<u8>) | Ping
```

Text is trimmed, 1–1000 Unicode scalar values; refused on decode otherwise.

**Padding**, before encryption: `len: u32 BE ‖ bytes ‖ zeros` to 512, 2048 or
8192 bytes, or a multiple of 32768 beyond; non-zero padding is refused.

**Sealing**: an MLS application message in the friendship's group (ciphersuite MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519, OpenMLS 0.7).

**Frames** on a stream: `len: u32 BE ‖ bytes`, at most 65536 bytes.

**Direct session**: the dialer connects to the friend's rendezvous onion and
sends frames. For each frame that opens to a Text, the host answers with one
frame: a sealed `Ack([id])`. A frame that does not open ends the session. An
idle session closes after 120 s.

## 5. Proteus (M3, D5)

HTTP/1.1 over its onion. Ids and tokens are lower-case hex; a token goes in
`Authorization: Bearer`.

| Method and path | Auth | Body → answer |
|---|---|---|
| `GET /v1/health` | – | `{"ok":true,"service":"proteus","version":…}` |
| `PUT /v1/mailbox/{id}` | token | sealed message → 201 `{"seq":n}`; the first PUT sets the token |
| `GET /v1/mailbox/{id}?after=n` | token | → `{"messages":[{"seq":n,"blob":base64}]}`, ≤ 100 |
| `POST /v1/mailbox/{id}/ack?upto=n` | token | → `{"removed":k}` |
| `PUT /v1/record/{id}` | token | sealed record → 204; the first PUT sets the token |
| `GET /v1/record/{id}` | – | → the record, or 404 |
| `PUT /v1/pairing/{token}` | – | reply → 201, or 409 if used |
| `GET /v1/pairing/{token}` | – | → the reply once, then 404 |

Errors: 400 bad id, 401 no token, 403 wrong token, 404, 409, 413 too large,
429 rate limited, 507 full. Defaults: messages ≤ 40 KiB, 500 per mailbox,
kept 14 days; records ≤ 2 KiB, 15 days; pairing replies ≤ 48 KiB, 7 days; 60
requests per minute per id.

A sender leaves messages for friend `F` in the mailbox `mailbox id(F)` on F's
Proteus; F fetches it, opens each blob as a friendship message, acknowledges
to Proteus up to the last seq, and owes the sender an `Ack`.

**Its page and its code.** On its onion, outside `/v1/`, Proteus serves a
static page for people (no JavaScript, no SVG, `Content-Security-Policy:
default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`): `/` in
English, `/pl` in Polish, `/proteus-qr.png` (the code as a QR image) and
`/proteus.txt` (the code as text). `proteus code` prints the same code and QR
in a terminal. The **Proteus code** is `pharos-proteus:` + base32 (no padding,
prefix and payload in any case) of the postcard encoding of

```
ProteusCode { v: u8 = 1, onion: [u8; 32] (the onion's ed25519 identity key), name: String (1–64 chars) }
```

The address is derived from `onion` (§3), so a code cannot carry a mistyped
one. Enigma also takes a bare v3 address; it checks its checksum and version.

**Directory record**: XChaCha20-Poly1305 under the directory key, associated
data `pharos/directory/v1`, nonce (24 bytes) ‖ ciphertext, of the JSON
`{"proteus": onion | null, "at": unix_seconds}`. The owner files it under
`directory id(owner, week)` and `week + 1` on its current and previous
Proteus addresses. A friend reads this week's, then last week's.
