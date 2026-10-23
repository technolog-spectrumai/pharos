# Enigma26 — Technology Overview

> **Since 2026-10-22 this app lives in the Belisario monorepo** at `apps/enigma/`. What
> this document calls Rutile — mounted at `rutile/` as a submodule — is the repo root now
> (`crates/`, `packages/`, `scripts/`, `tools/`), and the build is Dromon's: `./build.sh enigma pro|std`, from `apps/enigma/dromon.yaml`.
> Paths below that start `rutile/` mean the same path from the repo root. See
> [docs/migration.md](../../docs/migration.md).

A technical deep-dive into how Enigma26 works: its design, stack, dependencies,
communication flow, cryptography, privacy posture, and known weaknesses — plus the
project's conventions, config sources of truth and rework history, and how to run,
build, test, release and install it. The base it is built on — crypto crates,
shared packages, build tooling — is documented in
[docs/technology.md](../../docs/technology.md).

> **Status:** early-stage (`v0.1.10`). The cryptography is production-grade (OpenMLS),
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
[18 Invitations](#18-invitations--encrypted-expiring-revocable) ·
[19 Run, build, test](#19-run-build-and-test) · [20 Features and presets](#20-features-and-presets) ·
[21 Releasing](#21-releasing) · [22 Installing](#22-installing) ·
[23 App icon](#23-app-icon) · [24 Crypto audit inventory](#24-crypto-audit-inventory) ·
[Roadmap](#roadmap)

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
  ([§15](#15-config--sources-of-truth), [§19](#19-run-build-and-test)) bakes in the
  hosted-relay allow flag, the per-feature kill switches, crypto declarations,
  feature defaults, and setting clamps — a restricted build is a *different
  binary*, not a runtime toggle.

### Layered architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/enigma/src  (Vue 3 UI: Chat · Files · Vox · Calendar ·       │
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
| Build config | `src-tauri/build_config.yaml` → build.rs codegen ([§15](#15-config--sources-of-truth), [§19](#19-run-build-and-test)) |
| Build/CI | `./build.sh`, configured by a preset (`pro.yaml` / `std.yaml`); GitLab CI (`.gitlab-ci.yml`); Node 22 |

Rust backend crate: `enigma` → `enigma_lib` (`staticlib`/`cdylib`/`rlib`). Bundle
identifier `com.spectrumaipl.enigma26`. The tauri.conf `bundle.targets` list governs
which desktop formats a build emits — currently `["deb", "rpm"]`, out of the Linux
set Tauri can produce (`.deb`/`.AppImage`/`.rpm`); Android APK/AAB are produced
by the separate `scripts/build_android.sh` path ([§19](#19-run-build-and-test)).

---

## 3. Dependencies & libraries

Versions are the declared spec (resolved pins live in `apps/enigma/src-tauri/Cargo.lock`,
which is gitignored; Rutile's crypto workspace commits its own, in the submodule).

### Rust backend (`apps/enigma/src-tauri/Cargo.toml`)

| Crate | Ver | Role |
|---|---|---|
| `tauri` (+ `tauri-plugin-opener`/`-dialog`/`-notification`) | 2 | App framework, IPC, bundler, OS integration |
| `rotor-core` | path | MLS crypto engine (`crates/rotor/rotor_core`) |
| `protasius` | path | Per-profile encrypted store (vault lifecycle + sealed kv) |
| `gervasius` | path | At-rest crypto primitives (also used directly by `local_lock.rs`) |
| `iroh` | 0.98 | QUIC P2P endpoint, NodeId identity, n0 relay + discovery (`address-lookup-pkarr-dht` feature) |
| `iroh-gossip` | 0.98 | Epidemic broadcast over a topic (one room = one topic) |
| `mainline` | 6 | Direct BEP44 access to the BitTorrent Mainline DHT (room rendezvous, [§12](#12-dht-discovery-mainline-rendezvous--contacts)) |
| `postcard` | 1 | Serialize the pairing `Ticket` / room codes / archives |
| `blake3` | 1 | Topic id = `blake3(room name)`; DHT key derivation; transfer KeyPackage and chunk-chain hashes |
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
compile-time `build_config.yaml` codegen ([§19](#19-run-build-and-test)).

### Crypto workspace (`crates/rotor`, in the Rutile submodule)

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
and the in-repo `rakotis` workspace package. (`cytoscape` and `trix` left with the Mind
map when it was parked — see `limbo/`; `maplibre-gl` and `protomaps-themes-base`
left with the Map tab, which is Morion's now — [§16](#16-history--the-serverless-rework).)

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
  endpoint. A build without the `hosted_relays` feature
  ([§20](#20-features-and-presets)) uses `presets::Minimal` +
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
chat `file_accept` — and
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
can also remove the n0 dependency outright (leave out the `hosted_relays`
feature, [§20](#20-features-and-presets)) at the cost of NAT traversal.

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
  chunk-count check runs regardless (`file_xfer.rs`).
- **Voice-call media** → a *separate*, ephemeral per-call MLS group (a 2-member
  `RotorSession` keyed by the `call_id`) whose **RFC 9420 exporter secret**
  (`export_secret`) derives two directional 256-bit keys → two **ChaCha20-Poly1305**
  ciphers (one per direction; 96-bit nonce = a per-direction monotonic counter). Each
  10 ms μ-law datagram is `[counter‖ciphertext]`. If the MLS handshake over the call's
  bi-stream fails for any reason, the call **falls back to transport-only** (QUIC TLS,
  peers authenticated by NodeId) and the UI shows a downgraded-encryption badge.
- **PIN unlock (the `pin_unlock` feature)** → a **convenience layer, never an at-rest
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
| Device location | **Never read, never sent.** The app has no geolocation permission, no positioning plugin, and never calls `navigator.geolocation` (an e2e test traps the API and fails if that changes: `tests/e2e/noGeolocation.spec.ts`). It has no location feature of any kind: the Map tab, where a user could share a point they had tapped, moved to Morion on 2026-10-03, and the server-published Beacon layer was deleted with Enigma Cloud ([§16](#16-history--the-serverless-rework)). |
| Metadata protection (Tor) | **Available, opt-in** — the "use Tor" switch routes rendezvous + chat over peer-hosted onion services; off by default. |
| DHT participation (opt-in) | Publishing your pkarr record announces "this NodeId is online" to anyone who knows the NodeId (relay addresses only, not direct IPs). Room/nickname records are sealed — see [§12 threat notes](#12-dht-discovery-mainline-rendezvous--contacts). |

**Reading this table as a user.** [§17](#17-privacy-hp--the-exposure-budget)
turns every row above into a fixed, comparable price shown next to the control
that triggers it — the same threat model, expressed as a budget rather than a
table. It measures and remembers; it does not protect.

**At-rest posture.** All persisted state is sealed in the per-profile protasius vault
(Argon2id-derived key wrap, XChaCha20-Poly1305 values, AAD-bound to each record's
location). The plaintext exceptions are: the vault header `vault.json` (salt +
wrapped DEK — useless without the passphrase); in a profile that used the Map
tab before it left the app, the map-region blobs it imported
(`profiles/<p>/maps/<blake3>.pmtiles` — public map data, content-addressed, so
filenames carry no coordinates; nothing reads or writes them now, and a full
data wipe removes them); and — only while the app is unlocked
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
  files — the `keyring` build feature). There is no **Devices** sub-tab: device
  linking and the per-file device sync were parked whole on 2026-08-18
  ([limbo/frontend/devices/](limbo/frontend/devices/)), so nothing syncs between
  a user's own devices today ([§16](#16-history--the-serverless-rework)).
- **Contacts** (`EnigmaContactsView`) — saved peers with DHT presence ("recently
  online"), find-by-nickname, invite-to-room, call buttons, and **My code** —
  this device's NodeId QR, which lives here rather than in Settings because this
  is where it is used ([§12](#12-dht-discovery-mainline-rendezvous--contacts)).
- **Calendar** (`EnigmaCalendarView`) — room-scoped meetings + scheduling polls over
  the MLS seam; local OS notification reminders (lead time in Settings).
- **There is no Map tab.** It moved to Morion on 2026-10-03, as a viewer for
  map files with pins, routes and zones drawn on them
  ([§16](#16-history--the-serverless-rework)). A map share that is already in
  a room's history, or that arrives from a peer on an older build — a pin, a
  location, a region offer — is shown as one line saying it cannot be shown;
  its payload is not read or stored. **No geolocation, no tracking**: the app
  never calls `navigator.geolocation` and never asks the device where it is
  (an e2e test traps the API and fails if anything ever does).
- **Parked (2026-07-27)** — the **Board** (group Kanban), **Sketch board** and
  **Mind map** were the three sub-tabs of a Notes tab that no longer exists. No
  maintenance capacity; the code, tests, i18n and design docs are kept under
  `limbo/frontend/{kanban,sketch,mind}/`, each with a restore checklist, and
  their build-config sections were removed with them. No route, tab or store in
  the shipped app reaches any of them. The Files → Local text and SVG editors,
  which used Ace and the shared drawing engine (wisteria), were removed on
  2026-10-23; editing is Morion's. See [README.md](README.md#removed-features).
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
  shows; max file size; transfer chunk size + integrity check; meeting
  reminder), **Connections** (use-Tor, stable-onion, connection timeout,
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

**A build feature** (`dht` — in Professional, not in Standard;
[§20](#20-features-and-presets)). A build without it has no DHT at all: the
module, the `mainline` crate and the `dht_*` commands are not compiled, and
`discovery_enabled` reads false **whatever the profile says** — so a profile
carrying `dht_discovery: "on"` from a DHT-capable build reads as off without
the key being rewritten. rakotis applies the same gate in `getDhtDiscovery` /
`getDhtNickPublish` / `getDhtStatus`, so the whole UI goes inert at once, and
every DHT surface is hidden rather than disabled — their off-state copy points
at a Settings card such a build does not have.

**What it is.** An opt-in (default off; not present in a build without the
`dht` feature), fully
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

*(Condensed as-built reference. Crates: `crates/rotor/gervasius` — primitives;
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
- **Notes editor — removed from the UI on 2026-10-23** (see
  [README.md](README.md#removed-features)). The Rust commands it used
  (`local_note_read` / `local_note_write` in `local_lock.rs`) are still there but
  nothing in the front end calls them; `local_note_stat` is still used by the
  locked-file list. What follows describes the editor as it was: it edited local
  text files in an ACE editor. A locked
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
- **What the Map tab left behind.** A profile that used it still has its
  region list (`map:regions`) and its pins (`map:pins`) in the sealed kv, and
  its region blobs on disk (§8 at-rest posture). Nothing reads, writes or
  shows any of them since 2026-10-03, and nothing removes them short of a
  full data wipe (Settings → Data → clear data), which takes every profile.
  The blobs are ordinary PMTiles files and open in Morion as they are; the
  pins have no way out of the vault (see [todo.md](todo.md)).

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
  lowercase domain files (`chat.ts`, `user.ts`). Composables are
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
`calendar`, `contacts`, `files`, `vox`, `sketch`, `local`, `fileShare`,
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
invalid file = build error — see [§19](#19-run-build-and-test)). The same for every
build, and limited to what rarely changes: crypto declarations
(compile-asserted against rotor_core/gervasius) + Argon2id costs for new
vaults, network constants (frame cap, onion port, timeouts), defaults **and
clamp bounds** of the kv-backed settings, and the toggle defaults of a new
profile. The frontend fetches the relevant subset once at boot via
`app_get_build_config` (rakotis `initBuildConfig`/`getBuildConfig`; `main.ts`
seeds the browser-mode fallback from `config/app.ts` and the build-time feature
literals).

**Build features (compile-time):** which optional features a build contains is
a list in a root config — [pro.yaml](pro.yaml) or [std.yaml](std.yaml) — drawn
from the catalogue in `Cargo.toml` `[features]`
([§20](#20-features-and-presets)). Not a setting: an omitted feature is not
compiled.

**Who owns what — one authoritative source each.** Nothing below is stated
twice; where a value must be known in two places it is *read* from its owner,
and a test or the build fails if a copy drifts.

| What | Owner | Who reads it |
|---|---|---|
| App name, identifier, version | `tauri.conf.json` | `build.rs` (→ `build_config::app`), the bundler, the dev runner |
| Which feature ids exist, and what each requires | `Cargo.toml` `[features]` | cargo, the build driver (validation), `buildFeatures.ts` |
| Which features a build includes; debug/release, package formats, Android, tests | the root config (`pro.yaml` / `std.yaml`) | `./build.sh`, `./run_dev.sh`, `./tests.sh` |
| Crypto parameters, protocol constants, setting defaults and bounds, new-profile toggle defaults | `build_config.yaml` | `build.rs` → every Rust module; the frontend through `app_get_build_config` |
| Privacy HP prices | `privacy_hp.yaml` | `build.rs` → `hp_policy` |
| The value of a setting at run time | the profile's encrypted store (kv `p2p:settings`) | Rust and the frontend, clamped to the bounds above |

Precedence follows from that: a root config can choose features but cannot
touch crypto, protocol constants or setting bounds; `build_config.yaml` cannot
add or remove a feature; and a user's stored setting wins over a default but
never over a bound. **Built in is not switched on** — a feature in the build
makes it available, and the profile's own toggle (default from `defaults:`)
decides whether it is used.

App name and identifier are fixed to `Enigma26` / `com.spectrumaipl.enigma26`;
`build.rs` rejects a `tauri.conf.json` that says otherwise.

**Privacy HP price table (compile-time):**
[`apps/enigma/src-tauri/privacy_hp.yaml`](apps/enigma/src-tauri/privacy_hp.yaml)
— the second file `build.rs` bakes in, on the same contract as the build config
(validate → codegen → `enigma_lib::hp_policy`; an invalid table fails the build).
Like the build config it is the same for every preset: an exposure does not
get cheaper with a different product. Full rationale in
[§17](#17-privacy-hp--the-exposure-budget).

**Frontend app config:** [`apps/enigma/src/config/app.ts`](apps/enigma/src/config/app.ts)
— brand identity, UI policy, dev port. Import `brand` / `policy` / `dev` from here
instead of hardcoding.

| Value | Canonical home | Notes / mirrors |
| --- | --- | --- |
| Display name `Enigma26` | `config/app.ts` `brand.name` | Also `tauri.conf.json` `productName` + window `title` |
| Copyright / org / legal URL | `config/app.ts` `brand` | Was hardcoded in `App.vue` |
| Bundle identifier | `tauri.conf.json` `identifier` | Mirror `brand.bundleId` and Android `applicationId` (`com.spectrumaipl.enigma26`); `build.rs` rejects any other value |
| App icon | `apps/enigma/app-icon.png` | **Fixed, not a build choice** — one mark; the sizes generated from it are committed. See [§23](#23-app-icon) |
| In-app branding images | `apps/enigma/src/assets/<logoDir>/` (`logoDir` in `apps/enigma/package.json`, currently `enigma26`) | `app_icon.png` (large — the unlock/welcome gate) and `bar_icon.png` (small — the top bar) |
| Passphrase min length | `config/app.ts` `policy.passphraseMinLen` | **UI-only** today — see the roadmap note below |
| Profile field caps | `config/app.ts` `policy.*MaxLen` | `displayNameMaxLen` 150, `profileNameMaxLen` 80 |
| Hosted relays | build feature `hosted_relays` | Compiled in or out: without it iroh runs `presets::Minimal` + `RelayMode::Disabled` and the DHT cannot be built in either, leaving direct QUIC and Tor. In both presets today. (`cloud.allow_connections` sat beside its predecessor until 2026-08 and no longer exists — [§16](#16-history--the-serverless-rework).) |
| New-profile toggle defaults (tor/stable/dht) | `build_config.yaml` `defaults:` → Rust `AppProfileState` serde defaults + `p2p_dht` missing-key defaults | Apply to **new profiles only** (saved profiles keep their stored bools). UI mirrors via `policy.featureDefaults`; `offline` always starts false (not configurable). Distinct from build features: these are a profile's opt-ins |
| P2P connection timeout | kv `p2p:settings` / `connect_timeout_secs` (rakotis `appStorage.getConnectTimeoutSecs`) | **User-set in Settings**; default + clamp (60 s, 5–600) come from `build_config.yaml` `settings:`. Governs create/join give-up + the join window's read countdown (window ≤ 2×N) — never hardcode a connect deadline. Rust reads the same key (`p2p_dht::connect_timeout_secs`) for the DHT rendezvous-resolver deadline |
| DHT | build feature `dht` (requires `hosted_relays`) | Compiled in or out — **Professional only**. Without it there is no join-by-room-code, nickname directory or presence, and no `mainline` crate; n0 relays + pkarr are untouched. A stored `"on"` reads as off without being rewritten |
| DHT discovery + cadences | kv `p2p:settings` / `dht_discovery`, `dht_room_publish_secs`, `dht_presence_poll_secs` (rakotis `appStorage.getDht*`) | **User-set in Settings**, opt-in (default off). Publish default + clamp (600 s, 60–3600) from `build_config.yaml`; presence poll 300 s clamp 60–3600 (frontend-only). Rust reads the same keys directly (`vault::kv_get_raw`); absent when `dht.enabled: false`, inert when `p2p.allow_hosted_relays: false`; see [§12](#12-dht-discovery-mainline-rendezvous--contacts) |
| Key ring | build feature `keyring` | Compiled in or out — in both presets. One passphrase locking MANY local files; without it no `keyring_*` command exists. Per-file locking (`local_lock.rs`) is unaffected. The ring file `<profile_dir>/keyring.enig` is device-local and never synced |
| Chat history cap | kv `p2p:settings` / `chat_history_cap_msgs` (rakotis `appStorage.getChatHistoryCapMsgs`) | **User-tunable**; default 500 msgs clamped 50–5000 from `build_config.yaml`. Bounds the sealed per-room `chat:log` kv (oldest segment pruned past it) — the store that lets a room's timeline survive a restart |
| Meeting reminder lead | kv `p2p:settings` / `meeting_reminder_mins` (rakotis `appStorage.getMeetingReminderMins`) | **User-set in Settings**; default 15 min, clamped 0–1440, 0 = off. Read by `useMeetings`' reminder tick every round (changes apply live) — never hardcode a reminder lead |
| Release version `0.1.10` | `tauri.conf.json` `version` | The owner (drives bundle filenames; `build.rs` reads it into `build_config::app::VERSION`). Still hand-duplicated in `Cargo.toml` and the three `package.json` files. Bumped **with the code**, never chosen per build |
| Dev port `1420` | `vite.config.ts` `server.port` | Mirrored in `tauri.conf.json` `devUrl` (which Rutile's dev-server shim and `run_dev.sh --dual` read) and `dev.vitePort` |
| Argon2id params | `build_config.yaml` `crypto.kdf` (new vaults, via `lib.rs::kdf_params`) | Persisted per-vault in the header, so old vaults always unlock; `gervasius KdfParams::default()` is the library-level fallback and must stay in sync |
| P2P frame cap / onion port / Tor timeouts | `build_config.yaml` `network:` | `max_frame_bytes` is **wire-interop** (Tor frame + iroh gossip cap — change in lockstep across a fleet); onion port rides in tickets |
| Transfer chunk size | `build_config.yaml` `settings.file_chunk_kib` (clamp) → kv `p2p:settings/file_chunk_kib` | User-settable ("file chunk size"); governs every `file_xfer.rs` transfer (chat share, Maps regions). The sender's value governs a transfer and is echoed in the wire header. Device-local. Replaced the old `network.transfer_chunk_bytes` |
| Privacy HP price table | `apps/enigma/src-tauri/privacy_hp.yaml` | Compile-time, **the same for every preset** (prices are not a product knob). `build.rs` validates it (ladder membership, two-decimal precision, cap sanity, `requires:` pairing, and a required-id list so a rename fails the build instead of silently making a surface free) and generates `enigma_lib::hp_policy` |
| Privacy HP ledger | protasius ns `hp` via `vault::get/put` (**internal** tag) | Per-profile, append-only, reason codes and numbers only. Deliberately NOT in the `kv_*` keyspace the webview can write: a different AAD tag means JS cannot read, forge or clobber it. Balances are derived, never stored — see [§17.4](#174-regeneration) |
| Invitation state | protasius ns `invites` via `vault::get/put` (**internal** tag) | Per-profile, per-issuer: the capability, recipient binding, deadline and `Active/InFlight/Consumed/Revoked` state of every invitation minted. Deliberately NOT in the `kv_*` keyspace the webview can write. Expiry is decided **here**, on the inviter's clock — the deadline inside a ticket is advisory ([§18](#18-invitations--encrypted-expiring-revocable)) |
| PIN unlock | build feature `pin_unlock` (in both presets) + `build_config.yaml` `settings.pin_digits` (clamp) | Memory-only convenience re-unlock; the passphrase remains the at-rest secret. Nothing persisted, so no migration and no on-disk mode marker |
| Transfer integrity check | `build_config.yaml` `defaults.file_integrity` (default) → kv `p2p:settings/file_integrity` | Per-chunk hash chain; **either** side enabling it applies it, and a side that requires it aborts if the peer sends none |
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
the version isn't hand-maintained in eleven files; extract the apt list to
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
- **`rotor_wasm` → toto static handoff** (2026-07-14): the crypto crates live in
  one place — since 2026-10-03 that is Rutile's `crates/rotor` — and toto
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
  an absent peer is gone, and there is no store-and-forward replacement.
- **Contacts lost server search.** Finding someone by faros username is gone;
  the DHT nickname directory ([§12](#12-dht-discovery-mainline-rendezvous--contacts))
  is the only directory left, and Tor mode now has none at all.
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
| The prices | [`apps/enigma/src-tauri/privacy_hp.yaml`](apps/enigma/src-tauri/privacy_hp.yaml) — one file, every preset |
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
| `data.delete.chat` / `.files` | +0.12/MiB freed, floor 0.25, ceiling 2.5 | Own caps: 5/day, 12.5/week |

**Key rotation out-pays a passphrase change by a full rung, and the gap is the
point.** Changing a passphrase re-wraps the DEK: it protects the key, but every
byte on disk is still sealed under the same DEK as yesterday. Rotation replaces
the keys the *data* is encrypted under, so ciphertext an attacker copied earlier
is sealed under a key that no longer exists anywhere.

**Pairing is what makes recovery idempotent.** A credit with `requires:` pays only
while its paired exposure is live and unrecovered, so a switch flipped off and on
again is always a **net loss**, never a profit. Credits without a pair
(passphrase, rotation) are bounded by a rolling-day lockout instead.

**Who measures a deletion credit:** the frontend. `data.delete.chat` and
`.files` are both reported by it, because the deletion happens there; the
per-event ceiling and the two data caps are what make an inflated claim
pointless. (The one credit Rust measured itself, for deleting a map region,
went with the Map tab.)

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
4. **A known, capped farm exists.** Receive a large file, delete it, collect.
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

## 19. Run, build and test

How to run Enigma26 in development and package it into installable artifacts. A
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
([crates/rotor/](crates/rotor) — `rotor-core`, `gervasius`), the
sealed-file frame and the shared front-end packages come from **Rutile**, the
base repo mounted at `rutile/` as a git submodule, and are consumed by path —
as are [protasius/](protasius) and the `rakotis` workspace package. The whole
build is offline-friendly once crates.io/npm are cached.

Android has its own, larger toolchain (JDK 17, Android SDK/NDK, cargo-ndk) — see
[Android](#android--toolchain-setup--build) below.

---

### First-time setup

```bash
git submodule update --init   # Rutile — unless you cloned with --recurse-submodules
npm ci                        # once, at the repo root — sets up the workspace + all packages
```

Every script here stops with that `git submodule` hint if `rutile/` is empty.

`./run_dev.sh` and `./build.sh` do this themselves when the root
`node_modules` is missing, so a fresh clone can go straight to either.

`rakotis` is an in-repo workspace package (`packages/rakotis`); npm symlinks it
into the app's `node_modules`, so edits to its source are picked up immediately —
no rebuild step.

---

### Run (dev)

```bash
./run_dev.sh          # or: npm run dev
```

Both run `npm run tauri dev` inside `apps/enigma`: Vite starts on
`http://localhost:1420` and Tauri opens the native window pointed at it. Frontend
edits hot-reload; Rust edits trigger a rebuild.

> The first launch compiles the full Rust dependency tree (incl. OpenMLS + iroh +
> arti) and is slow. Later runs are incremental.

The launchers work from VS Code's integrated terminal even when VS Code is the
snap: they restore the environment the snap overrides before starting the app
(`scrub_snap_env` in [scripts/lib.sh](scripts/lib.sh)). Without that the build
succeeds and the window never opens — see [Troubleshooting](#troubleshooting).

#### Profiles & two-instance pairing

Two env vars isolate instances so you can pair two on one machine:

| Var | Default | Effect |
|---|---|---|
| `APP_PROFILE` | `default` | Storage namespace (separate encrypted store / profile dir) |
| `CHAT_USER` | `default` | MLS identity namespace |

```bash
./run_dev.sh --dual               # two instances at once: profiles alice + bob
./run_dev.sh --dual carol dave    # …with other names
# or by hand, one per terminal:
APP_PROFILE=alice CHAT_USER=alice ./run_dev.sh
APP_PROFILE=bob   CHAT_USER=bob   ./run_dev.sh
```

`--dual` gives each instance its own profile, identity and Cargo build
directory (`target-<profile>`, so neither waits on the other's link — about
8 GB each), and both share **one** Vite server: the first instance starts it,
the second reuses it. Because that server belongs to the first instance, the
two are tied together — Ctrl-C, or either window closing, stops both, and the
script takes every process it started down with it.

#### Starting over (`--reset`) — new passphrase, clean cache

There is no "forgot my passphrase" flow: the passphrase wraps the store's DEK,
so a fresh one means a fresh store. Both launchers take a flag for it:

```bash
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
| **What it keeps** | `iroh_gossip.key` and the legacy `kvstore/` at the app-data root — those are **global**, shared by every profile, so wiping them while resetting one would silently change the others' identity too |
| **Default is archive** | the profile dir is renamed to `<profile>.reset-<UTC stamp>`, not deleted — a dev vault holds a real identity (iroh key, MLS state, room history) and a mistyped profile name should not be unrecoverable |
| **`--purge`** | deletes instead, and asks you to type `purge` to confirm (`-y` skips the prompt). Use it when the archives pile up |

The work is done by `scripts/reset_profile.sh`, which both launchers call before
they start anything (the app holds the store open while it runs). You can call
it directly: `scripts/reset_profile.sh [--purge] [-y] <profile>…`. It reads the
bundle identifier from `tauri.conf.json` rather than hardcoding the data
directory, and refuses a profile name containing a path separator.

To wipe *everything* Enigma26 owns, including the global bits, use the app's own
panic code (Settings → Lock) instead — that is the audited path.

#### Pairing quick-start

1. **A**: Chat → *New chat* → name it → **Create**. A QR code appears (gold ★ host
   badge over Tor).
2. **B**: Chat → *Join a chat* → scan the QR (camera / image) or paste the ticket.
3. Both sides show **Encrypted** once the MLS handshake completes.

After the one-time pairing the app reconnects automatically (peer NodeIds are
persisted per room and re-resolved via iroh discovery) — no server, no accounts.
Restart B and it reopens the room and reconnects.

#### Browser-only mode (UI shell, no P2P)

```bash
npm run dev -w enigma        # http://localhost:1420
```

Plain Vite with no Tauri runtime — renders the UI shell only. P2P and MLS need
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
launches it (`Starting: Intent { cmp=com.spectrumaipl.enigma26/.MainActivity }`).
Frontend edits hot-reload; Rust or native Android changes trigger a rebuild. The
first build compiles the whole Rust tree for Android and is slow.

**Drive and inspect it** with adb:

```bash
adb exec-out screencap -p > /tmp/enigma.png          # screenshot
adb shell input tap 993 222                          # tap a point (device pixels)
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1        # 0 = portrait, 1 = landscape
adb shell wm size; adb shell wm density              # screen geometry
adb shell am start -n com.spectrumaipl.enigma26/.MainActivity   # relaunch
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

- `crypto` — declared algorithms are **compile-asserted** against Rutile's
  rotor_core/gervasius crates (editing the strings can't change the crypto; drift
  in either direction is a build error). Argon2id costs apply to newly created
  vaults only.
- `network` — frame cap (**wire-interop**: all peers must agree), onion port,
  Tor timeouts.
- `settings` — default and bounds of each user-tunable setting. The profile's
  encrypted store holds the live value; these seed and clamp it.
- `defaults` — the initial value of a new profile's runtime toggles (use Tor,
  DHT discovery, …).

What it does **not** hold: which optional features a build contains (the root
config — next section), and the app's name, identifier and version
(`tauri.conf.json`, which `build.rs` reads directly and holds to the fixed
identity). [§15](#15-config--sources-of-truth) lists every owner.

#### Features and presets

Which optional features a build contains is a list in a root config —
[pro.yaml](pro.yaml) (Professional, the default) or [std.yaml](std.yaml)
(Standard). A feature that is not listed is **not compiled**: not its Rust
module, not its dependencies, not its screens. The catalogue, the two presets
and how the exclusion works are [§20](#20-features-and-presets).

A dev run takes the same list: `./run_dev.sh` uses `pro.yaml`,
`./run_dev.sh std.yaml` another. Switching presets recompiles the app crate
(and compiles any optional dependency it did not have yet); nothing is cached
across feature sets by name, so there is no stale binary to worry about.

#### One fixed app identity

Every build is the same installable app:

| Value | Fixed setting |
|---|---|
| App name | `Enigma26` |
| Bundle identifier / Android package id | `com.spectrumaipl.enigma26` |
| Desktop binary name | `enigma26` |
| Data directory | `…/com.spectrumaipl.enigma26/` |

Presets differ only in features. They do **not** get separate Android package
ids or separate desktop data roots, so Standard and Professional update or
replace the same app instead of installing side by side. `build.rs` rejects a
`tauri.conf.json` that tries to change the name or identifier.

> **Moving existing data.** The package id changed from
> `com.spectrumaipl.enigma` to `com.spectrumaipl.enigma26`. Existing desktop
> data is not deleted; the new build looks in a new app-data directory. To carry
> a profile across:
> ```bash
> mv ~/.local/share/com.spectrumaipl.enigma/profiles/default \
>    ~/.local/share/com.spectrumaipl.enigma26/profiles/default
> ```
> Or just start fresh with `./run_dev.sh --reset`.

#### Building

There is one way to build: pick a preset and run `./build.sh`. There are no
build flags — the config is the whole interface. The build itself is Rutile's,
shared with Morion; `./build.sh` here only finds it and names the default.

```bash
./build.sh                 # Professional (pro.yaml)
./build.sh std.yaml        # Standard — or any other config of the same shape
./build.sh --dry-run       # print the commands the config resolves to, run none
npm run build              # -> ./build.sh
```

```yaml
output_dir: dist/pro          # packages are copied to dist/pro/enigma/ with a SHA256SUMS

apps:
  enigma:
    features: [hosted_relays, dht, calls, contacts, calendar, keyring, pin_unlock]
    test: false               # run the frontend + Rust suites first
    desktop:
      enabled: true
      profile: release        # release | debug
      bundles: [deb, rpm]     # this host's formats only
    android:
      enabled: false
      profile: debug          # debug | release (release needs a signing key)
      abis: [aarch64]
      allow_unsigned_release: false
```

Every key, what is validated and what each step runs is documented with the
tooling: [rutile/§5](../../docs/technology.md#5-build-tooling). An unknown key,
value or feature id is an error that names its path
(`apps.enigma.features: dht requires hosted_relays, which is not listed`),
never a silent default. The two presets write to different folders
(`dist/pro`, `dist/std`) because both produce a package with the same name.

The **app icon is fixed** — not a per-build choice. One mark, whose master is
[`apps/enigma/app-icon.png`](apps/enigma/app-icon.png); the generated sizes
under `src-tauri/icons/` are committed. Changing it is a code change:
[§23](#23-app-icon).

---

### Desktop build

Set `apps.enigma.desktop` in the preset ([pro.yaml](pro.yaml) / [std.yaml](std.yaml)) and run:

```bash
./build.sh
```

`profile: debug` gives a faster, unoptimized bundle. The frontend build runs
automatically via Tauri's `beforeBuildCommand`.

Which formats come out is `desktop.bundles` in the preset (falling back to
`bundle.targets` in `tauri.conf.json` when the key is omitted). The build fails
if *no* package appears, but not if fewer appear than you expected — read the
"Built" list it prints before a release. Output, also copied to
`dist/pro/enigma/`:

```
apps/enigma/src-tauri/target/release/bundle/     # release
apps/enigma/src-tauri/target/debug/bundle/       # profile: debug
  deb/Enigma26_<ver>_amd64.deb
  rpm/Enigma26-<ver>-1.x86_64.rpm
  appimage/Enigma26_<ver>_amd64.AppImage         # only if "appimage" is in bundle.targets
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
| Rust | stable | Tauri Rust core + vendored crates |
| cargo-ndk | latest | Rust → Android NDK bridge |

#### One-time setup (scripted)

```bash
bash scripts/setup_java.sh              # OpenJDK 17 (+ JAVA_HOME in ~/.bashrc)
bash scripts/install_android_studio.sh  # Studio, SDK 35, NDK, build tools, CMake, i386 libs
bash scripts/setup_rust_android.sh      # rustup Android targets + cargo-ndk
bash scripts/patch_cargo_android.sh     # Cargo.toml Android-compat check
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
vendored crates are pure Rust and cross-compile fine.

#### Build the APK / AAB

Set `apps.enigma.android.enabled: true` in the preset — with
`profile` and `abis` — and run `./build.sh`. That calls:

```bash
bash scripts/build_android.sh enigma debug                    # debug APK, aarch64
bash scripts/build_android.sh enigma release aarch64,x86_64   # release APK + AAB
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

`build.sh` copies these into `dist/pro/enigma/` with the app name in place of
Tauri's generic `app-` prefix (`enigma-universal-release.apk`), because the
Tauri names are identical between apps.

#### Signing a release build

Release signing **fails closed**: with no keystore configured, a release build
is refused before any work starts, and the SDK debug key (publicly known) is
rejected for release outright — by path, filename, or the `androiddebugkey`
alias. Debug builds keep the debug key and are unaffected.

One-time setup, with the stdlib-only checker the build itself calls
([scripts/android_signing/](scripts/android_signing)):

```bash
SIGN="python3 scripts/android_signing/signing_cli.py"
GEN=apps/enigma/src-tauri/gen/android

# Mint a release keystore (outside the repo, chmod 600, RSA 4096) — the tool
# warns loudly: losing this key permanently orphans every distributed install.
$SIGN create

# Would a release sign, and where does each credential come from?
$SIGN status --gen $GEN

# Build a signed release (android: { enabled: true, profile: release } in
# the preset). Artifacts are verified with apksigner afterwards and the report
# prints package, version, signer and SHA-256 fingerprint.
./build.sh

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
fallback: `allow_unsigned_release: true` under `android:` in the preset
(`scripts/build_android.sh enigma release aarch64 --allow-unsigned-release`).
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

[.gitlab-ci.yml](.gitlab-ci.yml) builds Enigma26 on GitLab:

| Job | Stage | When | What |
|---|---|---|---|
| `frontend:build` | check | every commit | `vue-tsc` + `vite build`, asserts `dist/index.html` |
| `tauri:build` | build | every branch commit | `./build.sh` — the Professional desktop bundle; fails if no package was produced |
| `tauri:desktop` | build | tags / manual | release bundle, 30-day artifacts |
| `android:build` | build | manual | stubbed (not provisioned to a CI image yet) |

---

### Tests

```bash
./tests.sh            # the full run — every suite below, with a pass/fail table at the end
./tests.sh rust e2e   # only these groups (js | rust | py | build | e2e)
./tests.sh --list     # the steps and the command each one runs
```

`tests.sh` keeps going after a failure, so one run tells you everything that is
broken, and saves each step's output under `test-results/tests/`. The steps, for
running one by hand:

```bash
npm test                                   # all workspaces
npm test -w enigma                         # vitest: chat store, components, i18n, …
npm test -w rakotis                        # vitest: transport bridge, storage, i18n
( cd apps/enigma/src-tauri && cargo test ) # Rust: tickets, DHT, Tor, kv, …
( cd protasius && cargo test )             # encrypted store
python3 -m pytest scripts/android_signing/tests   # Enigma's signing contract vs Rutile's checker
npm run test:e2e -w apps/enigma            # Playwright smoke tier (no backend — there is none)
( cd rutile && ./tests.sh )                # the base itself: crypto crates, substrate, petalite, wisteria
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
- **`rutile/ is empty — this repo is built on the Rutile submodule`** — the
  clone was made without submodules: `git submodule update --init`.
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
  with `cd crates/rotor && cargo check -p rotor-core`.
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
  re-run `scripts/setup_java.sh`.

---

## 20. Features and presets

One codebase, two shipped products. Each is the same source built with a
different **list of features**; there is no runtime licence check, no
server-side entitlement, and no dormant code path waiting for an unlock. A
feature that is not in a build is **not in that binary**: its Rust module is
not compiled, its dependencies are not linked, its commands and its network
protocol do not exist, and its screens are not in the frontend bundle.

That property is the whole point. Enigma26's pitch is a serverless, auditable,
end-to-end-encrypted client — a product that merely *hides* features would mean
every user still ships the attack surface of every feature. Excluding at build
time keeps each product's surface honest.

### 20.1 The catalogue

The optional features are **Cargo features**. The `[features]` table of
[`apps/enigma/src-tauri/Cargo.toml`](apps/enigma/src-tauri/Cargo.toml) is the
catalogue — the one place that says which ids exist and what each requires.

| Feature | What it adds | Rust | Frontend |
|---|---|---|---|
| `hosted_relays` | iroh's n0 relays and pkarr/DNS discovery. Without it iroh runs with relays disabled: direct QUIC by ticket and Tor keep working, reconnecting to a bare NodeId does not | a mode switch in `p2p_iroh.rs` / `file_xfer.rs` | — |
| `dht` | The Mainline DHT: join by room code, the nickname directory, presence ([§12](#12-dht-discovery-mainline-rendezvous--contacts)). **Requires `hosted_relays`** | `p2p_dht.rs`, the `dht_*` commands; crates `mainline`, iroh's `address-lookup-pkarr-dht` | the DHT card in Settings, find-people in Contacts, call-by-nickname |
| `calls` | 1:1 voice calls | `vox.rs`, the `vox_*` commands, the `enigma/vox/0` protocol; crate `rustfft` | the Vox tab, `useVoxCall` |
| `contacts` | Contacts and direct room invites | `p2p_invite.rs`, the invite protocol | the Contacts tab, `useRoomInvites` |
| `calendar` | Meetings and polls | none | the Calendar tab, `useMeetings` |
| `keyring` | The key ring: one passphrase locking many local files | `keyring.rs`, the `keyring_*` commands | the Keys panel in Files |
| `pin_unlock` | Re-opening an idle-locked vault with a PIN | the `vault_pin_*` commands and the PIN state | the keypad, the PIN card in Settings |

**Never optional:** the crypto (rotor_core, gervasius, protasius), the chat
transports (iroh, Tor), file transfer, per-file locking, invitations,
Privacy HP and voice notes (which is why the audio crates `cpal` and `hound`
stay even without `calls`).

### 20.2 The presets

A preset is a root config that names features — nothing more. "Standard" and
"Professional" are labels for two lists.

| Feature | [std.yaml](std.yaml) | [pro.yaml](pro.yaml) |
|---|:-:|:-:|
| `hosted_relays` | ✓ | ✓ |
| `contacts` | ✓ | ✓ |
| `keyring` | ✓ | ✓ |
| `pin_unlock` | ✓ | ✓ |
| `dht` | – | ✓ |
| `calls` | – | ✓ |
| `calendar` | – | ✓ |

`./build.sh` builds Professional; `./build.sh std.yaml` builds Standard
([§19](#building)). Any other list is a config away: copy a preset, edit
`features:`. The build driver refuses an id the catalogue does not have, and a
list that leaves out something a listed feature requires (`dht` without
`hosted_relays`) — the list must be closed, so the file always says exactly
what is built.

*(Until 2026-10-03 the line was Basic / Standard / Professional "editions",
selected by an `ENIGMA_EDITION` variable that picked one of several full copies
of the build config, and gated by constants rather than by compilation. Before
2026-08-18 it was Light / Plus / Pro.)*

### 20.3 How a feature is left out

One list, two consumers, and they get the same one:

```
pro.yaml  apps.enigma.features: [hosted_relays, dht, calls, …]
   │  the build driver validates it against Cargo.toml [features]
   ├─► tauri build/dev --features …           Rust: #[cfg(feature = "…")]
   └─► ENIGMA_FEATURES=… in the environment   Vite: build-time literals
```

**Rust.** The modules `vox`, `p2p_dht`, `keyring` and `p2p_invite` are
declared under `#[cfg(feature = …)]`, as are their commands in
`generate_handler!`, their managed state, and the PIN commands and state in
`vault.rs`. The optional crates are `optional = true` and named by the feature,
so a build without `calls` does not link `rustfft` at all.
`crate::features::{CALLS, DHT, …}` (`cfg!(feature)`) is what the app reports
to the frontend. Two details:

- *The DHT has a stand-in.* The iroh node (`p2p_iroh.rs`) is threaded with the
  DHT in a dozen places. Rather than `#[cfg]` each, a build without `dht`
  mounts `p2p_dht_off.rs` as `p2p_dht`: discovery always reads off, and the
  handle types are uninhabited, so everything that would use one is
  unreachable by construction. The node keeps one code path — the one a `dht`
  build takes with the user's toggle off.
- *`default = []`.* The Tauri CLI leaves a manifest's default features on, so
  a non-empty `default` could not be left out of a build. A bare `cargo build`
  therefore builds the core alone; `tests.sh` and CI name their features.

**Frontend.** [`buildFeatures.ts`](apps/enigma/buildFeatures.ts) reads the
catalogue from `Cargo.toml` and turns `ENIGMA_FEATURES` into one literal per
feature (`__FEATURE_CALLS__`, …) through Vite's `define`. Code is gated where it
is *imported or instantiated*, so the bundler drops it: feature routes are lazy
and registered only when compiled in (`router/index.ts`), `tabs.ts` lists only
compiled-in tabs, and the chat store creates `useVoxCall` / `useRoomInvites` /
`useMeetings` only behind the literal. A Standard bundle has no call or
calendar code. With `ENIGMA_FEATURES` unset — plain
`npm run dev`, vitest, Playwright — every feature is on.

The runtime gate is still there as the second check: rakotis'
`getBuildConfig()` carries the flags the Rust side reports (and, in the browser
shell, the same literals), and every surface asks it.

**Built in is not switched on.** `dht` in a build makes the DHT *available*; a
new profile still starts with discovery off (`defaults:` in
`build_config.yaml`) until the user opts in. The two never mix: features are
what the binary contains, defaults are what a profile begins with.

### 20.4 Invariants — what does NOT vary by preset

Presets differ **only in features**. Everything else is identical, deliberately:

- **Crypto.** Same MLS ciphersuite, same at-rest AEAD, same Argon2id costs. One
  security story to audit, not two. (These are compile-time asserted against
  Rutile's `rotor_core`/`gervasius` anyway — they cannot drift silently.)
- **Network / wire.** Same `max_frame_bytes`, `onion_port`, Tor timeouts.
  `max_frame_bytes` is **wire-interop sensitive**: peers in one room must agree
  on it, and a Standard user must be able to sit in a room with a Professional
  user.
- **Settings.** Same defaults and bounds for every user-tunable setting,
  including ones whose feature a preset leaves out (`dht_room_publish_secs` is
  still a required, validated field — a Standard build simply never reads it).
  They live in `build_config.yaml`, which no preset can override.
- **App identity.** One name, one identifier (`com.spectrumaipl.enigma26`), one
  version — all from `tauri.conf.json`. Presets replace the same app instead of
  installing side by side. The version is bumped with the code, never chosen
  per build. The app **icon** is fixed the same way: [§23](#23-app-icon).

### 20.5 What a peer on another preset sees

Because the composables are what register sync handlers on the chat channel, a
build without a feature does not merely hide a surface — it never subscribes to
those message types, and its endpoint does not speak the feature's protocol.

- An incoming **call** from a Professional peer is refused at protocol
  negotiation: a Standard endpoint has no `enigma/vox/0`.
- A **meeting invite** is an unhandled message type and is dropped. The
  Standard user sees nothing.

Cross-preset rooms therefore degrade quietly rather than erroring. That is the
intended behaviour, and also the sharpest edge in this design (§20.6).

One place where quiet degradation was **not** enough: a room joined by code
stores that code as its credential, so the room outlives the build that joined
it — open the profile with a build that has no DHT and the saved room comes
with it. `realtime_join_room` therefore recovers the room name from the code
(the topic is `blake3(name)`, which the code carries) and reconnects by
persisted NodeIds instead.

### 20.6 Known gaps / follow-ups

Tracked in [todo.md](todo.md); the ones that are properties of the design:

1. **No cross-preset capability signalling.** A Professional peer cannot tell
   that a room member is on Standard, so it cannot warn "3 members won't see
   this meeting". A capability byte in the MLS-carried presence/join payload
   would fix it; today the degradation is silent.
2. **Moving a profile between presets** is "install the other build and open
   the same profile" — the vault format does not depend on features, so it
   works, but it is untested.
3. **No preset shown in the UI.** Nothing tells the user which build they are
   running beyond which tabs exist.
4. **Thin frontend wrappers remain.** The views, composables and libraries of
   an omitted feature are gone from the bundle, but a few command wrappers in
   shared modules (rakotis' `dht*` helpers) and the inline DHT cards inside
   Settings and Contacts still ship, dead at run time.
5. **Settings cannot vary per preset.** If Professional should one day get,
   say, a larger default file size, `settings.*` bounds are safe to vary but
   `network.max_frame_bytes` is **not** (§20.4).

---

## 21. Releasing

This is the maintainer checklist for producing Enigma26 desktop and Android
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

- Which product: Professional ([pro.yaml](pro.yaml)) or Standard
  ([std.yaml](std.yaml)) — the feature list is the product
  ([§20](#20-features-and-presets)).
- Desktop only: `.deb` / `.rpm` — `desktop:` enabled in the preset.
- Android sideload/test distribution: a signed `.apk`.
- Android store distribution: a signed `.aab` uploaded to the store, plus an
  APK only when the store or test channel needs one.
- Both desktop and Android: enable both sections; one `./build.sh`
  builds them in turn. See [§19](#building).

Every one of those choices is a line in the preset — the only place a build is
configured. `./build.sh` builds Professional, `./build.sh std.yaml` Standard.

The preset is **not in the artifact's name**: both produce
`Enigma26_<version>_…`, which is why they are delivered to different folders
(`dist/pro/enigma/`, `dist/std/enigma/`). Keep them apart from there on, and
record which preset (and commit) a release was built from.

### 21.2 Prepare The Checkout

Start from the Enigma26 repo root:

```bash
cd /path/to/enigma
git status --short
npm ci
```

Do not release from a dirty tree unless every change is intentional. The
`dist/<preset>/enigma/` output folders can contain old artifacts, so do not use
"whatever is already in dist" as the release set.

The version is a property of the code, not a build-time choice: it is bumped
with the change that earns it — a preset has no key for it.
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

With `desktop: { enabled: true, profile: release, bundles: [deb, rpm] }` under
`apps.enigma` in the preset:

```bash
./build.sh
```

Expected release output (copied to `dist/pro/enigma/` as well):

```text
apps/enigma/src-tauri/target/release/bundle/
  deb/*.deb
  rpm/*.rpm
```

Which formats appear is `desktop.bundles` in the preset (`bundle.targets` in
`tauri.conf.json` when that key is omitted) — check the "Built" list the
command prints before a release.

An `.rpm` built on Ubuntu links against Ubuntu's glibc and webkit2gtk: it is a
package format, not a cross build, and will very likely refuse to start on
Fedora. Build each distribution's package on that distribution.

### 21.5 Configure Android Release Signing

Android release builds must be signed. Enigma26 deliberately fails closed when a
release key is missing or when the Android SDK debug key is used for a release.

Preferred flow:

```bash
SIGN="python3 scripts/android_signing/signing_cli.py"
$SIGN status --gen apps/enigma/src-tauri/gen/android
$SIGN create
./build.sh      # android: { enabled: true, profile: release, abis: [aarch64, x86_64] }
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
([scripts/android_signing/](scripts/android_signing)).

### 21.6 Build Android Artifacts

Set this under `apps.enigma` in the preset and run `./build.sh`:

```yaml
android:
  enabled: true
  profile: release
  abis: [aarch64, x86_64]
```

It runs `scripts/build_android.sh enigma release aarch64,x86_64`.

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
- `allow_unsigned_release: true` is only for inspecting packaging output. That APK
  should be treated as installable nowhere and must never be distributed.

### 21.7 Collect And Verify Artifacts

`./build.sh` clears the previous desktop bundle directory before it builds,
fails if the build leaves no package, and copies what it built into the
preset's `output_dir` (`dist/pro/enigma/` or `dist/std/enigma/`), Android artifacts
renamed from Tauri's generic `app-…` to `enigma-…`. It prints the list under
"Built".

It also writes a `SHA256SUMS` there, over **everything** in that directory —
including older installers left there by earlier builds. Treat that file as an
index of the directory, not as a manifest of this release, and publish checksums
for the exact files you ship:

```bash
( cd dist/pro/enigma && sha256sum -- Enigma26_<ver>_amd64.deb enigma-universal-release.apk )
```

Before sharing Android files, verify package, version, signer, and fingerprint:

```bash
python3 scripts/android_signing/signing_cli.py verify dist/pro/enigma/enigma-universal-release.apk
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
adb shell am start -n com.spectrumaipl.enigma26/.MainActivity
adb logcat -s RustStdoutStderr enigma
```

If the device already has a debug build, an unsigned build, or a build signed
with another key, Android may refuse the update. Uninstalling can fix the test
device, but it removes the local Enigma26 vault and room state.

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
git tag -a v<version> -m "Enigma26 <version>"
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
applicationId = "com.spectrumaipl.enigma26"
```

Standard and Professional APKs do not install side by side; they update
or replace the same Android package. Treat the package id printed by
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

`dist/pro/enigma/` can contain artifacts from earlier names, versions,
and signing states. A filename like `enigma-universal-release.apk` is not enough
proof that the file came from the current commit.

What to do:

- start from an empty `dist/pro/enigma/`, or checksum only the files you ship;
- verify the exact APK/AAB that will be shared.

#### Regenerated Android Project

`tauri android init` can regenerate files under
`apps/enigma/src-tauri/gen/android/`. Enigma26 has custom signing gates in the
generated Gradle project, mirrored by `scripts/android_signing/signing.py`.

What to do:

- run `python3 scripts/android_signing/signing_cli.py status --gen apps/enigma/src-tauri/gen/android`
  after regenerating Android files;
- verify that release signing still fails closed when credentials are missing;
- keep signing logic in Gradle and `signing.py` in lockstep.

---

## 22. Installing

This guide is for installing Enigma26 artifacts that were produced by the release
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
sudo apt install ./Enigma26_<version>_amd64.deb
```

Install an RPM package:

```bash
sudo dnf install ./Enigma26-<version>-1.x86_64.rpm
```

Run an AppImage, when one is shipped:

```bash
chmod +x ./Enigma26_<version>_amd64.AppImage
./Enigma26_<version>_amd64.AppImage
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
5. Open Enigma26 and grant camera or microphone permission only when using QR
   scanning or calls.

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
adb shell am start -n com.spectrumaipl.enigma26/.MainActivity
adb logcat -s RustStdoutStderr enigma
```

Uninstalling removes Enigma26's local vault, room state, and device-local data:

```bash
adb uninstall com.spectrumaipl.enigma26
```

Only uninstall as a last resort on a real user's device. Enigma26 is serverless, so
there is no central account that can restore local encrypted state.

### Why An APK May Fail To Install

#### The APK Is Unsigned

Android requires installable APKs to be signed. Enigma26's release build fails
closed: with no release keystore configured the build is refused before any
work starts, and the Android SDK debug key is refused for a release outright. The only way to obtain an
unsigned release artifact is to ask for it with `--allow-unsigned-release`, and
that artifact is for packaging inspection — it installs nowhere and must not be
shared.

What to do:

```bash
python3 scripts/android_signing/signing_cli.py verify <apk>
bash scripts/build_android.sh enigma release aarch64,x86_64
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

The default Enigma26 Android build targets `aarch64`, which is right for most
modern phones but wrong for an `x86_64` emulator and wrong for old 32-bit
devices.

What to do:

```bash
bash scripts/build_android.sh enigma release aarch64,x86_64
# or, when all targets are installed:
bash scripts/build_android.sh enigma release all
```

For an emulator, include `x86_64`.

#### The Device Is Too Old

Enigma26's generated Android project currently declares:

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

Installation success only proves the package was accepted by Android. If Enigma26
opens blank, crashes, cannot scan QR codes, or cannot join calls:

- update or enable Android System WebView / Chrome;
- grant camera permission for QR scanning;
- grant microphone permission for voice calls;
- capture logs with `adb logcat -s RustStdoutStderr enigma`;
- test with a clean profile on a disposable device before touching a real user's
  install.

### Repo-Specific Android Checks

Confirm what is actually inside an APK before distributing it:

```bash
python3 scripts/android_signing/signing_cli.py verify <apk>
```

The report should show:

- package id, fixed to `com.spectrumaipl.enigma26` in the generated Gradle file;
- visible version and Android `versionCode`;
- signer classification: signed release, debug, or unsigned;
- SHA-256 signing certificate fingerprint.

Once a release fingerprint has been pinned in
`apps/enigma/deploy/android-release-key.properties`, a build signed with any
other keystore fails instead of shipping — so a mismatch between that file and
the fingerprint printed above means the artifact did not come from the release
path. The full command set: `signing_cli.py --help`
([scripts/android_signing/](scripts/android_signing)).

Preset names and output filenames are not separate Android identities. Android
uses the APK's `applicationId` plus the signing key, and Enigma26 fixes the
release `applicationId` to `com.spectrumaipl.enigma26`.

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
changed here, in code — a preset has no key for it.

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

`app-icon.png` is what `npx tauri icon` consumes; the original is kept beside
it so a better master can be re-derived later without starting from an upscale.
The current master was made from the 1536×1024 original by **padding** it to
square on transparency (centred, never stretched) and scaling — do the same
with a new original, so the artwork is not distorted.

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
   master.
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

Written 2026-09-16; scope narrowed on 2026-10-03, when Morion moved to its own
repository and the code both apps share moved to Rutile. This document covers
Enigma26 and the Rutile crates it links. Nothing here was re-audited on that
date — only what no longer belongs to this repository was taken out.

### Scope

Active scope:

- Enigma26 desktop app: `apps/enigma`
- Enigma's encrypted store: `protasius`
- The crypto crates, from the Rutile submodule: `crates/rotor`
  (`rotor_core`, `gervasius`) and `crates/substrate` (the sealed-file
  frame — Enigma links it WITHOUT `legacy-detect`, so no Fernet and no OpenSSL)

Out of scope here:

- Morion and its file sealing (`padova`, the `ZINNLOCK` frame): its own
  repository. It shares `gervasius` and `substrate` with Enigma through Rutile,
  so a finding in those crates concerns both apps.
- Historical limbo material under `limbo/`

### Algorithm Inventory

| Area | Current algorithm or construction | Where used | Source of truth / notes |
| --- | --- | --- | --- |
| MLS group encryption | `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` via OpenMLS | Enigma room chat payloads, room metadata, membership changes, calendar cards, and feature signaling that rides the room channel | Declared in `apps/enigma/src-tauri/build_config.yaml`; asserted by `apps/enigma/src-tauri/build.rs` against `crates/rotor/rotor_core/src/lib.rs`. Rotor uses pure ciphertext wire format and ratchet-tree extension. |
| MLS credentials | OpenMLS `BasicCredential` with self-asserted device identity | MLS member identities and rosters | `crates/rotor/rotor_core/src/lib.rs`. This is not a PKI or verified identity binding. |
| At-rest envelope | Passphrase -> Argon2id -> UKEK wraps random 32-byte DEK -> XChaCha20-Poly1305 for values | Enigma profile vault, MLS state, chat/p2p settings, invite records, DHT secrets, iroh/Tor keys, panic sidecars | `crates/rotor/gervasius/src/*`, `protasius/src/lib.rs`. Vault headers store version, KDF params, salt, and wrapped DEK. |
| Password KDF | Argon2id v1.3, 32-byte output | New Enigma vaults, local file locks, key rings (and Morion's sealed files, through the same crate) | Configured in `build_config.yaml` as 64 MiB, t=3, p=4; validated by `build.rs`; implemented in `crates/rotor/gervasius/src/kdf.rs`. |
| AEAD for local data | XChaCha20-Poly1305 with 24-byte random nonce and AAD | Gervasius sealed blobs, Enigma local file locks, key-ring files, in-memory PIN passphrase box | `crates/rotor/gervasius/src/aead.rs`, `apps/enigma/src-tauri/src/local_lock.rs`, `apps/enigma/src-tauri/src/keyring.rs`, `crates/padova/src/lock.rs`. |
| Public-key sealing | Ephemeral-static X25519 -> HKDF-SHA256 -> XChaCha20-Poly1305 | Personal invite ticket body sealed to a recipient NodeId public key | `crates/rotor/gervasius/src/seal.rs`, `apps/enigma/src-tauri/src/invite_ticket.rs`. Recipient Ed25519 NodeId keys are converted to X25519; small-order/off-curve inputs are rejected. |
| DHT record encryption | BLAKE3-derived keys, ChaCha20-Poly1305, random 96-bit nonce | Mainline DHT room rendezvous, presence, nickname directory | `apps/enigma/src-tauri/src/p2p_dht.rs`. DHT records are public metadata containers; MLS still gates room membership. |
| DHT signatures | Ed25519 signing keys derived with BLAKE3 domain separation | BEP44 mutable DHT records | `apps/enigma/src-tauri/src/p2p_dht.rs`. |
| Invite redemption | Ed25519 signature over random challenge plus BLAKE3 keyed proof with 32-byte invite capability | QR/ticket redemption before MLS add | `apps/enigma/src-tauri/src/invite_redeem.rs`, `apps/enigma/src-tauri/src/invites.rs`. The capability itself does not cross the wire during redemption. |
| File transfer E2EE | Ephemeral 2-member MLS group for transfer chunks | Direct iroh file transfer payloads | `apps/enigma/src-tauri/src/file_xfer.rs`. Transfer auth is tied to a KeyPackage hash signaled through the feature's MLS channel. |
| File transfer integrity | BLAKE3 hash chain with final root | Direct iroh file transfer chunks | `apps/enigma/src-tauri/src/file_xfer.rs`; default enabled by `features.file_integrity` in `build_config.yaml`. |
| Voice media encryption | MLS exporter secrets -> directional ChaCha20-Poly1305 keys, monotonic counter nonce | 1:1 Vox media datagrams | `apps/enigma/src-tauri/src/vox.rs`. Current code can fall back to transport-only crypto if the MLS call handshake fails. |
| P2P transport | iroh QUIC and iroh-gossip; optional hosted relays/discovery | Normal Enigma rooms, direct invites, file transfer, calls | `apps/enigma/src-tauri/src/p2p_iroh.rs`. Relays should see MLS ciphertext for room payloads. |
| Tor transport | Arti onion services and streams | Tor-mode Enigma rooms | `apps/enigma/src-tauri/src/p2p_tor.rs`. The elected captain forwards MLS ciphertext and should not have other members' group keys beyond its own membership. |
| Topic derivation | BLAKE3 hash of room name | iroh gossip topics and Tor room naming helpers | `apps/enigma/src-tauri/src/p2p_iroh.rs`, `apps/enigma/src-tauri/src/p2p_tor.rs`. This is deterministic and not a secret by itself. |
| Legacy platform files | Fernet read/detect path: AES-128-CBC + HMAC | Historical Toto/Zinnia sealed files only — **not compiled into Enigma** | `crates/rotor/gervasius/src/gervazy.rs` (feature `gervazy`), `crates/substrate/src/lib.rs` (feature `legacy-detect`). Morion enables them; Enigma must not, and `./tests.sh` asserts `openssl-sys` is absent from its tree. |

Key dependency versions confirmed from the Enigma Rust tree:

- `openmls` 0.7.4 and `openmls_rust_crypto` 0.4.4
- `iroh` 0.98.2 and `iroh-gossip` 0.98.0
- `arti-client` 0.43.0
- `argon2` 0.5.3
- `chacha20poly1305` 0.10.1
- `blake3` 1.8.5
- `mainline` 6.2.0
- `rustls` 0.23.41

### Secret And Data Locations

| Secret or sensitive data | Storage | Protection |
| --- | --- | --- |
| Profile DEK | In memory only after unlock; wrapped in `vault.json` at rest | Argon2id-derived UKEK wraps DEK through gervasius |
| MLS state | Protasius encrypted store, namespace `mls` | XChaCha20-Poly1305 value sealing; exported state is zeroized on Rust paths that handle it |
| Chat/profile settings and room data | Protasius encrypted store | Values sealed with per-key AAD prefixing; keys remain plaintext for scans |
| iroh gossip identity key | Protasius encrypted store, namespace `keys` | Stored sealed; used for stable node identity |
| Tor onion service identity / keystore | Profile Tor area, sealed through the vault integration | Wiped/resealed on shutdown paths described in `p2p_tor.rs` |
| Invite capabilities and records | Protasius internal invite namespace | Sealed at rest; redemption sends only challenge-bound proof |
| DHT room secret | Protasius encrypted store, namespace `dht` | Used to derive DHT record keys; public DHT still leaks bounded metadata |
| PIN unlock passphrase copy | Process memory only | Passphrase sealed under PIN-derived gervasius vault; dropped after 5 wrong PINs or restart |
| Panic code targets | Panic sidecar | Sealed under panic passphrase path; panic unlock returns like a normal unlock |
| Key-ring file keys and absolute paths | Local ring file under profile keyrings | Ring table sealed under ring DEK; raw keys and absolute paths are device-local |

### Existing Cybersecurity Measures

- Build-time crypto declarations are validated in `apps/enigma/src-tauri/build.rs`.
  Unknown YAML fields fail the build, sane KDF ranges are checked, and algorithm
  strings are const-asserted against the vendored crypto crates.
- Enigma room content is designed to be E2EE through MLS. iroh relays, the
  Mainline DHT, and Tor captains are not intended to see plaintext room payloads.
- Local profile data is encrypted at rest through Protasius/gervasius. The
  vault has no password recovery path; a forgotten passphrase means the store is
  unavailable by design.
- The vault can idle-lock. Rust-side watchdog logic tears down Vox, iroh, Tor,
  file transfer, and in-memory MLS sessions before dropping the DEK.
- PIN unlock is explicitly convenience-only and memory-only. Nothing PIN-derived
  is persisted to disk.
- Panic code support keeps the unlock result indistinguishable from a normal
  unlock and can wipe profile state plus opted-in local files.
- Personal invite tickets hide the room material and capability from a passive
  QR observer by sealing the body to the recipient. General invites are bearer
  credentials by design.
- Invite redemption is challenge-bound and identity-bound: a captured proof
  should not replay against a new challenge or a different NodeId.
- File transfer chunks are MLS-encrypted in a short-lived 2-member group and
  can be protected by a BLAKE3 hash chain.
- Key rings use per-file random DEKs and fsync+rename writes for ring and file
  updates.
- Tauri capabilities for Enigma are narrow at the manifest level: core, opener,
  dialog, and notification defaults; no broad filesystem plugin permission is
  declared in `capabilities/default.json`.
- Remote Toto token handling, if kept in scope, avoids localStorage for tokens,
  requires HTTPS, disables redirects, bounds request bodies, and allowlists
  `/api/v1/` proxy paths.

### Audit Gaps And Required Work

P0 before an external encryption audit:

- Remove or hard-disable the pre-MLS plaintext chat fallback in
  `packages/rakotis/src/useChatChannel.ts`. Current code can send
  `chat_message` over the gossip topic before `mlsStatus === "ready"`.
- Make Vox fail closed when its MLS media handshake fails, or make the
  transport-only fallback an explicit, user-visible degraded mode with audit
  signoff. The current fallback is in `apps/enigma/src-tauri/src/vox.rs`.
- Add a real Tauri Content Security Policy. `apps/enigma/src-tauri/tauri.conf.json`
  currently has `"csp": null`.
- Enforce passphrase minimum and policy in Rust, not only in UI. Direct
  `invoke` calls can currently bypass UI-only policy.
- Run a fresh dependency audit for Rust and npm before the audit package is
  handed over. The lockfiles are the source of truth, and npm currently reports
  high/critical findings during install.

P1 hardening:

- Add member/key verification UX: safety numbers, SAS, or another explicit
  binding between QR/tickets, NodeIds, and MLS credentials. BasicCredential alone
  is self-asserted.
- Add admission approval for room joins and align old/modified-build behavior.
  DHT room codes and leaked general tickets are bearer-style entry paths until
  MLS admission is explicitly approved.
- Define and implement MLS rekey/post-compromise recovery cadence, including a
  user-visible "rekey room now" path and tests around removals.
- Scope native file operations more tightly. `local_lock.rs` operates on paths
  supplied by JS; prefer dialog-granted paths or an allowlist/capability model.
- Add fsync+rename durability to Enigma `local_lock.rs`, matching the stronger
  path in `crates/substrate` and `apps/enigma/src-tauri/src/keyring.rs`.
- Review all logging for passphrases, invite capabilities, tokens, DHT secrets,
  key material, and decrypted payloads. Add regression tests for redaction where
  practical.
- Document legacy Fernet/OpenSSL handling as read-only migration support and
  ensure it is not enabled in Enigma release builds by accident.

P2 documentation and test depth:

- Write a short threat model that separates confidentiality, integrity,
  authenticity, metadata privacy, local-device compromise, and malicious-room
  member assumptions.
- Document metadata leaks for iroh topics, hosted discovery, DHT room codes,
  nickname records, Tor captain topology, and file/call timing.
- Add fuzz/property tests for frame parsers, invite-ticket decoding, DHT record
  opening, and file-transfer frame handling.
- Review zeroization boundaries. Rust key paths use `zeroize` in several places,
  but webview/TypeScript plaintext and UI strings cannot provide the same memory
  guarantees.
- Add an audit appendix mapping each persisted file or keyspace to its
  encryption state, backup/recovery behavior, and deletion behavior.

### Verification Commands

Useful commands for keeping this document honest:

```bash
rg -n "MLS_128_DHKEMX25519|xchacha20-poly1305|argon2id|ChaCha20Poly1305|blake3|Fernet|csp" \
  apps rutile/crates protasius packages

cargo tree --manifest-path apps/enigma/src-tauri/Cargo.toml -i openmls --locked
cargo tree --manifest-path apps/enigma/src-tauri/Cargo.toml -i iroh --locked
cargo tree --manifest-path apps/enigma/src-tauri/Cargo.toml -i arti-client --locked
cargo tree --manifest-path apps/enigma/src-tauri/Cargo.toml -i chacha20poly1305 --locked

cargo metadata --format-version 1 --no-deps --manifest-path apps/enigma/src-tauri/Cargo.toml
npm query .workspace --json
npm audit
```

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
- **Housekeeping:** the centralization roadmap in
  [§15](#15-config--sources-of-truth).
