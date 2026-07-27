# Enigma — Technology Overview

A technical deep-dive into how Enigma works: its design, stack, dependencies,
communication flow, cryptography, privacy posture, and known weaknesses — plus the
project's conventions, config sources of truth, and rework history. For build and
run instructions see [build.md](build.md).

> **Status:** early-stage (`v0.1.0`). The cryptography is production-grade (OpenMLS),
> but several integration-level hardening items remain open — see
> [Security & privacy considerations](#9-security--privacy-considerations) and
> [Roadmap](#roadmap). This document is candid about them on purpose.

Contents: [1 Design](#1-design) · [2 Stack](#2-technology-stack) ·
[3 Dependencies](#3-dependencies--libraries) · [4 Architecture & flow](#4-architecture--communication-flow) ·
[5 Routing & transport](#5-routing--transport) · [6 Is it truly P2P?](#6-is-it-truly-p2p-intermittent-nodes) ·
[7 Encryption](#7-encryption--algorithms) · [8 Privacy](#8-privacy) ·
[9 Security considerations](#9-security--privacy-considerations) · [10 UI](#10-user-interface) ·
[11 Tor transport](#11-tor-onion-transport--captain-election) ·
[12 DHT discovery](#12-dht-discovery-mainline-rendezvous--contacts) ·
[13 Encryption at rest](#13-encryption-at-rest-gervasius--protasius) ·
[14 Conventions](#14-conventions-naming--palette) · [15 Config sources](#15-config--sources-of-truth) ·
[16 Rework history](#16-history-the-serverless-rework) · [Roadmap](#roadmap)

---

## 1. Design

Enigma is a **serverless, peer-to-peer, end-to-end-encrypted chat**, packaged as a
[Tauri 2](https://tauri.app) desktop/mobile app (Vue 3 frontend + Rust backend).

Design principles:

- **No app server.** There is no relay WebSocket, no REST gateway, no login, no
  server-side directory. Enigma operates no backend of its own. (This is *not* the
  same as "no infrastructure" — see [§6](#6-is-it-truly-p2p-intermittent-nodes).
  The optional **Enigma Cloud** feature talks to the *user's own self-hosted*
  faros server, never to one of ours.)
- **Rendezvous by QR code.** Two people meet when one shares a QR code carrying the
  room's *ticket*; scanning it (camera or image) or pasting it joins the room. With
  the opt-in DHT toggle ([§12](#12-dht-discovery-mainline-rendezvous--contacts)), a
  short *room code* joins ticketlessly.
- **Pair once, reconnect forever.** After the one-time QR pairing, each peer's stable
  NodeId is persisted per room and re-resolved through iroh's discovery when
  addresses change — no fresh QR needed on reconnect.
- **End-to-end encryption by default.** All message content is encrypted with **MLS**
  (Messaging Layer Security, RFC 9420) via OpenMLS. The crypto layer never leaves the
  device.
- **Encrypted at rest.** All persisted app state — keys, MLS sessions, PII, settings,
  saved rooms — lives in a per-profile passphrase-gated encrypted store
  ([§13](#13-encryption-at-rest-gervasius--protasius)).
- **Local-first identity.** Identity is a locally stored profile — no accounts, no
  PKI, no phone number. `APP_PROFILE` isolates storage; `CHAT_USER` sets the MLS
  identity, so multiple instances can run side-by-side.
- **Compile-time build policy.** A build config
  ([§15](#15-config--sources-of-truth), [build.md](build.md)) bakes in the allow
  flags (cloud, hosted relays), crypto declarations, feature defaults, and setting
  clamps — a restricted build is a *different binary*, not a runtime toggle.

### Layered architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/enigma/src  (Vue 3 UI: Chat · Calls · Files · Contacts ·    │
│                    Calendar · Settings; QR create/scan; unlock gate)│
├──────────────────────────────────────────────────────────────────┤
│  packages/rakotis (TS)                                             │
│   • useChatChannel — MLS envelope state machine / orchestration    │
│   • chatTransport  — transport bridge (iroh / Tor, uniform events) │
│   • crypto         — bridge to the mls_* Tauri commands            │
│   • services       — appStorage (settings/build config), contacts, │
│                      localDb (kv), i18n                            │
├──────────────────────────────────────────────────────────────────┤
│  Tauri IPC  (invoke commands + realtime://* file://* cloud://* …) │
├──────────────────────────────────────────────────────────────────┤
│  apps/enigma/src-tauri  (Rust)                                     │
│   • p2p_iroh.rs  — iroh-gossip transport (default)                 │
│   • p2p_tor.rs   — peer-hosted Tor onion transport (opt-in, §11)   │
│   • p2p_dht.rs   — Mainline-DHT rendezvous/presence (opt-in, §12)  │
│   • p2p_invite.rs — direct room invites (dedicated ALPN)           │
│   • realtime.rs  — realtime_* gateway (gates + transport dispatch) │
│   • vault.rs     — protasius integration (encrypted store, §13)    │
│   • cloud.rs     — Enigma Cloud client (user's own faros server)   │
│   • file_xfer.rs · vox.rs — P2P file transfer · 1:1 voice calls    │
│   • local_lock.rs — per-file passphrase locking (ENIGLOCK)         │
│   • lib.rs       — mls_* commands, profiles, build_config, audio   │
│   • tor.rs       — outbound Arti client (shared by cloud + p2p_tor)│
├───────────────┬───────────────────┬──────────────────────────────┤
│ cryptorotor/  │ protasius         │ iroh 0.98 + iroh-gossip 0.98  │
│ rotor_core    │ (encrypted store) │ (QUIC P2P, n0 relay+discovery)│
│ (OpenMLS)     │ gervasius (at-rest│ mainline 6 (BitTorrent DHT)   │
│               │ crypto primitives)│ arti 0.43 (embedded Tor)      │
└───────────────┴───────────────────┴──────────────────────────────┘
```

The Vue shell is deliberately thin; nearly all chat/identity logic lives in the
shared in-repo package **rakotis**, which is aliased to source (`vite.config.ts`) and
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
| P2P transport | iroh 0.98 (QUIC endpoint, NodeId identity, NAT traversal) + iroh-gossip 0.98 (topic broadcast); **or** peer-hosted Tor onion services (opt-in, [§11](#11-tor-onion-transport--captain-election)) |
| Peer discovery (opt-in) | BitTorrent Mainline DHT (`mainline` 6 + iroh `address-lookup-pkarr-dht`) — ticketless room codes, contacts presence, nickname directory ([§12](#12-dht-discovery-mainline-rendezvous--contacts)) |
| Cryptography (content) | OpenMLS 0.7 (RFC 9420 MLS) via the vendored `rotor_core` crate |
| Cryptography (at rest) | `gervasius` (Argon2id → wrapped DEK → XChaCha20-Poly1305) + `protasius` (per-profile encrypted fjall store) ([§13](#13-encryption-at-rest-gervasius--protasius)) |
| Local storage | protasius (encrypted fjall LSM keyspace) per profile; OS app-data dir |
| Media capture | cpal (microphone + speaker) + hound (WAV) for native voice notes; cpal + rustfft for live voice calls |
| Voice calls (Vox) | 1:1 real-time voice over iroh QUIC datagrams (ALPN `enigma/vox/0` on the main endpoint); G.711 μ-law audio, per-call MLS-keyed ChaCha20-Poly1305, rustfft equalizer |
| Tor (opt-in transport) | arti-client 0.43 `onion-service-service` — peer-hosted onion transport (`p2p_tor.rs`); the "use Tor" switch routes rendezvous + chat over it |
| Enigma Cloud (optional) | HTTP client (`cloud.rs`) to the user's own self-hosted faros server (telegraph auth + vault file storage), direct TLS (WebPKI) or via Tor; can be compiled out via build config |
| Beacon (optional) | `beacon.rs` riding the cloud.rs transport + session: expiring location shares (pin/zone/route, mandatory TTL) on the same faros server, rendered on the Maps tab; present only when cloud **and** maps are both in the build |
| Cloud rendezvous (optional) | `aster.rs` riding the cloud.rs transport + session: publish my iroh relay URL (never an IP) to my own faros server and resolve peers by NodeId/username — a third stacked `AddressLookup` beside n0/DHT; opt-in, default off; present only when cloud **and** hosted relays are both in the build (rdv.md) |
| Build config | `src-tauri/build_config.yaml` → build.rs codegen ([§15](#15-config--sources-of-truth), [build.md](build.md)) |
| Build/CI | `build_desktop.sh` one-click; GitLab CI (`.gitlab-ci.yml`); Node 22 |

Rust backend crate: `enigma` → `enigma_lib` (`staticlib`/`cdylib`/`rlib`). Bundle
identifier `com.spectrumaipl.enigma`. The tauri.conf `targets: "all"` governs the
desktop bundle formats (Linux `.deb`/`.AppImage`/`.rpm`); Android APK/AAB are produced
by the separate `scripts/build_android.sh` path ([build.md](build.md)).

---

## 3. Dependencies & libraries

Versions are the declared spec (resolved pins live in `apps/enigma/src-tauri/Cargo.lock`,
which is gitignored, and `cryptorotor/Cargo.lock`, which is committed).

### Rust backend (`apps/enigma/src-tauri/Cargo.toml`)

| Crate | Ver | Role |
|---|---|---|
| `tauri` (+ `tauri-plugin-opener`/`-dialog`/`-notification`) | 2 | App framework, IPC, bundler, OS integration |
| `rotor-core` | path | MLS crypto engine (vendored `cryptorotor/rotor_core`) |
| `protasius` | path | Per-profile encrypted store (vault lifecycle + sealed kv) |
| `gervasius` | path | At-rest crypto primitives (also used directly by `local_lock.rs`) |
| `iroh` | 0.98 | QUIC P2P endpoint, NodeId identity, n0 relay + discovery (`address-lookup-pkarr-dht` feature) |
| `iroh-gossip` | 0.98 | Epidemic broadcast over a topic (one room = one topic) |
| `mainline` | 6 | Direct BEP44 access to the BitTorrent Mainline DHT (room rendezvous, [§12](#12-dht-discovery-mainline-rendezvous--contacts)) |
| `postcard` | 1 | Serialize the pairing `Ticket` / room codes / archives |
| `blake3` | 1 | Topic id = `blake3(room name)`; DHT key derivation; map-region content addressing |
| `pmtiles` | 0.23 | PMTiles v3 read/write for the Map tab: mmap'd local region blobs (`maps.rs`; minimal features — no reqwest/S3/zstd). The app never fetches tiles — packages come from `tools/map_packager` |
| `data-encoding` | 2 | BASE32 (no-pad) ticket/code text encoding |
| `bytes`, `futures-lite`, `anyhow` | — | Gossip stream plumbing, error handling |
| `arti-client`, `tor-rtcompat` | 0.43 | Embedded Tor: outbound client (`tor.rs`) **and** `onion-service-service` hosting for the onion transport (`p2p_tor.rs`) |
| `tor-hsservice`, `tor-cell`, `safelog` | 0.43 / 0.8 | Onion-service hosting types (launch/config, accept relay cell, unredacted `.onion` display) |
| `hyper`, `hyper-util`, `http-body-util`, `tokio-rustls` | — | HTTP plumbing (outbound `tor.rs` client + `cloud.rs`) |
| `webpki-roots` | 1 | Mozilla root bundle for direct clearnet cloud TLS verification |
| `tokio` | 1 | Async runtime |
| `cpal` | 0.15 | Microphone capture (native voice notes) + duplex capture/playback for voice calls (`vox.rs`) |
| `hound` | 3 | WAV encoding of recordings |
| `rustfft` | 6 | Pure-Rust FFT of the incoming call audio → the `vox://spectrum` equalizer |
| `chacha20poly1305` | 0.10 | AEAD for voice-call media (keyed per call by an MLS exporter secret) + DHT-rendezvous record sealing |
| `fjall` | 2 | LSM key/value backend under protasius (pure Rust; avoids a second SQLite link) |
| `zeroize` | 1 | Wipe plaintext/state buffers in RAM |
| `serde`/`serde_json`, `uuid` | — | Serialization, ids |
| `typed-index-collections` | =3.3.0 | MSRV pin (arti transitively pulls it; 3.4+ needs rustc 1.90) |
| `webkit2gtk` (Linux), `rusqlite` bundled (Android) | — | Platform-specific glue |

Build-dependencies: `tauri-build`, plus `serde`/`serde_norway`/`serde_json` for the
compile-time `build_config.yaml` codegen ([build.md](build.md)).

### Crypto workspace (`cryptorotor/`, vendored)

- **`rotor_core`** — the MLS engine (`RotorSession`). `openmls =0.7.4`,
  `openmls_rust_crypto =0.4.4`, `openmls_basic_credential =0.4.1`,
  `openmls_traits =0.4.1`, `tls_codec 0.4`, `zeroize`. Exports the compiled
  ciphersuite (`CIPHERSUITE`/`CIPHERSUITE_NAME`) for the build-config assert.
- **`gervasius`** — at-rest primitives: `argon2` 0.5 (Argon2id), `chacha20poly1305`
  0.10 (XChaCha20-Poly1305), `rand_core`, `zeroize`. Pure Rust, wasm-clean.
- **`rotor_wasm`** — `wasm-bindgen` browser bindings (`WasmRotorSession`); built with
  wasm-pack (`cryptorotor/build_wasm.sh`; CI job `rotor:wasm`). Consumed by the
  sibling *toto* project as a static committed copy — no GitLab in toto's path.
- **`rotor_py`** — PyO3/maturin Python bindings for toto's Django side.

`protasius/` (repo root) is the standalone encrypted-store crate built on gervasius
(`fjall` 2, `serde`, `zeroize`); Tauri-agnostic — `lib.rs` wires the commands.

### Frontend (`apps/enigma/package.json` + `packages/rakotis`)

**Used at runtime:** `vue` 3.5, `vue-router` 5 (`createMemoryHistory`), `pinia`,
`vue-i18n` 9 (en/pl), `tailwindcss` 4, `@fortawesome/*`, `@tauri-apps/api` 2,
`qrcode` (generate ticket/NodeId QR), `html5-qrcode` (scan), `nanoid` (message ids),
`maplibre-gl` 5 (Map tab canvas; WebGL), `protomaps-themes-base` 4 (basemap style
layers as code — glyphs/sprites are bundled under `public/map/`, so styling makes
no CDN contact), `ace-builds` (Files → Local notes editor, bundled offline — §13),
`cytoscape` 3.30 (Mind tab graph canvas, core only — no layout/interaction
plugins), `trix` 2 (Mind node notes rich-text editor; bundled JS + CSS, every
toolbar icon an inline `data:` SVG — no CDN, no fetches), and the in-repo
`rakotis` workspace package.

**Dormant / carried from the earlier multi-app codebase (declared but unused by this
app):** `leaflet` (+ `@types`). Dead weight worth pruning.

---

## 4. Architecture & communication flow

### The seams

The frontend talks to Rust through two mechanisms, both guarded by an `isTauri()`
runtime check (in a plain browser there is no backend — chat is inert by design):

- **`invoke` (commands):** `realtime_*` (transport — dispatched to iroh or Tor),
  `mls_*` (crypto), `app_*` (profiles/runtime/airplane/use-Tor/build-config),
  `vault_*` (encrypted-store lifecycle), `kv_*` (sealed kv), `dht_*` (discovery),
  `file_*` (P2P transfer), `vox_*` (calls), `cloud_*` (Enigma Cloud),
  `beacon_*` (server location shares on the cloud transport),
  `invite_*` (direct room invites), `audio_*` (recording), `fs_*` (local file IO),
  `local_*` (per-file locking), `tor_*`.
- **Events (`listen`):** `realtime://message` `{room, payload}` and
  `realtime://status` `{room, state, peers, peer_id?, reason?}` (both transports
  emit identical shapes, so the frontend is transport-agnostic); plus
  `file://progress|done|error`, `cloud://progress|done|error`,
  `invite://incoming|resolved`, and `vox://*` (call state + spectrum).

### Sending a text message (outbound)

```
ChatPanel.send(text)
  → useChatChannel.sendMessage(text)
      if MLS ready:  cryptoService.encrypt → mls_encrypt (Rust) → ciphertext
                     wrap as {type:"mls_app", ciphertext:<base64>, sender fields}
      → chatTransport.send(slug, payload)
          → invoke("realtime_send", {room, payload: JSON.stringify(...)})
              → Rust realtime_send (offline-gated)
                  → p2p_iroh::broadcast (or p2p_tor, by room ownership)
```

### Receiving (inbound)

```
p2p_iroh / p2p_tor receive loop  → emit realtime://message {room, payload}
  → chatTransport listener (JSON-parse) → per-room handler
      → useChatChannel.handleMessage(data)  (drops frames for other rooms)
          switch data.type:
            mls_app        → mls_process_message → plaintext → route inner type
            mls_key_package/welcome/commit → MLS handshake steps
            mls_reset_request → rebuild the group
            chat_message   → pre-MLS plaintext fallback (see weaknesses)
```

### The MLS envelope state machine

`useChatChannel` implements a transport-agnostic JSON envelope protocol over the
gossip topic; all cryptography is delegated to the Rust `mls_*` commands. States:
`idle → initializing → key_exchange → ready → error`.

1. On transport `connected`, each side inits a fresh local MLS group, broadcasts a
   `mls_key_package`, and arms a **5-second timer** that optimistically flips to
   `ready`. (The timer is armed by *every* peer; it only survives — and mislabels the
   room "encrypted" — when no peer key package arrives, i.e. for a peer left alone in
   the room.)
2. On receiving a peer's key package, an **admin** (elected by the lexicographic rule
   `ourId < theirId`) calls `mls_add_member` and broadcasts a `mls_commit` (to all)
   plus a targeted `mls_welcome`; a non-admin re-sends its own key package and waits.
3. `mls_welcome` → `mls_join_from_welcome` → `ready`. `mls_commit` → `mls_process_message`.
4. Application messages ride `mls_app` frames (base64 MLS ciphertext).
5. Recovery: a `"group id differs"` decrypt error re-runs key exchange; any peer can
   broadcast `mls_reset_request` to rebuild the group (deduplicated for 30 s).

### Persistence — everything through protasius ([§13](#13-encryption-at-rest-gervasius--protasius))

All app state persists as **sealed values** in the per-profile protasius keyspace
(`<profile_dir>/protasius/`), unlocked by the launch passphrase gate:

- **MLS session state** → ns `mls` (blob keyed `room\0identity`, rewritten after
  every MLS operation).
- **iroh transport key** (stable NodeId) → `keys\0iroh_gossip`; Tor presence id →
  `keys\0tor_peer_id`; sealed onion keystore → `keys\0tor_keystore`.
- **Saved rooms** → kv ns `p2p:rooms` as `{room, name, ticket, peers[], host?, tor?,
  onion?, code?}` — `peers[]` is the persisted NodeId address book that powers
  ticketless reconnect.
- **Profile / PII / feature switches** → ns `profile`, key `state`
  (`AppProfileState`: offline, use_tor, stable_onion, offline profiles).
- **User settings** → kv ns `p2p:settings` (connect timeout, DHT toggles/cadences,
  max file size, meeting reminder), ns `cloud:settings` / `cloud:auth`,
  ns `contacts`, ns `files:local` (locked-file index), ns `dht` (room secrets).
- The only plaintext artifact is `vault.json` (the vault header: salt + wrapped
  DEK — reveals nothing without the passphrase).

---

## 5. Routing & transport

The default transport is **iroh-gossip over QUIC**; the opt-in alternative is the
peer-hosted **Tor onion transport** ([§11](#11-tor-onion-transport--captain-election)).
There is no WebSocket and no HTTP data path for chat.

- **Endpoint.** A single process-global iroh `Endpoint` is built with `presets::N0` +
  `RelayMode::Default`, i.e. iroh's built-in **n0 public relays and n0 discovery**
  (pkarr-style signed DNS records). Identity is a stable Ed25519 `SecretKey` →
  **NodeId**. The router accepts iroh-gossip's ALPN plus `enigma/invite/0` (direct
  room invites) and `enigma/vox/0` (calls); file transfer runs its own ephemeral
  endpoint. A build with `p2p.allow_hosted_relays: false`
  ([§15](#15-config--sources-of-truth)) uses `presets::Minimal` +
  `RelayMode::Disabled` instead — direct QUIC and Tor only.
- **Room → topic.** `topic = blake3(room_name)` — a deterministic 32-byte id, with
  **no salt and no secret**. The room name is the only thing gating topic membership.
- **Ticket / QR.** `Ticket { topic, name, peers: Vec<EndpointAddr> }` is
  `postcard`-serialized, tagged (`IROH_TAG 0x49`; Tor tickets `0x54`, DHT room codes
  `0x44`) then BASE32-encoded (lowercased). That string **is** the QR payload. It
  contains the topic, the **plaintext room name**, and the creator's
  `EndpointAddr` (NodeId + relay URL + socket addresses). Join routing sniffs the
  tag, so any pasted/scanned code lands on the right transport regardless of the
  use-Tor switch.
- **Connecting.** `create_room` subscribes with no bootstrap; `join_room` seeds the
  ticket peers' addresses into a manual lookup and bootstraps from their NodeIds;
  `join_room_by_node` is ticketless (addresses resolved purely via discovery); DHT
  room codes resolve rendezvous records ([§12](#12-dht-discovery-mainline-rendezvous--contacts)).
  iroh then dials over QUIC, **hole-punching directly where possible and falling
  back to relaying through an n0 relay** when direct connectivity fails.
- **Frame size.** The gossip `max_message_size` and the Tor transport frame cap are
  the same build-config value (`network.max_frame_bytes`, default 16 MiB) so an
  entire MLS-encrypted image or voice note fits in a single broadcast. This is a
  **wire-interop constant** — peers built with different caps can drop each other's
  large frames.
- **Reconnection.** Neighbor-up gossip events carry the peer's NodeId (`peer_id` on
  `realtime://status`); it is persisted per room. On next launch the app re-opens the
  most-recent room, reusing the saved ticket but seeding the saved NodeIds so
  discovery re-resolves current addresses. There is no app-level retry/backoff loop —
  reconnection relies on iroh's swarm maintenance and discovery freshness.
- **Connect timeout.** Room create/join give up after the user-set
  `connect_timeout_secs` (Settings; default/clamp from build config). The join
  window then stays one more interval with a countdown — total ≤ 2×N. Never
  hardcode a connect deadline ([§15](#15-config--sources-of-truth)).
- **Airplane mode.** A per-profile `offline` flag tears down both transports and
  every network-touching command refuses while set (`realtime_leave_room` is the one
  exempt command). This is a **cooperative app-level gate**, not an OS firewall.

### Voice calls (Vox) — real-time media over the same endpoint

1:1 voice calls (`vox.rs`, Calls tab) reuse the **main iroh endpoint**: a second ALPN
(`enigma/vox/0`) is registered on the same router as gossip and invites, so a callee is
call-reachable at the very NodeId their contacts/nickname already resolve to (no
separate identity, no directory). Three ways to place a call, all ending in one dial:

- **Ticket / QR** — the callee `vox_create`s a `VoxTicket { call_id, EndpointAddr }`
  (postcard + BASE32, like a room ticket) and shares it; the caller `vox_join`s it.
- **Call a room member** — the call *offer* is signaled over the chat's MLS group via
  the `onSync`/`sendSync` seam (the `vox_*` message family), exactly like file offers;
  the initiator listens and the accepting member dials back.
- **Call by nickname / saved contact** — `dht_find_nick` (or a Contacts entry) yields
  the peer's NodeId, dialed directly (`vox_call_node`).

Once connected, a control **bi-stream** carries a length-prefixed-JSON
hello/accept/decline handshake, then audio flows as **G.711 μ-law** frames (48 kHz,
10 ms / 480 samples) over **unreliable QUIC datagrams** — no head-of-line blocking, a
~0.5 s jitter buffer, and a linear resampler so each device runs at its native rate.
cpal capture and playback each live on their own OS thread (`cpal::Stream` is `!Send`).
Media is end-to-end encrypted (see [§7](#7-encryption--algorithms)), with a fail-soft
fallback to the QUIC-TLS transport when the media handshake can't complete. Voice is
iroh-only, so `vox_*` commands are **blocked offline and in Tor-exclusive mode** (a
direct QUIC call would leak the IP outside Tor), and a `vox::shutdown` hangs up any
live call when airplane/Tor is toggled or the profile is switched.

---

## 6. Is it truly P2P? (intermittent nodes)

**Short answer: message *content* is genuinely peer-to-peer and end-to-end encrypted,
and Enigma runs no server of its own — but the network layer is not
infrastructure-free.**

To make QR pairing and ticketless reconnect work behind NATs, iroh is configured to
use **n0's public infrastructure** (`presets::N0` + `RelayMode::Default`), which
introduces two categories of third-party, always-on "intermittent" nodes:

1. **n0 relay servers.** Used to coordinate QUIC hole-punching and, when a direct
   connection can't be established, to **relay the packets**. A relay sees your public
   **IP**, your **NodeId**, the **peer NodeIds** you talk to, and **packet timing/size**
   — but **not** content (traffic is QUIC-encrypted and the payloads are additionally
   MLS-encrypted).
2. **n0 discovery servers (pkarr/DNS).** Your endpoint **publishes a signed record**
   mapping `NodeId → current addresses + home relay`, and resolves peers the same way.
   This exposes your **NodeId↔IP mapping and effective online status** to a third
   party — it is exactly what makes NodeId-only reconnect work.

So "serverless" here means **"no *our* server,"** per the design's own wording — not
"no infrastructure." If n0's relays/discovery are unreachable or blocked, NAT'd peers
may fail to connect and ticketless reconnect breaks. (The opt-in **DHT discovery**
toggle — [§12](#12-dht-discovery-mainline-rendezvous--contacts) — adds a
community-run alternative for the discovery half: address records and room rendezvous
ride the public BitTorrent Mainline DHT, racing n0 in parallel; relays remain the
NAT-traversal path.) The relay/discovery operators (or a network observer) can build
a who-talks-to-whom metadata graph even though they never see plaintext. This n0
metadata exposure applies **only on the default iroh transport**; flipping
**"use Tor"** on routes rendezvous + chat over peer-hosted onion services instead,
which hides the NodeId↔IP graph from n0 (at the cost of Tor's own latency and the
captain-hosting model of [§11](#11-tor-onion-transport--captain-election)). A build
can also remove the n0 dependency outright (`p2p.allow_hosted_relays: false`,
[§15](#15-config--sources-of-truth)) at the cost of NAT traversal.

Topology is **1:1 / small "star" rooms** on both transports; over Tor the elected
captain is the onion host + relay. Group scale (gossip fan-out + the naive admin
election) is explicitly unverified for large groups.

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
- **Credentials:** `BasicCredential` carrying the raw identity string, signed by a
  locally generated Ed25519 key. No X.509/PKI — identities are self-asserted.
- **Storage provider:** OpenMLS `MemoryStorage` (in-RAM), serialized and sealed into
  protasius by the app after each operation.

### RotorSession API → `mls_*` commands

`create_group` / `key_package` / `add_member` (→ welcome+commit) / `join_from_welcome`
/ `process_message` / `encrypt_app` / `members` (authenticated roster) / `remove_member`
/ `export_secret` (RFC 9420 exporter — keys the Vox voice-call media ciphers; see
below) / `export_state` + `import_state` (serializable session).

### What is encrypted

- **Text** → `mls_encrypt` → `mls_app` frame.
- **Images** → downscaled client-side to ≤1600 px JPEG (q 0.85), embedded as a base64
  data-URL inside an encrypted `image_message`.
- **Voice notes** → native cpal capture → hound WAV → encrypted `voice_message`.
- **Presence, leave, and control messages** → encrypted inner JSON over the same group.
- **Voice-call media** → a *separate*, ephemeral per-call MLS group (a 2-member
  `RotorSession` keyed by the `call_id`) whose **RFC 9420 exporter secret**
  (`export_secret`) derives two directional 256-bit keys → two **ChaCha20-Poly1305**
  ciphers (one per direction; 96-bit nonce = a per-direction monotonic counter). Each
  10 ms μ-law datagram is `[counter‖ciphertext]`. If the MLS handshake over the call's
  bi-stream fails for any reason, the call **falls back to transport-only** (QUIC TLS,
  peers authenticated by NodeId) and the UI shows a downgraded-encryption badge.
- **Everything at rest** → Argon2id + XChaCha20-Poly1305 via gervasius/protasius
  ([§13](#13-encryption-at-rest-gervasius--protasius)); user-chosen files can
  additionally be locked in place with a per-file passphrase (`local_lock.rs`,
  `ENIGLOCK` format: `magic ‖ version ‖ VaultHeader(JSON) ‖ nonce ‖ ct+tag`).
- **DHT records** → ChaCha20-Poly1305 under blake3-derived keys
  ([§12](#12-dht-discovery-mainline-rendezvous--contacts)).

### Security properties

- **Forward secrecy:** MLS's per-message secret-tree ratchet gives forward secrecy
  within an epoch; consumed message keys are deleted.
- **Post-compromise security (limited):** epochs only advance on add/remove commits.
  There is **no periodic self-update / empty-commit key rotation** in the code, so a
  long-lived 2-party group never rotates its epoch on its own — PCS is effectively not
  exercised after the initial add.

---

## 8. Privacy

| Aspect | Posture |
|---|---|
| Message content | **End-to-end encrypted (MLS).** Relays/discovery see only ciphertext. |
| Accounts / identifiers | **None.** No phone number, email, or server account required. |
| Identity | Local profile; `CHAT_USER` = MLS identity, NodeId = transport identity. Self-asserted, no PKI. |
| Metadata to n0 relays/discovery | **Exposed on iroh:** NodeId↔IP, who-talks-to-whom, timing, sizes, online presence. Avoided when "use Tor" is on; removable at build time (`p2p.allow_hosted_relays: false`). |
| QR ticket contents | iroh: leaks the **plaintext room name** + the creator's **NodeId + IP addresses**. Tor: leaks the room name + the creator's `.onion` (no IP). |
| Topic secrecy | `topic = blake3(name)` — anyone who knows/guesses the room name can join the swarm (MLS still gates the group). DHT room codes carry an unguessable secret instead. |
| Local at-rest | **Encrypted** — passphrase-gated vault ([§13](#13-encryption-at-rest-gervasius--protasius)); no recovery by design. |
| Map tiles | **The app performs no tile fetches at all.** Maps render exclusively from imported region packages produced offline by the standalone `tools/map_packager` (that tool — not the app — contacts the PMTiles host you give it, on a machine you choose). Imports are BLAKE3-verified against the package manifest. |
| Device location | **Never read.** The app has no geolocation permission, no positioning plugin, and never calls `navigator.geolocation` (an e2e test traps the API and fails if that changes). "Share a location" sends a point the **user tapped on the map** after an explicit press — it is a place they chose, not a device fix — to that room's MLS group only, and it stops rendering on peers' maps after 6 h. The optional **Beacon** layer follows the same rule: it publishes only a tapped point / drawn shape, only on an explicit Publish press, only to the **user's own** faros server, always with a **mandatory expiry** (15 min / 1 h / 6 h presets) after which the server deletes it; fetched beacon data is volatile (never persisted at rest) and refresh is manual + on-open, never polled. Nothing is ever shared automatically or in the background. |
| Metadata protection (Tor) | **Available, opt-in** — the "use Tor" switch routes rendezvous + chat over peer-hosted onion services; off by default. |
| DHT participation (opt-in) | Publishing your pkarr record announces "this NodeId is online" to anyone who knows the NodeId (relay addresses only, not direct IPs). Room/nickname records are sealed — see [§12 threat notes](#12-dht-discovery-mainline-rendezvous--contacts). |

**At-rest posture.** All persisted state is sealed in the per-profile protasius vault
(Argon2id-derived key wrap, XChaCha20-Poly1305 values, AAD-bound to each record's
location). The plaintext exceptions are: the vault header `vault.json` (salt +
wrapped DEK — useless without the passphrase); map-region blobs
(`profiles/<p>/maps/<blake3>.pmtiles` — public map data, immutable and
content-addressed, so filenames carry no coordinates; which area they cover, plus
all pins/routes, lives only in sealed kv — accepted because whole-blob sealing
is incompatible with the random-access reads the map needs); and — only while the app is unlocked
*and* "keep onion stable" is on — arti's materialized onion keystore, which is sealed
back into the vault and wiped on lock/exit (a crash can leave it until the next
unlock's sweep). `zeroize` scrubs transient RAM buffers; `wipe_file` is a
best-effort single-pass overwrite (not a secure erase on SSD/journaling
filesystems). There is **no passphrase recovery**: the unlock gate has no
wipe/reset; the only destructive reset is Settings → "Clear all data".

---

## 9. Security & privacy considerations

Enigma's cryptographic core (OpenMLS) is solid; the current weaknesses are almost all
at the **integration layer**. Documented candidly here (roughly most- to
least-serious) so they can be addressed:

1. ~~**Plaintext local storage.**~~ **Resolved** — all state is now encrypted at
   rest behind the passphrase gate ([§13](#13-encryption-at-rest-gervasius--protasius)).
   Residual: the managed onion-keystore crash window and best-effort wipes (see §8).
2. **No key verification (TOFU only).** The QR/ticket carries no MLS key or
   fingerprint, and the MLS credential is a self-asserted string. There is no
   safety-number/SAS check, so a man-in-the-middle or impersonator on the pairing
   channel or gossip topic is not detectable in-app. → *Bind the MLS credential to the
   QR and add a fingerprint/safety-number verification step.*
3. **Advisory-only group management.** "Admin" is elected by a lexicographic string
   compare (`ourId < theirId`) over self-chosen identities — anyone can name themselves
   to win. OpenMLS in this config lets any member commit adds/removes; the single-adder
   rule is app convention, not protocol enforcement.
4. **Unauthenticated control frames.** MLS-signaling envelopes are plaintext gossip
   frames. Any topic member can broadcast `mls_reset_request` (forces every client to
   rebuild the group / clear history) or trigger the `"group id differs"` re-key path —
   an unauthenticated disruption/DoS vector.
5. **Pre-MLS plaintext window + optimistic lock badge.** Before MLS is `ready`,
   `sendMessage` falls back to a cleartext `chat_message` over the topic (protected
   only by QUIC transport, not E2E). Separately, a peer's status flips to
   "🔒 encrypted" after a **blind 5-second timer** (armed by every peer in `startMls`),
   so the lock indicator can show "encrypted" for a group-of-one. Also, the displayed
   `sender_name` is an attacker-controllable field, not the MLS-authenticated identity.
6. **Metadata exposure to n0 infrastructure** — NodeId social graph, IPs, timing, and
   presence (see [§6](#6-is-it-truly-p2p-intermittent-nodes)). Mitigations: "use Tor"
   (runtime, per profile) or a no-hosted-relays build (compile time).
7. **Weak transport-level room access control.** `topic = blake3(name)` with no
   secret; low-entropy names are trivially derived, letting anyone who knows the name
   join the swarm and attempt to be added to the MLS group. (DHT room *codes* carry a
   proper secret; the auto-admit MLS flow is the shared gap — an admission-approval UI
   is future work.)
8. **WebView / IPC surface.** `tauri.conf.json` sets `security.csp = null` (no Content
   Security Policy); on Linux the app auto-grants every WebView permission request; and
   `fs_read_text_file` / `fs_write_text_file` are invokable with **unrestricted
   absolute paths** (no scope/allowlist). → *Add a CSP, gate permission requests, and
   scope or remove the raw FS commands.*
9. **`tor.rs` clearnet-TLS footgun.** `tor.rs` (the outbound Arti client, shared by
   `p2p_tor.rs` and `cloud.rs`) contains an `AcceptAnyServerCert` TLS verifier (no
   name/CA validation). It is used deliberately for `.onion` (self-authenticating)
   and loopback cloud hosts; real clearnet cloud hosts get full WebPKI verification
   (`webpki-roots`). The onion transport carries plaintext frames over the Tor
   circuit — no TLS — so it doesn't touch this verifier. Keep it away from any new
   clearnet path.
10. **Minor:** `openmls_rust_crypto` is built with the `test-utils` feature in
    production; the untested orchestration core (`useChatChannel`/`crypto` have no unit
    tests); 16 MiB gossip frames are an amplification consideration.

---

## 10. User interface

A tabbed app (memory-history router, no URL bar), behind the at-rest **unlock gate**
(`App.vue`: passphrase setup on first run, unlock on every launch — no recovery):

- **Chat** (`EnigmaChatView` / `ChatPanel`) — a responsive 3-column layout at desktop
  width (rooms sidebar · conversation · participants), collapsing to a hamburger drawer
  on mobile. Create room → QR (`CreateRoomModal`, gold ★ captain badge); join by
  QR scan / image / pasted ticket or DHT room code (`JoinRoomModal`, connect-timeout
  countdown); compose text / images / voice notes / emoji; MLS lock badge +
  "reset encryption". Room info (`RoomInfoModal`) shows the QR plus the captain-set
  **room logo** (also in the sidebar rows + chat header) and **room rules**; the
  captain moderates from the participants panel (`ModerateMemberModal`: timed mute
  with presets/custom duration, kick + ban with unban in room info) — see
  [§11](#11-tor-onion-transport--captain-election).
- **Calls** (`EnigmaCallsView` / `VoxPanel`) — 1:1 voice calls: by ticket/QR, by
  room member (signaled over the chat's MLS seam), or by DHT nickname / saved
  contact; live spectrum equalizer; incoming-call nav dot.
- **Files** (`EnigmaFilesView`) — four sub-tabs: **P2P** (offer/accept transfers
  with progress, max-size guard), **Cloud** (the user's own Enigma Cloud server —
  login/register, browse buckets/directories, upload/download/move/delete; hidden
  in cloud-disabled builds), **Local** (passphrase-lock files in place, ENIGLOCK),
  **Devices** (`DevicesTab` — the user's OWN linked devices, never a room peer):
  an always-visible list of linked devices (kind, this-device badge, per-device
  online dot, last sync, unlink) over two sub-sub-tabs — **Files**, a shared list
  of allowed files with checkboxes, Select all and explicit **Push**/**Pull**
  buttons (nothing transfers by itself; identical copies are skipped by hash;
  received files land in `<profile>/synced/`), and **Pairing** (the QR pairing +
  join flows, moved here from Settings). Compile-time gated
  (`devices.allow_linking`); see fsync.md and sync.md.
- **Contacts** (`EnigmaContactsView`) — saved peers with DHT presence ("recently
  online"), find-by-nickname, invite-to-room, call buttons ([§12](#12-dht-discovery-mainline-rendezvous--contacts)).
- **Calendar** (`EnigmaCalendarView`) — room-scoped meetings + scheduling polls over
  the MLS seam; local OS notification reminders (lead time in Settings).
- **Map** (`EnigmaMapView` / `MapPanel`, `RegionsPanel`) — fully offline MapLibre map
  over imported PMTiles region packages: immutable content-addressed blobs made by
  the standalone `tools/map_packager` (the app never talks to tile servers),
  imported from the device with BLAKE3 + manifest verification and storage-budgeted;
  import/export region files, private pins + hand-drawn routes (sealed kv), and
  room sharing — pins/routes as compact MLS chat cards ("Open in Maps" is always an
  explicit action), region files over the P2P file-transfer path (never MLS).
  Builds with Enigma Cloud also get the **Beacon** sidebar card + map layer
  (`beacon.rs`, `stores/beacon.ts`, `BeaconCard`/`BeaconPublishModal`): expiring
  location shares (one live pin per user, zones, routes — teal, distinct from
  local pins and room shares) on the user's own faros server, published from map
  taps with a mandatory TTL, fetched on open / explicit refresh, plus a
  "Near here" viewport query (`/beacon/near`, distance-sorted).
  One region can be **activated** (Regions → Activate): served first for tiles
  (others still fill), badged in the list + a chip on the canvas, the view opens
  spread to it, and the choice persists sealed per profile (device-local).
  Room members' shares also render as a distinct **shared layer** (violet
  pins/routes, orange locations, sender initial on the badge) wherever an
  imported region covers them; anything outside coverage is listed in the
  sidebar rather than drawn over blank canvas. A **shared location** is pushed
  by hand — the user taps a point, adds an optional label, and presses Share —
  and stops being drawn after 6 h, though its chat card remains. Per-item "Save
  to my pins" adopts a share as ordinary local map data.
  Compile-time gated (`maps.enabled`). The basemap follows the app theme (a
  night-styled map in dark mode) by swapping the bundled protomaps flavour —
  no tile server is involved. **No geolocation, no tracking, no directions
  engine** — location sharing changes none of that: the app never calls
  `navigator.geolocation` and never asks the device where it is (an e2e test
  traps the API and fails if anything ever does); a shared location is a point
  the user chose, which may or may not be where they are.
- **Mind** (`EnigmaMindView` / `MindMapPanel`, `MindTopicsPanel`) — a private
  mind map, strictly this device's: sealed kv (ns `mind`), deliberately absent
  from the device-link and peer-sync allow-lists (negative pinning tests), and
  no `mind_*` wire messages exist. One directed graph on a cytoscape canvas:
  note nodes and hexagonal **topic** hubs, labeled directed edges with
  two-click connect + a rubber-band ghost, endpoint **reconnect** handles on
  the selected edge, and collapse-a-branch (double-tap / Space / ⊖ chip;
  hidden = unreachable except through a collapsed frontier, so cross-linked
  topics never punch holes in each other). All node text lives in ONE edit
  modal (`MindNodeEditModal`, opened from the ✎ chip / inspector / F2 / node
  creation): title, kind, and content as Trix rich text or plain text,
  buffered drafts, Save = one undo step, Discard = nothing happened. The
  Topics sub-tab browses topic hubs — a read-only details modal (description
  through read-only Trix, linked nodes either direction) with "add note",
  which creates a note wired note → topic and hands it to the editor.
  Autosaved (debounced), whole-doc undo/redo, breadthfirst auto-arrange, JSON
  export/import (validated, replace-after-confirm, one Undo restores).
  Compile-time gated (`mind.enabled`).
- **Settings** (`EnigmaConfigView`) — four tabs: **Profile** (local-only PII,
  multiple named profiles), **Settings** (language en/pl; "My identity" NodeId QR;
  connection timeout; max file size; meeting reminder; DHT discovery + cadences +
  status probe; Enigma Cloud server URL), **Connections** (use-Tor, stable-onion),
  **Data** (airplane mode; data profiles; reset passphrase; clear data).

Styling is Tailwind v4 with the in-repo "Oya" primitives kit; CSS-first design
tokens — see [§14](#14-conventions-naming--palette). Dark mode defaults on but is
not persisted across launches; locale is persisted.

---

## 11. Tor onion transport & captain election

*(Condensed as-built reference; the transport lives in `p2p_tor.rs`, orchestration
in rakotis `useChatChannel.ts`.)*

**What it is.** An opt-in second transport: flip **"use Tor"** (Settings →
Connections) and rooms are hosted as **peer-hosted onion services** — the QR carries
a `.onion`, all rendezvous + chat rides Tor, and iroh is not used (exclusive mode).
This hides the NodeId↔IP graph from n0 at the cost of Tor latency. No app server:
the onion service is hosted *by a peer*.

The elected **captain** (lowest live MLS id) is more than the Tor host: on **both**
transports it is the room's moderation authority — it sets the room **logo** and
**rules** and can **kick** (MLS removal + identity ban, refused re-admission by the
acting admin) or **time-mute** members (everyone drops the muted member's messages
until expiry; its composer locks). State travels as a captain-authoritative
`room_meta` snapshot over the encrypted seam and is persisted per room. When a
member joins (its first presence), **every holder shares the snapshot** — a
captain's copy applies at same-or-higher revision, anyone else's only when
strictly newer, which hands the state over when captaincy shifts (e.g. a
lower-id joiner becomes captain and re-broadcasts the adopted snapshot).
User avatars ride presence the same way, so logo + member pictures arrive
automatically on join. Enforcement is cooperative, like all group management
here ([§9](#9-security--privacy-considerations)).

**Topology — everyone hosts, one relay, re-pointable dial.** Every member of a Tor
room hosts its own onion (always-on accept loop) and maintains **one outbound dial
to the current captain**; the captain relays MLS ciphertext among its inbound peers.
Relaying is pure byte fan-out — the captain never holds group secrets for messages
it forwards. The relay graph is a **loop-free tree**: a member with both inbound
dialers and an outbound bridges child↔parent frames, so *any* member is a valid
entry point (parent pointers go strictly downward in id ⇒ no cycles).

**Captain election + failover.** The captain is the **lowest MLS identity** among
members whose onion is known and live. Onions are shared over encrypted presence
messages; every member computes the same election locally (`electCaptain` in
`useChatChannel`, debounced ~2 s). If the captain becomes unreachable (outbound
retry budget exhausted: 3 retries, exponential 2→4→8 s capped 15 s), the transport
emits `realtime://status` with `reason:"captain_unreachable"`; survivors mark it
dead, re-elect the next-lowest, re-point their outbound to its already-published
onion, and the admin evicts the dead captain from MLS. A revived member's fresh
presence clears its dead flag; if lowest, captaincy hands back. The ★ badge
(`--color-highlight` gold) marks the captain in the roster (Tor rooms only).

**Mechanics (as built):**
- arti 0.43 `onion-service-service`; the client is bootstrapped from a per-profile
  state dir. `fs-mistrust` is relaxed (`dangerously_trust_everyone`) — deliberate
  and re-affirmed after the at-rest work: the HS key is sealed in protasius and only
  transiently on disk while unlocked ([§13](#13-encryption-at-rest-gervasius--protasius)).
  Stale arti lockfiles are cleared before bootstrap and never sealed into archives;
  `tor_clean_keystore` (Settings → clear data) is the recovery path that mints a
  fresh `.onion`.
- Framing: 4-byte LE length prefix + JSON, cap = `network.max_frame_bytes` (build
  config; matches iroh's gossip cap). Handshake `Hello{name, peer_id}` → `Ready`.
  Fan-out writes are bounded (`tor_write_timeout_secs`), the join handshake read too
  (`tor_handshake_timeout_secs`) — one stalled circuit can't wedge the host.
- Ticket: `TorTicket { onion, port, name }`, tag byte `0x54` + postcard + base32.
  Join routing sniffs the tag; `realtime_send` routes by **room ownership** (which
  backend has the room), not the switch, so ticket-sniffed joins can always send.
  The virtual onion port is a build-config value carried in each ticket.
- "Stable onion" is a per-profile switch: OFF ⇒ ephemeral key, new `.onion` each
  session; ON ⇒ the HS key persists sealed in protasius (managed keystore lifecycle).
- Descriptor publish takes seconds-to-tens-of-seconds on first launch — surfaced as
  `"connecting"` with a spinner, and why connect timeouts must stay user-tunable.

**Known limitations (accepted):**
- **New joiners still need the ticket onion online.** Failover keeps existing
  members connected, but the QR only carries the creator's `.onion` — a brand-new
  joiner can't bootstrap while the creator is offline; a current member must share a
  fresh QR.
- A creator that was captain, fully failed over, then restarts alone re-hosts as an
  isolated (non-corrupting) solo group.
- Handoff transients: ~2 s debounce message-loss window, brief split-brain during
  death detection (converges to lowest live id), best-effort frame drop mid-reconnect.
- Multi-peer *mesh* over Tor is out of scope (star/tree only); election is scoped to
  the currently open room.
- Rooms paired over iroh don't auto-migrate to Tor (fresh QR pairing required), and
  vice versa.

---

## 12. DHT discovery (Mainline rendezvous + Contacts)

*(Condensed as-built reference; engine in `p2p_dht.rs`, endpoint wiring in
`p2p_iroh.rs`, contacts in rakotis `services/contacts.ts`.)*

**Not in Tor mode.** The DHT rides the iroh endpoint, which Tor-exclusive mode
shuts down, so `discovery_enabled` / `nick_publish_enabled` return false there
regardless of the toggle — and a nickname claim would otherwise publish a relay
address the profile is deliberately not using. Over Tor the peer directory is
the user's own faros server (Cloud rendezvous, rdv.md): its Contacts surfaces
are hidden and the Settings toggle disables with the reason.

**What it is.** An opt-in (default off; inert in no-hosted-relays builds), fully
community-run discovery path over the **BitTorrent Mainline DHT** (~10M nodes, no
infrastructure of ours or n0's): ticketless room join by a shareable **room code**,
plus the **Contacts** tab (saved peers, presence, nickname search). iroh 0.98's
native `DhtAddressLookup` (pkarr-over-DHT) races n0 discovery in parallel; the
`mainline` crate gives direct BEP44 access for our rendezvous records. MLS still
gates membership — the DHT only introduces transport connections. The gossip topic
derivation is unchanged (`blake3(room_name)`), so DHT-joiners, ticket-joiners and
reconnects land on the same topic.

**Room secret & room code.** On room creation with discovery on:
`room_secret: [u8;32]` (random, never derived from the name — prevents
squatting/enumeration). Room code = `base32_nopad(0x44 ‖ postcard{name, secret})`,
lowercase; the `0x44` tag joins the ticket-tag family for sniff-routing. The secret
persists in the vault (ns `dht`); any online holder keeps the room discoverable.

**Rendezvous records** (BEP44 mutable items, ≈200 B) under hourly-rotating keys:

```
bucket      = floor(unix_seconds / 3600)
signing_key = ed25519 from blake3::derive_key("enigma/dht/room-sign/v1", secret ‖ bucket_le)
enc_key     =              blake3::derive_key("enigma/dht/room-enc/v1",  secret ‖ bucket_le)
salt        = b"enigma-room-v1"
plaintext   = postcard { v:1, node_id, peers: Vec<[u8;32]> (≤4), ts }
value       = nonce(12) ‖ ChaCha20-Poly1305(enc_key, nonce, plaintext)
```

Readers query bucket `b` and `b−1`; records older than two buckets are dropped.
Multi-writer under one shared bucket key: every secret-holder signs the same key,
storage nodes keep the highest `seq`, readers decrypt + dedupe. Encryption hides
room membership from DHT observers; the derived signing key means only
secret-holders can write acceptable records. The publisher loop re-announces every
`dht_room_publish_secs` (±20 % jitter; skips a round when ≥5 fresh third-party
records are visible).

**Nickname directory** ("findable as ‹nick›", opt-in): static keys derived from the
normalized nickname (`blake3::derive_key("enigma/dht/nick-sign/v1" / "nick-enc/v1")`,
salt `b"enigma-nick-v1"`), sealed claim record `{v, node_id, display name ≤64, ts}`.
Claims, not identities: anyone can publish any name; search lists every fresh
claimant with its NodeId fingerprint (verification is out-of-band; the direct-invite
handshake authenticates the NodeId cryptographically). You are findable only while
the app is publishing (freshness window ~2 h). A crawler can't harvest the
directory — you must know the name you search.

**Presence** (Contacts): no record type of ours — iroh's `DhtAddressLookup` already
publishes each enabled node's pkarr record (~1 h republish); "recently online" =
that record's freshness vs ~2× the window. Honest granularity ≈ 1 hour; meaningful
only between peers who both enabled the toggle.

**Cadences** are user-set (kv `p2p:settings`; defaults + clamps from the build
config): `dht_discovery` (off), `dht_room_publish_secs` (600, 60–3600),
`dht_presence_poll_secs` (300, 60–3600, frontend-only). Flipping the toggle rebinds
the iroh node (`dht_apply`); vault-locked or unreadable settings are treated as off.
Failure modes degrade silently: lookups race n0 in parallel, so a blocked UDP path
falls back to n0 DNS/relay; `dht_status` feeds the Settings/Contacts status lines.

**Threat notes:** the room code is a **bearer credential** (transport access + the
current auto-admit MLS flow — same trust model as a leaked QR ticket; an
admission-approval UI is future work). Rendezvous linkability is bounded by the
hourly key rotation. Enabling the toggle publishes your NodeId record (relay
addresses only, by default) — the presence feature's data source *is* its privacy
cost. Topic collision on `blake3(name)` is unchanged from ticket rooms.

**Direct room invites** ride a dedicated ALPN (`enigma/invite/0`, `p2p_invite.rs`):
an offer/accept handshake whose payload carries a fresh ticket + the DHT room code,
surfaced as `invite://incoming` / `invite://resolved`.

---

## 13. Encryption at rest (gervasius + protasius)

*(Condensed as-built reference. Crates: `cryptorotor/gervasius` — primitives;
`protasius/` — the store; app integration in `vault.rs` / `lib.rs`.)*

**Model.** On every launch the user enters a passphrase (per profile; set on first
run — minimum length enforced in UI only). Envelope:
`passphrase --Argon2id--> UKEK --wraps--> random 32-byte DEK
--XChaCha20-Poly1305--> data`. Password change re-wraps only the DEK (O(1), fresh
salt) — data is never re-encrypted. Wrong passphrase fails closed on the wrapped-DEK
AEAD tag. Keys are held in memory only and zeroized on lock/exit. **No recovery by
design**: the unlock gate has no wipe/reset; the only destructive reset is
Settings → "Clear all data".

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
  commands; all persistence sites (profile state, MLS sessions, iroh/tor keys, kv)
  reach the store via managed state. Profile switch tears down transports first
  (so the onion keystore seals into the correct profile), re-opens protasius locked,
  and reloads the webview so the gate re-runs.
- **Managed onion keystore** ("keep onion stable" switch, default off): OFF ⇒
  ephemeral, the `.onion` regenerates each session; ON ⇒ arti's keystore dir is
  archived (postcard), sealed into `keys/tor_keystore`, and wiped on
  shutdown/lock — materialized on disk only while unlocked. The plaintext dir is
  wiped **only after a successful seal**. A crash while unlocked leaves it until the
  next unlock's sweep — the one accepted exposure window.
- **Per-file locking** (`local_lock.rs`, Files → Local): encrypt any chosen file in
  place under its own passphrase using the same gervasius envelope. On-disk format
  `ENIGLOCK`: `magic(8) ‖ version(1) ‖ header_len(u32 LE) ‖ VaultHeader(JSON) ‖
  nonce(24) ‖ ct+tag`, AAD `enigma:localfile:v1` (constant, so locked files can be
  renamed/moved). The passphrase is never stored; the UI keeps only a record of
  which files are locked (kv ns `files:local`).
- **Notes editor** (`local_note_read` / `local_note_write` / `local_note_stat` in
  `local_lock.rs`, Files → Local): edits local text files in an ACE editor. A locked
  file is decrypted into memory only — reading never rewrites it, and saving re-seals
  from the buffer, so its plaintext never lands on disk. Encryption is opt-in per file:
  a plain file saves as plaintext (refused if the file on disk is currently `ENIGLOCK`,
  so ciphertext is never clobbered), and "Encrypt…" converts it. Saves are stateless —
  no DEK is cached in Rust; each encrypted save re-reads the file's *current* header and
  re-derives the key from the passphrase the editor holds, so a file re-keyed by another
  process fails closed instead of being overwritten under a stale key. Recently edited
  files are remembered under kv ns `files:local`, key `notes`. ACE is bundled offline:
  modes and themes are static imports and its six syntax workers are registered with
  `ace.config.setModuleUrl` against bundler-emitted asset URLs (`aceSetup.ts`), so it
  never falls back to fetching them from a CDN.
- **Maps data:** region manifests (`map:regions`), pins (`map:pins`) and routes
  (`map:routes`) are sealed kv like everything else — coordinates never persist
  outside the vault. The region *blobs* are the documented plaintext exception
  (see §8 at-rest posture).
- **Device file sync (fsync.md):** the shared allowed-files list (ns `filesync`,
  key `""`) and this device's paths/hashes for it (key `local`) are sealed kv.
  The list replicates between linked devices over the devlink room's own
  `dlink_files` message — deliberately NOT through DEVLINK_SYNC_KV — and the
  per-device `local` key never leaves the device (a path leaks directory
  layout). The synced FILES themselves land in `<profile_dir>/synced/` as
  ordinary plaintext: they are the user's own files, arriving over file_xfer and
  BLAKE3-verified on the way in (the same documented exception as map blobs and
  exported sketches — see §8).
- **Map shares add NO at-rest surface.** What a room shared lives only in the
  already-sealed `chat:log` (as the map card it arrived as); the shared map
  layer is derived from that timeline at render time, never stored again. The
  `map:*` namespaces grow only when the user explicitly saves a pin/route, and
  a shared LOCATION is never written there at all unless adopted.
- **Mind data:** the mind-map document (ns `mind`, key `""`) is sealed kv,
  device-local by construction (absent from `DEVLINK_SYNC_KV` and
  `PEER_SCOPE_KV`; pinned by negative tests). Node content
  is Trix HTML treated as an opaque capped string, scrubbed at validation
  (`scrubContentHtml`): images/attachments/scripts stripped and hrefs allowlisted
  to http(s)/mailto, because the webview has no CSP and a smuggled
  `<img src="https://…">` would otherwise fetch — the editor additionally blocks
  attachments and scrubs rich pastes before Trix parses them. Content is only
  ever rendered through Trix's parser, never `v-html`.

Notes: the first profile to run setup inherited the previously-global kvstore and
iroh key; other profiles start fresh (accepted pre-release). Values decrypted for
the webview cross into JS and can't be zeroized there — accepted.

---

## 14. Conventions (naming & palette)

### Naming

Two naming schemes coexist by design — know which applies:

| Scheme | Used for | Examples |
| --- | --- | --- |
| **Functional-descriptive** | the app, its lib, and API surface | `enigma`, `enigma_lib`, `rotor-core`/`rotor-py`/`rotor-wasm`, commands `vault_*`/`kv_*`/`mls_*` |
| **Thematic codename** | reusable libraries & subsystems | `cryptorotor` (crypto workspace), `gervasius` + `protasius` (at-rest crypto pair), `rakotis` (UI/chat package), `Oya*` (UI primitives) |

`gervasius` & `protasius` are a deliberate paired hagiography (at-rest **primitives**
vs the **store** built on them). Don't "normalise" the codenames away.

**Rust crates.** Directory + `[lib]` name = `snake_case`; Cargo `[package].name` =
`kebab-case`. So `cryptorotor/rotor_core/` → package `rotor-core`. The Tauri app is
bin `enigma` + lib `enigma_lib` (the `_lib` suffix avoids a Windows bin/lib clash).

**Vue components.**
- Reusable primitives live in `packages/rakotis/src/components/primitives/` with the
  **`Oya`** prefix, PascalCase (`OyaButton`, `OyaModal`, `OyaTextField` … zero exceptions).
- App components are PascalCase, **no** prefix, grouped by feature folder
  (`components/chat/`), and carry a type suffix: `*Modal`, `*Chip`, `*Panel`, `*Bar`,
  `*Row`, `*Sidebar`, `*Drawer`, `*List`.
- Route views are `Enigma<Domain>View` (`EnigmaChatView`, `EnigmaFilesView`,
  `EnigmaContactsView`, `EnigmaConfigView`, `EnigmaProfileView`, …). Stores are
  lowercase domain files (`chat.ts`, `user.ts`, `cloud.ts`). Composables are
  `useXxx` camelCase.

**Tauri commands.** `snake_case`, `<domain>_<verb>` families — `app_*`, `vault_*`,
`kv_*`, `mls_*`, `realtime_*`, `audio_*`, `fs_*`, `tor_*`, `file_*`, `dht_*`,
`invite_*`, `vox_*`, `cloud_*`, `local_*`, `map_*`, `devlink_*`. All registered in the single
`generate_handler!` block in `apps/enigma/src-tauri/src/lib.rs`. (Two legacy getters,
`current_profile`/`current_identity`, predate the prefix rule — leave or migrate to
`app_*`, don't add new prefix-less commands.)

**Events.** `scheme://path` naming: `realtime://message` and `realtime://status`
(both transports emit identical names so the frontend is transport-agnostic; a
single event multiplexes all rooms, the payload carries the room id), plus
`file://progress|done|error`, `cloud://progress|done|error`,
`invite://incoming|resolved`, `vox://*`,
`devlink://request|paired|progress|done|error`.

**i18n keys.** Two levels: `namespace.camelCaseLeaf` (`chat.newChat`, `vault.wrongPass`).
Namespaces: `nav`, `common`, `lang`, `config`, `chat`, `calendar`, `kanban`,
`map`, `contacts`, `fileShare`, `profile`, `vault`, `files`, `vox`, `cloud`,
`local`, `devices`. Interpolation uses single-brace named
tokens (`{n}`).

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
| `highlight` | `#facc15` (both) | | Host/captain ★ marker / "attention" (MLS key-exchange) |

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
invalid file = build error — see [build.md](build.md)). Owns: the cloud/hosted-relay
allow flags, crypto declarations (compile-asserted against rotor_core/gervasius) +
Argon2id costs for new vaults, feature defaults for new profiles, defaults **and
clamp bounds** of the kv-backed settings, and network constants (frame cap, onion
port, chunk size, timeouts). The frontend fetches the relevant subset once at boot
via `app_get_build_config` (rakotis `initBuildConfig`/`getBuildConfig`; `main.ts`
seeds the browser-mode fallback from `config/app.ts`). `tauri.conf.json` stays
authoritative for productName/identifier/version — `build.rs` asserts the YAML
mirrors it.

**Frontend app config:** [`apps/enigma/src/config/app.ts`](apps/enigma/src/config/app.ts)
— brand identity, UI policy, dev port. Import `brand` / `policy` / `dev` from here
instead of hardcoding.

| Value | Canonical home | Notes / mirrors |
| --- | --- | --- |
| Display name `Enigma` | `config/app.ts` `brand.name` | Also `tauri.conf.json` `productName` + window `title` (kept capitalised to match) |
| Copyright / org / legal URL | `config/app.ts` `brand` | Was hardcoded in `App.vue` |
| Bundle identifier | `tauri.conf.json` `identifier` | Mirror `brand.bundleId` (`com.spectrumaipl.enigma`) |
| Passphrase min length | `config/app.ts` `policy.passphraseMinLen` | **UI-only** today — see the roadmap note below |
| Profile field caps | `config/app.ts` `policy.*MaxLen` | `displayNameMaxLen` 150, `profileNameMaxLen` 80 |
| Cloud / hosted-relay allow flags | `build_config.yaml` `cloud.allow_connections`, `p2p.allow_hosted_relays` | Compile-time kill switches: cloud gates all `cloud_*` commands (`CLOUD_DISABLED`) + hides the Cloud UI; relays flips iroh to `RelayMode::Disabled` and forces DHT discovery off |
| Feature defaults (tor/stable/dht) | `build_config.yaml` `features:` → Rust `AppProfileState` serde defaults + `p2p_dht` missing-key defaults | Apply to **new profiles only** (saved profiles keep their stored bools). UI mirrors via `policy.featureDefaults`; `offline` always starts false (not configurable) |
| P2P connection timeout | kv `p2p:settings` / `connect_timeout_secs` (rakotis `appStorage.getConnectTimeoutSecs`) | **User-set in Settings**; default + clamp (60 s, 5–600) come from `build_config.yaml` `settings:`. Governs create/join give-up + the join window's read countdown (window ≤ 2×N) — never hardcode a connect deadline. Rust reads the same key (`p2p_dht::connect_timeout_secs`) for the DHT rendezvous-resolver deadline |
| DHT discovery + cadences | kv `p2p:settings` / `dht_discovery`, `dht_room_publish_secs`, `dht_presence_poll_secs` (rakotis `appStorage.getDht*`) | **User-set in Settings**, opt-in (default off). Publish default + clamp (600 s, 60–3600) from `build_config.yaml`; presence poll 300 s clamp 60–3600 (frontend-only). Rust reads the same keys directly (`vault::kv_get_raw`); inert when `p2p.allow_hosted_relays: false`; see [§12](#12-dht-discovery-mainline-rendezvous--contacts) |
| Maps kill switch | `build_config.yaml` `maps.enabled` | Compile-time: `false` builds without the Map tab (route redirects, `map_*` commands error `MAPS_DISABLED`). No other map knobs exist — the app has no tile-fetch path to configure |
| Maps storage limit | kv `p2p:settings` / `map_storage_limit_mb` (rakotis `appStorage.getMapStorageLimitMb`) | **User-set in Settings**; default 512 MB clamped 64–65536 from `build_config.yaml`. Enforced in Rust before every region import (`MAPS_STORAGE_LIMIT` error contract) |
| Maps active region | kv `p2p:settings` / `map_active_region` (rakotis `appStorage.getMapActiveRegion`) | **User-set via Map → Regions → Activate**; the priority region for tile resolution — checked first, other imported regions still fill the gaps. Rust reads the same key (`maps.rs`) and clears it when the region is removed. Device-local — deliberately NOT in the device-link sync allow-list (each device imports its own packages) |
| Mind kill switch + caps | `build_config.yaml` `mind.enabled`, `mind.max_nodes` 500, `max_edges` 1000, `max_title_len` 200 (also edge labels), `max_content_len` 20000 (Trix HTML) | Compile-time: `false` builds without the Mind tab (`/mind` redirects). Caps enforced in `useMind` (creation refused at capacity) and `mindModel` validators (load/import truncate). No Rust surface — the feature is pure frontend over sealed kv |
| Device-linking kill switch | `build_config.yaml` `devices.allow_linking` | Compile-time: `false` builds without the Files→Devices tab (pairing AND per-file sync) and every `devlink_*` command errors `DEVLINK_DISABLED`. Linking is pure P2P (iroh), so it ships **on** by default |
| Devlink pairing window / resync cadence | kv `p2p:settings` / `devlink_pair_window_secs`, `devlink_resync_secs` | Window bounds how long a pairing QR's one-time secret stays redeemable (default 600 s, 60–3600; read Rust-side in `device_link.rs`); resync paces the linked-device catch-up exchange (default 300 s, 30–3600; rakotis `appStorage.getDevlinkResyncSecs`). Device-local — deliberately NOT in the sync allow-list. Pairing dials use `connect_timeout_secs` like every other connect deadline |
| Chat history cap | kv `p2p:settings` / `chat_history_cap_msgs` (rakotis `appStorage.getChatHistoryCapMsgs`) | **User-tunable**; default 500 msgs clamped 50–5000 from `build_config.yaml`. Bounds the sealed per-room `chat:log` kv (oldest segment pruned past it) — the store that survives restarts and replays to linked devices |
| Meeting reminder lead | kv `p2p:settings` / `meeting_reminder_mins` (rakotis `appStorage.getMeetingReminderMins`) | **User-set in Settings**; default 15 min, clamped 0–1440, 0 = off. Read by `useMeetings`' reminder tick every round (changes apply live) — never hardcode a reminder lead |
| Release version `0.1.0` | `tauri.conf.json` `version` | De-facto owner (drives bundle filenames); duplicated in 6 manifests. `build_config.yaml` `app:` must mirror it — `build.rs` fails the build on drift |
| Dev port `1420` | `vite.config.ts` `server.port` | Mirrored in `tauri.conf.json` `devUrl`, `scripts/tauri-dev-server.mjs`, `dev.vitePort` |
| Argon2id params | `build_config.yaml` `crypto.kdf` (new vaults, via `lib.rs::kdf_params`) | Persisted per-vault in the header, so old vaults always unlock; `gervasius KdfParams::default()` is the library-level fallback and must stay in sync |
| P2P frame cap / onion port / chunk sizes / Tor timeouts | `build_config.yaml` `network:` | `max_frame_bytes` is **wire-interop** (Tor frame + iroh gossip cap — change in lockstep across a fleet); onion port rides in tickets |
| AAD prefix / tag bytes | `protasius/src/lib.rs` | `protasius:v1:`, `TAG_INTERNAL`/`TAG_KV` |
| Window size, bundle targets | `tauri.conf.json` | — |
| Two-profile dev instances | `APP_PROFILE` / `CHAT_USER` env | Defaulted in `run_dev.sh`; **`lib.rs` owns the `"default"` fallback** |

**Pairs that MUST be bumped together** (no shared source yet): the `rakotis` source
alias path (`vite.config.ts` + `vitest.config.ts` + `tsconfig.json`); the desktop apt
dependency list (docs + CI jobs); the Playwright image tag `v1.60.0` ↔
`@playwright/test ^1.60.0`; the NDK version `27.2.12479018` (docs ↔ installer); the
`*.deb/*.AppImage/*.rpm` bundle glob (`build_desktop.sh` + CI). State one Node floor
(CI uses **node 22**).

### Centralization roadmap (not yet done)

Deliberately deferred; each is a real drift source. Do these when touching the
relevant subsystem:

**Rust consts (a shared module, or in-crate):**
- `gervasius`: name the magic sizes — `SALT_LEN = 16`, `KEY_LEN = 32`, `VAULT_VERSION = 1`.
- Transport: `IROH_TAG 0x49` / `TOR_TAG 0x54` / `DHT_TAG 0x44` (ticket/code routing)
  currently one per file, cross-referenced only in comments (and mirrored in
  `useChatChannel.ts` `isTorTicket`/`isDhtCode`) → **one shared module** so they
  can't collide.
- protasius namespace/key strings (`profile`/`keys`/`cache`/`state`, `tor_peer_id`,
  `tor_keystore`, `iroh_gossip`) are bare literals across 4 files → named consts (a
  typo silently loses stored data).
- Fold inline Tor timers (`backoff cap 15s`, `onion-poll 200ms`) in with the named ones.

**Policy enforced on both layers.** `passphraseMinLen` is UI-only — a direct `invoke`
bypasses it, and `gervasius::create_vault` accepts any passphrase. If it's a real
boundary, enforce the same value in Rust (`vault_setup`/`vault_change_passphrase`).

**Frontend consts (rakotis).** LocalStorage keys + the `enigma:` prefix + the on/off
boolean encoding are scattered (`enigma:stableOnion` is inline-duplicated in
get/set) → one constants module. Same for chat timing (`5000`, `30000` duplicated) and
UI copy/confirm delays (`1200`/`1500`/`2000`).

**Build.** A version-bump script (or Tauri reading version from `package.json`) so
`0.1.0` isn't hand-maintained in 6 manifests; extract the apt list to
`scripts/install_desktop_deps.sh`; add `.nvmrc`/`engines` for the Node floor.

**Palette.** Promote a `--color-scrim` token (unify `black/70` vs `black/40`) and lift
the repeated `text-white border-white/20` modal buttons into a rakotis primitive.
Consider self-hosting Orbitron (`@font-face`) — the CDN `<link>` fails in the offline
desktop/mobile shell.

---

## 16. History — the serverless rework

This repo used to be a three-app monorepo (Enigma / Enigma+ / Aurora) with a server
relay. The rework turned it into a **single serverless P2P chat**: no relay
WebSocket, no REST gateway, no login, no server-side directory.

**Removed:** the sibling apps (`apps/aurora/`, `apps/enigma_plus/`); the Rust server
plumbing (`data.rs` REST gateway, `aster.rs` server directory, the WebSocket half of
`realtime.rs`, server/auth fields + commands); their Cargo/npm deps; the rakotis
relay branch (`services/ws.ts`, `apiBase.ts`, `chatCommands.ts`, the `kind ===
"relay"` path of `useChatChannel.ts`); the login view and server-address settings;
relay/aster tests and CI matrix entries.

**Kept / promoted:** `p2p_iroh.rs` (room = gossip topic = `blake3(name)`; the ticket
string *is* the QR payload); all `mls_*` commands + `RotorSession` (crypto
unchanged); the stable-NodeId secret (relocated into `p2p_iroh.rs`); QR
generate/scan as the primary pairing UX; `tor.rs` + arti; native voice-note
recording; offline profiles and the airplane switch.

**Shipped since the rework** (each summarized in this doc):
- **Tor onion transport** + **captain election/failover** ([§11](#11-tor-onion-transport--captain-election)).
- **DHT discovery, Contacts, nickname directory, direct invites** ([§12](#12-dht-discovery-mainline-rendezvous--contacts)).
- **Encryption at rest** (gervasius/protasius, [§13](#13-encryption-at-rest-gervasius--protasius)) and per-file locking.
- **Voice calls (Vox) and P2P file transfer restored** from the parked `limbo/`
  set (both now first-class tabs; `limbo/` retains the restore playbook).
- **Enigma Cloud** (self-hosted faros client, Files → Cloud).
- **`rotor_wasm` → toto static handoff** (2026-07-14): cryptorotor lives only in
  this repo; toto consumes a static committed copy of the wasm — no GitLab
  anywhere in toto's path. CI job `rotor:wasm` builds it as a gate. (toto's
  `edge/apps/*` still build from `toto/rotors/` — repointing or retiring edge is a
  separate decision.)
- **Compile-time build config** (`build_config.yaml`, [§15](#15-config--sources-of-truth)).
- **Maps** (MapLibre + PMTiles, `maps.rs` + `EnigmaMapView`): fully offline regions
  imported from packages made by the standalone `tools/map_packager` (BLAKE3 +
  manifest verified), P2P region sharing over file_xfer, pins/routes as MLS chat
  cards. The 2026-07-19 pivot removed every in-app tile-fetch path (§8/§10/§15).
- **Beacon** (`beacon.rs` on the cloud.rs transport, rakotis `beaconModel`,
  `stores/beacon.ts`): expiring server-side location shares (live pin / zones /
  routes with mandatory TTL) on the user's own faros host, rendered as a Maps-tab
  layer; gated by cloud + maps build flags together (no own switch), volatile
  only, tap-published (see beacon.md).
- **Cloud rendezvous** (`aster.rs`, rdv.md): the pre-rework aster directory
  revived on the Enigma Cloud substrate — opt-in publish of the relay URL to
  the user's own faros server, NodeId lookups racing n0/DHT, username search
  in Contacts. Optional by contract; serverless behavior is byte-identical
  when unused.
- **Multi-device (linked devices)** (`device_link.rs` + rakotis `useDeviceSync`,
  plan + decisions in [sync.md](sync.md)): QR pairing streams an E2EE one-shot
  bundle (rooms/tickets, contacts, calendar, settings subset, personas, chat
  history) over a dedicated iroh QUIC endpoint; each device is its own MLS leaf
  (`user#dev-xxxxxxxx`, grouped by user in rosters) and ongoing catch-up rides a
  hidden `devlink-…` gossip room gated by a linkKey HMAC. Chat history is now
  persisted per room (sealed `chat:log` kv) so timelines survive restarts.

---

## Roadmap

Open work, in rough priority order (security hardening items are enumerated in
[§9](#9-security--privacy-considerations) and are the recommended pre-production
work — key verification, admission approval, CSP/FS scoping, PCS key rotation):

- **Admission-approval UI** before `addMember` — closes the auto-admit gap shared by
  guessable room names and leaked room codes/tickets.
- **Accepted limitations (documented, deliberate):**
  - Cold start: if *every* member is offline long enough for discovery records to
    lapse **and** all addresses changed, reconnection needs a fresh QR.
  - Group scale: gossip fan-out and the lexicographic admin election are fine for
    small rooms, not hardened for large groups.
  - Tor: new joiners need the ticket onion online ([§11](#11-tor-onion-transport--captain-election)).
- **Deferred features:** deterministic pairwise DM rooms from Contacts;
  consolidating the two mainline UDP sockets; mesh-over-Tor (out of scope).
- **Housekeeping:** prune dormant frontend deps (§3); the centralization roadmap in
  [§15](#15-config--sources-of-truth).
