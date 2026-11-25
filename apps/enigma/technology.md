# Enigma27 — Technology Overview

> **Since 2026-11-22/23 this app lives in Pharos** at `apps/enigma/`. It came from
> technolog-spectrumai/enigma, branch `dev_mvp1` ("Enigma26"), and was copied, not
> vendored: Pharos owns the code. The shared crates are the repo root's `crates/`
> (`rotor/rotor_core`, `gervasius`, `protasius`, `enigmatite`); the build is Dromon's:
> `./build.sh enigma`, from `apps/enigma/dromon.yaml`. Older history (Belisario,
> Rutile) is kept short in [§16](#16-history--the-serverless-rework); where a passage
> below still says `rutile/`, read the repo root.

A technical deep-dive into how Enigma27 works: its design, stack, dependencies,
communication flow, cryptography, privacy posture, and known weaknesses — plus the
project's conventions, config sources of truth and rework history, and how to run,
build, test, release and install it. Who learns what is also in the root
[SECURITY.md](../../SECURITY.md); the wire format in [PROTOCOL.md](../../PROTOCOL.md),
Part A.

> **Status:** early-stage (`v0.1.10`). The cryptography is production-grade (OpenMLS),
> but several integration-level hardening items remain open — see
> [Security & privacy considerations](#9-security--privacy-considerations), the root
> [todo.md](../../todo.md) Stage 7 and the [Roadmap](#roadmap). This document is
> candid about them on purpose.

Contents: [1 Design](#1-design) · [2 Stack](#2-technology-stack) ·
[3 Dependencies](#3-dependencies--libraries) · [4 Architecture & flow](#4-architecture--communication-flow) ·
[5 Routing & transport](#5-routing--transport) · [6 Is it truly P2P?](#6-is-it-truly-p2p-intermittent-nodes) ·
[7 Encryption](#7-encryption--algorithms) · [8 Privacy](#8-privacy) ·
[9 Security considerations](#9-security--privacy-considerations) · [10 UI](#10-user-interface) ·
[11 The Tor mesh and vanguards](#11-the-tor-mesh-and-vanguards) ·
[12 How Enigma keeps and encrypts messages](#12-how-enigma-keeps-and-encrypts-messages) ·
[13 Encryption at rest](#13-encryption-at-rest-gervasius--protasius) ·
[14 Conventions](#14-conventions-naming--palette) · [15 Config sources](#15-config--sources-of-truth) ·
[16 Rework history](#16-history--the-serverless-rework) ·
[18 Invitations](#18-invitations--encrypted-expiring-revocable) ·
[19 Run, build, test](#19-run-build-and-test) · [20 Features and presets](#20-features-and-presets) ·
[21 Releasing](#21-releasing) · [22 Installing](#22-installing) ·
[23 App icon](#23-app-icon) · [24 Crypto audit inventory](#24-crypto-audit-inventory) ·
[Roadmap](#roadmap)

---

## 1. Design

Enigma27 is a **serverless, end-to-end-encrypted group chat that always runs over
Tor**, packaged as a [Tauri 2](https://tauri.app) desktop/mobile app (Vue 3 frontend +
Rust backend).

Design principles:

- **No app server.** There is no relay, no REST gateway, no login, no server-side
  directory. The Rust core makes no outbound HTTP request of any kind; the one
  network fetch left anywhere in the app is the Google Fonts `<link>` in
  `index.html`, which the webview attempts on load and which is queued for
  self-hosting ([§15](#15-config--sources-of-truth), palette note). It does rely on
  the Tor network ([§6](#6-is-it-truly-p2p-intermittent-nodes)).
- **Always Tor, a mesh.** Every member of a room hosts its own onion service for it
  and keeps a link to every other member. Frames go straight down each link; nobody
  forwards anyone else's traffic. There is no direct (non-Tor) connection, no
  captain and no relaying member ([§11](#11-the-tor-mesh-and-vanguards)).
- **In by invitation only.** An invitation (QR or text) is redeemed against the
  inviter's onion while it is online; it is sealed to one device or is a bearer
  code, expires on the inviter's clock, can be revoked, and is spent once
  ([§18](#18-invitations--encrypted-expiring-revocable)).
- **Reconnect without a new QR.** Members announce their onions inside the
  encrypted presence message; each device keeps the list per room, and the onions
  are stable, so a reopened room links to the others again.
- **End-to-end encryption by default.** All message content is encrypted with **MLS**
  (RFC 9420) via OpenMLS. Nothing is ever sent or shown in plaintext
  ([§12](#12-how-enigma-keeps-and-encrypts-messages)).
- **Encrypted at rest.** All persisted app state — keys, MLS sessions, history,
  settings, saved rooms, Tor's own state — lives in a per-profile passphrase-gated
  encrypted store ([§13](#13-encryption-at-rest-gervasius--protasius)).
- **Local-first identity.** Identity is a locally stored profile — no accounts, no
  PKI, no phone number. `APP_PROFILE` isolates storage; `CHAT_USER` sets the MLS
  identity (the profile name by default), so several instances can run side by
  side. Each profile also has a device key (Ed25519, `device.rs`) that invitations
  are sealed to and redeemed with.
- **Compile-time build policy.** A build config
  ([§15](#15-config--sources-of-truth), [§19](#19-run-build-and-test)) bakes in the
  crypto declarations, protocol constants, setting defaults and clamps.

### Layered architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/enigma/src  (Vue 3 UI: Chat · Files · Settings;              │
│                    invitation create/scan; unlock gate)            │
├──────────────────────────────────────────────────────────────────┤
│  packages/rakotis (TS)                                             │
│   • useChatChannel — MLS envelope state machine / orchestration    │
│   • chatTransport  — bridge to the Rust mesh (realtime_* / events) │
│   • crypto         — bridge to the mls_* Tauri commands            │
│   • services       — appStorage (settings/build config),           │
│                      localDb (kv), chatLog (history), i18n         │
├──────────────────────────────────────────────────────────────────┤
│  Tauri IPC  (invoke commands + realtime://* file://* invite://* …) │
├──────────────────────────────────────────────────────────────────┤
│  apps/enigma/src-tauri  (Rust)                                     │
│   • mesh.rs       — the Tor mesh: onions, links, outbox (§11)      │
│   • realtime.rs   — realtime_* commands over the mesh              │
│   • invite_*.rs   — invitations: tickets, redemption (§18)         │
│   • device.rs     — the device key (Ed25519)                       │
│   • files.rs      — file downloads over the sender's onion         │
│   • vault.rs      — protasius integration (encrypted store, §13)   │
│   • lib.rs        — mls_* commands, profiles, build_config, audio  │
├───────────────┬───────────────────┬──────────────────────────────┤
│ rotor_core    │ protasius         │ arti 0.43 (embedded Tor,      │
│ (OpenMLS),    │ (encrypted store) │ onion services, full          │
│ enigmatite    │ gervasius (crypto │ vanguards)                    │
│ (sessions)    │ primitives)       │                               │
└───────────────┴───────────────────┴──────────────────────────────┘
```

The Vue shell is deliberately thin; nearly all chat/identity logic lives in the
in-repo package **rakotis**, which is aliased to source (`vite.config.ts`) and
compiled as app code (no prebuild step). Crypto is delegated entirely to the Rust
`mls_*` commands backed by `rotor_core` — never reimplemented in TypeScript.

---

## 2. Technology stack

| Layer | Technology |
|---|---|
| UI framework | Vue 3 (Composition API, `<script setup>`), Tailwind CSS v4, Font Awesome |
| Desktop/mobile shell | Tauri 2 (Rust core + system WebView; Linux/Windows/macOS/Android) |
| App language (frontend) | TypeScript (ES2020, `strict`) built with Vite |
| App language (backend) | Rust (edition 2021), Tokio async runtime |
| Transport | arti 0.43 (embedded Tor): a mesh of onion services, one per member per room, with full vanguards ([§11](#11-the-tor-mesh-and-vanguards)). Nothing else |
| Cryptography (content) | OpenMLS 0.7 (RFC 9420 MLS) via the `rotor_core` crate; sessions per (room, identity) in `enigmatite` |
| Cryptography (at rest) | `gervasius` (Argon2id → wrapped DEK → XChaCha20-Poly1305) + `protasius` (per-profile encrypted fjall store) ([§13](#13-encryption-at-rest-gervasius--protasius)) |
| Local storage | protasius (encrypted fjall LSM keyspace) per profile; OS app-data dir |
| Media capture | cpal (microphone) + hound (WAV) for native voice notes |
| Room invites | Invitations only ([§18](#18-invitations--encrypted-expiring-revocable)): sealed or bearer, expiring QR codes, redeemed against the inviter's onion while it is online. No mailbox and no store-and-forward |
| Build config | `src-tauri/build_config.yaml` → build.rs codegen ([§15](#15-config--sources-of-truth), [§19](#19-run-build-and-test)) |
| Build/CI | `./build.sh enigma`, configured by [dromon.yaml](dromon.yaml) (one variant); GitHub Actions (`.github/workflows/`); Node 22 |

Rust backend crate: `enigma` → `enigma_lib` (`staticlib`/`cdylib`/`rlib`). Bundle
identifier `com.spectrumaipl.enigma27`. The tauri.conf `bundle.targets` list governs
which desktop formats a build emits — currently `["deb", "rpm"]`, out of the Linux
set Tauri can produce (`.deb`/`.AppImage`/`.rpm`); Android APK/AAB are produced
by `tools/android/build_android.sh` ([§19](#19-run-build-and-test)).

---

## 3. Dependencies & libraries

Versions are the declared spec; resolved pins are in the repo root's `Cargo.lock`.

### Rust backend (`apps/enigma/src-tauri/Cargo.toml`)

| Crate | Ver | Role |
|---|---|---|
| `tauri` (+ `tauri-plugin-opener`/`-dialog`/`-notification`/`-deep-link`) | 2 | App framework, IPC, bundler, OS integration |
| `rotor-core` | path | MLS crypto engine (`crates/rotor/rotor_core`) |
| `enigmatite` | path | MLS sessions per (room, identity), kept in the vault; key-package admission (`crates/enigmatite`) |
| `protasius` | path | Per-profile encrypted store (vault lifecycle + sealed kv) |
| `gervasius` | path | At-rest crypto primitives (also used directly by `vault.rs` for the PIN and panic envelopes, and for sealing personal invitations) |
| `arti-client` | 0.43 | Embedded Tor: `onion-service-service` to host each room's onion, `onion-service-client` to dial members, `vanguards` |
| `tor-guardmgr`, `tor-config` | 0.43 | Setting the vanguard mode to full explicitly |
| `tor-hsservice`, `tor-cell`, `tor-rtcompat`, `safelog` | 0.43 / 0.8 | Onion-service hosting types (launch/config, accept a rendezvous request, unredacted `.onion` display) |
| `ed25519-dalek` | 3 | The device key (`device.rs`) |
| `postcard` | 1 | Invitations, archives of arti's state |
| `blake3` | 1 | Room slug and onion nickname from the room name; file hash; the download commitment; the redemption proof |
| `data-encoding` | 2 | BASE32 (no-pad) invitation text |
| `futures-lite`, `anyhow`, `uuid` | — | Stream plumbing, errors, ids |
| `tokio` | 1 | Async runtime |
| `cpal` | 0.15 | Microphone capture (native voice notes) |
| `hound` | 3 | WAV encoding of recordings |
| `chacha20poly1305` | 0.10 | Its `rand_core` re-export (`OsRng`) for invitation and download secrets |
| `zeroize` | 1 | Wipe plaintext/state buffers in RAM |
| `serde`/`serde_json` | — | Serialization |
| `typed-index-collections` | =3.3.0 | MSRV pin (arti transitively pulls it; 3.4+ needs rustc 1.90) |
| `webkit2gtk` (Linux), `rusqlite` bundled (Android) | — | Platform-specific glue |

Build-dependencies: `tauri-build`, plus `serde`/`serde_norway`/`serde_json` for the
compile-time `build_config.yaml` codegen ([§19](#19-run-build-and-test)).

### Crypto crates (`crates/`)

- **`rotor/rotor_core`** — the MLS engine (`RotorSession`). `openmls =0.7.4`,
  `openmls_rust_crypto =0.4.4`, `openmls_basic_credential =0.4.1`,
  `openmls_traits =0.4.1`, `tls_codec 0.4`, `zeroize`. Exports the compiled
  ciphersuite (`CIPHERSUITE`/`CIPHERSUITE_NAME`) for the build-config assert.
- **`gervasius`** — at-rest primitives: `argon2` 0.5 (Argon2id), `chacha20poly1305`
  0.10 (XChaCha20-Poly1305), sealing to an X25519 key, `rand_core`, `zeroize`.
- **`protasius`** — the encrypted store built on gervasius (`fjall` 2, `serde`,
  `zeroize`); Tauri-agnostic — `vault.rs` wires the commands.
- **`enigmatite`** — `mls` (one rotor session per (room, identity), saved after every
  step) and `admission` (a key package's proof by a device key, for rooms that admit
  by a certified roster; unused by Enigma27's own rooms).

### Frontend (`apps/enigma/package.json` + `packages/rakotis`)

**Used at runtime:** `vue` 3.5, `vue-router` 5 (`createMemoryHistory`), `pinia`,
`vue-i18n` 9 (en/pl), `tailwindcss` 4, `@fortawesome/*`, `@tauri-apps/api` 2,
`qrcode` (generate invitation QR), `html5-qrcode` (scan), `nanoid` (message ids),
and the in-repo `rakotis` and `petalite` workspace packages.

---

## 4. Architecture & communication flow

### The seams

The frontend talks to Rust through two mechanisms, both guarded by an `isTauri()`
runtime check (in a plain browser there is no backend — chat is inert by design):

- **`invoke` (commands):** `realtime_*` (the mesh: create, join, set peers, send,
  leave, forget onion, device id), `mls_*` (crypto), `app_*`
  (profiles/runtime/airplane/build-config), `vault_*` (encrypted-store lifecycle,
  PIN, panic code), `kv_*` (sealed kv), `file_*` (offers and downloads),
  `invite_*` (invitations), `audio_*` (recording), `tor_clean_keystore`.
- **Events (`listen`):** `realtime://message` `{room, payload}` and
  `realtime://status` `{room, state, peers, linked, peer_id}`, where `state` is
  `connected` (at least one member linked; `linked` lists their onions),
  `waiting` (nobody linked) or `disconnected` (room closed); plus
  `file://progress|done|error`, `invite://admit`, and `vault://locked` (the
  idle-lock watchdog).

### Sending a text message (outbound)

```
ChatPanel.send(text)
  → useChatChannel.sendMessage(text)
      needs MLS ready (not a live link):
        cryptoService.encrypt → mls_encrypt (Rust) → ciphertext
        wrap as {type:"mls_app", ciphertext:<base64>, sender fields}
      not ready → "Encryption not ready yet", nothing is sent
  → chatTransport.send(slug, payload)
      → invoke("realtime_send", {room, payload: JSON.stringify(...)})
          → mesh::broadcast: write down every live link; queue in the outbox
            of every wanted member without one (256 frames each)
```

### Receiving (inbound)

```
mesh.rs link reader  → emit realtime://message {room, payload}
  → chatTransport listener (JSON-parse; malformed frames ignored) → per-room handler
      → useChatChannel.handleMessage(data)
          switch data.type:
            mls_app        → mls_process_message → plaintext → route inner type
            mls_welcome / mls_commit → MLS handshake steps
            mls_key_package → ignored (rooms admit only by invitation)
            mls_reset_request → rebuild the group (see §9.4)
            anything else  → ignored; nothing in the clear is shown
```

### The MLS envelope state machine

`useChatChannel` implements a transport-agnostic JSON envelope protocol over the
room's links; all cryptography is delegated to the Rust `mls_*` commands. States:
`idle → initializing → key_exchange → ready → error`.

1. **MLS starts on entering a room**, not on a link coming up (`enterP2pRoom` →
   `startMls`). A room this device was let into comes back from its saved session
   (`mls_init_session` restores it) and is `ready` at once.
2. **A room just created** becomes an encrypted group of one at once (`alone`).
3. **A joiner** gets in only by redeeming an invitation: the inviter adds its key
   package (`mls_add_member`), broadcasts the `mls_commit` to the room, and returns
   the Welcome in the redemption answer; the joiner calls `mls_join_from_welcome` and
   is `ready` ([§18](#18-invitations--encrypted-expiring-revocable)).
4. Application messages ride `mls_app` frames (base64 MLS ciphertext).
5. **Sessions are always kept** across reopens and restarts (sealed in ns `mls`). A
   member who leaves is removed by the remaining member with the smallest MLS
   identity.
6. **Reset** (`mls_reset_request`, or the "reset encryption" button) throws the
   session away and starts a new group of one — see [§9](#9-security--privacy-considerations) item 4.

Fixed in the move from Enigma26 (the "stuck on Connecting… / Not encrypted" bug):
MLS used to start only on a `connected` status, so a lone creator waited for a peer
that could never come, and the inviter's admission needed `ready`, which deadlocked
invitations; every reopen wiped the MLS state and made a new group of one, cut off
from the others (the "Session reset / New encryption group" messages); sending
needed a live link; and a plaintext `chat_message` fallback and network
`system_error` frames existed. All of that is gone.

### Persistence — everything through protasius ([§13](#13-encryption-at-rest-gervasius--protasius))

All app state persists as **sealed values** in the per-profile protasius keyspace
(`<profile_dir>/protasius/`), unlocked by the launch passphrase gate:

- **MLS session state** → ns `mls` (blob keyed `room\0identity`, rewritten after
  every MLS operation).
- **Device key** → `keys\0device_ed25519`; presence id → `keys\0tor_peer_id`;
  arti's state directory (onion keys, guards, vanguard sets), archived →
  `keys\0tor_keystore`.
- **Saved rooms** → kv ns `p2p:rooms` as `{room, name, peers[], host?, onion?}` —
  `peers[]` is the other members' onions as last learned, what a reopen links to;
  `onion` our own for the room.
- **Chat history** → kv ns `chat:log`, per room, in segments, capped by
  `chat_history_cap_msgs` (500 by default).
- **Profile / PII / airplane switch** → ns `profile`, key `state`.
- **User settings** → kv ns `p2p:settings` (connect timeout, max file size, file
  chunk size, history cap, idle lock, PIN digits).
- **Invitations** → ns `invites` (internal tier).
- The only plaintext artifact is `vault.json` (the vault header: salt + wrapped
  DEK — reveals nothing without the passphrase).

---

## 5. Routing & transport

There is one transport: the **Tor mesh** in `mesh.rs` ([§11](#11-the-tor-mesh-and-vanguards)
has the design). No iroh, no gossip, no WebSocket, no HTTP data path.

- **One arti client per profile**, started right after unlock (`mesh::warm_up`), so
  opening a room does not wait for a bootstrap.
- **A room is identified** by its *slug*, BLAKE3(name) in hex; its onion key is kept
  under the nickname `enigma_<first 16 hex of BLAKE3(name)>`, so the address is
  stable across launches.
- **Links.** Every member hosts its onion (virtual port `network.onion_port`, 9999)
  and dials every other member it knows of; both ends keep the link dialled by the
  smaller onion. Frames for a member with no link wait in its outbox (256 frames,
  oldest dropped first). Redial backoff 5 s, doubling to 2 min.
- **Who knows whom.** A joiner starts with the onions in the redemption answer
  (every member's); after that, every member announces its onion in the encrypted
  `presence` message, and the frontend hands the full list to `realtime_set_peers`.
  The list is saved per room (`P2pRoomEntry.peers`).
- **Frame size.** `network.max_frame_bytes` (16 MiB): 4-byte LE length + JSON. A
  **wire-interop constant** — members built with different caps can drop each
  other's large frames. An image or voice note rides whole in one MLS message.
- **Connect timeout.** The user-set `connect_timeout_secs` (Settings; default 60 s)
  bounds the join window and the inviter's wait for the MLS add during a
  redemption. Never hardcode a connect deadline ([§15](#15-config--sources-of-truth)).
- **Airplane mode.** A per-profile `offline` flag makes every network command
  refuse while set (`realtime_leave_room` is the one exempt command). This is a
  **cooperative app-level gate**, not an OS firewall.

### File transfer — over the sender's onion, verified

`files.rs`. The offer and the answer travel inside the room's MLS-encrypted chat;
only the bytes use a Tor stream:

```
sender   file_offer_create(path, room) → { offerId, addr (our onion), name, size, mime }
         → file_offer{…} to the recipient, inside MLS
receiver file_prepare(offerId) → a random 32-byte secret, kept in Rust;
         returns commitment = BLAKE3(secret)
         → file_accept{offerId, commitment}, inside MLS
sender   file_authorize(offerId, commitment)
receiver file_download(addr, offerId, dest): dial the onion with Hello{kind:"file"},
         send {offer_id, secret}; the sender checks BLAKE3(secret) against the
         commitment, clears it (one download), answers {size, hash}, streams the bytes
receiver keeps the file only if size and BLAKE3 match; otherwise it is deleted
```

The secret never leaves the receiver until the onion stream is up, so only the
member who accepted can download, and only once. The bytes are protected by Tor's
end-to-end onion encryption, not by MLS. The check is always on (the integrity
switch is gone). The read buffer is the user's **file chunk size** (Settings,
default 256 KiB). Progress (`file://progress`) is throttled to 200 ms.

---

## 6. Is it truly P2P? (intermittent nodes)

**Message content is peer-to-peer and end-to-end encrypted, and Enigma27 runs no
server of its own. It relies on the Tor network.**

Every frame goes from the sender's device to each other member's onion, over Tor.
No member forwards anyone else's traffic. Tor's directory authorities and relays are
the only infrastructure; a relay sees ciphertext cells, and nothing it sees links you
to a room.

The cost is latency and start-up time: arti bootstraps in seconds (warm cache) to a
minute (cold), and a freshly published onion takes 30–90 s to become reachable. A
member who is offline simply has no link; frames for it wait in the sender's outbox
while the sender's app runs, and are lost if the sender closes the room first. There
is no store-and-forward.

So "serverless" here means **"no *our* server,"** not "no infrastructure".

Topology is a **full mesh** of small rooms: a room of N members has at most
N(N−1)/2 links. Fine for the small rooms Enigma is for; not built for large groups.

---

## 7. Encryption & algorithms

### The MLS engine (`rotor_core`)

All content encryption is **MLS (RFC 9420)** via OpenMLS, wrapped by `RotorSession`.
The single compiled ciphersuite (exported as `rotor_core::CIPHERSUITE`, declared and
compile-asserted in `build_config.yaml`) is:

**`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`** (RFC 9420 suite `0x0001`, 128-bit
security), which implies:

| Primitive | Algorithm | Backing crate |
|---|---|---|
| KEM (HPKE) | DHKEM(X25519, HKDF-SHA256) | `x25519-dalek`, `hpke-rs` |
| AEAD | AES-128-GCM | `aes-gcm` |
| KDF | HKDF-SHA256 | `hkdf` |
| Hash | SHA-256 | `sha2` |
| Signatures | Ed25519 | `ed25519-dalek` |

- **Wire format:** `PURE_CIPHERTEXT_WIRE_FORMAT_POLICY` — both handshake and
  application messages are MLS `PrivateMessage` (ciphertext), minimizing in-band
  metadata. The full ratchet tree is embedded in the GroupInfo carried by `welcome`
  messages (`use_ratchet_tree_extension`), so new joiners need no external tree.
- **Credentials:** `BasicCredential` carrying the raw identity string (the profile
  name, `CHAT_USER`), signed by a locally generated Ed25519 key. No X.509/PKI —
  identities are self-asserted.
- **Storage provider:** OpenMLS `MemoryStorage` (in-RAM), serialized and sealed into
  protasius by `enigmatite` after each operation.

### RotorSession API → `mls_*` commands

`create_group` / `key_package` / `add_member` (→ welcome+commit) / `join_from_welcome`
/ `adopt_session` / `process_message` / `encrypt_app` / `members` (authenticated
roster) / `remove_member` / `export_secret` (RFC 9420 exporter) / `export_state` +
`import_state` (serializable session).

### What is encrypted

- **Text** → `mls_encrypt` → `mls_app` frame.
- **Images** → downscaled client-side to ≤1600 px JPEG (q 0.85), embedded as a base64
  data-URL inside an encrypted `image_message`.
- **Voice notes** → native cpal capture → hound WAV → encrypted `voice_message`.
- **Presence (with the member's onion), leave, room closed, file offers and
  answers** → encrypted inner JSON over the same group.
- **Files** → not MLS: Tor's onion encryption on a stream to the sender's onion,
  gated by a secret committed over MLS, checked by BLAKE3 ([§5](#5-routing--transport)).
- **PIN unlock** → a **convenience layer, never an at-rest
  secret**. At enrolment the passphrase is proven (`Protasius::verify_passphrase`,
  read-only) and a copy of it is sealed under a PIN-derived key held in **process
  memory only** (`vault.rs`, `PinState`). An idle lock zeroizes the DEK as always
  but keeps that blob, so the PIN re-opens the session; a restart, profile switch
  or wipe takes it with it and the passphrase is required again. Nothing
  PIN-derived reaches disk, so `vault.json` is unchanged and a short PIN adds
  **no offline attack surface** — which matters, because 6 digits is ~20 bits and
  the whole keyspace would fall in minutes against a copied vault. Five wrong
  PINs drop the blob and fall back to the passphrase (no wipe: the counter is
  meaningful *because* it is in memory, where an attacker cannot copy it aside).
  A panic PIN may be enrolled alongside and must differ in **≥ 2 digits**, so one
  mistyped key cannot trigger the device wipe. *Caveat:* a RAM dump of an
  idle-locked process could brute-force the blob — strictly weaker than scraping
  an unlocked process, which is already total compromise.
- **Everything at rest** → Argon2id + XChaCha20-Poly1305 via gervasius/protasius
  ([§13](#13-encryption-at-rest-gervasius--protasius)).

What is **not** encrypted end to end, on the wire: the outer JSON of each frame —
its `type`, and on `mls_app` the sender fields (MLS identity, display name,
picture, message id) — and the size and timing of every frame
([§12](#12-how-enigma-keeps-and-encrypts-messages)).

### Security properties

- **Forward secrecy:** MLS's per-message secret-tree ratchet gives forward secrecy
  within an epoch; consumed message keys are deleted.
- **Post-compromise security (limited):** epochs only advance on add/remove commits.
  There is **no periodic self-update / empty-commit key rotation** in the code, so a
  long-lived group never rotates its epoch on its own — PCS is effectively not
  exercised after the last add or remove.

---

## 8. Privacy

| Aspect | Posture |
|---|---|
| Message content | **End-to-end encrypted (MLS).** Tor relays and anyone linked see only ciphertext — plus the plaintext sender fields of the outer frame (§12). |
| Your IP | **Never shown to anyone.** Always Tor; members are reached only at their onions. A network observer sees that you use Tor. |
| Accounts / identifiers | **None.** No phone number, email, or server account required. |
| Identity | Local profile; `CHAT_USER` (the profile name) = MLS identity; a device key (Ed25519) for invitations; an onion per room. Self-asserted, no PKI. |
| What members learn | Each other's onions for the room, display names and pictures, MLS identities, the inviter's device id, and the timing and size of what they receive. |
| Invitation QR contents | **No room name, no MLS material.** The inviter's device id and the inviter's onion for the room (no IP), an id, a capability and an advisory deadline. A *personal* invitation is sealed to the recipient's device id; a *general* one is a cleartext bearer code ([§18](#18-invitations--encrypted-expiring-revocable)). |
| Local at-rest | **Encrypted** — passphrase-gated vault ([§13](#13-encryption-at-rest-gervasius--protasius)); no recovery by design. |
| Device location | **Never read, never sent.** The app has no geolocation permission, no positioning plugin, and never calls `navigator.geolocation` (an e2e test traps the API and fails if that changes: `tests/e2e/noGeolocation.spec.ts`). It has no location feature of any kind: the Map tab moved to Morion on 2026-10-03 ([§16](#16-history--the-serverless-rework)). |
| Metadata protection | **Always Tor**, with full vanguards for the onions it hosts ([§11](#11-the-tor-mesh-and-vanguards)). Not yet: padding, cover traffic, Tor client authorisation (root todo.md Stage 7). |

**At-rest posture.** All persisted state is sealed in the per-profile protasius vault
(Argon2id-derived key wrap, XChaCha20-Poly1305 values, AAD-bound to each record's
location). The plaintext exceptions are: the vault header `vault.json` (salt +
wrapped DEK — useless without the passphrase); arti's directory cache (public
consensus data); arti's state directory (onion keys, guards, vanguard sets) **while
the app runs** — sealed back into the vault and wiped on lock/exit, though a crash
leaves it on disk until the next clean stop; and, in a profile that used the Map
tab before it left the app, the map-region blobs it imported
(`profiles/<p>/maps/<blake3>.pmtiles` — public map data, nothing reads or writes
them now, and a full data wipe removes them). `zeroize` scrubs transient RAM
buffers; `wipe_file` is a best-effort single-pass overwrite (not a secure erase on
SSD/journaling filesystems). There is **no passphrase recovery**: a forgotten
passphrase means a lost store. The two destructive resets are both deliberate —
Settings → Data → "Clear all data", and the **panic code**, a second passphrase
enrolled in Settings → Lock that looks like an ordinary unlock and wipes every
profile instead (`vault.rs::panic_wipe`; the call returns `Ok(())`
indistinguishably). The profile's Tor directory is inside the profile folder, so a
wipe takes it too.

---

## 9. Security & privacy considerations

Enigma's cryptographic core (OpenMLS) is solid; the current weaknesses are almost all
at the **integration layer**. Documented candidly here (roughly most- to
least-serious) so they can be addressed. The item numbers are referenced from code
and tests; resolved items stay, struck through.

1. ~~**Plaintext local storage.**~~ **Resolved** — all state is encrypted at rest
   behind the passphrase gate ([§13](#13-encryption-at-rest-gervasius--protasius)).
   Residual: arti's state on disk after a crash, and best-effort wipes (see §8).
2. **No key verification (TOFU only).** The MLS credential is a self-asserted string
   (the profile name) and there is no safety-number/SAS check, so an impersonator is
   not detectable in-app. Invitations do bind the redeemer to a device key, and a
   personal invitation to its recipient's device id. → *Bind the MLS credential to
   the device key and add a fingerprint/safety-number check.*
3. **Advisory group management.** Who removes a member who left (the remaining
   member with the smallest MLS identity) and who may add (only an inviter, during a
   redemption) are app convention; OpenMLS in this config lets any member commit
   adds and removes.
4. **Unauthenticated control frames.** `mls_reset_request` is a plaintext frame. Any
   connection to a member's onion — and links are not authenticated below MLS (no
   Tor client authorisation yet) — can send one, and the receiving member throws its
   MLS state away and starts a new group of one. As key packages from the mesh are
   refused, it cannot get back in without a new invitation. The "reset encryption"
   button in the room's status bar does the same on purpose. → *Authenticate or drop
   the reset frame; add client authorisation (root todo.md 7.3).*
5. ~~**Pre-MLS plaintext window + optimistic lock badge.**~~ **Resolved** — there is no
   plaintext fallback: sending needs MLS `ready`, and nothing in the clear is shown. A
   created room is a group of one at once; a joiner is `ready` only from a Welcome.
   Residual: the displayed `sender_name` is a plaintext, attacker-controllable field,
   not the MLS-authenticated identity.
6. **Metadata on the network path.** Always Tor, so no member or observer learns an
   IP. But there is no padding (root todo.md 7.1), the sender fields ride outside
   the ciphertext (7.2), and there is no cover traffic (7.4): anyone linked sees who
   sends, when, and roughly what kind of message by its size.
7. **Room access control.** There is no topic to guess: the only way into the MLS
   group is a redeemed invitation, and every member refuses key packages from the
   mesh ([§18.8](#188-invite-only-rooms)). Enforcement is app convention like §9.3: a
   member on a modified build could still add someone. Separately, anyone who knows a
   member's onion can open a link to it and receive that member's ciphertext and
   outer sender fields (item 4).
8. **WebView / IPC surface.** `tauri.conf.json` sets `security.csp = null` (no Content
   Security Policy), and on Linux the app auto-grants every WebView permission
   request. → *Add a CSP and gate permission requests.*
9. ~~**`tor.rs` clearnet-TLS footgun.**~~ **Resolved by deletion** (2026-08, with
   Enigma Cloud). The Rust core makes no outbound HTTP request at all. The mesh
   carries JSON frames over onion streams — no TLS layer, Tor's onion encryption end
   to end. *If a future feature needs an HTTP client, it must not resurrect a
   permissive verifier alongside a clearnet path.*
10. **Minor:** `openmls_rust_crypto` is built with the `test-utils` feature in
    production; 16 MiB frames are an amplification consideration; the outbox (256
    frames per member) drops the oldest beyond that.

---

## 10. User interface

A tabbed app (memory-history router, no URL bar), behind the at-rest **unlock gate**
(`App.vue`: passphrase setup on first run, unlock on every launch — no recovery):

- **Chat** (`EnigmaChatView` / `ChatPanel`) — a responsive 3-column layout at desktop
  width (rooms sidebar · conversation · participants), collapsing to a hamburger drawer
  on mobile. Create room (`CreateRoomModal`: launches the room's onion, then offers an
  invitation); join by scanning, opening an image of, or pasting an invitation
  (`JoinRoomModal`, connect-timeout countdown); compose text / images / voice notes /
  emoji; MLS lock badge, a link chip ("Linked to N") and "reset encryption". The
  member list shows each member as **Linked** or **Away**, from the `linked` onions of
  `realtime://status`. Room info (`RoomInfoModal`) says what is true of every room
  (invitation only, over Tor, members linked directly) and holds the share card.
  There is no captain, no room logo, no rules and no moderation.
- **Files** (`EnigmaFilesView`) — offer/accept transfers with progress and a
  max-size guard. Nothing syncs between a user's own devices.
- **There are no Vox, Contacts, Calendar or Map tabs** (Vesper and Morion have them,
  [§16](#16-history--the-serverless-rework)). A map share that is already in a room's
  history is shown as one line saying it cannot be shown.
- **Sharing a room** (`RoomShareCard`, in `CreateRoomModal` and `RoomInfoModal`) — two
  kinds of invitation: a **private** one (sealed to one recipient's device code,
  expiring, revocable) and a **shareable** one (bearer, expiring, revocable, with an
  explicit "this is not secret" warning). Both carry the "keep this room open until
  they join" note ([§18](#18-invitations--encrypted-expiring-revocable)). There is no
  room ticket any more.
- **Settings** (`EnigmaConfigView`) — five tabs: **Profile** (local-only PII,
  multiple named profiles), **Settings** (language en/pl; which tabs this device
  shows; your device code for private invitations; max file size; transfer chunk
  size), **Connections** (Tor: always on, a note on the mesh and on vanguards;
  connection timeout), **Lock** (auto-lock delay, lock-on-hide, reset passphrase,
  PIN unlock, panic code), **Data** (airplane mode; data profiles; clear data).
  Settings itself is the one tab with no visibility checkbox — it is the only route
  back to the others.
- **Welcome** (`EnigmaWelcomeView`, `/welcome`) — reached by tapping the Enigma27
  mark in the top left. Two cards: what the app is (icon, version, one-line
  pitch) and who you are on it (profile name, avatar, MLS identity, active
  storage profile). Deliberately **not** `/`: that redirect still resolves to the
  first visible tab, which is where every lock cycle re-enters after the webview
  reload.

Styling is Tailwind v4 with the in-repo "Oya" primitives kit (`packages/petalite`);
CSS-first design tokens — see [§14](#14-conventions-naming--palette). Dark mode
defaults on but is not persisted across launches; locale is persisted.

---

## 11. The Tor mesh and vanguards

*(The design is the header comment of `src-tauri/src/mesh.rs`; the frontend half is
rakotis `chatTransport.ts` and `useChatChannel.ts`; the wire is
[PROTOCOL.md](../../PROTOCOL.md) Part A.)*

**Every member hosts, every member links.** For each open room, every member hosts
its own onion service and keeps one link to every other member it knows. A message
goes straight down each link; nobody forwards anyone else's traffic, so no member
sees the room's whole traffic and there is no captain to elect or to lose.

**Who knows whom.** A joiner starts with the onions in the redemption answer (every
member's, the inviter's included). Once in the MLS group, every member announces its
onion inside the encrypted `presence` message, and the frontend hands the full list
to `realtime_set_peers`. Rust then keeps a link to each: it dials every wanted member
it has no link to, with backoff (5 s, doubling to 2 min), for as long as the room is
open. The list is saved per room (`P2pRoomEntry.peers`), so a reopen links to them
again; a member who leaves is dropped from it.

**One link per pair.** Both ends may dial at once. When two links to the same member
exist, both ends keep the one dialled by the smaller onion address, so they agree
without talking. Any other newcomer replaces the old link, which is then most likely
dead (the peer redialled before we noticed it drop).

**The outbox.** While a wanted member has no link, frames for it wait in a per-member
outbox (256 frames; the oldest go first beyond that) and go out, in order, when the
link comes up. So a message written while someone's onion is still being published
is not lost, and sending needs only encryption, not a live link. The outbox lives in
memory: closing the room drops it.

**Status.** `connected` while at least one member is linked (with the list of linked
onions, which the member list shows as Linked / Away), `waiting` while nobody is
(alone, or the others are offline), `disconnected` once the room is closed.

**Other streams on the same onion.** The `Hello` frame's `kind` routes a stream:
absent or `room` is a member's link, `redeem` an invitation redemption
(`invite_redeem.rs`), `file` a file download (`files.rs`).

**Stable onions.** arti runs one client per profile. Its state directory (keystore,
guards, vanguard sets) is kept per profile under `profiles/<p>/tor/state`: on lock or
exit it is archived and sealed into the vault (`keys/tor_keystore`) and the plaintext
copy removed; on the next start it is restored before arti starts. So a room's onion
address is stable, and so are the guards and vanguards. The directory cache is not
secret and stays on disk, which keeps the next bootstrap short. Deleting a room
removes its key from the keystore (`realtime_forget_onion`), so a new room of the same
name gets a fresh onion; Settings → clear data (`tor_clean_keystore`) forgets every
onion. arti's file-permission check is relaxed (`dangerously_trust_everyone`): the
keystore is sealed at rest, and a permissive umask or home would otherwise fail the
bootstrap. Stale lockfiles are cleared before start.

**Start-up.** Tor starts right after unlock (`mesh::warm_up`), so opening a room does
not wait for a bootstrap. A fresh onion still takes 30–90 s to be reachable by
others while its descriptor is published; the first few dials to it are expected to
fail, which is what the backoff is for.

**Vanguards.** A long-lived hosted onion is what guard-discovery attacks go after.
The attacker makes your onion build circuits on demand — by connecting to it again
and again — while running relays of their own, until one of theirs is picked as the
hop right next to your guard. From there they learn your guard, and can watch or
pressure it to find where you are. Vanguards fix the second and third hops of onion
circuits to small sets: **4 L2 relays, each kept 1–12 days, and 8 L3 relays, each
kept 1–48 hours**, so an attacker's relay at the third hop sees a vanguard, not your
guard, and it takes far longer to get one next to it. arti is built with the
`vanguards` feature, and `mesh.rs` sets **full** vanguards explicitly
(`VanguardMode::Full`): every member hosts an onion, and arti 0.43 does not yet choose
full mode for onion services by itself. As the sets live in arti's state directory,
they survive restarts (sealed in the vault while the app is stopped). Vanguards narrow
guard discovery; they do not hide you from your guard, nor from a global observer.

**Mechanics.** Framing: 4-byte LE length + JSON, cap `network.max_frame_bytes`
(16 MiB). Handshake `Hello{name, peer_id, kind?, onion?}` → `Ready{ok}`. Writes are
bounded (`tor_write_timeout_secs`, 20 s), so one stalled circuit cannot hold up a send
to everyone else; the handshake read too (`tor_handshake_timeout_secs`, 30 s). The
virtual onion port is `network.onion_port` (9999), the same for every member.

**Known limitations:**
- **Links are not authenticated below MLS.** Anyone who knows a member's onion can
  connect, claim an onion in its `Hello`, and receive what that member sends; MLS
  keeps the content shut, not the outer sender fields or the timing
  ([§9](#9-security--privacy-considerations) items 4, 6, 7). Tor client authorisation
  (arti `restricted-discovery`) is planned (root todo.md 7.3).
- **New joiners need the inviter online**, with the room open.
- **A frame for an offline member is lost** if the sender closes the room before the
  member comes back. No store-and-forward.
- **Scale:** a full mesh, N(N−1)/2 links; for small rooms.

**Removed 2026-11-22/23:** iroh, iroh-gossip and Ferrozine (no direct P2P at all), the
"Route over Tor" and "Keep onion stable" switches, legacy room tickets, and the
captain (star topology, election, failover, relaying) with all moderation.

---

## 12. How Enigma keeps and encrypts messages

*(The old §12, DHT discovery, was removed 2026-11-16; the DHT, Heliodor, was never in
Enigma27.)*

**On the wire.** Every frame is `len: u32 LE ‖ JSON`, at most 16 MiB, on a Tor
stream between two members (Tor's onion encryption end to end). Content is an MLS
(RFC 9420) message in the room's group, ciphersuite
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, pure-ciphertext wire format: text,
images, voice notes, presence (with the member's onion), leave, room closed, file
offers and answers. Handshake messages (commit, Welcome) are MLS ciphertext too. No
plaintext message is ever sent or shown: the old `chat_message` fallback and network
`system_error` frames are gone, and key packages from the mesh are ignored.

**What leaks on the wire**, to anyone linked to you (members, and anyone who knows
your onion for the room):
- the outer JSON: each frame's `type`, and on `mls_app` the sender's MLS identity
  (the profile name), display name, picture and message id (root todo.md 7.2);
- sizes: nothing is padded (7.1), so a text, an image and a voice note look
  different;
- timing: no cover traffic (7.4).

Tor relays see none of that, only cells; a network observer sees that you use Tor.

**At rest.** Per profile, one protasius store (`profiles/<p>/protasius/`): keys in
the clear, values sealed with XChaCha20-Poly1305 under a random DEK, each bound to
its key by the AAD `"protasius:v1:" ‖ key`. The DEK is wrapped in `vault.json` by
Argon2id (64 MiB, t=3, p=4) from the passphrase, beside a slot for the panic code. A
PIN re-unlocks only while the app runs. The panic code, entered at the unlock prompt,
wipes every profile. What is kept:
- **history** in sealed `chat:log` segments per room (`services/chatLog.ts`), capped at
  500 messages by default (`chat_history_cap_msgs`, 50–5000; the oldest segment goes
  first);
- **MLS state** per (room, identity) in ns `mls`, rewritten after every MLS operation
  and kept across reopens, so a reopened room is the same group;
- **the room list** with the other members' onions (`p2p:rooms`);
- **arti's state** (onion keys, guards, vanguards), sealed as `keys/tor_keystore`
  while the app is stopped, plaintext under `profiles/<p>/tor/state` only while it
  runs.

---

## 13. Encryption at rest (gervasius + protasius)

*(Condensed as-built reference. Crates: `crates/gervasius` — primitives;
`crates/protasius` — the store; app integration in `vault.rs` / `lib.rs`.)*

**Model.** On every launch the user enters a passphrase (per profile; set on first
run — minimum length enforced in UI only). Envelope:
`passphrase --Argon2id--> UKEK --wraps--> random 32-byte DEK
--XChaCha20-Poly1305--> data`. Password change re-wraps only the DEK (O(1), fresh
salt) — data is never re-encrypted. Wrong passphrase fails closed on the wrapped-DEK
AEAD tag. Keys are held in memory only and zeroized on lock/exit. **No recovery by
design**: a forgotten passphrase means a lost store. Destroying data is a
deliberate act — Settings → Data → "Clear all data", or the panic code (§8).

- **gervasius** (primitives, pure Rust, wasm-clean): Argon2id (v1.3; costs from the
  app's build config for new vaults, default 64 MiB / t=3 / p=4 / out=32, recorded
  per-vault in the header so old vaults always unlock), XChaCha20-Poly1305 with a
  random 24-byte nonce (`frame = nonce ‖ ct+tag`), the vault envelope
  (`create_vault[_with_params]` / `unlock` / `rewrap` / `seal` / `open`), and the
  name consts (`AEAD_NAME`, `KDF_NAME`) the build config compile-asserts against.
- **protasius** (the store): ONE fjall keyspace per profile
  (`<profile_dir>/protasius`), **keys plaintext, values sealed**. Key layout: a
  leading tier tag byte (`TAG_INTERNAL 0x01`, `TAG_KV 0x02`) + `\0`-separated
  segments; AAD = `"protasius:v1:" ‖ full_key` binds every value to its exact
  location (a new tier claims a new tag byte; a layout change bumps the AAD
  version). The `VaultHeader` is plaintext `vault.json` (salt + wrapped DEK — safe
  in the clear; enables a cheap `status()` and atomic setup/rewrap commits).
  Lifecycle: `setup` (creates the vault and migrates any legacy plaintext,
  crash-safe and idempotent — commit point is the atomic `vault.json` rename, with
  an opportunistic sweep on every unlock) / `unlock` / `lock` /
  `change_passphrase` / `wipe`.
- **App integration:** `vault_*` Tauri commands + a `require_unlocked` gate on data
  commands; all persistence sites (profile state, MLS sessions, device key, Tor
  state, kv) reach the store via managed state. Lock and profile switch stop the
  mesh first (so arti's state seals into the correct profile), re-open protasius
  locked, and reload the webview so the gate re-runs. Unlock starts Tor again
  (`mesh::warm_up`).
- **arti's state** (always kept, since there is no "keep onion stable" switch any
  more): archived (postcard), sealed into `keys/tor_keystore`, and wiped on
  shutdown/lock — on disk only while the app runs. The plaintext directory is wiped
  **only after a successful seal**. A crash while running leaves it on disk until the
  next clean stop — the one accepted exposure window.
- **Per-file locking, the key ring and the notes editor — removed 2026-10-23**
  (README.md, "Removed features"). Enigma no longer seals, opens or rotates local
  files. A profile carried over from that time may still hold files on disk sealed
  as `ENIGLOCK` or `.enigr`, which this version cannot open, and a kv index of them
  (ns `files:local`) that nothing reads.
- **What the Map tab left behind.** A profile that used it still has its region list
  (`map:regions`) and its pins (`map:pins`) in the sealed kv, and its region blobs on
  disk (§8 at-rest posture). Nothing reads, writes or shows any of them since
  2026-10-03, and nothing removes them short of a full data wipe.

---

## 14. Conventions (naming & palette)

### Naming

**Vue components.**

- Reusable primitives live in `packages/rakotis/src/components/primitives/` with the
  **`Oya`** prefix, PascalCase (`OyaButton`, `OyaModal`, `OyaTextField` … zero exceptions).
- App components are PascalCase, **no** prefix, grouped by feature folder
  (`components/chat/`), and carry a type suffix: `*Modal`, `*Chip`, `*Panel`, `*Bar`,
  `*Row`, `*Sidebar`, `*Drawer`, `*List`.
- Route views are `Enigma<Domain>View` (`EnigmaChatView`, `EnigmaFilesView`,
  `EnigmaConfigView`, `EnigmaProfileView`, …). Stores are
  lowercase domain files (`chat.ts`, `user.ts`). Composables are
  `useXxx` camelCase.

**Tauri commands.** `snake_case`, `<domain>_<verb>` families — `app_*`, `vault_*`,
`kv_*`, `mls_*`, `realtime_*`, `audio_*`, `tor_*`, `file_*`,
`invite_*`. All registered in the single
`generate_handler!` block in `apps/enigma/src-tauri/src/lib.rs`. (Two legacy getters,
`current_profile`/`current_identity`, predate the prefix rule — leave or migrate to
`app_*`, don't add new prefix-less commands.)

**Events.** `scheme://path` naming: `realtime://message` and `realtime://status`
(a single event multiplexes all rooms, the payload carries the room id), plus
`file://progress|done|error`, `invite://admit`, and
`vault://locked` (emitted when the watchdog re-locks the vault).

**i18n keys.** Two levels: `namespace.camelCaseLeaf` (`chat.newChat`, `vault.wrongPass`).
Namespaces: `nav`, `common`, `keys`, `lang`, `network`, `config`, `chat`,
`files`, `sketch`, `local`, `fileShare`, `invite`,
`profile`, `vault`, `welcome`. Interpolation uses single-brace named tokens
(`{n}`). English and Polish live in
[`apps/enigma/src/i18n/`](apps/enigma/src/i18n/) and are the **only** catalogs;
documentation is not translated.

`chat.sys.*` is a namespace of its own for the 34 system notices the chat channel
pushes into the transcript ("🔒 End-to-end encryption active.", "Disconnected.",
"The room host went offline…"). These are emitted from **rakotis**, which
[`packages/rakotis/src/i18n/index.ts`](packages/rakotis/src/i18n/index.ts) says
must carry no app strings — so they reach a catalog through an injected
translator, [`i18n/chatText.ts`](packages/rakotis/src/i18n/chatText.ts), registered
by the app in `main.ts`:

```ts
sysMsg("chat.sys.joined", 'Joined "{name}". Connecting to peers…', { name })
```

The English **fallback stays at the call site**, which is a deliberate softening of
that rule and the reason the seam is shaped this way. A *catalog* in rakotis would
be the drift hazard the rule exists to prevent; one fallback beside its key is not,
and it means an unregistered translator — a headless channel, a unit test, a boot
that failed before `main.ts` ran — degrades to today's English instead of rendering
a raw key at somebody mid-call.

**Dates, times and numbers** go through
[`i18n/dateFormat.ts`](packages/rakotis/src/i18n/dateFormat.ts) — `formatDate`,
`formatTime`, `formatNumber`, `formatBytes` — never `toLocaleDateString` directly.
The reason is that `toLocaleDateString(undefined, …)` reads the **operating
system's** locale, not the app's, so a user who chose Polski still read
"August 2026" in a date header if their OS was English. The formatters read
`currentLocale`, a ref the i18n factory keeps in step with `i18n.global.locale`;
being a ref is what makes a rendered date re-render on a language switch, so a date
formatted in a `computed` or a template updates with everything else. Format one
outside a tracked scope — a plain array built in `setup` — and it will not.

The module holds **no month or weekday names**. Polish declines them: nominative
standing alone, genitive beside a day number, and Intl gets both right on its own
(`{ month: "long", year: "numeric" }` → "sierpień 2026";
`{ day: "numeric", month: "long", … }` → "24 **sierpnia** 2026"). A hand-written
table would have to encode that grammar and would be wrong in one of the two cases.
For the same reason no stylesheet may `capitalize` a formatted date: Polish writes
month and weekday names in lower case, and English arrives capitalised already.

The `DateStyle` union is a **closed set** rather than free-form options, so two
surfaces showing the same kind of date cannot drift apart, and so the coverage test
can tell a formatted date from a hand-rolled one.

**Plurals.** Polish has three forms where English has two, chosen by the last two
digits (1 uczestnik · 2–4 uczestnicy · 5+ uczestników, with 12–14 taking the third
despite their last digit). vue-i18n's default rule is English, so `createAppI18n`
registers a `pl` rule; without it a Polish catalog can only ever offer two forms and
the middle one is unreachable. Counts must be passed **positionally** —
`t("chat.participantCount", n)`, not `{ n }` — since a named param interpolates the
number but never selects a form. That mistake read "1 days" in English too.

Two tests guard this, and they cover different failures.
[`i18n.test.ts`](apps/enigma/tests/unit/i18n.test.ts) checks en/pl define the same
keys; it cannot see a string that never became a key at all, which is how ~41 of
them accumulated. [`i18nCoverage.test.ts`](apps/enigma/tests/unit/i18nCoverage.test.ts)
closes that: it reads `.vue` and `useChatChannel.ts` as text and fails on bare
English in `placeholder=`/`label=`/`alt=`/`title=`/`aria-label=`, in `{{ … }}`
interpolations, in strings computed inside `<script setup>` (the gap that let the
composer's placeholder chain through), in `systemMsg(…)`, and on any raw
`toLocale*String` call. `alt` and `aria-label` are in scope on
purpose — a Polish screen-reader user is still a Polish user. Its allowlist
(protocol and product names: `Tor`, `Enigma27`, `MLS`, `QR`) requires a
reason per entry, so it stays a record rather than a dumping ground.

**protasius storage.** Versioned AAD prefix `protasius:v1:` binds every sealed value;
keyspace tiers are separated by a leading tag byte (`TAG_INTERNAL = 0x01`,
`TAG_KV = 0x02`) with `\0`-separated segments. A new keyspace tier claims a **new tag
byte**; a key-layout change bumps the AAD to `protasius:v2:`.

### Colour palette / design tokens

Tailwind v4 is **CSS-first**: the palette lives in the `@theme` block of
[`apps/enigma/src/style.css`](apps/enigma/src/style.css) as `--color-<role>-<light|dark>`
tokens, consumed as `text-<role>-light dark:text-<role>-dark` (class-based dark mode,
`.dark` on `<html>`). This CSS block is the **single source of truth** — do not define
colours in JS. Rakotis component source is `@source`-scanned so its utilities generate.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `primary-bg` | `#f2f3f5` | `#0a0c11` | Page / primary surface |
| `text-main` | `#0f1114` | `#d3d7e0` | Primary body text (most-used foreground) |
| `header-bg` | `#1d2333` | `#0f1420` | Top bar (== `footer-bg`) |
| `footer-bg` | `#1d2333` | `#0f1420` | Footer (== `header-bg`) |
| `appbar-bg` | `#252c3e` | `#151b29` | Secondary chrome |
| `appbar-text` | `#e4e7ef` | `#cfd4df` | Text on appbar (== `footer-text`) |
| `footer-text` | `#e4e7ef` | `#cfd4df` | Footer text (== `appbar-text`) |
| `bubble-bg` | `#e8e9ec` | `#191f2d` | Chat message bubble |
| `sunken` | `#e1e2e5` | `#141821` | Inset / recessed surface (inputs, wells) |
| `accent` | `#2f3d63` | `#4f5fa1` | Primary accent (indigo/navy) |
| `warn` | `#d94a4a` | `#ff4455` | Warning / error / destructive (red) |
| `success` | `#4a8f7a` | `#5fa38c` | Success / positive (teal-green) |
| `link` | `#2a4b8f` | `#5f7fc9` | Hyperlink (blue) |
| `accent-1` | `#4f5fa1` (both) | | Mode-independent accent end (== `accent-dark`) |
| `accent-2` | `#2f3d63` (both) | | Mode-independent accent end (== `accent-light`) |
| `highlight` | `#facc15` (both) | | Room-creator marker / "attention" (MLS key-exchange) |

**Typeface:** Orbitron, via `--font-sans` (currently CDN-loaded from Google Fonts —
see the centralization roadmap below for the offline-resilience note).

**Rules.**
- Never use a raw Tailwind palette utility (`text-yellow-400`, `bg-red-500`, …) or a
  literal hex for a *thematic* colour — add/point to a token. The gold host ★ is
  `text-highlight`; the recording/destructive red is `warn`.
- Functional black/white is fine where it's **not** theming: QR codes need true
  black-on-white to scan; toggle knobs are conventionally white.
- Native `<select>/<option>` (can't take Tailwind reliably, needs `color-scheme`) may
  use scoped CSS, but must read `var(--color-*)`, not re-hardcoded hexes.

Known un-tokenized bits worth folding in later: the modal/drawer scrims
(`bg-black/70` vs `bg-black/40` — inconsistent opacity, candidate `--color-scrim`) and
the copy-pasted `text-white border-white/20` modal buttons (candidate rakotis
primitive).

---

## 15. Config — sources of truth

**Build config (compile-time):**
[`apps/enigma/src-tauri/build_config.yaml`](apps/enigma/src-tauri/build_config.yaml)
— baked into the binary by `build.rs` (codegen → `enigma_lib::build_config` consts;
invalid file = build error — see [§19](#19-run-build-and-test)). The same for every
build, and limited to what rarely changes: crypto declarations
(compile-asserted against rotor_core/gervasius) + Argon2id costs for new
vaults, network constants (frame cap, onion port, timeouts), and defaults **and
clamp bounds** of the kv-backed settings. The frontend fetches the relevant subset once at boot via
`app_get_build_config` (rakotis `initBuildConfig`/`getBuildConfig`; `main.ts`
seeds the browser-mode fallback from `config/app.ts` and the build-time feature
literals).

**Build features (compile-time):** none — one edition
([§20](#20-features-and-presets)).

**Who owns what — one authoritative source each.** Nothing below is stated
twice; where a value must be known in two places it is *read* from its owner,
and a test or the build fails if a copy drifts.

| What | Owner | Who reads it |
|---|---|---|
| App name, identifier, version | `tauri.conf.json` | `build.rs` (→ `build_config::app`), the bundler, the dev runner |
| Debug/release, package formats, Android, tests, forbidden crates | [dromon.yaml](dromon.yaml) (one variant, `default`) | `./build.sh enigma`, `./run_dev.sh enigma`, `./tests.sh enigma` |
| Crypto parameters, protocol constants, setting defaults and bounds | `build_config.yaml` | `build.rs` → every Rust module; the frontend through `app_get_build_config` |
| The value of a setting at run time | the profile's encrypted store (kv `p2p:settings`) | Rust and the frontend, clamped to the bounds above |

Precedence follows from that: `dromon.yaml` cannot touch crypto, protocol
constants or setting bounds, and a user's stored setting wins over a default but
never over a bound. There are no opt-in toggles left: Tor is always on, onions
are always stable, files are always verified.

App name and identifier are fixed to `Enigma27` / `com.spectrumaipl.enigma27`;
`build.rs` rejects a `tauri.conf.json` that says otherwise.

**Frontend app config:** [`apps/enigma/src/config/app.ts`](apps/enigma/src/config/app.ts)
— brand identity, UI policy, dev port. Import `brand` / `policy` / `dev` from here
instead of hardcoding.

| Value | Canonical home | Notes / mirrors |
| --- | --- | --- |
| Display name `Enigma27` | `config/app.ts` `brand.name` | Also `tauri.conf.json` `productName` + window `title` |
| Copyright / org / legal URL | `config/app.ts` `brand` | Was hardcoded in `App.vue` |
| Bundle identifier | `tauri.conf.json` `identifier` | Mirror `brand.bundleId` and Android `applicationId` (`com.spectrumaipl.enigma27`); `build.rs` rejects any other value |
| App icon | `apps/enigma/app-icon.png` | **Fixed, not a build choice** — one mark; the sizes generated from it are committed. See [§23](#23-app-icon) |
| In-app branding images | `apps/enigma/src/assets/<logoDir>/` (`logoDir` in `apps/enigma/package.json`, currently `enigma27`) | `app_icon.png` (large — the unlock/welcome gate) and `bar_icon.png` (small — the top bar) |
| Passphrase min length | `config/app.ts` `policy.passphraseMinLen` | **UI-only** today — see the roadmap note below |
| Profile field caps | `config/app.ts` `policy.*MaxLen` | `displayNameMaxLen` 150, `profileNameMaxLen` 80 |
| P2P connection timeout | kv `p2p:settings` / `connect_timeout_secs` (rakotis `appStorage.getConnectTimeoutSecs`) | **User-set in Settings**; default + clamp (60 s, 5–600) come from `build_config.yaml` `settings:`. Governs create/join give-up + the join window's read countdown (window ≤ 2×N) — never hardcode a connect deadline. Rust reads the same key (`net_settings::connect_timeout_secs`) |
| Chat history cap | kv `p2p:settings` / `chat_history_cap_msgs` (rakotis `appStorage.getChatHistoryCapMsgs`) | **User-tunable**; default 500 msgs clamped 50–5000 from `build_config.yaml`. Bounds the sealed per-room `chat:log` kv (oldest segment pruned past it) — the store that lets a room's timeline survive a restart |
| Release version `0.1.10` | `tauri.conf.json` `version` | The owner (drives bundle filenames; `build.rs` reads it into `build_config::app::VERSION`). Still hand-duplicated in `Cargo.toml` and the three `package.json` files. Bumped **with the code**, never chosen per build |
| Dev port `1420` | `vite.config.ts` `server.port` | Mirrored in `tauri.conf.json` `devUrl` (which `scripts/tauri-dev-server.mjs` and `run_dev.sh --dual` read) and `dev.vitePort` |
| Argon2id params | `build_config.yaml` `crypto.kdf` (new vaults, via `lib.rs::kdf_params`) | Persisted per-vault in the header, so old vaults always unlock; `gervasius KdfParams::default()` is the library-level fallback and must stay in sync |
| Frame cap / onion port / Tor timeouts | `build_config.yaml` `network:` | `max_frame_bytes` is **wire-interop** (the cap on a member's link — change in lockstep across a fleet); every member listens on the same onion port |
| Transfer chunk size | `build_config.yaml` `settings.file_chunk_kib` (clamp) → kv `p2p:settings/file_chunk_kib` | User-settable ("file chunk size"); the read/write buffer of a download in `files.rs`. Device-local, no wire impact |
| Invitation state | protasius ns `invites` via `vault::get/put` (**internal** tag) | Per-profile, per-issuer: the capability, recipient binding, deadline and `Active/InFlight/Consumed/Revoked` state of every invitation minted. Deliberately NOT in the `kv_*` keyspace the webview can write. Expiry is decided **here**, on the inviter's clock — the deadline inside a ticket is advisory ([§18](#18-invitations--encrypted-expiring-revocable)) |
| PIN unlock | always built in; `build_config.yaml` `settings.pin_digits` (clamp) | Memory-only convenience re-unlock; the passphrase remains the at-rest secret. Nothing persisted, so no migration and no on-disk mode marker |
| AAD prefix / tag bytes | `protasius/src/lib.rs` | `protasius:v1:`, `TAG_INTERNAL`/`TAG_KV` |
| Window size, bundle targets | `tauri.conf.json` | — |
| Two-profile dev instances | `APP_PROFILE` / `CHAT_USER` env | Defaulted in `run_dev.sh`; **`lib.rs` owns the `"default"` fallback** |

**Pairs that MUST be bumped together** (no shared source yet): the `rakotis` source
alias path (`vite.config.ts` + `vitest.config.ts` + `tsconfig.json`); the desktop apt
dependency list (docs + CI jobs); the Playwright image tag `v1.60.0` ↔
`@playwright/test ^1.60.0`; the NDK version `27.2.12479018` (docs ↔ installer); the
`*.deb/*.AppImage/*.rpm` bundle glob (`scripts/build.mjs`). State one Node floor
(CI uses **node 22**).

### Centralization roadmap (not yet done)

Deliberately deferred; each is a real drift source. Do these when touching the
relevant subsystem:

**Rust consts (a shared module, or in-crate):**
- `gervasius`: name the magic sizes — `SALT_LEN = 16`, `KEY_LEN = 32`, `VAULT_VERSION = 1`.
- Transport: the invitation tag `0x4E` is the only ticket tag left (the old
  `0x49` / `0x54` / `0x44` tags went with iroh tickets, Tor tickets and the DHT);
  comments in `invite_ticket.rs` still name them.
- protasius namespace/key strings (`profile`/`keys`/`cache`/`state`, `tor_peer_id`,
  `tor_keystore`, `device_ed25519`) are bare literals across several files → named consts (a
  typo silently loses stored data).
- Fold inline Tor timers (redial backoff 5 s → 2 min, outbox 256, onion-poll) in with the named ones.

**Policy enforced on both layers.** `passphraseMinLen` is UI-only — a direct `invoke`
bypasses it, and `gervasius::create_vault` accepts any passphrase. If it's a real
boundary, enforce the same value in Rust (`vault_setup`/`vault_change_passphrase`).

**Frontend consts (rakotis).** LocalStorage keys + the `enigma:` prefix + the on/off
boolean encoding are scattered → one constants module. Same for chat timing (`5000`, `30000` duplicated) and
UI copy/confirm delays (`1200`/`1500`/`2000`).

**Build.** A version-bump script (or Tauri reading version from `package.json`) so
the version isn't hand-maintained in eleven files; extract the apt list to
`scripts/install_desktop_deps.sh`; add `.nvmrc`/`engines` for the Node floor.

**Palette.** Promote a `--color-scrim` token (unify `black/70` vs `black/40`) and lift
the repeated `text-white border-white/20` modal buttons into a rakotis primitive.
Consider self-hosting Orbitron (`@font-face`) — the CDN `<link>` fails in the offline
desktop/mobile shell.

---

## 16. History — the serverless rework

The newest change first, then the older record, kept short. Paths under `limbo/`
below are in the Enigma26 and Belisario repositories; `limbo/` was not copied into
Pharos.

### Moved to Pharos — Enigma27 (2026-11-22/23)

Enigma26 (technolog-spectrumai/enigma, branch `dev_mvp1`) was copied into Pharos as
`apps/enigma` and renamed **Enigma27** (identifier `com.spectrumaipl.enigma27`, the
letter E as its icon, `scripts/letter_icon.py`). It replaced Pharos's previous
client, which had Friends (Pharos 1:1 over rendezvous onions, with Beacon) and
Vesper's groups. Pharos owns the code now; nothing is vendored.

**Removed:** iroh, iroh-gossip and Ferrozine — there is no direct P2P at all; the
"Route over Tor" and "Keep onion stable" switches (always Tor, onions always
stable); the file-integrity switch (files are always verified); legacy room tickets
(`legacy_ticket.rs`, the `0x49` / `0x54` tags); the captain — star topology,
election, failover and relaying; and all moderation — room logo, rules, mute, kick
and ban, with the `room_meta` snapshot that carried them. Privacy HP had gone a day
earlier (below). The DHT (Heliodor) was never in Enigma27.

**New:** the mesh ([§11](#11-the-tor-mesh-and-vanguards)): every member hosts an
onion per room and links to every other; full vanguards; arti's state kept per
profile and sealed at rest; Tor started right after unlock. Invitations carry the
inviter's device id and onion and are redeemed over it; the grant carries every
member's onion ([§18](#18-invitations--encrypted-expiring-revocable)). Files are
downloaded from the sender's onion ([§5](#5-routing--transport)).

**Fixed** — the "stuck on Connecting… / Not encrypted" bug in Enigma26: MLS starts
on entering a room, not on a `connected` status (a lone creator was waiting for a
peer that could never come, and the inviter's admission needed `ready`, which
deadlocked invitations); a just-created room is an encrypted group of one at once;
sessions are kept across reopens (Enigma26 wiped the MLS state on every reopen and
made a new group of one, cut off from the others — the "Session reset / New
encryption group" messages); sending needs only encryption, not a live link (the
outbox); no plaintext is ever sent or shown (the `chat_message` fallback and network
`system_error` frames are gone).

Still open: root [todo.md](../../todo.md) Stage 7 — padding (7.1), sender fields
inside the ciphertext (7.2), Tor client authorisation on member onions (part of
7.3), cover traffic and timing (7.4).

### The serverless rework (Belisario)

This repo used to be a three-app monorepo (Enigma / Enigma+ / Aurora) with a server
relay. The rework turned it into a **single serverless P2P chat**: no relay
WebSocket, no REST gateway, no login, no server-side directory.

**Removed:** the sibling apps (`apps/aurora/`, `apps/enigma_plus/`); the Rust server
plumbing (`data.rs` REST gateway, `aster.rs` server directory, the WebSocket half of
`realtime.rs`, server/auth fields + commands); their Cargo/npm deps; the rakotis
relay branch (`services/ws.ts`, `apiBase.ts`, `chatCommands.ts`, the `kind ===
"relay"` path of `useChatChannel.ts`); the login view and server-address settings;
relay/aster tests and CI matrix entries.

**Kept / promoted:** `p2p_iroh.rs` (room = gossip topic = `blake3(name)`; since
removed, see above); all `mls_*` commands + `RotorSession` (crypto unchanged); QR
generate/scan; arti and the Tor plumbing; native voice-note recording; offline
profiles and the airplane switch.

**Shipped since the rework** (each summarized in this doc):
- **Tor onion transport** with a captain (election, failover) — replaced by the mesh on 2026-11-22/23 ([§11](#11-the-tor-mesh-and-vanguards)).
- **DHT discovery, Contacts, nickname directory, direct invites** (removed 2026-11-16, see below).
- **Encryption at rest** (gervasius/protasius, [§13](#13-encryption-at-rest-gervasius--protasius)) and per-file locking (removed 2026-10-23).
- **Voice calls (Vox) and P2P file transfer restored** from the parked `limbo/`
  set (both then first-class tabs; `limbo/` retains the restore playbook). Voice
  calls were removed again on 2026-11-16, see below.
- **`rotor_wasm` → toto static handoff** (2026-07-14): the crypto crates live in
  one place — since 2026-10-03 Rutile's `crates/rotor`, now Pharos's — and toto
  consumes a static committed copy of the wasm build.
- **Compile-time build config** (`build_config.yaml`, [§15](#15-config--sources-of-truth)).
- **Maps** (MapLibre + PMTiles, `maps.rs` + `EnigmaMapView`): fully offline regions
  imported from packages made by the standalone `tools/map_packager` (BLAKE3 +
  manifest verified), P2P region sharing over file_xfer, pins as MLS chat
  cards. The 2026-07-19 pivot removed every in-app tile-fetch path. **Moved to
  Morion on 2026-10-03** — see the end of this section.
- **Persisted chat history** (sealed per-room `chat:log` kv, `services/chatLog.ts`
  + `chatHistoryModel.ts`): a room's timeline survives a restart, bounded by
  `chat_history_cap_msgs`. It arrived as part of multi-device sync and outlived
  it — when device linking was parked, the storage/merge half stayed behind
  ([below](#parked--device-linking--multi-device-sync-2026-08-18)).

### Removed — Enigma Cloud (2026-08-15, branch `cleanup_1408`)

Enigma Cloud was the client for the user's *own* self-hosted faros/toto server:
`cloud.rs` (HTTP + telegraph auth + vault file storage), `aster.rs` (username →
NodeId directory and the HPKE-sealed invite mailbox), `beacon.rs` (expiring
server-side location shares on the Maps tab), `invite_seal.rs`, `tor.rs` (the
outbound Arti HTTP client, used by nothing else), the Cloud tab and its Vue
components, `stores/cloud.ts` / `stores/beacon.ts`, rakotis `beaconModel.ts`, the
`cloud.allow_connections` build gate in `build.rs` and all five `build_config`
YAMLs, and the Builder tool's Cloud checkbox — about 7,200 lines of feature code,
≈11,400 counting its tests, i18n keys and fixtures. Deleted, not parked: there is
no restorable copy, only the record at
[limbo/removed/cloud.md](limbo/removed/cloud.md) with its rendezvous and
location halves beside it ([rdv.md](limbo/removed/rdv.md),
[beacon.md](limbo/removed/beacon.md)).

**What the removal buys.** Enigma Cloud was the only path by which the app spoke
to an application server, and it carried a second architecture to do it: an HTTP
stack (`hyper`, `tokio-rustls`, `webpki-roots`), a session and auth model, a
server-side directory, and a permissive TLS verifier
([§9](#9-security--privacy-considerations) item 9). All of that is gone, which
makes §1's "no app server" literal rather than qualified — there is no
server-speaking code left to audit, no login, and no outbound HTTP request of any
kind from the Rust core (the webview's Google Fonts `<link>` is the one remaining
network fetch — §1). The cost is real and is listed below: offline invite delivery and server
file storage had no P2P equivalent and were not replaced.

**What it means in practice, and what was NOT touched:**

- **Room invites are out-of-band only.** The QR code, the copyable ticket string
  and the DHT room code. `p2p_invite.rs` still delivers a direct invite, but both
  peers must be online at once — the sealed mailbox that could hold an invite for
  an absent peer is gone, and there is no store-and-forward replacement. (The DHT
  and `p2p_invite.rs` were removed on 2026-11-16, see below.)
- **Contacts lost server search.** Finding someone by faros username is gone;
  the DHT nickname directory
  is the only directory left, and Tor mode now has none at all. (Contacts and the
  nickname directory moved to Vesper on 2026-11-16, see below.)
- **Maps lost the Beacon layer**, but not location sharing: the peer-to-peer
  *Share this spot* card over the room's MLS seam is untouched (§8, §10).
- **Files lost the Cloud sub-tab.** File *storage* is now local, and the only way
  a file moves is a P2P transfer the user starts.
- **The P2P stack was untouched:** iroh QUIC + gossip, MLS, the peer-hosted onion
  transport in `p2p_tor.rs` (which never used `tor.rs`), file transfer, maps (then
  still here) and calls all came through unchanged. Device linking survived this removal too —
  it was parked three days later, for reasons of its own (below).
- **Third-party infrastructure still in use, deliberately:** iroh's n0 hosted
  relays, the Mainline DHT, and Tor's directory authorities
  ([§6](#6-is-it-truly-p2p-intermittent-nodes)) — of which only Tor's remain since
  2026-11-16 (see below). "No server" has always meant no
  *application* server; that distinction is unchanged.

### Parked — device linking & multi-device sync (2026-08-18)

Everything that made a second device *yours* moved to
[limbo/frontend/devices/](limbo/frontend/devices/) and `limbo/rust/devices/` in
one piece: QR device pairing, the device registry, the chat-log/kv convergence
between a user's own devices, and the Files → Devices per-file push/pull. Parked
whole because pairing was the only way to create a link — with it gone the rest
was unreachable code. **Zinnia is reimplementing it**, so the record is kept
where the code went: `NOTES.md` (design, the bugs that were expensive to find, a
restore checklist) beside the plan docs
[sync.md](limbo/frontend/devices/sync.md) and
[fsync.md](limbo/frontend/devices/fsync.md).

What that means for this document: there is no `device_link.rs`, no `devlink_*`
command family, no `devlink://*` events, no Devices sub-tab, and the
`devices.allow_linking` gate plus the `devlink_pair_window_secs` /
`devlink_resync_secs` settings are gone from the build config
([§15](#15-config--sources-of-truth)). One half deliberately stayed: the model
file was **split**, and its chat-history and leaf-identity helpers live on as
`packages/rakotis/src/chatHistoryModel.ts` — the sealed `chat:log` store, the
message merge, and the `user#dev-xxxxxxxx` leaf parsing the roster still uses.

### Parked — peer links (2026-08-18)

Scoped person-to-person sync — a pairwise key, a hidden gossip room and a
per-direction allow-list of what two *different* people share (calendar, contact
card, shared rooms) — moved to [limbo/frontend/peers/](limbo/frontend/peers/) and
`limbo/rust/peers/`, with its design doc at
[peer.md](limbo/frontend/peers/peer.md). Two stated reasons, and the first is the
one worth carrying forward: a grant **persisted a 32-byte pairwise link key in
each contact record** — long-lived secret material sitting where anything that
can read the contact list can read it, and outliving any single sync. The second
is plainer: it cost more to maintain than it returned. The `enigma/plink/0` ALPN,
the `peer_*` commands, the `peers.enabled` gate and the `peer_resync_secs`
setting all went with it. A revival should start by asking whether the link key
needs to persist at all.

Not to be confused with device linking, which assumes both ends are the same
person and therefore filters nothing. The two families were deliberately
domain-separated in their HMAC labels (`enigma/plink/v1/kp` vs
`enigma/devlink/v1/kp`) so a proof minted for one could never be replayed into
the other — a test in the parked set still pins that.

### Moved to Vesper — calls, DHT, contacts, calendar (2026-11-16)

Enigma became chat and files only, over iroh or Tor (Tor only since 2026-11-22/23), in one edition. Voice calls
(Vox), the Mainline DHT (room codes, nickname directory, presence), contacts and
direct room invites, the room calendar (meetings, polls), iroh's hosted n0 relays
and discovery, and the Professional/Standard editions were removed; Vesper keeps
them. Invitations, file transfer, Tor and PIN unlock stayed. Last commit with
all of it: `998d5360da06f571f5d0c21f5d012888b8e5e453`.

### Removed — Privacy HP (2026-11-22)

The exposure budget (two meters, a price beside every exposing control, a
ledger in the vault) was dropped to keep the app simple. Its price table
(`privacy_hp.yaml`), the `hp_*` commands, the header chip, the Privacy page and
the welcome page's meters went with it. A profile that used it keeps a sealed
`hp` namespace in its vault that nothing reads any more; it goes with the rest
of the vault when the profile's data is cleared.

### Moved to Morion — maps (2026-10-03)

The Map tab left this app and became Morion's map viewer. It was not parked:
nothing of it is under `limbo/`, and the code went rather than waited.

**What went:** `maps.rs` and its ten `map_*` commands, the `maps` build
feature and the `pmtiles` crate, the Map tab (`EnigmaMapView`, `MapPanel`,
`RegionsPanel`, the pin form, the shared layer), `stores/map.ts`, rakotis'
`mapModel.ts` and `mapData.ts`, the map storage-limit setting, the
`data.delete.maps` Privacy HP credit, `maplibre-gl` and
`protomaps-themes-base`, the bundled glyphs and sprites, and
`tools/map_packager`, which is now in Morion's repository.

**What it became there** is a different shape, not a copy. Enigma imported a
package into a private library, kept the region list and the pins in its
encrypted store, and let a room share pins, places and region files. Morion
opens a map as a file in a workspace and keeps what is drawn on it — pins,
routes, zones — in that file. There is no sharing in Morion; the room cards
went with the tab.

**What stays here, on purpose:**

- The three message types — `map_pin`, `map_loc`, `map_region` — are still
  *known* (`chatHistoryModel.ts`, `MAP_SHARE_TYPES`). They are in stored
  histories and can still arrive from a peer on an older build, and an
  unknown type would be dropped: a history would silently lose entries. Such
  a message is kept as a card that says it cannot be shown; its payload is not
  read or stored, and nothing can send one.
- The geolocation guard (`tests/e2e/noGeolocation.spec.ts`). It lived with the
  Map tab's tests, but the promise is the app's.
- `WEBKIT_DISABLE_DMABUF_RENDERER=1` in `main.rs`. It was set for the map's
  WebGL canvas; it also changes how the whole window is composited on the GPU
  stacks it was written for, and the app has not been run without it.

**What is left behind in a profile that used the tab** is in
[§13](#13-encryption-at-rest-gervasius--protasius): the region blobs, which
open in Morion as they are, and the pins, which have no way out.

---

## 18. Invitations — encrypted, expiring, revocable

The only way into a room. An **invitation** carries no room name and no MLS
material, is checked against the *inviter's own* clock at redemption, and can be
revoked or spent exactly once. (Room tickets, which were permanent bearer codes with
the plaintext room name, were removed on 2026-11-22/23.)

Two kinds, because the honest claim differs:

- **Personal** — the whole body is sealed to the recipient's device id. Nobody
  else who photographs it can read it, and **no decryption key travels with it**:
  the recipient opens it with the secret behind their own device id, which was never
  in the QR. A real confidentiality claim.
- **General** — a transferable bearer code in **cleartext**. There is no
  recipient to seal it to, so it is not confidential, is not claimed to be, and
  the UI says so. Whoever sees it learns the inviter's device id and onion.

### 18.1 The ticket

```
base32-nopad-lowercase( TAG(0x4E) || FORMAT_V(0x01) || KIND || body )
  KIND 0x50 'P' → body = seal_to(recipient_x25519, AAD, postcard(InviteBody))
  KIND 0x47 'G' → body = postcard(InviteBody)
  AAD = [TAG, FORMAT_V, KIND]        (so a sealed body cannot be relabelled)

InviteBody { invite_id[16], capability[32], inviter, onion, issued_at, expires_at }
  inviter = the inviter's device id (Ed25519 public key, 64 hex digits)
  onion   = the inviter's onion for the room (no IP)
```

**Never carried:** room name, MLS material, or the recipient's identity — a Personal
ticket must not name its own recipient, or a photograph would reveal who was
invited. `JoinRoomModal`'s one paste/scan field recognises an invitation by its tag
byte.

The **version byte sits outside the seal** on purpose: a v2 ticket handed to a v1
build must say "this needs a newer version" rather than failing as corrupt, and
that decision cannot wait on a key we may not have.

**`expires_at` here is advisory.** It drives the countdown and nothing else — a
bearer can edit their own copy, and on a General ticket it is not even
authenticated. Only the inviter's record decides.

### 18.2 Sealing (`gervasius::seal`)

Ephemeral-static X25519 → HKDF-SHA256 → the crate's existing XChaCha20-Poly1305:

```
sealed = eph_pk(32) || nonce(24) || ciphertext+tag
key    = HKDF-SHA256(ikm = X25519(eph_sk, recipient_pk),
                     salt = eph_pk || recipient_pk, info = …/v1)
```

Both public keys go into the salt, so a ciphertext is bound to the recipient it
was made for and cannot be re-pointed by rewriting the ephemeral header.

**Identity keys are reused for encryption.** A recipient is named by its **device
id**, an Ed25519 *signing* key (`device.rs`), so `x25519_from_ed25519_pk` maps it to
Curve25519's Montgomery form — the standard birational map (age does the same for
`ssh-ed25519`; libsodium ships it as `crypto_sign_ed25519_pk_to_curve25519`). The
signing side is Ed25519 over the Edwards form and the sealing side is X25519 ECDH
over the Montgomery form; they use disjoint hash prefixes and neither protocol
interprets the other's messages. The alternative — a second key per contact,
distributed and verified out of band — is a channel Enigma27 does not have. The
recipient gives the inviter its device code (Settings → "My code").

Small-order keys are refused at both conversion and seal time; note that roughly
**half of all 32-byte strings are valid curve points**, so a successful conversion
is not a device-id validator and is not used as one.

Forward secrecy is **one-sided**: the ephemeral key is discarded, but the
recipient's is long-lived, so a later compromise opens any captured blob. Right
for something that expires in hours; wrong for a long-term secret.

### 18.3 Redemption

The redeemer dials the ticket's `onion` with `Hello{kind:"redeem"}` — the same
onion and port as the room's links, routed by `kind` ([§11](#11-the-tor-mesh-and-vanguards)).

```
inviter  → redeemer : challenge (32 random bytes)
redeemer → inviter  : invite_id, node_id (the redeemer's device id), key_package, name,
                      sig   = Ed25519(device key, challenge)
                      proof = blake3::keyed_hash(capability,
                                  invite_id ‖ challenge ‖ node_id)
inviter checks, under one lock:  signature → state → expiry (INVITER's clock)
                                 → recipient binding → proof
                                 → CAS Active → InFlight
inviter  → redeemer : welcome ‖ room name ‖ every member's onion — or a refusal code
```

**The capability never crosses the wire.** What travels is a MAC over a fresh
challenge *and* the redeemer's device id, so a captured proof cannot be replayed by
the same holder (new challenge) or reused by a different one (different device id).

**The signature exists because of Tor.** **Tor authenticates the server, not the
client** — an onion stream carries no client identity, so without a signature
"recipient binding" would reduce to the redeemer *claiming* to be the recipient.

**One-use is a lease, not a burn.** `Active → InFlight(60 s) → Consumed`. Two
racing redeemers: exactly one takes the lease. A failed MLS round lets the lease
lapse back to `Active` rather than destroying the invitation over someone else's
bad network. The inviter waits for the MLS add at most the user's connect timeout.

**The grant carries every member's onion**, so the joiner links to all of them at
once, not only to the inviter; after that, presence keeps the list current.

### 18.4 Admission, and the KeyPackage ordering problem

Rust performs every check, then parks and asks the frontend, because admission is
an MLS group operation whose commit must reach the room's existing members over
the room's links — both `useChatChannel`'s. The inviter needs its own session
loaded, which it has from the moment it entered the room (MLS starts on entry, not
on a link); Enigma26 waited for `ready` here and deadlocked.

The redeemer has to produce a **KeyPackage before it knows which room it is for**,
since the QR deliberately does not name one until the capability is proven. So it
builds a session under a scratch key (`invite:<inviter>:<expiry>`), and
`mls_adopt_session` re-files it onto the real room once the grant names one — that
session is the one holding the KeyPackage's private init key. It refuses to
overwrite an existing session: adopting onto a room we are already in would
discard live group state.

### 18.5 State

`vault::get/put` under ns `invites` — the protasius **internal** tag, so the
webview can neither read nor forge invite state.

The **capability itself is stored**, not just a hash. Verifying a keyed MAC needs
the key; an issuer holding only a hash could not check the proof, and the protocol
would have to fall back to the redeemer transmitting the raw capability — losing
the challenge binding to protect a secret the vault already protects, alongside
the MLS state and the device key.

Retention runs from the **terminal event** (`Consumed{at}` / `Revoked{at}`), not
the deadline: an invitation revoked today but issued with a year to run is
finished today.

### 18.7 Limitations

1. **The inviter must be online AND have the room open.** There is no
   store-and-forward ([§16](#16-history--the-serverless-rework)). An invitation is a
   rendezvous, not a message left for someone. The share card says so.
2. **A General invitation is not confidential.** Cleartext by construction; there
   is no recipient to seal it to. Sealing it under a key printed beside it would
   be theatre. It also gives away the inviter's onion for the room, which anyone can
   then connect to ([§11](#11-the-tor-mesh-and-vanguards), known limitations).
3. **Admission is app convention** (§18.8): every member refuses key packages from
   the mesh, but a member on a modified build could still add someone.
4. **`expires_at` in the QR is advisory** (§18.1). Only the inviter's record
   decides.
5. **Identity-key reuse** (§18.2) is a deliberate, documented trade.
6. **Forward secrecy is one-sided** (§18.2).
7. **A member can always re-share.** After admission the redeemer holds the room
   name and every member's onion, as every member must. The invitation controls
   *admission*, not what a member does afterwards.

### 18.8 Invite-only rooms

Every room is invite only; there is no switch any more (it rode the captain's
`room_meta`, which went with moderation on 2026-11-22/23). Every member refuses
`mls_key_package` frames from the mesh outright. The only way in is a redeemed
invitation — which does not use the room's links at all, so the refusal does not
close the invitations.

**Enforcement sits above the admin split** in the `mls_key_package` handler. That
placement is the point: a guard below it would close the branch that *adds* while
leaving the branch that *defers* still answering a stranger with our own key
package — a half-closed door. Headless channels (Teutates' certified roster) are
exempt; they carry their own `admissionCheck`.

**A refused joiner is told nothing by the room.** No member has to confirm to a
stranger that a room exists, and there is no unauthenticated frame for anyone to
forge.

**What it does not guarantee.** Every member enforces independently, so the
guarantee is only as strong as the weakest member's client: a member running a
modified build can still add someone, as OpenMLS in this configuration lets any
member commit an add ([§9.3](#9-security--privacy-considerations)). Room info says
"Everyone in the room enforces this, so it holds as long as they are all running
this app" rather than "only people you invite can join".

---

## 18a. Shared room engine (Enigma and Teutates)

Since Belisario `dev_teuta4` step 2, Teutates' chat runs on Enigma's room engine. In
Pharos only Enigma27 uses it, and the options below stay as they were (off by
default); what Teutates needed from the Rust side is reduced to `mls` and
`admission`:

- **The protocol** stays rakotis' `useChatChannel` (`packages/rakotis`). Teutates imports its
  modules by path (`rakotis/*` aliases in `apps/teutates`), and injects what Enigma's Tauri
  shell otherwise provides: `transport`, `crypto` (both default to Enigma's `chatTransport` and
  `cryptoService`) and a kv backend (`setKvBackend` in `services/localDb.ts`).
- **The Rust half** is `crates/enigmatite` (no tauri): `mls` — the per-(room, identity) rotor
  session registry behind Enigma's `mls_*` commands (Enigma keeps its command names and
  protasius store); `admission` — a key package's proof by a device key. (Its `events` and
  gossip `gateway` modules went with iroh on 2026-11-22/23.)
- **Options Teutates added** (all off by default, so Enigma's rooms are unchanged):
  `openAdmission` + `admissionCheck` (a certified roster instead of invitation-only; the
  lowest live member adds), `keepSession` (the group survives a restart: no new handshake — Enigma27 now does this always),
  `mayFound`, `mailbox` (a server's room mailbox in Demio's format
  `{"kind":"demio-room","room","frame"}`, `mailbox.ts`; key packages and Welcomes go there too),
  `threads` (`#tags`, `@mentions`, the sender's device on messages), `inlineFiles` (≤ 256 KiB,
  Demio's `file_inline`), `rosterNotices` (who joined/left on commits, our own removal) and
  `enforceRoster(users)` (re-key on leave). The frames are the same in both apps, so an Enigma
  device and a Teutates device read the same frames (an Enigma device still admits only by
  invitation); they no longer share a transport.
- **Fakes** for tests and demos: `fakes.ts` (`MemHub`, `MlsWorld`/`fakeMls`, `memKv`) and
  `MemMailbox`; `tests/unit/sharedOptions.test.ts` covers the options.

## 19. Run, build and test

How to run Enigma27 in development and package it into installable artifacts. A
"build" compiles the frontend (`vue-tsc` + Vite) and the Rust core, then bundles
them.

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 20+ (CI uses 22) | frontend build (Vite) + Tauri CLI |
| Rust | stable | Tauri core + `rotor-core` |
| System libs (Linux desktop) | — | WebKitGTK stack + bundling tools |

Debian/Ubuntu desktop deps:

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev pkg-config build-essential curl file
```

**Nothing is fetched at build time but crates.io and npm.** The crypto crates
(`crates/rotor/rotor_core`, `crates/gervasius`, `crates/protasius`,
`crates/enigmatite`) and the shared front-end package (`packages/petalite`) are in
this repository and consumed by path, as is the `rakotis` workspace package. The
whole build is offline-friendly once crates.io/npm are cached. arti downloads
nothing at build time; at run time it fetches the Tor consensus.

Android has its own, larger toolchain (JDK 17, Android SDK/NDK, cargo-ndk) — see
[Android](#android--toolchain-setup--build) below.

---

### First-time setup

```bash
npm ci                        # once, at the repo root — sets up the workspace + all packages
```

`./run_dev.sh` and `./build.sh` do this themselves when the root
`node_modules` is missing, so a fresh clone can go straight to either.

`rakotis` is an in-repo workspace package (`packages/rakotis`); npm symlinks it
into the app's `node_modules`, so edits to its source are picked up immediately —
no rebuild step.

---

### Run (dev)

```bash
./run_dev.sh                  # from the repo root: profile "default" (./run_dev.sh bob for another)
apps/enigma/run_dev.sh        # the same, with --dual / --reset / --purge
```

Both run `tauri dev` inside `apps/enigma`: Vite starts on
`http://localhost:1420` and Tauri opens the native window pointed at it. Frontend
edits hot-reload; Rust edits trigger a rebuild.

> The first launch compiles the full Rust dependency tree (incl. OpenMLS and arti)
> and is slow. Later runs are incremental. After unlock, Tor bootstraps in the
> background: seconds with a warm cache, up to a minute cold.

The launchers work from VS Code's integrated terminal even when VS Code is the
snap: they restore the environment the snap overrides before starting the app
(`scrub_snap_env` in [scripts/lib.sh](../../scripts/lib.sh)). Without that the build
succeeds and the window never opens — see [Troubleshooting](#troubleshooting).

#### Profiles & two-instance pairing

Two env vars isolate instances so you can pair two on one machine:

| Var | Default | Effect |
|---|---|---|
| `APP_PROFILE` | `default` | Storage namespace (separate encrypted store / profile dir) |
| `CHAT_USER` | the profile name | MLS identity |

```bash
apps/enigma/run_dev.sh --dual             # two instances at once: profiles alice + bob
apps/enigma/run_dev.sh --dual carol dave  # …with other names
# or from the repo root, one per terminal:
./run_dev.sh alice
./run_dev.sh bob
```

`--dual` gives each instance its own profile, identity and Cargo build
directory (`target-<profile>`, so neither waits on the other's link — about
8 GB each), and both share **one** Vite server: the first instance starts it,
the second reuses it. Because that server belongs to the first instance, the
two are tied together — Ctrl-C, or either window closing, stops both, and the
script takes every process it started down with it.

#### Starting over (`--reset`) — new passphrase, clean cache

There is no "forgot my passphrase" flow: the passphrase wraps the store's DEK,
so a fresh one means a fresh store. `apps/enigma/run_dev.sh` takes a flag for it
(the root `./run_dev.sh` takes only a profile name):

```bash
cd apps/enigma
./run_dev.sh --reset              # reset profile "default", then run
APP_PROFILE=alice ./run_dev.sh --reset
./run_dev.sh --dual --reset       # reset BOTH profiles (alice + bob), then run
./run_dev.sh --dual --reset carol dave   # flags mix with the names, any order
ENIGMA_RESET=1 ./run_dev.sh       # env equivalent (ENIGMA_RESET=purge for --purge)
```

The next start is a **first run**, so the app asks you to set a new passphrase.

| | |
|---|---|
| **What it clears** | `profiles/<profile>/` (protasius store, `vault.json`, `profile_state.json`, `tor/`) and the global webview caches (`WebKitCache`, `CacheStorage`, `storage`, …) |
| **What it keeps** | anything at the app-data root outside `profiles/` (e.g. a legacy `kvstore/` from an old build) — it is **global**, shared by every profile |
| **Default is archive** | the profile dir is renamed to `<profile>.reset-<UTC stamp>`, not deleted — a dev vault holds a real identity (device key, onion keys, MLS state, room history) and a mistyped profile name should not be unrecoverable |
| **`--purge`** | deletes instead, and asks you to type `purge` to confirm (`-y` skips the prompt). Use it when the archives pile up |

The work is done by `scripts/reset_profile.sh`, which both launchers call before
they start anything (the app holds the store open while it runs). You can call
it directly: `scripts/reset_profile.sh [--purge] [-y] <profile>…`. It reads the
bundle identifier from `tauri.conf.json` rather than hardcoding the data
directory, and refuses a profile name containing a path separator.

To wipe *everything* Enigma27 owns, including the global bits, use the app's own
panic code (Settings → Lock) instead — that is the audited path.

#### Invitation quick-start

1. **A**: Chat → *New chat* → name it → **Create**. The room's onion launches; the
   room is encrypted (a group of one) at once. Make an invitation: *shareable*, or
   *private* with B's device code (B: Settings → Settings → "My code").
2. **B**: Chat → *Join a chat* → scan the QR (camera / image) or paste the text.
   B redeems it against A's onion; A must be running with the room open. A freshly
   created onion takes 30–90 s to be reachable, so the first try may wait.
3. Both sides show **Encrypted** and, once their link is up, **Linked**.

The onions are stable and saved per room, so after a restart each side reopens the
room and links to the other again — no new invitation, no server, no accounts.

#### Browser-only mode (UI shell, no P2P)

```bash
npm run dev -w enigma        # http://localhost:1420
```

Plain Vite with no Tauri runtime — renders the UI shell only. Tor and MLS need
the Rust backend, so chat does not function here; use it for pure-frontend work.

#### Android emulator

One-time SDK/NDK/Java setup is [below](#android--toolchain-setup--build). Tauri
finds the SDK and NDK through `ANDROID_HOME` and `NDK_HOME`; an x86_64 AVD (the
examples use one named `Pixel_9`) needs the `x86_64-linux-android` Rust target.

```bash
"$ANDROID_HOME/emulator/emulator" -list-avds
rustup target list --installed | grep android
```

**Boot it** with a software GPU (works without a physical one) and without
persisting snapshots, so each run is a clean boot. It has to stay up for the
whole session:

```bash
"$ANDROID_HOME/emulator/emulator" -avd Pixel_9 \
  -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect &
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 5; done
adb devices          # -> emulator-5554   device
```

**Build, install and run**, from `apps/enigma/`:

```bash
npm run tauri android dev
```

Tauri detects the emulator and its ABI, runs the `beforeDevCommand` (the Vite
dev server on `:1420`, reverse-tunnelled to the device with `adb reverse`),
cross-compiles the Rust library, builds the APK with Gradle, installs and
launches it (`Starting: Intent { cmp=com.spectrumaipl.enigma27/.MainActivity }`).
Frontend edits hot-reload; Rust or native Android changes trigger a rebuild. The
first build compiles the whole Rust tree for Android and is slow.

**Drive and inspect it** with adb:

```bash
adb exec-out screencap -p > /tmp/enigma.png          # screenshot
adb shell input tap 993 222                          # tap a point (device pixels)
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1        # 0 = portrait, 1 = landscape
adb shell wm size; adb shell wm density              # screen geometry
adb shell am start -n com.spectrumaipl.enigma27/.MainActivity   # relaunch
```

**Shut down:** stop `npm run tauri android dev`, then `adb emu kill`.

---

### Build configuration (`build_config.yaml`)

[`apps/enigma/src-tauri/build_config.yaml`](apps/enigma/src-tauri/build_config.yaml)
is the compile-time build config: `build.rs` parses + validates it and generates
Rust consts (`enigma_lib::build_config`); the shipped binary never re-reads the
file. **An invalid or missing file fails the build** with the offending YAML paths
listed.

It is the same for every build and holds only what rarely changes:

- `crypto` — declared algorithms are **compile-asserted** against the
  rotor_core/gervasius crates (editing the strings can't change the crypto; drift
  in either direction is a build error). Argon2id costs apply to newly created
  vaults only.
- `network` — frame cap (**wire-interop**: all peers must agree), onion port,
  Tor timeouts.
- `settings` — default and bounds of each user-tunable setting. The profile's
  encrypted store holds the live value; these seed and clamp it.

There is no `defaults:` section any more: the toggles it held (use Tor, stable
onion, file integrity) were removed — all three are always on.

What it does **not** hold: how a build is packaged ([dromon.yaml](dromon.yaml) —
below), and the app's name, identifier and version
(`tauri.conf.json`, which `build.rs` reads directly and holds to the fixed
identity). [§15](#15-config--sources-of-truth) lists every owner.

#### Features and presets

None: Enigma has one edition ([§20](#20-features-and-presets)).

#### One fixed app identity

Every build is the same installable app:

| Value | Fixed setting |
|---|---|
| App name | `Enigma27` |
| Bundle identifier / Android package id | `com.spectrumaipl.enigma27` |
| Desktop binary name | `enigma27` |
| Data directory | `…/com.spectrumaipl.enigma27/` |

`build.rs` rejects a
`tauri.conf.json` that tries to change the name or identifier.

> **Moving existing data.** The package id changed from
> `com.spectrumaipl.enigma` to `com.spectrumaipl.enigma27`. Existing desktop
> data is not deleted; the new build looks in a new app-data directory. To carry
> a profile across:
> ```bash
> mv ~/.local/share/com.spectrumaipl.enigma/profiles/default \
>    ~/.local/share/com.spectrumaipl.enigma27/profiles/default
> ```
> Or just start fresh with `./run_dev.sh --reset`.

#### Building

There is one way to build: `./build.sh enigma`, from the repo root. There are no
build flags — [dromon.yaml](dromon.yaml) is the whole interface. The build itself is
Dromon's (`dromon/dromon.mjs`); `./build.sh` checks the toolchain first (`install.sh`).

```bash
./build.sh enigma            # from the repo root, as dromon.yaml says
./build.sh enigma --dry-run  # print the commands it resolves to, run none
npm run build              # -> ./build.sh
```

```yaml
variants:
  default:
    output_dir: dist/enigma   # packages land in dist/enigma/enigma/ with a SHA256SUMS and build.json
    forbid_crates: [mainline, rustfft]
    test: false               # run the frontend + Rust suites first
    desktop:
      enabled: true
      profile: release        # release | debug
      bundles: [deb, rpm]     # this host's formats only
    android:
      enabled: false
      profile: debug          # debug | release (release needs a signing key)
      abis: [aarch64]
      signing: debug-key      # debug-key | release-key | none
```

Every key, what is validated and what each step runs is documented with the
tooling: [dromon/README.md](../../dromon/README.md). An unknown key,
value is an error that names its path, never a silent default
([dromon/README.md](../../dromon/README.md)).

The **app icon is fixed** — not a per-build choice. One mark, whose master is
[`apps/enigma/app-icon.png`](apps/enigma/app-icon.png); the generated sizes
under `src-tauri/icons/` are committed. Changing it is a code change:
[§23](#23-app-icon).

---

### Desktop build

Set `desktop:` in [dromon.yaml](dromon.yaml) and run:

```bash
./build.sh enigma
```

`profile: debug` gives a faster, unoptimized bundle. The frontend build runs
automatically via Tauri's `beforeBuildCommand`.

Which formats come out is `desktop.bundles` in dromon.yaml (falling back to
`bundle.targets` in `tauri.conf.json` when the key is omitted). The build fails
if *no* package appears, but not if fewer appear than you expected — read the
"Built" list it prints before a release. Output, also copied to
`dist/enigma/enigma/`:

```
apps/enigma/src-tauri/target/release/bundle/     # release
apps/enigma/src-tauri/target/debug/bundle/       # profile: debug
  deb/Enigma27_<ver>_amd64.deb
  rpm/Enigma27-<ver>-1.x86_64.rpm
  appimage/Enigma27_<ver>_amd64.AppImage         # only if "appimage" is in bundle.targets
```

#### Piecemeal (frontend / Rust separately)

```bash
npm run build -w rakotis                 # vue-tsc typecheck (shared package)
npm run build -w enigma                  # vue-tsc --noEmit && vite build (frontend only)
( cd apps/enigma/src-tauri && cargo build )          # Rust debug
( cd apps/enigma/src-tauri && cargo build --release ) # Rust release
```

The frontend build emits `apps/enigma/dist/` (`index.html` + assets); Tauri reads
it via `frontendDist: "../dist"`.

---

### Android — toolchain setup & build

Building an Android APK/AAB from an Ubuntu dev machine.

#### Toolchain overview

| Tool | Version | Purpose |
|---|---|---|
| Java (OpenJDK) | 17 | Gradle & Android build tools |
| Android Studio | 2024.3.x | SDK manager UI (optional but recommended) |
| Android SDK | platform 35 | Android platform headers |
| Android NDK | 27.2.12479018 | Native (C/Rust) cross-compilation |
| Android Build Tools | 35.0.0 | `aapt2`, `d8`, `apksigner`, `zipalign` |
| CMake | 3.31.6 | Required by NDK toolchain |
| Rust | stable | Tauri Rust core + the repo's crates |
| cargo-ndk | latest | Rust → Android NDK bridge |

#### One-time setup (scripted)

```bash
bash tools/android/setup_java.sh              # OpenJDK 17 (+ JAVA_HOME in ~/.bashrc)
bash tools/android/install_android_studio.sh  # Studio, SDK 35, NDK, build tools, CMake, i386 libs
bash tools/android/setup_rust_android.sh      # rustup Android targets + cargo-ndk
bash tools/android/patch_cargo_android.sh     # Cargo.toml Android-compat check
source ~/.bashrc
```

Environment written to `~/.bashrc` / `~/.profile` (full reference):

```bash
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk-amd64"
export ANDROID_HOME="${HOME}/Android/Sdk"
export NDK_HOME="${ANDROID_HOME}/ndk/27.2.12479018"
export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"
```

Verify:

```bash
java -version                                   # must print "openjdk 17..."
sdkmanager --list_installed
ls "$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/" | grep aarch64
rustup target list --installed | grep android   # aarch64 / armv7 / x86_64 / i686
cargo ndk --version
```

Native-dependency notes: `webkit2gtk` is Linux-only (cfg-guarded; Android uses the
system WebView); `cpal` uses the `oboe-shared-stdcxx` feature on Android (already
declared in `Cargo.toml`); arti's transitive `rusqlite` is pinned `bundled` on
Android (the NDK ships no `libsqlite3` — the pin compiles SQLite from source); all
repo's crates are pure Rust and cross-compile fine.

#### Build the APK / AAB

Set `android.enabled: true` in dromon.yaml — with
`profile` and `abis` — and run `./build.sh enigma`. That calls:

```bash
bash tools/android/build_android.sh enigma debug                    # debug APK, aarch64
bash tools/android/build_android.sh enigma release aarch64,x86_64   # release APK + AAB
```

`build_android.sh <app> [debug|release] [abi-spec]` runs `npm install`,
`tauri android init` (first time only — the generated project under
`src-tauri/gen/android/` is committed), then `tauri android build`. Valid ABIs:
`aarch64` (modern phones), `x86_64` (emulator), `armv7` (old 32-bit), `i686`
(32-bit emulator), or `all`.

Output — the selected ABIs are packed into ONE `universal` APK (Gradle's
`universal` flavour), so the paths do not vary with `abi-spec`:

```
apps/enigma/src-tauri/gen/android/app/build/outputs/
  apk/universal/debug/app-universal-debug.apk
  apk/universal/release/app-universal-release.apk     # release only
  bundle/universalRelease/app-universal-release.aab   # release only
```

`build.sh` copies these into `dist/enigma/enigma/` with the app name in place of
Tauri's generic `app-` prefix (`enigma-universal-release.apk`), because the
Tauri names are identical between apps.

#### Signing a release build

Release signing **fails closed**: with no keystore configured, a release build
is refused before any work starts, and the SDK debug key (publicly known) is
rejected for release outright — by path, filename, or the `androiddebugkey`
alias. Debug builds keep the debug key and are unaffected.

One-time setup, with the stdlib-only checker the build itself calls
([tools/android/android_signing/](../../tools/android/android_signing)):

```bash
SIGN="python3 tools/android/android_signing/signing_cli.py"
GEN=apps/enigma/src-tauri/gen/android

# Mint a release keystore (outside the repo, chmod 600, RSA 4096) — the tool
# warns loudly: losing this key permanently orphans every distributed install.
$SIGN create

# Would a release sign, and where does each credential come from?
$SIGN status --gen $GEN

# Build a signed release (android: { enabled: true, profile: release } in
# dromon.yaml). Artifacts are verified with apksigner afterwards and the report
# prints package, version, signer and SHA-256 fingerprint.
./build.sh enigma

# After confirming the first build, pin the fingerprint (committed file) so a
# swapped or regenerated keystore FAILS the build instead of shipping:
$SIGN pin --pin-file apps/enigma/deploy/android-release-key.properties --from <apk>

# Inspect any artifact:
$SIGN verify <apk-or-aab>
```

Credentials resolve per key from: a `${VAR}` placeholder in
`gen/android/keystore.properties` → the `ENIGMA_KEYSTORE_FILE` /
`ENIGMA_KEYSTORE_PASSWORD` / `ENIGMA_KEY_ALIAS` / `ENIGMA_KEY_PASSWORD`
environment variables → a literal in `keystore.properties` → 
`~/.config/enigma-builder/signing.properties` (must be chmod 600). Passwords
never live in source control and never appear on an argv.
`gen/android/keystore.properties.example` is the committed template and
documents the four keys; `signing_cli.py --help` lists the commands.

An **unsigned release** for internal inspection is a deliberate act, never a
fallback: `signing: none` under `android:` in dromon.yaml
(`tools/android/build_android.sh enigma release aarch64 --allow-unsigned-release`).
It installs nowhere, says so loudly, and still refuses the debug
key. The pinned fingerprint lives in
`apps/enigma/deploy/android-release-key.properties` — deliberately outside
`gen/android`, which `tauri android init` regenerates.

#### Install & inspect on a device

```bash
adb devices
adb install apps/enigma/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb logcat -s RustStdoutStderr enigma
```

---

### CI builds

GitHub Actions, in the repo root's `.github/workflows/`:

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every push | `./tests.sh js` and `./tests.sh rust` |
| `release.yml` | a `v*` tag | Enigma27 for Linux and Windows (`tauri build`), Beacon for arm64 (binary and `.deb`) |
| `real-tor.yml` | by hand | `./test_tor2.sh`: two instances over the real Tor network |

Android is not built in CI.

---

### Tests

```bash
./tests.sh                    # from the repo root: every Pharos suite (js | rust), a table at the end
apps/enigma/tests.sh          # Enigma's long run, with a pass/fail table at the end
apps/enigma/tests.sh rust py  # only these groups (js | rust | py | build)
apps/enigma/tests.sh --list   # the steps and the command each one runs
./test_tor2.sh                # two instances over the real Tor network (needs Tor access; minutes)
```

`tests.sh` keeps going after a failure, so one run tells you everything that is
broken, and saves each step's output under `test-results/tests/`. The steps, for
running one by hand:

```bash
npm test                                   # all workspaces
npm test -w enigma                         # vitest: chat store, components, i18n, …
npm test -w rakotis                        # vitest: transport bridge, storage, i18n
cargo test -p enigma                       # Rust: mesh, invitations, files, kv, …
cargo test -p protasius -p gervasius -p rotor-core -p enigmatite   # the shared crates
python3 -m pytest apps/enigma/scripts/android_signing/tests   # Enigma's signing contract
npm run test:e2e -w apps/enigma            # Playwright smoke tier (no backend — there is none)
./test_tor2.sh                             # mesh_live.rs: Hello/Ready and frames both ways over real Tor
```

---

### Troubleshooting

**Dev:**

- **Port 1420 already in use** — a stray Vite server is running.
  `npm run dev:tauri` reuses an existing server on `:1420`; otherwise kill the
  process holding the port (`lsof -i :1420`) and relaunch.
- **Window opens blank / WebKit errors** — the WebKitGTK dev libs above are
  missing or mismatched; reinstall them.
- **Every `npm` command dies with `Cannot find module 'graceful-fs'`** — npm
  itself is broken, not the repo: npm keeps its own dependencies in a
  `node_modules` beside it, and a disk cleanup that deletes every `node_modules`
  it finds takes that one too. Reinstall the Node version
  (`nvm install <version>`); the launchers detect this and say so.
- **`sh: 1: vite: not found` / `tauri: not found`** — the root `node_modules` is
  gone (same cleanup, usually). `npm ci` at the repo root; the launchers do it
  themselves when the directory is missing.
- **Build succeeds, then `symbol lookup error: /snap/core20/…/libpthread.so.0:
  undefined symbol: __libc_pthread_init`** — the app was started with a snap's
  GTK environment (VS Code's integrated terminal, when VS Code is the snap).
  `run_dev.sh` undoes that itself; a binary
  started by hand from such a terminal still needs a normal shell.
- **First Rust compile is very slow / high memory** — expected for the initial
  build; subsequent runs are incremental.

**Desktop build:**

- **`No space left on device` / linker (`collect2`) failure at the final link** —
  the release binary link step is large; this is almost always **disk space, not a
  code bug**. Free space (clear `target/`, docker/build caches) and retry.
- **`build_config.yaml is invalid` / `not found`** — the compile-time build config
  failed validation; the panic message lists the offending YAML paths (see
  [Build configuration](#build-configuration-build_configyaml)).
- **`rotor-core` build error** — it's the in-repo crate at
  `crates/rotor/rotor_core` (no fetch involved); reproduce in isolation
  with `cargo check -p rotor-core` from the repo root.
- **`webkit2gtk` / `soup` not found** — install the desktop system libs above.
- **`frontendDist` doesn't exist** — the frontend build didn't run/produce
  `apps/enigma/dist/`; run `npm run build -w enigma` (or a full `./build.sh`).

**Android:**

- **`ANDROID_HOME` / NDK not found during `tauri android build`** —
  `source ~/.bashrc`, or export `ANDROID_HOME`/`NDK_HOME` per the reference above.
- **`linker aarch64-linux-android-clang not found`** — NDK not on PATH or wrong
  version; confirm with `ls "$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/" | grep aarch64`.
- **`ld.lld: unable to find library -lsqlite3`** — the Android `rusqlite { bundled }`
  pin in `Cargo.toml` is missing/removed; restore it.
- **`webkit2gtk` compile error when targeting Android** — should not happen (it's
  cfg-guarded to Linux); verify you're running `tauri android build`, not plain
  `cargo build`.
- **Gradle Java version mismatch** — `JAVA_HOME` must point at JDK 17 (not 11/21);
  re-run `tools/android/setup_java.sh`.

---

## 20. Features and presets

**One edition since 2026-11-16.** The crate has no optional cargo features and
[dromon.yaml](dromon.yaml) one variant (`./build.sh enigma`). Enigma is chat and
file transfer, always over Tor, with PIN unlock; voice calls, the
DHT, contacts, the calendar and iroh's hosted relays went to Vesper, and with them
the Professional/Standard split. The build still refuses to link `mainline` or
`rustfft` (`forbid_crates`), so they cannot come back with a merge. The last commit
with the two editions is `998d5360da06f571f5d0c21f5d012888b8e5e453`.

## 21. Releasing

This is the maintainer checklist for producing Enigma27 desktop and Android
release artifacts. For toolchain setup and lower-level build notes, see
[§19](#19-run-build-and-test). For end-user installation, see [§22](#22-installing).

### Release Goals

A release artifact should be:

- built from a known commit;
- versioned consistently across every file that carries the version (§21.2);
- signed when Android release artifacts are produced;
- smoke-tested on the target platform;
- distributed with checksums and enough metadata to diagnose install failures.

### 21.1 Pick The Release Shape

Decide what is being shipped:

- There is one edition ([§20](#20-features-and-presets)), so no product to pick.
- Desktop only: `.deb` / `.rpm` — `desktop:` enabled in dromon.yaml.
- Android sideload/test distribution: a signed `.apk`.
- Android store distribution: a signed `.aab` uploaded to the store, plus an
  APK only when the store or test channel needs one.
- Both desktop and Android: enable both sections; one `./build.sh enigma`
  builds them in turn. See [§19](#building).

Every one of those choices is a line in [dromon.yaml](dromon.yaml) — the only
place a build is configured. Record which commit a release was built from
(`build.json` beside the packages holds it).

### 21.2 Prepare The Checkout

Start from the Enigma27 repo root:

```bash
cd /path/to/enigma
git status --short
npm ci
```

Do not release from a dirty tree unless every change is intentional. The
`dist/enigma/enigma/` output folder can contain old artifacts, so do not use
"whatever is already in dist" as the release set.

The version is a property of the code, not a build-time choice: it is bumped
with the change that earns it — dromon.yaml has no key for it.
`apps/enigma/src-tauri/tauri.conf.json` owns it: the native bundle is built from
that file and `build.rs` reads the Rust side's copy out of it. Keep these in
step by hand:

- root `package.json`, `apps/enigma/package.json`,
  `packages/rakotis/package.json`;
- `apps/enigma/src-tauri/Cargo.toml`.

Android's generated
`apps/enigma/src-tauri/gen/android/app/tauri.properties` is regenerated from
`tauri.conf.json` and tracks that version — 0.1.3 produced `1003`, so 0.1.10
produces:

```text
tauri.android.versionName=0.1.10
tauri.android.versionCode=1010
```

`versionCode` must increase for every Android update with the same
`applicationId`, or Android refuses the install as a downgrade.

### 21.3 Run Pre-Release Checks

Run the normal test gates before packaging:

```bash
npm test
npm run build -w rakotis
npm run build -w enigma
( cd apps/enigma/src-tauri && cargo test )
( cd crates/rotor/gervasius && cargo test )
( cd protasius && cargo test )
npm run test:e2e -w apps/enigma
```

For Android, also smoke-test on at least one real phone or emulator:

```bash
adb devices
npm run tauri android dev
adb logcat -s RustStdoutStderr enigma
```

### 21.4 Build Desktop Artifacts

With `desktop: { enabled: true, profile: release, bundles: [deb, rpm] }` in
dromon.yaml:

```bash
./build.sh enigma
```

Expected release output (copied to `dist/enigma/enigma/` as well):

```text
apps/enigma/src-tauri/target/release/bundle/
  deb/*.deb
  rpm/*.rpm
```

Which formats appear is `desktop.bundles` in dromon.yaml (`bundle.targets` in
`tauri.conf.json` when that key is omitted) — check the "Built" list the
command prints before a release.

An `.rpm` built on Ubuntu links against Ubuntu's glibc and webkit2gtk: it is a
package format, not a cross build, and will very likely refuse to start on
Fedora. Build each distribution's package on that distribution.

### 21.5 Configure Android Release Signing

Android release builds must be signed. Enigma27 deliberately fails closed when a
release key is missing or when the Android SDK debug key is used for a release.

Preferred flow:

```bash
SIGN="python3 tools/android/android_signing/signing_cli.py"
$SIGN status --gen apps/enigma/src-tauri/gen/android
$SIGN create
./build.sh enigma   # android: { enabled: true, profile: release, abis: [aarch64, x86_64] }
$SIGN verify <apk-or-aab>
```

After the first real signed release has been inspected, pin its upload-key
fingerprint:

```bash
$SIGN pin --pin-file apps/enigma/deploy/android-release-key.properties --from <signed-release.apk>
git add apps/enigma/deploy/android-release-key.properties
```

That pinned fingerprint is public metadata. It exists so a swapped, regenerated,
or lost keystore becomes a build failure instead of an update that strands
existing installs.

Secrets must stay outside source control. Each of the four values
(`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) is resolved on its
own, highest first:

1. a `${VAR}` placeholder in `gen/android/keystore.properties`, read from the
   environment;
2. the well-known environment variables `ENIGMA_KEYSTORE_FILE`,
   `ENIGMA_KEYSTORE_PASSWORD`, `ENIGMA_KEY_ALIAS`, `ENIGMA_KEY_PASSWORD`;
3. a literal in `keystore.properties`;
4. `~/.config/enigma-builder/signing.properties`, which is refused unless it is
   mode `0600`.

With the environment or that local file supplying everything,
`keystore.properties` can be absent entirely; the committed
`keystore.properties.example` is the only half that belongs in the repo. No
password is ever passed on an argv. Command reference: `signing_cli.py --help`
([tools/android/android_signing/](../../tools/android/android_signing)).

### 21.6 Build Android Artifacts

Set this in dromon.yaml and run `./build.sh enigma`:

```yaml
android:
  enabled: true
  profile: release
  abis: [aarch64, x86_64]
```

It runs `tools/android/build_android.sh enigma release aarch64,x86_64`.

Expected output — every selected ABI is packed into one `universal` artifact,
so these paths do not change with the ABI list:

```text
apps/enigma/src-tauri/gen/android/app/build/outputs/
  apk/universal/release/app-universal-release.apk
  bundle/universalRelease/app-universal-release.aab
```

Important defaults:

- `android.profile` defaults to `debug` and `android.abis` to `[aarch64]`.
- Debug APKs are installable for testing but are not releasable.
- `signing: none` is only for inspecting packaging output. That APK
  should be treated as installable nowhere and must never be distributed.

### 21.7 Collect And Verify Artifacts

`./build.sh enigma` clears the previous desktop bundle directory before it builds,
fails if the build leaves no package, and copies what it built into
`<output_dir>/enigma/` (`dist/enigma/enigma/`), Android artifacts
renamed from Tauri's generic `app-…` to `enigma-…`. It prints the list under
"Built".

It also writes a `SHA256SUMS` there, over **everything** in that directory —
including older installers left there by earlier builds. Treat that file as an
index of the directory, not as a manifest of this release, and publish checksums
for the exact files you ship:

```bash
( cd dist/enigma/enigma && sha256sum -- Enigma27_<ver>_amd64.deb enigma-universal-release.apk )
```

Before sharing Android files, verify package, version, signer, and fingerprint:

```bash
python3 tools/android/android_signing/signing_cli.py verify dist/enigma/enigma/enigma-universal-release.apk
```

For manual SDK inspection:

```bash
apksigner verify --verbose --print-certs <release.apk>
aapt2 dump badging <release.apk> | head
```

### 21.8 Smoke-Test The Install

Use a clean test device or emulator:

```bash
adb install -r apps/enigma/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
adb shell pm list packages | grep enigma
adb shell am start -n com.spectrumaipl.enigma27/.MainActivity
adb logcat -s RustStdoutStderr enigma
```

If the device already has a debug build, an unsigned build, or a build signed
with another key, Android may refuse the update. Uninstalling can fix the test
device, but it removes the local Enigma27 vault and room state.

### 21.9 Publish

For direct distribution:

- ship only the signed release APK;
- include `SHA256SUMS`;
- include the release signing fingerprint from verification output;
- point users to [§22](#22-installing).

For Google Play or another store:

- upload the signed `.aab` when the store expects bundles;
- keep the upload keystore and password backed up long-term;
- remember that store-generated device APKs may be signed by the store's app
  signing key, while Enigma's local pin records the upload key used by this
  build.

Tag the commit after artifacts are verified:

```bash
git tag -a v<version> -m "Enigma27 <version>"
git push origin v<version>
```

### Known Release Friction Points

#### Android Signing Identity

Android updates are keyed by `(applicationId, signing certificate)`. Losing the
release keystore, changing it without an accepted rotation path, or accidentally
using the debug key means existing users cannot update in place.

What to do:

- create and back up the release keystore before the first release;
- pin the first release fingerprint in
  `apps/enigma/deploy/android-release-key.properties`;
- verify every release artifact before upload or sharing;
- never distribute debug-signed or unsigned releases.

#### Android Package ID Is Fixed

The generated Android Gradle file declares:

```text
applicationId = "com.spectrumaipl.enigma27"
```

Every Enigma27 APK uses this one package id, so two builds do not install side
by side; one updates or replaces the other. Treat the package id printed by
`signing_cli.py verify` as the authority.

#### AAB Is Not A Direct Installer

An `.aab` is for publishing. A phone installs APKs. For sideloading, distribute
the signed release APK; for app stores, upload the AAB and let the store generate
device-specific APKs.

#### ABI Coverage

The default Android build is `aarch64`, which covers modern ARM64 phones but not
the common `x86_64` emulator and not older 32-bit phones.

What to do:

- use `aarch64,x86_64` for phone plus emulator testing;
- use `all` only when the full target set is installed and the artifact size is
  acceptable;
- diagnose `INSTALL_FAILED_NO_MATCHING_ABIS` by rebuilding for the device ABI.

#### Stale Artifact Collection

`dist/enigma/enigma/` can contain artifacts from earlier names, versions,
and signing states. A filename like `enigma-universal-release.apk` is not enough
proof that the file came from the current commit.

What to do:

- start from an empty `dist/enigma/enigma/`, or checksum only the files you ship;
- verify the exact APK/AAB that will be shared.

#### Regenerated Android Project

`tauri android init` can regenerate files under
`apps/enigma/src-tauri/gen/android/`. Enigma27 has custom signing gates in the
generated Gradle project, mirrored by `tools/android/android_signing/signing.py`.

What to do:

- run `python3 tools/android/android_signing/signing_cli.py status --gen apps/enigma/src-tauri/gen/android`
  after regenerating Android files;
- verify that release signing still fails closed when credentials are missing;
- keep signing logic in Gradle and `signing.py` in lockstep.

---

## 22. Installing

This guide is for installing Enigma27 artifacts that were produced by the release
process in [§21](#21-releasing). For building from source, see
[§19](#19-run-build-and-test).

### Choose The Right File

Use the artifact for your platform:

- Ubuntu / Debian: `.deb`
- Fedora / RHEL: `.rpm`
- Linux portable build, when produced: `.AppImage`
- Android direct install: signed `.apk`
- Android store upload: `.aab`

Do not try to install an `.aab` directly on Android. It is a publishing format;
phones install APKs.

Before installing a downloaded release, compare its checksum with `SHA256SUMS`:

```bash
sha256sum -c SHA256SUMS
```

### Linux

Install a Debian package:

```bash
sudo apt install ./Enigma27_<version>_amd64.deb
```

Install an RPM package:

```bash
sudo dnf install ./Enigma27-<version>-1.x86_64.rpm
```

Run an AppImage, when one is shipped:

```bash
chmod +x ./Enigma27_<version>_amd64.AppImage
./Enigma27_<version>_amd64.AppImage
```

If a desktop package refuses to start after installation, run the app from a
terminal and keep the output. Missing WebKitGTK or a package built on the wrong
Linux distribution is usually the first thing to check.

### Android: Install From The Device

Use the signed release APK, for example:

```text
enigma-universal-release.apk
```

Steps:

1. Download or copy the APK to the Android device.
2. Open it from Files, Downloads, a browser, or the app that received it.
3. If Android asks, allow that source to install unknown apps.
4. Tap Install.
5. Open Enigma27 and grant camera or microphone permission only when using QR
   scanning or recording voice notes.

On Android 8.0 and newer, the unknown-app permission is per source. Allowing a
browser does not automatically allow a file manager or chat app to install APKs.

On managed work phones, school phones, or enterprise profiles, the administrator
may block unknown-app installs entirely. In that case, use the approved app
store, MDM channel, or `adb` if the device policy permits it.

### Android: Install With adb

Enable Developer options and USB debugging on the phone, then connect it:

```bash
adb devices
adb install -r ./enigma-universal-release.apk
```

Useful inspection commands:

```bash
adb shell pm list packages | grep enigma
adb shell am start -n com.spectrumaipl.enigma27/.MainActivity
adb logcat -s RustStdoutStderr enigma
```

Uninstalling removes Enigma27's local vault, room state, and device-local data:

```bash
adb uninstall com.spectrumaipl.enigma27
```

Only uninstall as a last resort on a real user's device. Enigma27 is serverless, so
there is no central account that can restore local encrypted state.

### Why An APK May Fail To Install

#### The APK Is Unsigned

Android requires installable APKs to be signed. Enigma27's release build fails
closed: with no release keystore configured the build is refused before any
work starts, and the Android SDK debug key is refused for a release outright. The only way to obtain an
unsigned release artifact is to ask for it with `--allow-unsigned-release`, and
that artifact is for packaging inspection — it installs nowhere and must not be
shared.

What to do:

```bash
python3 tools/android/android_signing/signing_cli.py verify <apk>
bash tools/android/build_android.sh enigma release aarch64,x86_64
```

Share only a signed release APK.

#### The Existing App Was Signed With Another Key

Common adb symptom:

```text
INSTALL_FAILED_UPDATE_INCOMPATIBLE
```

Android treats an update as valid only when the installed app and the new APK
have the same package id and compatible signing certificate. A debug APK cannot
update a release APK, and a release APK signed by a new keystore cannot update an
older release signed by the original keystore.

What to do:

- install an APK signed with the same release key as the existing app;
- use a separate intentionally configured package id only for throwaway test
  builds outside the fixed release path;
- uninstall only if losing local data is acceptable.

#### The APK Version Is Older Than The Installed Version

Common adb symptom:

```text
INSTALL_FAILED_VERSION_DOWNGRADE
```

Android compares `versionCode`, not only the visible version name. If the device
already has a higher `versionCode`, a normal install is blocked.

What to do:

- build a new release with a higher Android `versionCode`;
- for a disposable test device, uninstall the existing app and install again.

#### The APK Does Not Match The Device ABI

Common adb symptom:

```text
INSTALL_FAILED_NO_MATCHING_ABIS
```

The default Enigma27 Android build targets `aarch64`, which is right for most
modern phones but wrong for an `x86_64` emulator and wrong for old 32-bit
devices.

What to do:

```bash
bash tools/android/build_android.sh enigma release aarch64,x86_64
# or, when all targets are installed:
bash tools/android/build_android.sh enigma release all
```

For an emulator, include `x86_64`.

#### The Device Is Too Old

Enigma27's generated Android project currently declares:

```text
minSdk = 24
targetSdk = 36
```

Android devices below API 24 cannot install the app. API 24 is Android 7.0.

What to do:

- use Android 7.0 or newer;
- do not try to bypass this with signing or installer settings.

#### Android Blocks Unknown Apps

Symptoms include a generic "App not installed", a security warning, or a prompt
that sends you to settings.

What to do:

- allow "Install unknown apps" for the source app that opens the APK;
- verify checksums and the release signing fingerprint before proceeding;
- on managed devices, ask the administrator to approve the app or distribute it
  through the managed store;
- use `adb install` for internal testing when USB debugging is allowed.

#### The File Is An AAB, Not An APK

An `.aab` will not install when opened on a phone.

What to do:

- use the `.apk` for direct install;
- upload the `.aab` to Google Play or another store that accepts app bundles;
- use bundletool only when you intentionally need generated APKs from an AAB.

#### The Download Is Corrupt Or Incomplete

Common symptoms are package parse errors, a zero-byte file, or an installer that
fails before showing the app name.

What to do:

```bash
sha256sum -c SHA256SUMS
```

Download the APK again if the checksum does not match. Also confirm the device
has enough free internal storage.

#### Play Protect Or Developer Verification Warns

Sideloaded APKs can show extra warnings, especially for apps outside an app
store or from an unverified developer.

What to do:

- prefer the official release channel when available;
- verify the checksum and signing fingerprint;
- avoid forwarding APKs without the matching release notes and checksums.

#### The App Installs But Does Not Work Correctly

Installation success only proves the package was accepted by Android. If Enigma27
opens blank, crashes, cannot scan QR codes, or cannot record voice notes:

- update or enable Android System WebView / Chrome;
- grant camera permission for QR scanning;
- grant microphone permission for voice notes;
- capture logs with `adb logcat -s RustStdoutStderr enigma`;
- test with a clean profile on a disposable device before touching a real user's
  install.

### Repo-Specific Android Checks

Confirm what is actually inside an APK before distributing it:

```bash
python3 tools/android/android_signing/signing_cli.py verify <apk>
```

The report should show:

- package id, fixed to `com.spectrumaipl.enigma27` in the generated Gradle file;
- visible version and Android `versionCode`;
- signer classification: signed release, debug, or unsigned;
- SHA-256 signing certificate fingerprint.

Once a release fingerprint has been pinned in
`apps/enigma/deploy/android-release-key.properties`, a build signed with any
other keystore fails instead of shipping — so a mismatch between that file and
the fingerprint printed above means the artifact did not come from the release
path. The full command set: `signing_cli.py --help`
([tools/android/android_signing/](../../tools/android/android_signing)).

Preset names and output filenames are not separate Android identities. Android
uses the APK's `applicationId` plus the signing key, and Enigma27 fixes the
release `applicationId` to `com.spectrumaipl.enigma27`.

### Official Android References

- Android app signing:
  <https://developer.android.com/studio/publish/app-signing>
- Prepare an Android app for release:
  <https://developer.android.com/studio/publish/preparing>
- APK vs Android App Bundle:
  <https://developer.android.com/guide/app-bundle/faq>
- Alternative distribution and unknown-app opt-in:
  <https://developer.android.com/distribute/marketing-tools/alternative-distribution>
- PackageInstaller failure categories:
  <https://developer.android.com/reference/android/content/pm/PackageInstaller>
- Android developer verification FAQ:
  <https://developer.android.com/developer-verification/guides/faq>

---

## 23. App icon

The app icon is not a build option. It is part of the product's identity, like
its name, its bundle id and its version: one mark, fixed in the repository and
changed here, in code — dromon.yaml has no key for it.

### Why fixed rather than chosen

An app icon is what a user identifies on their launcher. A build that could
pick a different one is a build that can ship the wrong brand, and nothing
downstream would catch it — the artifact installs and runs perfectly with the
wrong face. Fixing it removes a decision that has exactly one right answer at
any moment, and the answer belongs in version control beside the name and the
version it goes out with.

### The master

```
apps/enigma/
├── app-icon.png          # normalised master: square, 1024×1024, what `tauri icon` consumes
└── app-icon-source.png   # the original as authored — never overwritten
```

`app-icon.png` is what `npx tauri icon` consumes. Enigma27's mark is the letter
**E** on a rounded tile, drawn as plain geometry (no font) by
`scripts/letter_icon.py`, which writes both files and the in-app marks:

```bash
python3 scripts/letter_icon.py apps/enigma E <tile colour> <ink colour> enigma27
```

Everything generated from the master is **committed**: the desktop
`.png`/`.ico`/`.icns` set under `apps/enigma/src-tauri/icons/`, and the Android
launcher mipmaps under `apps/enigma/src-tauri/gen/android/app/src/main/res/`.
A build uses those committed files as they are; it does not regenerate them.

#### Master image requirements

- **Square** — Tauri would distort anything else into every output size.
- **At least 512×512**; **1024×1024 recommended**, below which the largest
  generated sizes are upscaled from a smaller original.
- **PNG with alpha**, or **SVG**.
- **Keep the mark inside the middle ~66%.** Android's adaptive icon crops to a
  circle, squircle or rounded square depending on the launcher; anything in the
  corners is gone. Design for the circle, then check the square still looks
  deliberate.
- **Test it small.** Most of an icon's life is 32–48px in a taskbar, where fine
  detail and thin strokes disappear.

### Changing the app icon

Deliberately a manual, reviewed step.

1. Replace `apps/enigma/app-icon.png` (and `app-icon-source.png`) with the new
   master — for the letter mark, by running `scripts/letter_icon.py` as above.
2. Regenerate every size from it:

   ```bash
   cd apps/enigma
   npx tauri icon app-icon.png
   ```

   That rewrites `src-tauri/icons/` — the desktop set plus an `icons/android/`
   mipmap tree.
3. Mirror the Android mipmaps into the generated project. The Gradle project
   does **not** read `icons/android/`: `tauri android init` copies it once, at
   init time, so without this step an Android build ships the previous
   launcher icon.

   ```bash
   cp -r src-tauri/icons/android/. src-tauri/gen/android/app/src/main/res/
   ```
4. Review the diff (roughly 90 files) and commit it with the master.

The in-app marks (the unlock gate and the top bar) are separate files, cut from
the same master: `apps/enigma/src/assets/<logoDir>/app_icon.png` and
`bar_icon.png` — see [`logos.ts`](apps/enigma/src/assets/logos.ts). Replace
them in the same change so the app's face stays the same everywhere.

---

## 24. Crypto audit inventory

Written 2026-09-16; brought up to date 2026-11-23 for Enigma27 in Pharos (iroh, the
captain, file locks and key rings are gone). Nothing here was re-audited on that
date — rows were corrected to match the code, and what no longer exists was taken
out.

### Scope

Active scope:

- Enigma27: `apps/enigma` (Rust core, Vue front end, `packages/rakotis`)
- The crates it links: `crates/rotor/rotor_core`, `crates/gervasius`,
  `crates/protasius`, `crates/enigmatite`
- arti 0.43 as configured in `src-tauri/src/mesh.rs`

Out of scope here:

- Beacon and the `pharos-*` crates (the friend protocol): root
  [SECURITY.md](../../SECURITY.md), Part 2
- Morion and its file sealing (another repository)

### Algorithm Inventory

| Area | Current algorithm or construction | Where used | Source of truth / notes |
| --- | --- | --- | --- |
| MLS group encryption | `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` via OpenMLS | Room chat payloads, presence (with onions), membership changes, file offers | Declared in `apps/enigma/src-tauri/build_config.yaml`; asserted by `build.rs` against `crates/rotor/rotor_core/src/lib.rs`. Pure-ciphertext wire format and ratchet-tree extension. |
| MLS credentials | OpenMLS `BasicCredential` with a self-asserted identity (the profile name) | MLS member identities and rosters | `crates/rotor/rotor_core/src/lib.rs`. Not a PKI or verified identity binding. |
| Device key | Ed25519 (`ed25519-dalek`), 32-byte seed in the vault | Invitation redemption signature; personal invitations are sealed to its X25519 twin | `apps/enigma/src-tauri/src/device.rs` |
| At-rest envelope | Passphrase -> Argon2id -> UKEK wraps random 32-byte DEK -> XChaCha20-Poly1305 for values | Profile vault: MLS state, history, settings, rooms, invite records, device key, arti's state | `crates/gervasius/src/*`, `crates/protasius/src/lib.rs`. Vault headers store version, KDF params, salt, and wrapped DEK. |
| Password KDF | Argon2id v1.3, 32-byte output | New Enigma vaults | Configured in `build_config.yaml` as 64 MiB, t=3, p=4; validated by `build.rs`; implemented in `crates/gervasius`. |
| AEAD for local data | XChaCha20-Poly1305 with 24-byte random nonce and AAD (`protasius:v1:` ‖ key) | Every sealed value; the in-memory PIN passphrase box | `crates/gervasius`, `crates/protasius`, `apps/enigma/src-tauri/src/vault.rs`. |
| Public-key sealing | Ephemeral-static X25519 -> HKDF-SHA256 -> XChaCha20-Poly1305 | Personal invite ticket body sealed to the recipient's device id | `crates/gervasius/src/seal.rs`, `apps/enigma/src-tauri/src/invite_ticket.rs`. Ed25519 device keys are converted to X25519; small-order/off-curve inputs are rejected. |
| Invite redemption | Ed25519 signature over a random challenge plus BLAKE3 keyed proof with the 32-byte capability | Redemption over the inviter's onion, before the MLS add | `apps/enigma/src-tauri/src/invite_redeem.rs`, `invites.rs`. The capability does not cross the wire. |
| File download | One-time 32-byte secret, committed as BLAKE3(secret) over MLS; BLAKE3 of the whole file | Downloads over the sender's onion | `apps/enigma/src-tauri/src/files.rs`. Bytes are protected by Tor's onion encryption, not by MLS. |
| Transport | arti onion services, one per member per room; full vanguards | Room links, redemptions, downloads | `apps/enigma/src-tauri/src/mesh.rs`. No direct connections. Links carry JSON frames; only MLS protects content. |
| Room slug / onion nickname | BLAKE3 of the room name | Room ids and the keystore nickname | `mesh.rs`. Deterministic, not a secret. |

Key dependency versions in the Enigma Rust tree (check with the commands below):

- `openmls` 0.7.4 and `openmls_rust_crypto` 0.4.4
- `arti-client` 0.43 (features `onion-service-client`, `onion-service-service`, `vanguards`)
- `argon2` 0.5
- `chacha20poly1305` 0.10
- `ed25519-dalek` 3
- `blake3` 1

### Secret And Data Locations

| Secret or sensitive data | Storage | Protection |
| --- | --- | --- |
| Profile DEK | In memory only after unlock; wrapped in `vault.json` at rest | Argon2id-derived UKEK wraps DEK through gervasius |
| MLS state | Protasius, namespace `mls` | Sealed; exported state is zeroized on Rust paths that handle it |
| Chat history, settings, saved rooms (with members' onions) | Protasius kv (`chat:log`, `p2p:settings`, `p2p:rooms`) | Values sealed with per-key AAD; keys remain plaintext for scans |
| Device key | Protasius, `keys/device_ed25519` | Sealed |
| arti's state (onion keys, guards, vanguards) | `profiles/<p>/tor/state` while running; `keys/tor_keystore` when stopped | Sealed at rest; plaintext on disk while the app runs, and after a crash until the next clean stop |
| Invite capabilities and records | Protasius internal invite namespace | Sealed at rest; redemption sends only a challenge-bound proof |
| PIN unlock passphrase copy | Process memory only | Passphrase sealed under PIN-derived gervasius vault; dropped after 5 wrong PINs or restart |
| Panic code | A second slot in `vault.json` | Panic unlock returns like a normal unlock and wipes every profile |

### Existing Cybersecurity Measures

- Build-time crypto declarations are validated in `apps/enigma/src-tauri/build.rs`.
  Unknown YAML fields fail the build, sane KDF ranges are checked, and algorithm
  strings are const-asserted against the crypto crates.
- Room content is E2EE through MLS; nothing is sent or shown in plaintext; key
  packages from the mesh are refused (invitation-only admission).
- Always Tor, with full vanguards for every hosted onion; no direct connection
  and no outbound HTTP from the Rust core.
- Local profile data is encrypted at rest through protasius/gervasius, arti's
  state included. No password recovery path.
- The vault can idle-lock. Locking stops the mesh (sealing arti's state) and drops
  in-memory MLS sessions before the DEK.
- PIN unlock is convenience-only and memory-only. Nothing PIN-derived is persisted.
- The panic code's unlock result is indistinguishable from a normal unlock.
- Personal invitations hide the capability and the inviter's onion from a passive QR
  observer by sealing the body to the recipient. General invitations are bearer
  credentials by design.
- Invite redemption is challenge-bound and identity-bound: a captured proof does not
  replay against a new challenge or a different device id.
- A file download needs the secret only the accepting member holds, works once, and
  is checked by BLAKE3 before it is kept.
- Tauri capabilities are narrow at the manifest level: core, opener, dialog,
  notification and deep-link defaults; no filesystem plugin permission.

### Audit Gaps And Required Work

P0 before an external encryption audit:

- Authenticate or drop `mls_reset_request`: today any connection to a member's
  onion can make that member start a new group of one (§9 item 4).
- Add a real Tauri Content Security Policy. `tauri.conf.json` has `"csp": null`.
- Enforce passphrase minimum and policy in Rust, not only in UI.
- Run a fresh dependency audit for Rust and npm.

P1 hardening (root [todo.md](../../todo.md) Stage 7):

- Padding of every frame before MLS (7.1).
- Move the sender fields (MLS identity, name, picture, message id) inside the
  ciphertext (7.2).
- Tor client authorisation on member onions (part of 7.3), so only members can
  fetch a member's descriptor and link.
- Cover traffic and timing (7.4).
- Member/key verification UX: bind the MLS credential to the device key; safety
  numbers or SAS.
- MLS rekey/post-compromise cadence.
- Review all logging for passphrases, invite capabilities, onions and key material.

P2 documentation and test depth:

- Fuzz/property tests for frame parsers, invite-ticket decoding and the download
  handshake.
- Review zeroization boundaries; webview/TypeScript plaintext cannot get the same
  memory guarantees.

### Verification Commands

```bash
rg -n "MLS_128_DHKEMX25519|xchacha20-poly1305|argon2id|blake3|VanguardMode|csp" \
  apps/enigma crates

cargo tree -p enigma -i openmls
cargo tree -p enigma -i arti-client -e features
cargo tree -p enigma -i chacha20poly1305
cargo tree -p enigma | grep -c iroh     # 0: no iroh in Enigma27

npm query .workspace --json
npm audit
```

---

## Roadmap

Open work, in rough priority order (security hardening items are in
[§9](#9-security--privacy-considerations) and root [todo.md](../../todo.md) Stage 7):

- **Metadata hardening:** padding, sealed sender fields, Tor client authorisation,
  cover traffic (Stage 7.1–7.4).
- **An authenticated reset**, or none (§9 item 4).
- **Key verification** and an MLS rekey cadence.
- **A room mailbox** on Beacon, so a message can wait for a member who is offline
  after the sender has closed the room (Enigma27 does not talk to Beacon yet).
- **Accepted limitations (documented, deliberate):**
  - New joiners need the inviter online, with the room open ([§18.7](#187-limitations)).
  - Group scale: a full mesh, for small rooms.
- **Housekeeping:** the centralization roadmap in
  [§15](#15-config--sources-of-truth).
