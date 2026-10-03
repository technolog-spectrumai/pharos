# Enigma26 — Technology Overview

A technical deep-dive into how Enigma26 works: its design, stack, dependencies,
communication flow, cryptography, privacy posture, and known weaknesses — plus the
project's conventions, config sources of truth, and rework history. For build and
run instructions see [build.md](build.md).

> **Status:** early-stage (`v0.1.6`). The cryptography is production-grade (OpenMLS),
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
[16 Rework history](#16-history--the-serverless-rework) ·
[17 Privacy HP](#17-privacy-hp--the-exposure-budget) ·
[18 Invitations](#18-invitations--encrypted-expiring-revocable) · [Roadmap](#roadmap)

---

## 1. Design

Enigma26 is a **serverless, peer-to-peer, end-to-end-encrypted chat**, packaged as a
[Tauri 2](https://tauri.app) desktop/mobile app (Vue 3 frontend + Rust backend).

Design principles:

- **No app server.** There is no relay WebSocket, no REST gateway, no login, no
  server-side directory. Enigma26 speaks to no application server at all — not one of
  ours, and since the 2026-08 removal of Enigma Cloud ([§16](#16-history--the-serverless-rework))
  not the user's own either. The Rust core makes no outbound HTTP request of any
  kind; the one network fetch left anywhere in the app is the Google Fonts
  `<link>` in `index.html`, which the webview attempts on load and which is
  queued for self-hosting ([§15](#15-config--sources-of-truth), palette note).
  (This is *not* the same as "no infrastructure" — see
  [§6](#6-is-it-truly-p2p-intermittent-nodes).)
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
  ([§15](#15-config--sources-of-truth), [build.md](build.md)) bakes in the
  hosted-relay allow flag, the per-feature kill switches, crypto declarations,
  feature defaults, and setting clamps — a restricted build is a *different
  binary*, not a runtime toggle.

### Layered architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/enigma/src  (Vue 3 UI: Chat · Files · Vox · Calendar · Map · │
│                    Contacts · Settings; QR create/scan; unlock gate)│
├──────────────────────────────────────────────────────────────────┤
│  packages/rakotis (TS)                                             │
│   • useChatChannel — MLS envelope state machine / orchestration    │
│   • chatTransport  — transport bridge (iroh / Tor, uniform events) │
│   • crypto         — bridge to the mls_* Tauri commands            │
│   • services       — appStorage (settings/build config), contacts, │
│                      localDb (kv), i18n                            │
├──────────────────────────────────────────────────────────────────┤
│  Tauri IPC  (invoke commands + realtime://* file://* vox://* …)   │
├──────────────────────────────────────────────────────────────────┤
│  apps/enigma/src-tauri  (Rust)                                     │
│   • p2p_iroh.rs  — iroh-gossip transport (default)                 │
│   • p2p_tor.rs   — peer-hosted Tor onion transport (opt-in, §11)   │
│   • p2p_dht.rs   — Mainline-DHT rendezvous/presence (opt-in, §12)  │
│   • p2p_invite.rs — direct room invites (dedicated ALPN)           │
│   • realtime.rs  — realtime_* gateway (gates + transport dispatch) │
│   • vault.rs     — protasius integration (encrypted store, §13)    │
│   • maps.rs      — offline PMTiles regions, pins, shares (§10)     │
│   • file_xfer.rs · vox.rs — P2P file transfer · 1:1 voice calls    │
│   • local_lock.rs — per-file passphrase locking (ENIGLOCK)         │
│   • lib.rs       — mls_* commands, profiles, build_config, audio   │
├───────────────┬───────────────────┬──────────────────────────────┤
│ rutile/       │ protasius         │ iroh 0.98 + iroh-gossip 0.98  │
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
| Room invites | Peer-to-peer only (`p2p_invite.rs`, ALPN `enigma/invite/0`): a live offer/accept handshake carrying a fresh ticket + DHT room code, so both peers must be online at once. Everything else is out-of-band — the QR code, the copyable ticket string, or a DHT room code. There is no mailbox and no store-and-forward, so an invite cannot be left for a peer who is away ([§12](#12-dht-discovery-mainline-rendezvous--contacts)) |
| Build config | `src-tauri/build_config.yaml` → build.rs codegen ([§15](#15-config--sources-of-truth), [build.md](build.md)) |
| Build/CI | `./build.sh`, configured by `build.yaml`; GitLab CI (`.gitlab-ci.yml`); Node 22 |

Rust backend crate: `enigma` → `enigma_lib` (`staticlib`/`cdylib`/`rlib`). Bundle
identifier `com.spectrumaipl.enigma26`. The tauri.conf `bundle.targets` list governs
which desktop formats a build emits — currently `["deb", "rpm"]`, out of the Linux
set Tauri can produce (`.deb`/`.AppImage`/`.rpm`); Android APK/AAB are produced
by the separate `rutile/scripts/build_android.sh` path ([build.md](build.md)).

---

## 3. Dependencies & libraries

Versions are the declared spec (resolved pins live in `apps/enigma/src-tauri/Cargo.lock`,
which is gitignored; Rutile's crypto workspace commits its own, in the submodule).

### Rust backend (`apps/enigma/src-tauri/Cargo.toml`)

| Crate | Ver | Role |
|---|---|---|
| `tauri` (+ `tauri-plugin-opener`/`-dialog`/`-notification`) | 2 | App framework, IPC, bundler, OS integration |
| `rotor-core` | path | MLS crypto engine (`rutile/crates/rotor/rotor_core`) |
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
| `arti-client`, `tor-rtcompat` | 0.43 | Embedded Tor, used **only** by the peer-hosted onion transport (`p2p_tor.rs`): `onion-service-service` to host a room's own onion, `onion-service-client` to dial the captain's. There is no outbound HTTP client — it left with Enigma Cloud ([§16](#16-history--the-serverless-rework)) |
| `tor-hsservice`, `tor-cell`, `safelog` | 0.43 / 0.8 | Onion-service hosting types (launch/config, accept relay cell, unredacted `.onion` display) |
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

### Crypto workspace (`rutile/crates/rotor`, in the Rutile submodule)

- **`rotor_core`** — the MLS engine (`RotorSession`). `openmls =0.7.4`,
  `openmls_rust_crypto =0.4.4`, `openmls_basic_credential =0.4.1`,
  `openmls_traits =0.4.1`, `tls_codec 0.4`, `zeroize`. Exports the compiled
  ciphersuite (`CIPHERSUITE`/`CIPHERSUITE_NAME`) for the build-config assert.
- **`gervasius`** — at-rest primitives: `argon2` 0.5 (Argon2id), `chacha20poly1305`
  0.10 (XChaCha20-Poly1305), `rand_core`, `zeroize`. Pure Rust, wasm-clean.
- **`rotor_wasm`** — `wasm-bindgen` browser bindings (`WasmRotorSession`); built with
  wasm-pack (`build_wasm.sh` beside it). Consumed by the *toto* project as a
  static committed copy.
- **`rotor_py`** — PyO3/maturin Python bindings for toto's Django side.

`protasius/` (repo root) is the standalone encrypted-store crate built on gervasius
(`fjall` 2, `serde`, `zeroize`); Tauri-agnostic — `lib.rs` wires the commands.

### Frontend (`apps/enigma/package.json` + `packages/rakotis`)

**Used at runtime:** `vue` 3.5, `vue-router` 5 (`createMemoryHistory`), `pinia`,
`vue-i18n` 9 (en/pl), `tailwindcss` 4, `@fortawesome/*`, `@tauri-apps/api` 2,
`qrcode` (generate ticket/NodeId QR), `html5-qrcode` (scan), `nanoid` (message ids),
`maplibre-gl` 5 (Map tab canvas; WebGL), `protomaps-themes-base` 4 (basemap style
layers as code — glyphs/sprites are bundled under `public/map/`, so styling makes
no CDN contact), `ace-builds` (Files → Local notes editor, bundled offline — §13; the SVG editor beside it adds no dependency at all — it renders and rasterizes from its own model), and the
in-repo `rakotis` workspace package. (`cytoscape` and `trix` left with the Mind
map when it was parked — see `limbo/`.)

**Dormant / carried from the earlier multi-app codebase (declared but unused by this
app):** `leaflet` (+ `@types`). Dead weight worth pruning.

---

## 4. Architecture & communication flow

### The seams

The frontend talks to Rust through two mechanisms, both guarded by an `isTauri()`
runtime check (in a plain browser there is no backend — chat is inert by design):

- **`invoke` (commands):** `realtime_*` (transport — dispatched to iroh or Tor),
  `mls_*` (crypto), `app_*` (profiles/runtime/airplane/use-Tor/build-config),
  `vault_*` (encrypted-store lifecycle, PIN, panic code), `kv_*` (sealed kv),
  `dht_*` (discovery), `file_*` (P2P transfer), `vox_*` (calls),
  `invite_*` (direct room invites), `audio_*` (recording), `fs_*` (local file IO),
  `local_*` / `keyring_*` (per-file locking), `map_*`, `tor_*`.
- **Events (`listen`):** `realtime://message` `{room, payload}` and
  `realtime://status` `{room, state, peers, peer_id?, reason?}` (both transports
  emit identical shapes, so the frontend is transport-agnostic); plus
  `file://progress|done|error`, `invite://incoming|resolved`,
  `vault://locked` (the idle-lock watchdog), and `vox://*` (call state + spectrum).

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
  max file size, meeting reminder), ns `contacts`,
  ns `files:local` (locked-file index), ns `dht` (room secrets).
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

1:1 voice calls (`vox.rs`, Vox tab) reuse the **main iroh endpoint**: a second ALPN
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

### File transfer — chunked, MLS-sealed, chain-verified

`file_xfer.rs` binds its own ephemeral iroh endpoint on ALPN `enigma/file/1` (v1 =
MLS chunks; a v0 peer simply cannot negotiate it, so a version skew fails to connect
rather than misreading the stream). One bi-stream carries everything:

| Frame | Direction | Contents |
|---|---|---|
| `Request` | downloader → host | `offer_id`, MLS KeyPackage, `want_integrity` |
| `Header` | host → downloader | name/size/mime, MLS Welcome, `chunk_size`, `chunk_count`, `integrity` |
| data ×N | host → downloader | MLS ciphertext of `0x00 ‖ seq ‖ chunk` |
| trailer | host → downloader | MLS ciphertext of `0x01 ‖ chunk_count ‖ root` |

The frame kind lives *inside* the ciphertext so it is authenticated. Progress
(`file://progress`) is throttled to whole-percent ticks — all the UI renders.
Integrity is a Settings toggle and composes fail-closed: the host enables the chain
if **either** side asked, and a downloader that requires it but receives
`integrity: false` aborts rather than accept unverified bytes. Any verification
failure deletes the partial file.

**The transfer is bound to one peer.** Before dialling, the downloader calls
`file_prepare`, which mints its transfer KeyPackage and returns a BLAKE3 hash of it;
that hash travels back to the host over the feature's own MLS-encrypted signalling —
chat `file_accept` or the Maps `map_region_bind` card — and
the host records it with `file_authorize`. `serve` then accepts only a connection
presenting that exact KeyPackage, waiting up to 20 s for the authorization to land
(the bind message and the QUIC dial race each other). Possession of
`{addr, offer_id}` is therefore no longer sufficient: only the peer that replied over
the authenticated channel, and holds the matching private key, can complete the
handshake. Cancelling an offer drops its authorization with it.

---

## 6. Is it truly P2P? (intermittent nodes)

**Short answer: message *content* is genuinely peer-to-peer and end-to-end encrypted,
and Enigma26 runs no server of its own — but the network layer is not
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
- **P2P file transfers** → a *separate*, ephemeral per-transfer MLS group (a 2-member
  `RotorSession` keyed by the `offer_id`, handshake in-stream: the downloader's
  KeyPackage rides the Request, the host's Welcome the Header). The file is split into
  chunks of the user's **file chunk size** (Settings, default 256 KiB) and each chunk is
  sealed with `encrypt_app` — literally a chat message per chunk — so the bytes are
  MLS-protected, not merely QUIC-protected. Optional per-chunk **BLAKE3 hash chain**
  (`h_i = BLAKE3(h_{i-1} ‖ seq ‖ chunk)`, seeded from the offer id, root in a trailer
  frame) lets the receiver detect a dropped, reordered or altered chunk; a size and
  chunk-count check runs regardless. Applies to both transfer features (chat
  share and Maps regions) — they share `file_xfer.rs`.
- **Voice-call media** → a *separate*, ephemeral per-call MLS group (a 2-member
  `RotorSession` keyed by the `call_id`) whose **RFC 9420 exporter secret**
  (`export_secret`) derives two directional 256-bit keys → two **ChaCha20-Poly1305**
  ciphers (one per direction; 96-bit nonce = a per-direction monotonic counter). Each
  10 ms μ-law datagram is `[counter‖ciphertext]`. If the MLS handshake over the call's
  bi-stream fails for any reason, the call **falls back to transport-only** (QUIC TLS,
  peers authenticated by NodeId) and the UI shows a downgraded-encryption badge.
- **PIN unlock (`lock.pin_unlock`)** → a **convenience layer, never an at-rest
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
| Invitation QR contents | **No room name, no topic, no MLS material.** A *personal* invitation is sealed to one contact's key and carries no decryption key of its own; a *general* one is a cleartext bearer code. Both carry the inviter's address — an IP on clearnet, an `.onion` over Tor — and a deadline the inviter's own clock enforces ([§18](#18-invitations--encrypted-expiring-revocable)). |
| Topic secrecy | `topic = blake3(name)` — anyone who knows/guesses the room name can join the swarm (MLS still gates the group). DHT room codes carry an unguessable secret instead. |
| Local at-rest | **Encrypted** — passphrase-gated vault ([§13](#13-encryption-at-rest-gervasius--protasius)); no recovery by design. |
| Map tiles | **The app performs no tile fetches at all.** Maps render exclusively from imported region packages produced offline by the standalone `tools/map_packager` (that tool — not the app — contacts the PMTiles host you give it, on a machine you choose). Imports are BLAKE3-verified against the package manifest. |
| Device location | **Never read.** The app has no geolocation permission, no positioning plugin, and never calls `navigator.geolocation` (an e2e test traps the API and fails if that changes). "Share a location" sends a point the **user tapped on the map** after an explicit press — it is a place they chose, not a device fix — to that room's MLS group only, and it stops rendering on peers' maps after 6 h. That share is the app's **only** location path — it goes to room members over the encrypted seam and nowhere else, since the server-published Beacon layer was deleted with Enigma Cloud ([§16](#16-history--the-serverless-rework)). Nothing is ever shared automatically or in the background. |
| Metadata protection (Tor) | **Available, opt-in** — the "use Tor" switch routes rendezvous + chat over peer-hosted onion services; off by default. |
| DHT participation (opt-in) | Publishing your pkarr record announces "this NodeId is online" to anyone who knows the NodeId (relay addresses only, not direct IPs). Room/nickname records are sealed — see [§12 threat notes](#12-dht-discovery-mainline-rendezvous--contacts). |

**Reading this table as a user.** [§17](#17-privacy-hp--the-exposure-budget)
turns every row above into a fixed, comparable price shown next to the control
that triggers it — the same threat model, expressed as a budget rather than a
table. It measures and remembers; it does not protect.

**At-rest posture.** All persisted state is sealed in the per-profile protasius vault
(Argon2id-derived key wrap, XChaCha20-Poly1305 values, AAD-bound to each record's
location). The plaintext exceptions are: the vault header `vault.json` (salt +
wrapped DEK — useless without the passphrase); map-region blobs
(`profiles/<p>/maps/<blake3>.pmtiles` — public map data, immutable and
content-addressed, so filenames carry no coordinates; which area they cover, plus
all pins, live only in sealed kv — accepted because whole-blob sealing
is incompatible with the random-access reads the map needs); and — only while the app is unlocked
*and* "keep onion stable" is on — arti's materialized onion keystore, which is sealed
back into the vault and wiped on lock/exit (a crash can leave it until the next
unlock's sweep). `zeroize` scrubs transient RAM buffers; `wipe_file` is a
best-effort single-pass overwrite (not a secure erase on SSD/journaling
filesystems). There is **no passphrase recovery**: a forgotten passphrase means a
lost store. The two destructive resets are both deliberate — Settings → Data →
"Clear all data", and the **panic code**, a second passphrase enrolled in
Settings → Lock that looks like an ordinary unlock and wipes every profile
instead (`vault.rs::panic_wipe`; the call returns `Ok(())` indistinguishably).

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
   is future work.) **Invitations ([§18](#18-invitations--encrypted-expiring-revocable))
   add an authenticated, expiring, revocable admission path, and marking a room
   **invite only** ([§18.8](#188-invite-only-rooms)) makes every member refuse
   gossip key packages outright — which narrows this gap substantially. It does
   not close it: enforcement is app convention like everything else in §9.3, so a
   member on a modified or older build still auto-admits, and OpenMLS in this
   configuration still lets any member commit an add.
8. **WebView / IPC surface.** `tauri.conf.json` sets `security.csp = null` (no Content
   Security Policy); on Linux the app auto-grants every WebView permission request; and
   `fs_write_base64_file` — the "save as…" binary writer behind the native dialog —
   takes an **unrestricted absolute path** (no scope/allowlist). It is the only raw
   FS command left registered: the text writer that sat beside it is parked
   (`limbo/rust/NOTES.md`), and text now moves through `local_note_read` /
   `local_note_write`. → *Add a CSP, gate permission requests, and either scope
   that command or move it to `@tauri-apps/plugin-fs`, which is permission-declared.*
9. ~~**`tor.rs` clearnet-TLS footgun.**~~ **Resolved by deletion** — the outbound
   Arti HTTP client (`tor.rs`) and its `AcceptAnyServerCert` verifier (no name/CA
   validation) went with Enigma Cloud in 2026-08
   ([§16](#16-history--the-serverless-rework)), taking `hyper` and `webpki-roots`
   with them. The Rust core now makes no outbound HTTP request at all, so there
   is no clearnet TLS surface it can get wrong. (The webview still requests
   Orbitron from `fonts.googleapis.com` — a `<link>` in `index.html`, outside
   any Rust code path; self-hosting it is on the §15 palette list.) The onion
   transport carries plaintext frames
   over the Tor circuit — no TLS layer — and arti is reached only through
   `p2p_tor.rs`. *If a future feature needs an HTTP client, it must not resurrect a
   permissive verifier alongside a clearnet path.*
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
- **Vox** (`EnigmaVoxView` / `VoxPanel`, route `/vox`) — 1:1 voice calls: by
  ticket/QR, by room member (signaled over the chat's MLS seam), or by DHT
  nickname / saved contact where the build has the DHT and Contacts; live
  spectrum equalizer; incoming-call nav dot.
- **Files** (`EnigmaFilesView`) — three sub-tabs: **P2P** (offer/accept transfers
  with progress, max-size guard), **Local** (passphrase-lock files in place,
  ENIGLOCK), and **Keys** (`KeyringPanel` — one passphrase over many locked
  files, gated by `keyring.enabled`). There is no **Devices** sub-tab: device
  linking and the per-file device sync were parked whole on 2026-08-18
  ([limbo/frontend/devices/](limbo/frontend/devices/)), so nothing syncs between
  a user's own devices today ([§16](#16-history--the-serverless-rework)).
- **Contacts** (`EnigmaContactsView`) — saved peers with DHT presence ("recently
  online"), find-by-nickname, invite-to-room, call buttons, and **My code** —
  this device's NodeId QR, which lives here rather than in Settings because this
  is where it is used ([§12](#12-dht-discovery-mainline-rendezvous--contacts)).
- **Calendar** (`EnigmaCalendarView`) — room-scoped meetings + scheduling polls over
  the MLS seam; local OS notification reminders (lead time in Settings).
- **Map** (`EnigmaMapView` / `MapPanel`, `RegionsPanel`) — fully offline MapLibre map
  over imported PMTiles region packages: immutable content-addressed blobs made by
  the standalone `tools/map_packager` (the app never talks to tile servers),
  imported from the device with BLAKE3 + manifest verification and storage-budgeted;
  import/export region files, private pins (sealed kv), and
  room sharing — pins as compact MLS chat cards ("Open in Maps" is always an
  explicit action), region files over the P2P file-transfer path (never MLS).
  (Hand-drawn routes were part of this tab until 2026-07-27; they are parked
  under `limbo/frontend/map-routes/` — map.md D6b — and no `map_route` card is
  sent or accepted today.)
  One region can be **activated** (Regions → Activate): served first for tiles
  (others still fill), badged in the list + a chip on the canvas, the view opens
  spread to it, and the choice persists sealed per profile (device-local).
  Room members' shares also render as a distinct **shared layer** (violet
  pins, orange locations, sender initial on the badge) wherever an
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
- **Parked (2026-07-27)** — the **Board** (group Kanban), **Sketch board** and
  **Mind map** were the three sub-tabs of a Notes tab that no longer exists. No
  maintenance capacity; the code, tests, i18n and design docs are kept under
  `limbo/frontend/{kanban,sketch,mind}/`, each with a restore checklist, and
  their build-config sections were removed with them. No route, tab or store in
  the shipped app reaches any of them. One piece was kept rather than parked:
  the Sketch board's drawing engine (`components/sketch/`) is what the Files →
  Local **SVG editor** (`components/local/SvgEditor.vue`) draws with, so that
  code ships — the *board*, with its own tab and its own document store, does
  not.
- **Sharing a room** (`RoomShareCard`, in both `CreateRoomModal` and
  `RoomInfoModal`) — three ways in, on segmented pills: the **room ticket**
  (permanent, anyone, not revocable), a **private QR** (sealed to one contact,
  expiring, revocable) and a **shareable QR** (bearer, expiring, revocable, with
  an explicit "this is not secret" warning). Each states its consequence and its
  Privacy HP price before the tap, and the invitation modes carry the "keep this
  room open until they join" note ([§18](#18-invitations--encrypted-expiring-revocable)).
  Redemption needs no new surface: `JoinRoomModal`'s single field routes an
  invitation by its tag byte. In a room the captain has marked **invite only**
  ([§18.8](#188-invite-only-rooms)) the ticket pill is withdrawn entirely and the
  card says why — a ticket there would put someone on the topic and never into
  the group.
- **Room info** (`RoomInfoModal`) — the share card above, the captain-set room
  logo and rules, ban management, and the **invite only** switch
  ([§18.8](#188-invite-only-rooms)), whose label states plainly that enforcement
  holds only while every member is running this app.
- **Privacy** (`EnigmaPrivacyView`, `/privacy`) — the two HP meters, then two
  sub-tabs: **Rules** (the whole price table, each section folded by default, plus
  what earns HP back) and **Decisions** (the ledger, scrolling in its own box).
  Read-only by design — prices are charged where the risky thing happens, never
  from a list of them ([§17](#17-privacy-hp--the-exposure-budget)).

  Reached **only** from the header's **HP chip**, and deliberately absent from
  `APP_TABS`: like Settings and the welcome page it is chrome, not a nav tab, so
  it has no nav link, no visibility checkbox and no route guard — the chip cannot
  be stranded by hiding tabs. It lived as a sixth pill inside Settings until the
  meters became something people *check* rather than configure.
- **Settings** (`EnigmaConfigView`) — five tabs: **Profile** (local-only PII,
  multiple named profiles), **Settings** (language en/pl; which tabs this device
  shows; max file size; transfer chunk size + integrity check; meeting reminder;
  map storage limit), **Connections** (use-Tor, stable-onion, connection timeout,
  DHT discovery + cadences + status probe),
  **Lock** (auto-lock delay, lock-on-hide, reset passphrase, PIN unlock, panic
  code), **Data** (airplane mode; data profiles; clear data). Settings itself is
  the one tab with no visibility checkbox — it is the only route back to the
  others.
- **Welcome** (`EnigmaWelcomeView`, `/welcome`) — reached by tapping the Enigma26
  mark in the top left. Three cards: what the app is (icon, version, one-line
  pitch), who you are on it (profile name, avatar, MLS identity, active storage
  profile) and your HP meters. Ungated for the same reason Settings is — a logo
  that could lead nowhere would be a dead end on every screen. Deliberately **not** `/`: that
  redirect still resolves to the first visible tab, which is where every lock
  cycle re-enters after the webview reload. A compact **HP chip** — today's
  balance only — sits in the header on every screen and is the only way into
  **Privacy**
  ([§17](#17-privacy-hp--the-exposure-budget)).

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
address the profile is deliberately not using. There is **no fallback directory**:
the Contacts surfaces that depend on discovery are hidden and the Settings toggle
disables with the reason. Over Tor, peers are reached by ticket/QR alone. (Until
2026-08 the fallback was a lookup on the user's own faros server; that client is
gone — [§16](#16-history--the-serverless-rework).)

**Standard and up.** `dht.enabled: false` (Basic — pland.md) short-circuits
`discovery_enabled` / `nick_publish_enabled` **ahead of the kv read**, so a
profile carrying `dht_discovery: "on"` from a DHT-capable build reads as off
without the key being rewritten. `dht_presence` / `dht_publish_nick` / `dht_find_nick` /
`dht_apply` fail fast with `DHT_DISABLED`; `dht_status` and `dht_room_code` stay
silent (each has a total "nothing here" value already). rakotis mirrors the gate
in `getDhtDiscovery` / `getDhtNickPublish` / `getDhtStatus`, so the whole UI goes
inert at once, and every DHT surface is hidden rather than disabled — their
off-state copy points at a Settings card such a build does not have.

**What it is.** An opt-in (default off; absent in Basic builds and inert in
no-hosted-relays ones), fully
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
surfaced as `invite://incoming` / `invite://resolved`. Both peers must be **online
at the same time** — the handshake is a live QUIC dial with nothing to hold a
message in the meantime. Since the sealed server mailbox was deleted
([§16](#16-history--the-serverless-rework)) there is no store-and-forward path at
all, so inviting someone who is away means handing them a QR code, a ticket string
or a room code out of band.

---

## 13. Encryption at rest (gervasius + protasius)

*(Condensed as-built reference. Crates: `rutile/crates/rotor/gervasius` — primitives;
`protasius/` — the store; app integration in `vault.rs` / `lib.rs`.)*

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
- **Maps data:** region manifests (`map:regions`) and pins (`map:pins`) are
  sealed kv like everything else — coordinates never persist
  outside the vault. The region *blobs* are the documented plaintext exception
  (see §8 at-rest posture).
- **Map shares add NO at-rest surface.** What a room shared lives only in the
  already-sealed `chat:log` (as the map card it arrived as); the shared map
  layer is derived from that timeline at render time, never stored again. The
  `map:*` namespaces grow only when the user explicitly saves a pin, and
  a shared LOCATION is never written there at all unless adopted.

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
  `EnigmaContactsView`, `EnigmaConfigView`, `EnigmaProfileView`, …). Stores are
  lowercase domain files (`chat.ts`, `user.ts`, `map.ts`). Composables are
  `useXxx` camelCase.

**Tauri commands.** `snake_case`, `<domain>_<verb>` families — `app_*`, `vault_*`,
`kv_*`, `mls_*`, `realtime_*`, `audio_*`, `fs_*`, `tor_*`, `file_*`, `dht_*`,
`invite_*`, `vox_*`, `local_*`, `keyring_*`, `map_*`. All registered in the single
`generate_handler!` block in `apps/enigma/src-tauri/src/lib.rs`. (Two legacy getters,
`current_profile`/`current_identity`, predate the prefix rule — leave or migrate to
`app_*`, don't add new prefix-less commands.)

**Events.** `scheme://path` naming: `realtime://message` and `realtime://status`
(both transports emit identical names so the frontend is transport-agnostic; a
single event multiplexes all rooms, the payload carries the room id), plus
`file://progress|done|error`, `invite://incoming|resolved`, `vox://*`, and
`vault://locked` (emitted when the watchdog re-locks the vault).

**i18n keys.** Two levels: `namespace.camelCaseLeaf` (`chat.newChat`, `vault.wrongPass`).
Namespaces: `nav`, `common`, `keys`, `lang`, `network`, `config`, `chat`,
`calendar`, `map`, `contacts`, `files`, `vox`, `sketch`, `local`, `fileShare`,
`profile`, `vault`, `hp`, `welcome`. Interpolation uses single-brace named tokens
(`{n}`). English and Polish live in
[`apps/enigma/src/i18n/`](apps/enigma/src/i18n/) and are the **only** catalogs;
documentation is not translated.

`chat.sys.*` is a namespace of its own for the 34 system notices the chat channel
pushes into the transcript ("🔒 End-to-end encryption active.", "Disconnected.",
"The room host went offline…"). These are emitted from **rakotis**, which
[`packages/rakotis/src/i18n/index.ts`](packages/rakotis/src/i18n/index.ts) says
must carry no app strings — so they reach a catalog through an injected
translator, [`i18n/chatText.ts`](packages/rakotis/src/i18n/chatText.ts), registered
by the app in `main.ts` beside the identical `setHpTranslator` seam:

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
"August 2026" in the calendar header if their OS was English. The formatters read
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
(protocol and product names: `Tor`, `iroh`, `Enigma26`, `MLS`, `QR`) requires a
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
invalid file = build error — see [build.md](build.md)). Owns: the hosted-relay
allow flag, the per-feature kill switches
(`calls`/`contacts`/`calendar`/`maps`/`dht`/`keyring`/`lock.pin_unlock`),
crypto declarations (compile-asserted against rotor_core/gervasius) +
Argon2id costs for new vaults, feature defaults for new profiles, defaults **and
clamp bounds** of the kv-backed settings, and network constants (frame cap, onion
port, timeouts). The frontend fetches the relevant subset once at boot
via `app_get_build_config` (rakotis `initBuildConfig`/`getBuildConfig`; `main.ts`
seeds the browser-mode fallback from `config/app.ts`). App name and identifier
are fixed to `Enigma26` / `com.spectrumaipl.enigma26`; `build.rs` rejects drift
and still asserts the YAML mirrors `tauri.conf.json`.

**Privacy HP price table (compile-time):**
[`apps/enigma/src-tauri/privacy_hp.yaml`](apps/enigma/src-tauri/privacy_hp.yaml)
— the second file `build.rs` bakes in, on the same contract as the build config
(validate → codegen → `enigma_lib::hp_policy`; an invalid table fails the build).
Unlike the build config it is **not per-edition**: an exposure does not get
cheaper with a different tier. Full rationale in
[§17](#17-privacy-hp--the-exposure-budget).

**Frontend app config:** [`apps/enigma/src/config/app.ts`](apps/enigma/src/config/app.ts)
— brand identity, UI policy, dev port. Import `brand` / `policy` / `dev` from here
instead of hardcoding.

| Value | Canonical home | Notes / mirrors |
| --- | --- | --- |
| Display name `Enigma26` | `config/app.ts` `brand.name` | Also `tauri.conf.json` `productName` + window `title` |
| Copyright / org / legal URL | `config/app.ts` `brand` | Was hardcoded in `App.vue` |
| Bundle identifier | `tauri.conf.json` `identifier` | Mirror `brand.bundleId` and Android `applicationId` (`com.spectrumaipl.enigma26`); `build.rs` rejects any other value |
| App icon | `apps/enigma/app-icon.png` | **Fixed, not a build choice** — one mark; the sizes generated from it are committed. See [icons.md](icons.md) |
| In-app branding images | `apps/enigma/src/assets/<logoDir>/` (`logoDir` in `apps/enigma/package.json`, currently `enigma26`) | `app_icon.png` (large — the unlock/welcome gate) and `bar_icon.png` (small — the top bar) |
| Passphrase min length | `config/app.ts` `policy.passphraseMinLen` | **UI-only** today — see the roadmap note below |
| Profile field caps | `config/app.ts` `policy.*MaxLen` | `displayNameMaxLen` 150, `profileNameMaxLen` 80 |
| Hosted-relay allow flag | `build_config.yaml` `p2p.allow_hosted_relays` | Compile-time kill switch: flips iroh to `presets::Minimal` + `RelayMode::Disabled` and forces DHT discovery off, leaving direct QUIC and Tor. (`cloud.allow_connections` sat beside it until 2026-08 and no longer exists — [§16](#16-history--the-serverless-rework)) |
| Feature defaults (tor/stable/dht) | `build_config.yaml` `features:` → Rust `AppProfileState` serde defaults + `p2p_dht` missing-key defaults | Apply to **new profiles only** (saved profiles keep their stored bools). UI mirrors via `policy.featureDefaults`; `offline` always starts false (not configurable) |
| P2P connection timeout | kv `p2p:settings` / `connect_timeout_secs` (rakotis `appStorage.getConnectTimeoutSecs`) | **User-set in Settings**; default + clamp (60 s, 5–600) come from `build_config.yaml` `settings:`. Governs create/join give-up + the join window's read countdown (window ≤ 2×N) — never hardcode a connect deadline. Rust reads the same key (`p2p_dht::connect_timeout_secs`) for the DHT rendezvous-resolver deadline |
| DHT kill switch | `build_config.yaml` `dht.enabled` | Compile-time, **Standard and up** (off in Basic): `false` removes the Mainline DHT alone (no join-by-room-code, nickname directory or presence) while leaving n0 relays + pkarr intact. Checked ahead of the kv read on both sides, so a stored `"on"` reads as off without being rewritten; `dht_presence`/`dht_publish_nick`/`dht_find_nick`/`dht_apply` error `DHT_DISABLED`; the UI is hidden, not disabled. Requires `p2p.allow_hosted_relays` — build.rs rejects the pair |
| DHT discovery + cadences | kv `p2p:settings` / `dht_discovery`, `dht_room_publish_secs`, `dht_presence_poll_secs` (rakotis `appStorage.getDht*`) | **User-set in Settings**, opt-in (default off). Publish default + clamp (600 s, 60–3600) from `build_config.yaml`; presence poll 300 s clamp 60–3600 (frontend-only). Rust reads the same keys directly (`vault::kv_get_raw`); absent when `dht.enabled: false`, inert when `p2p.allow_hosted_relays: false`; see [§12](#12-dht-discovery-mainline-rendezvous--contacts) |
| Maps kill switch | `build_config.yaml` `maps.enabled` | Compile-time, **Professional only** (off in Basic and Standard): `false` builds without the Map tab (route redirects, `map_*` commands error `MAPS_DISABLED`). No other map knobs exist — the app has no tile-fetch path to configure |
| Key-ring kill switch | `build_config.yaml` `keyring.enabled` | Compile-time, **Standard and up** (off in Basic): `false` builds without the key ring (one passphrase locking MANY local files) — every `keyring_*` command errors `KEYRING_DISABLED`. Per-file locking (`local_lock.rs`) is unaffected. The ring file `<profile_dir>/keyring.enig` never leaves the device — it holds raw file keys + absolute local paths, so it stays out of every transfer path |
| Maps storage limit | kv `p2p:settings` / `map_storage_limit_mb` (rakotis `appStorage.getMapStorageLimitMb`) | **User-set in Settings**; default 512 MB clamped 64–65536 from `build_config.yaml`. Enforced in Rust before every region import (`MAPS_STORAGE_LIMIT` error contract) |
| Maps active region | kv `p2p:settings` / `map_active_region` (rakotis `appStorage.getMapActiveRegion`) | **User-set via Map → Regions → Activate**; the priority region for tile resolution — checked first, other imported regions still fill the gaps. Rust reads the same key (`maps.rs`) and clears it when the region is removed. Device-local: each device imports its own packages |
| Chat history cap | kv `p2p:settings` / `chat_history_cap_msgs` (rakotis `appStorage.getChatHistoryCapMsgs`) | **User-tunable**; default 500 msgs clamped 50–5000 from `build_config.yaml`. Bounds the sealed per-room `chat:log` kv (oldest segment pruned past it) — the store that lets a room's timeline survive a restart |
| Meeting reminder lead | kv `p2p:settings` / `meeting_reminder_mins` (rakotis `appStorage.getMeetingReminderMins`) | **User-set in Settings**; default 15 min, clamped 0–1440, 0 = off. Read by `useMeetings`' reminder tick every round (changes apply live) — never hardcode a reminder lead |
| Release version `0.1.6` | `tauri.conf.json` `version` | De-facto owner (drives bundle filenames); hand-duplicated in eleven files — `Cargo.toml`, three `package.json`, `build_config.yaml` and every `configs/*.yaml`. Each config's `app.version` must mirror it — `build.rs` fails the build on drift. Bumped **with the code**: it is not a build-time choice, and the Builder shows it read-only |
| Dev port `1420` | `vite.config.ts` `server.port` | Mirrored in `tauri.conf.json` `devUrl`, `scripts/tauri-dev-server.mjs`, `dev.vitePort` |
| Argon2id params | `build_config.yaml` `crypto.kdf` (new vaults, via `lib.rs::kdf_params`) | Persisted per-vault in the header, so old vaults always unlock; `gervasius KdfParams::default()` is the library-level fallback and must stay in sync |
| P2P frame cap / onion port / Tor timeouts | `build_config.yaml` `network:` | `max_frame_bytes` is **wire-interop** (Tor frame + iroh gossip cap — change in lockstep across a fleet); onion port rides in tickets |
| Transfer chunk size | `build_config.yaml` `settings.file_chunk_kib` (clamp) → kv `p2p:settings/file_chunk_kib` | User-settable ("file chunk size"); governs every `file_xfer.rs` transfer (chat share, Maps regions). The sender's value governs a transfer and is echoed in the wire header. Device-local. Replaced the old `network.transfer_chunk_bytes` |
| Privacy HP price table | `apps/enigma/src-tauri/privacy_hp.yaml` | Compile-time, **all editions** (prices are not a product knob — one file, not one per `configs/*.yaml`). `build.rs` validates it (ladder membership, two-decimal precision, cap sanity, `requires:` pairing, and a required-id list so a rename fails the build instead of making a surface free) and generates `enigma_lib::hp_policy`. Fetched once at boot via `hp_get_policy` → rakotis `initHpPolicy`/`getHpPolicy`; `services/hp.ts` carries a browser-mode mirror that `privacyHpDrift.test.ts` pins against the YAML. See [§17](#17-privacy-hp--the-exposure-budget) |
| Privacy HP ledger | protasius ns `hp` via `vault::get/put` (**internal** tag) | Per-profile, append-only, reason codes and numbers only. Deliberately NOT in the `kv_*` keyspace the webview can write: a different AAD tag means JS cannot read, forge or clobber it. Balances are derived, never stored — see [§17.4](#174-regeneration) |
| Invitation state | protasius ns `invites` via `vault::get/put` (**internal** tag) | Per-profile, per-issuer: the capability, recipient binding, deadline and `Active/InFlight/Consumed/Revoked` state of every invitation minted. Deliberately NOT in the `kv_*` keyspace the webview can write. Expiry is decided **here**, on the inviter's clock — the deadline inside a ticket is advisory ([§18](#18-invitations--encrypted-expiring-revocable)) |
| PIN unlock | `build_config.yaml` `lock.pin_unlock` (gate) + `settings.pin_digits` (clamp) | Memory-only convenience re-unlock; the passphrase remains the at-rest secret. Nothing persisted, so no migration and no on-disk mode marker |
| Transfer integrity check | `build_config.yaml` `features.file_integrity` (default) → kv `p2p:settings/file_integrity` | Per-chunk hash chain; **either** side enabling it applies it, and a side that requires it aborts if the peer sends none |
| AAD prefix / tag bytes | `protasius/src/lib.rs` | `protasius:v1:`, `TAG_INTERNAL`/`TAG_KV` |
| Window size, bundle targets | `tauri.conf.json` | — |
| Two-profile dev instances | `APP_PROFILE` / `CHAT_USER` env | Defaulted in `run_dev.sh`; **`lib.rs` owns the `"default"` fallback** |

**Pairs that MUST be bumped together** (no shared source yet): the `rakotis` source
alias path (`vite.config.ts` + `vitest.config.ts` + `tsconfig.json`); the desktop apt
dependency list (docs + CI jobs); the Playwright image tag `v1.60.0` ↔
`@playwright/test ^1.60.0`; the NDK version `27.2.12479018` (docs ↔ installer); the
`*.deb/*.AppImage/*.rpm` bundle glob (`rutile/scripts/build.mjs`). State one Node floor
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
`0.1.6` isn't hand-maintained in eleven files; extract the apt list to
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
generate/scan as the primary pairing UX; arti and the Tor plumbing; native
voice-note recording; offline profiles and the airplane switch.

**Shipped since the rework** (each summarized in this doc):
- **Tor onion transport** + **captain election/failover** ([§11](#11-tor-onion-transport--captain-election)).
- **DHT discovery, Contacts, nickname directory, direct invites** ([§12](#12-dht-discovery-mainline-rendezvous--contacts)).
- **Encryption at rest** (gervasius/protasius, [§13](#13-encryption-at-rest-gervasius--protasius)) and per-file locking.
- **Voice calls (Vox) and P2P file transfer restored** from the parked `limbo/`
  set (both now first-class tabs; `limbo/` retains the restore playbook).
- **`rotor_wasm` → toto static handoff** (2026-07-14): cryptorotor lives only in
  this repo; toto consumes a static committed copy of the wasm — no GitLab
  anywhere in toto's path. CI job `rotor:wasm` builds it as a gate. (toto's
  `edge/apps/*` still build from `toto/rotors/` — repointing or retiring edge is a
  separate decision.)
- **Compile-time build config** (`build_config.yaml`, [§15](#15-config--sources-of-truth)).
- **Maps** (MapLibre + PMTiles, `maps.rs` + `EnigmaMapView`): fully offline regions
  imported from packages made by the standalone `tools/map_packager` (BLAKE3 +
  manifest verified), P2P region sharing over file_xfer, pins as MLS chat
  cards. The 2026-07-19 pivot removed every in-app tile-fetch path (§8/§10/§15).
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
  an absent peer is gone, and there is no store-and-forward replacement.
- **Contacts lost server search.** Finding someone by faros username is gone;
  the DHT nickname directory ([§12](#12-dht-discovery-mainline-rendezvous--contacts))
  is the only directory left, and Tor mode now has none at all.
- **Maps lost the Beacon layer**, but not location sharing: the peer-to-peer
  *Share this spot* card over the room's MLS seam is untouched (§8, §10, map.md
  Part IV).
- **Files lost the Cloud sub-tab.** File *storage* is now local, and the only way
  a file moves is a P2P transfer the user starts.
- **The P2P stack was untouched:** iroh QUIC + gossip, MLS, the peer-hosted onion
  transport in `p2p_tor.rs` (which never used `tor.rs`), file transfer, maps and
  calls all came through unchanged. Device linking survived this removal too —
  it was parked three days later, for reasons of its own (below).
- **Third-party infrastructure still in use, deliberately:** iroh's n0 hosted
  relays, the Mainline DHT, and Tor's directory authorities
  ([§6](#6-is-it-truly-p2p-intermittent-nodes)). "No server" has always meant no
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

---

## 17. Privacy HP — the exposure budget

A small, deliberately game-like layer that lets a user **compare the relative
safety of the choices this app offers**, in one currency, with the price shown
before the tap. Two meters per profile: **Daily, max 100** and **Weekly, max
700**.

**It is advisory and inert.** Nothing in it gates, blocks, delays or weakens MLS,
Tor, iroh, the vault or the passphrase. Deleting the whole feature would leave
the app behaviourally identical, minus the numbers. It adds no server, no
account and no telemetry — every byte it writes stays in the profile's own
encrypted store, and nothing about it ever leaves the device.

### 17.1 Where each part lives

| Concern | Home |
| --- | --- |
| The prices | [`apps/enigma/src-tauri/privacy_hp.yaml`](apps/enigma/src-tauri/privacy_hp.yaml) — one file, all editions |
| Validation + codegen | `build.rs` → `enigma_lib::hp_policy` consts. **An invalid table fails the build** |
| Ledger, clock, enforcement | `src-tauri/src/privacy_hp.rs` (`hp_*` commands) |
| Policy, derivation, copy | `packages/rakotis/src/privacyHp.ts` (pure) + `services/hp.ts` (bridge + browser mirror) |
| UI | `OyaHpPrice` / `OyaHpMeter` primitives; `components/hp/` (chip, flash, confirm, panel, `useHp`); `EnigmaWelcomeView`; Settings → Privacy |

**The webview never names an amount.** It names an action id and Rust looks the
price up in its own compile-time table. A compromised frontend can charge the
*wrong* action; it cannot invent a price or hand itself a credit.

**Storage boundary.** The ledger uses `vault::get/put` under ns `hp` — the
protasius **internal** tag. The `kv_*` commands the webview can call use a
different AAD tag and a different record space, so JS can neither read, forge nor
clobber the ledger even though it freely writes its own settings.

**Arithmetic.** Every amount is an integer number of hundredths ("centi-HP") in
both languages. No float reaches the ledger, so balances are reproducible
byte-for-byte. `build.rs` rejects a third decimal place.

### 17.2 The price table

Five rungs — **0.5 / 1.5 / 2.5 / 5 / 10** — for negligible, low, moderate, high and
severe. A fixed price must land on a rung (build-enforced); metered actions bill

**Halved 2026-08-24.** Every rung, metered rate and credit was divided by two, so
the budget goes twice as far while every *ratio* between prices is preserved —
which is what the ladder is for. The meters (100 / 700) and the regeneration
rates were deliberately left alone: the change was to what actions cost, not to
the size of the budget or the speed of recovery. Three rates could not halve
exactly at two decimal places (0.05 → 0.025, 0.25 → 0.125) and are rounded
**down** — the direction the halving was asked for, on per-message and per-MiB
rates where the difference is far below anything a user can perceive.
in fractions below the bottom rung. Every price cites the threat-model line it
comes from.

**Transport posture**

| Action | HP | Why ([§8](#8-privacy), [§9](#9-security--privacy-considerations)) |
| --- | ---: | --- |
| `transport.tor.disable` | **−20** | §8, §9.6 — re-exposes NodeId↔IP, social graph, timing, sizes and presence to n0 for *everything after it*. Severe because it is a posture, not one disclosure |
| `transport.onion_stable.enable` | −1.5 | One long-lived `.onion` makes sessions linkable; materialises an onion keystore while unlocked (§8) |

**Discovery**

| Action | HP | Why ([§12](#12-dht-discovery-mainline-rendezvous--contacts)) |
| --- | ---: | --- |
| `dht.nickname.publish` | **−10** | Binds a *human-chosen* handle to your NodeId in a global directory. The strongest de-anonymiser in the app: everything else leaks a machine identity |
| `dht.presence.enable` | **−5** | *"The presence feature's data source is its privacy cost"* — publishes your pkarr record hourly to anyone holding the NodeId |
| `dht.room_code.publish` | −2.5 | Sealed and hourly-rotated, but the record is public and the code is a **bearer credential** |

**Rooms and tickets** — the Tor variant axis (chat re-homes onto the onion transport)

| Action | HP | Why |
| --- | ---: | --- |
| `ticket.export.clearnet` | **−5** | §8 — carries room name + NodeId + **IP addresses**, and is the most copyable artefact in the app |
| `ticket.export.tor` | −1.5 | Room name + `.onion`, **no IP** |
| `room.create.clearnet` / `.tor` | −2.5 / −0.5 | A `blake3(name)` topic joined in the clear (§9.7) vs. the same topic without an IP |
| `room.join.clearnet` / `.tor` | −2.5 / −0.5 | Announces your device to the topic's peers, with or without an IP |

**Messages** — billed per send *and* per MiB, because size is exactly what an
observer sees when the content is sealed. Received messages are never billed.

| Lane | Per message | Per MiB | Cap |
| --- | ---: | ---: | ---: |
| `msg.tor.mls` | **0** | 0 | — |
| `msg.clearnet.mls` | −0.02 | −0.02 | −0.5 |
| `msg.tor.plain` | −0.05 | 0 | — |
| `msg.clearnet.plain` | −0.25 | −0.25 | −2.5 |

The plaintext lanes are the pre-MLS cleartext fallback (§9.5). The composer shows
the current lane's rate and it **drops to "Free" the moment MLS reports ready over
Tor** — which makes the encryption state legible in a way the lock badge alone is
not.

**Calendar** — meeting invites, RSVPs, poll snapshots and ballots.

| Action | Per action | Per MiB | Cap |
| --- | ---: | ---: | ---: |
| `calendar.share.tor` | **0** | 0 | — |
| `calendar.share.clearnet` | −0.02 | −0.02 | −0.5 |

Priced **identically to an encrypted chat message on the same transport**,
because the observable event is identical: a relay sees that you sent something,
when, how big, and to which peers. Scheduling "Tuesday 3pm" must not be cheaper
than typing it, or the budget would teach a distinction that does not exist.

There is **no `.plain` lane**, and that is a real property rather than an
omission: calendar traffic rides `sendSync` → `sendEncryptedMedia`, which
**encrypts or throws**, and `canSendTo` additionally gates every send on
`mlsStatus === "ready"`. So the Calendar can never emit on the cleartext path
that ordinary chat text falls back to (§9.5) — a stronger guarantee than chat
itself gets.

Charged **once per user action, never per frame.** The outbox re-broadcasts on
its own (`flushOutbox` when MLS becomes ready, `rebroadcastRoom` when the
participant list grows), and billing those would drain the meter for sends
nobody initiated. `confirmPoll` emits two frames — the poll close and the meeting
it created — for one tap, and is billed once, because it delegates to `create`
where the charge lives.

**Traffic that cannot use Tor.** `vox.rs` and `file_xfer.rs` are iroh-direct-QUIC
only and are *blocked* in Tor mode (`stores/network.ts`: `irohBlocked`). There is
no safe variant to offer, which is precisely why they price where they do.

| Action | Base | Metered | Cap |
| --- | ---: | --- | ---: |
| `vox.call` | −1.5 | −0.05 / minute | −5 |
| `file.send` | −0.5 | −0.02 / MiB | −2.5 |

**Local security** — not exposure, but a lower wall between the data and whoever
picks up the device.

| Action | HP | Why |
| --- | ---: | --- |
| `local.autolock.off` | **−5** | `idle_lock_mins = 0` keeps the DEK live indefinitely ([§13](#13-encryption-at-rest-gervasius--protasius)) |
| `local.pin.enroll` | −1.5 | Memory-only convenience; a RAM dump of an idle-locked process can brute-force six digits (§7) |
| `local.panic_code.clear` | −1.5 | Loss of the duress escape hatch — priced low precisely because it is not an exposure |
| `local.lock_on_hide.off` | −0.5 | |
| `local.file_integrity.off` | −0.5 | Drops the per-chunk hash chain |

**Never charged:** receiving anything, reading, searching, local-only work, and
every message on the safe lane.

### 17.3 Charging rules

- **Toggles** charge on the off→on transition only and are idempotent —
  re-affirming a live switch costs nothing and writes nothing.
- **Events** charge on every activation. No dedup: the meter always moves by
  exactly the number that was on the button.
- **Metered** actions charge a base plus a rate, capped per event, and are
  coalesced (§17.6).
- **Confirmation** is raised only at ≥5 HP or when a meter is already empty.
  Everything cheaper stays one-tap. The dialog never refuses — "Continue" is
  always available, at any balance.
- Charges land **after** the action succeeds, so a room that never came up or a
  transfer that was declined costs nothing.

### 17.4 Regeneration

Both meters are **rolling windows** — 24 h and 7 days — not calendar-bounded.
That needs no timezone (std has no local-offset API and this was not worth a
dependency), has no midnight to double-collect across, and makes "a charge
expires one day after it was made" literally true.

Each charge then **heals on its own clock**:

```
unhealed(charge) = max(0, hp − elapsed × rate)
balance          = clamp(max − Σ unhealed + credits, 0, max)
```

Daily heals **+4 HP/h**, Weekly **+1 HP/h**. Nothing is written when HP returns —
which is why offline use, restarts, crashes and app-closed time need no
reconciliation at all: there is no counter to reconcile. The two meters therefore
differ *only* in ceiling, window length and rate.

The rates were chosen against real use: you would have to send **>80 clearnet
messages an hour** to outpace the daily drip, and **>20/hour** to outpace the
weekly one. So casual clearnet chat is effectively free and the weekly meter is
what registers a sustained habit.

### 17.5 Recovery

Fixed credits, paid **only for a change that reduces risk you are currently
carrying**, capped at **12.5 HP/day and 50 HP/week** across everything.

| Recovery | HP | Condition |
| --- | ---: | --- |
| `transport.tor.enable` | +5 | Paired exposure live |
| `dht.nickname.withdraw` | +5 | Paired exposure live |
| `local.passphrase.strengthen` | +5 | New passphrase **longer** than the old (lengths only, compared inside `vault_change_passphrase`; neither is stored) |
| `local.reencrypt.keyring` / `.files` | +5 | A completed key rotation |
| `dht.presence.withdraw` | +2.5 | Paired exposure live |
| `local.autolock.on` | +2.5 | `idle_lock_mins > 0` |
| `local.passphrase.change` | +1.5 | Any change — protasius re-wraps the DEK under a fresh salt |
| `room.rekey` / `room.leave` | +1.5 | Once per rolling day |
| `invite.revoke` | +2.5 | Only when a record really moved live→revoked |
| `room.inviteonly.enable` | +2.5 | Only when a room really moved open→closed ([§18.8](#188-invite-only-rooms)) |
| `data.delete.chat` / `.maps` / `.files` | +0.12/MiB freed, floor 0.25, ceiling 2.5 | Own caps: 5/day, 12.5/week |

**Key rotation out-pays a passphrase change by a full rung, and the gap is the
point.** Changing a passphrase re-wraps the DEK: it protects the key, but every
byte on disk is still sealed under the same DEK as yesterday. Rotation replaces
the keys the *data* is encrypted under, so ciphertext an attacker copied earlier
is sealed under a key that no longer exists anywhere.

**Pairing is what makes recovery idempotent.** A credit with `requires:` pays only
while its paired exposure is live and unrecovered, so a switch flipped off and on
again is always a **net loss**, never a profit. Credits without a pair
(passphrase, rotation) are bounded by a rolling-day lockout instead.

**Who measures a deletion credit:** `data.delete.maps` is measured in Rust —
`maps::map_region_remove` reads the blob's real size immediately before unlinking
it. `data.delete.chat` and `.files` are reported by the frontend, because the
deletion happens there; the per-event ceiling and the two data caps are what make
an inflated claim pointless.

### 17.6 The ledger

`ns "hp"`, one sealed blob per UTC day (`d/<day>`) plus a `meta` index — the
`chat:log` pattern, without needing a key-listing API protasius does not have.
30-day retention; the meters need 8.

```
{ ts, kind: "spend" | "recover", code, hp, n, bucket }
```

**Reason codes and numbers only.** No message, contact, room name, nickname,
ticket, path or peer id ever reaches this file. The "Why did this change?" view
(Settings → Privacy) is therefore as specific as *"47 messages on an
unencrypted-transport channel · −2.35 HP"* and no more.

**Micro-charges are coalesced** into one row per (action, hour). One row per
message would bloat a blob that is re-sealed on every append — and, more
importantly, **a timestamped row per message is itself a log of your messaging
activity**. The open bucket for the current hour is updated in place; a sealed one
is never touched again.

**Timestamps are clamped monotonic** (`ts = max(now, hi_ts + 1)`), so a clock set
backwards cannot slip a row in behind existing history, escape a charge, or
re-collect a once-per-day credit. Backwards clocks also heal nothing (saturating
subtraction).

### 17.7 Limitations — read these before trusting a number

1. **Regeneration is gamification. It repairs nothing.** A DHT record you
   published is still out there long after the bar has refilled. The meters
   measure and remember; they do not protect, and no balance implies safety.
2. **A forward clock change is not defended against.** Winding the clock forward
   heals charges early and expires them from the window. Backwards is guarded;
   forwards is not, because the only person it cheats is the user.
3. **HP prices actions and changes, not standing posture.** Tor ships *off*, so a
   fresh profile is never charged `transport.tor.disable` even though it is fully
   exposed. That is why the clearnet posture is *also* priced through every
   action's own variant.
4. **A known, capped farm exists.** Import a large map region, delete it, collect.
   The per-event ceiling and the data caps bound it to a nuisance. Closing it
   properly would need a hidden "data must be N days old" rule, and a visible cap
   is the more honest trade.
5. **Two deletion credits trust the frontend's byte count** (§17.5). The caps, not
   the caller, are what bound them.
6. **A full "Clear all data" wipe awards nothing** — it destroys the profile store
   *including* this ledger, so there is nowhere to put a credit. The outcome is
   already the best available: the fresh profile opens at a full 100 / 700,
   because no history survives to count against it. The panic-code wipe is the
   same, and that path is untouched by any of this.
7. **The ledger is per-profile and per-device.** It is not synced, and a second
   device has its own.
8. **Prices are a judgement, not a measurement.** They are ordinal — they say a
   clearnet ticket is worse than a Tor one — and the ordering, not the absolute
   number, is what is meant to be trusted.
9. **Lock-time accrual was considered and deliberately not built.** An earlier
   design regenerated HP per hour spent locked behind the passphrase gate; it was
   dropped because the vault DEK is gone while locked, forcing an
   anchor-then-settle mechanism with real edge cases (crash windows, restarts,
   clock rollback) for a small gain. Its absence is a decision, not an oversight.

---

## 18. Invitations — encrypted, expiring, revocable

A second way into a room, deliberately narrower than a ticket.

A **room ticket** is a permanent bearer credential: it carries the plaintext room
name, the creator's NodeId and — on clearnet — their IP addresses ([§8](#8-privacy)).
It cannot expire, cannot be revoked, and anyone it is forwarded to can join. An
**invitation** carries no room name and no topic, is checked against the
*inviter's own* clock at redemption, and can be revoked or spent exactly once.

Two kinds, because the honest claim differs:

- **Personal** — the whole body is sealed to one contact's public key. Nobody
  else who photographs it can read it, and **no decryption key travels with it**:
  the recipient opens it with the secret behind their own NodeId, which was never
  in the QR. A real confidentiality claim.
- **General** — a transferable bearer code in **cleartext**. There is no
  recipient to seal it to, so it is not confidential, is not claimed to be, and
  the UI, the HP explanation and the price all say so.

### 18.1 The ticket

```
base32-nopad-lowercase( TAG(0x4E) || FORMAT_V(0x01) || KIND || body )
  KIND 0x50 'P' → body = seal_to(recipient_x25519, AAD, postcard(InviteBody))
  KIND 0x47 'G' → body = postcard(InviteBody)
  AAD = [TAG, FORMAT_V, KIND]        (so a sealed body cannot be relabelled)

InviteBody { invite_id[16], capability[32], inviter, addr, issued_at, expires_at }
  addr = Iroh(Vec<EndpointAddr>) | Tor(onion)
```

The tag joins the `IROH_TAG 0x49` / `TOR_TAG 0x54` / `DHT_TAG 0x44` family, so one
paste/scan field routes everything. **Never carried:** room name, gossip topic,
room code, MLS material, or the recipient's identity — a Personal ticket must not
name its own recipient, or a photograph would reveal who was invited.

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

**Identity keys are reused for encryption.** A contact record holds only their
iroh **NodeId**, an Ed25519 *signing* key, so `x25519_from_ed25519_pk` maps it to
Curve25519's Montgomery form — the standard birational map (age does the same for
`ssh-ed25519`; libsodium ships it as `crypto_sign_ed25519_pk_to_curve25519`). The
signing side is Ed25519 over the Edwards form and the sealing side is X25519 ECDH
over the Montgomery form; they use disjoint hash prefixes and neither protocol
interprets the other's messages. The alternative — a second key per contact,
distributed and verified out of band — is a channel Enigma26 does not have.

Small-order keys are refused at both conversion and seal time; note that roughly
**half of all 32-byte strings are valid curve points**, so a successful conversion
is not a NodeId validator and is not used as one.

Forward secrecy is **one-sided**: the ephemeral key is discarded, but the
recipient's is long-lived, so a later compromise opens any captured blob. Right
for something that expires in hours; wrong for a long-term secret.

### 18.3 Redemption

`REDEEM_ALPN = enigma/redeem/0` on the same iroh router as `INVITE_ALPN`; over Tor,
the existing `Hello` frame gained `kind: "room" | "redeem"` (absent = `"room"`, so
older peers are untouched and a room dial is byte-identical to before).

```
inviter  → redeemer : challenge (32 random bytes)
redeemer → inviter  : invite_id, node_id, key_package,
                      sig   = Ed25519(identity_sk, challenge)
                      proof = blake3::keyed_hash(capability,
                                  invite_id ‖ challenge ‖ node_id)
inviter checks, under one lock:  signature → transport identity (iroh only)
                                 → state → expiry (INVITER's clock)
                                 → recipient binding → proof
                                 → CAS Active → InFlight
inviter  → redeemer : welcome ‖ room name ‖ addresses    — or a refusal code
```

**The capability never crosses the wire.** What travels is a MAC over a fresh
challenge *and* the redeemer's identity, so a captured proof cannot be replayed by
the same holder (new challenge) or reused by a different one (different node_id).

**The signature exists because of Tor.** On iroh, QUIC already authenticates the
peer and the handler cross-checks the claimed NodeId against it. **Tor
authenticates the server, not the client** — an onion stream carries no client
identity, so without a signature "recipient binding" there would reduce to the
redeemer *claiming* to be the recipient.

**One-use is a lease, not a burn.** `Active → InFlight(60 s) → Consumed`. Two
racing redeemers: exactly one takes the lease. A failed MLS round lets the lease
lapse back to `Active` rather than destroying the invitation over someone else's
bad network.

### 18.4 Admission, and the KeyPackage ordering problem

Rust performs every check, then parks and asks the frontend, because admission is
an MLS group operation whose commit must reach the room's existing members over
that room's transport — both `useChatChannel`'s.

The redeemer has to produce a **KeyPackage before it knows which room it is for**,
since the QR deliberately does not name one until the capability is proven. So it
builds a session under a scratch key (`invite:<inviter>:<expiry>`), and
`mls_adopt_session` re-files it onto the real room once the grant names one — that
session is the one holding the KeyPackage's private init key. It refuses to
overwrite an existing session: adopting onto a room we are already in would
discard live group state.

### 18.5 State

`vault::get/put` under ns `invites` — the protasius **internal** tag, so the
webview can neither read nor forge invite state (the boundary the HP ledger uses).

The **capability itself is stored**, not just a hash. Verifying a keyed MAC needs
the key; an issuer holding only a hash could not check the proof, and the protocol
would have to fall back to the redeemer transmitting the raw capability — losing
the challenge binding to protect a secret the vault already protects, alongside
the MLS state and the iroh identity key.

Retention runs from the **terminal event** (`Consumed{at}` / `Revoked{at}`), not
the deadline: an invitation revoked today but issued with a year to run is
finished today.

### 18.6 Prices ([§17](#17-privacy-hp--the-exposure-budget))

| Action | HP |
| --- | ---: |
| `invite.personal.create.tor` | **−0.5** |
| `invite.personal.create.clearnet` | **−1.5** |
| `invite.general.create.tor` | −2.5 |
| `invite.general.create.clearnet` | −5 |
| `invite.revoke` | **+5** |

A private invitation is **−1.5 against the room ticket's −5** — the cheap option is
the private one, which is the point. A bearer invitation is priced *level with*
exporting a ticket: same address, same audience, better only in that it expires
and can be revoked. At −5 it always raises the confirmation, so the warning
precedes the tap.

Charged at **creation**, not on copy: minting brings the credential into
existence, and copying it again exposes nothing further. (The room ticket is the
other way round — it already exists, so sharing is the act.) Redemption is charged
as `room.join.*`, because it *is* a room join.

`invite.revoke` is unpaired — a bearer invitation can be minted on either
transport, so pairing it to one action id would refuse to pay for the other. The
verified state change is enforced at the call site: `invite_revoke` returns whether
a record really moved from live to revoked, and the credit is claimed only on that.

### 18.7 Limitations

1. **The inviter must be online AND have the room open.** There is no
   store-and-forward ([§16](#16-history--the-serverless-rework)), and admission
   needs the group loaded plus a live transport for its commit. An invitation is a
   rendezvous, not a message left for someone. The share card says so.
2. **A General invitation is not confidential.** Cleartext by construction; there
   is no recipient to seal it to. Sealing it under a key printed beside it would
   be theatre.
3. **An invitation alone does not close a room — the room has to be closed too.**
   A room left open still admits anyone holding its ticket or guessing its
   `blake3(name)` topic, whatever the invitation did. Marking it **invite only**
   ([§18.8](#188-invite-only-rooms)) is what makes the guarantee about the room
   rather than only the QR — and even then it is app convention, not protocol
   (§9.3).
4. **`expires_at` in the QR is advisory** (§18.1). Only the inviter's record
   decides.
5. **Identity-key reuse** (§18.2) is a deliberate, documented trade.
6. **Forward secrecy is one-sided** (§18.2).
7. **A member can always re-share.** After admission the redeemer holds the room
   name and its addresses, as every member must. The invitation controls
   *admission*, not what a member does afterwards. It is not handed the DHT room
   code, so it cannot publish or resolve the room by rendezvous.

### 18.8 Invite-only rooms

A room the captain has marked **invite only** refuses gossip `mls_key_package`
frames outright. The only way in is a redeemed invitation — which never rides
gossip at all, so closing the room does not close the invitations.

**The flag rides `room_meta`**, the captain-authored snapshot that already
distributes the logo, rules, mutes and bans over the MLS seam. It inherits that
mechanism's revision guard (a stale snapshot cannot silently reopen a closed
room) and its persistence, and needs no new message type. **Absent means open**,
which is what an older peer's snapshot looks like — the field is additive in both
directions, so a build that never heard of it can neither close a room by accident
nor keep one closed.

**Enforcement sits above the admin split** in the `mls_key_package` handler. That
placement is the point: a guard below it would close the branch that *adds* while
leaving the branch that *defers* still answering a stranger with our own key
package — a half-closed door. Headless channels (device link, peer sync) are
exempt; they carry their own `admissionCheck` and have no room meta.

**A refused joiner is told, locally.** They land in the existing observer state,
and once the user's connect deadline passes without a Welcome they see "no one
admitted you to this room — it may require an invitation". Nothing is sent to
them: no member has to confirm to a stranger that a room exists and is closed, and
there is no unauthenticated frame for anyone to forge. This also fixed a related
lie — the key-exchange timer used to declare "end-to-end encryption active" after
five seconds regardless, so a refused joiner was shown a green lock over a group
of one and could type into the void ([§9.5](#9-security--privacy-considerations)).
It now distinguishes the two cases by whether any *other* member's traffic has
been seen: a lone creator sees none, a refused joiner sees plenty and can read
none of it.

**The share card withdraws the room ticket** while the room is closed (§10),
because a ticket would put someone on the topic and never into the group — handing
out something that silently does not work reads as a bug, not a policy.

**What it does not guarantee.** Every member enforces independently, so the
guarantee is only as strong as the weakest member's client: a member running a
modified or older build will still auto-admit, and OpenMLS in this configuration
lets any member commit an add. This is the same app-convention caveat as the
captain election and the single-adder rule ([§9.3](#9-security--privacy-considerations)),
and it is why the switch's own label says "everyone in the room enforces this, so
it holds as long as they are all running this app" rather than "only people you
invite can join".

Privacy HP: `room.inviteonly.enable` **+5**, claimed only on a real open→closed
move ([§17](#17-privacy-hp--the-exposure-budget)).

---

## Roadmap

Open work, in rough priority order (security hardening items are enumerated in
[§9](#9-security--privacy-considerations) and are the recommended pre-production
work — key verification, admission approval, CSP/FS scoping, PCS key rotation):

- **Admission-approval UI** before `addMember` — the remaining half of the
  auto-admit gap. [§18.8](#188-invite-only-rooms) lets a room refuse gossip key
  packages outright, which covers the "nobody uninvited gets in" case; an approval
  UI is what an *open* room still needs, so a member can see and accept a joiner
  rather than the first admin adding them silently.
- **Duration-scaled invitation pricing** — an invitation valid for a week should
  cost more Privacy HP than one valid for an hour, over a baseline for minting at
  all. The metered machinery already has the shape (a base `cost` plus a rate plus
  a `cap_per_event`, exactly as `vox.call` bills by the minute); what is missing is
  a third rate axis beside `per_mib` and `per_minute`:

  ```yaml
  - id: invite.general.create.clearnet
    kind: metered
    cost: 5           # baseline: minting a credential at all
    per_hour: 0.05    # the validity window, not a payload size
    cap_per_event: 20
  ```

  Needs `per_hour` in `build.rs`, in the derivation, and in the share card — whose
  badge must move as the deadline preset changes, because the price on the button
  has to be the price charged ([§17](#17-privacy-hp--the-exposure-budget)).
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
