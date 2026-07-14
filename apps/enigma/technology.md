# Enigma — Technology Overview

A technical deep-dive into how Enigma works: its design, stack, dependencies,
communication flow, cryptography, privacy posture, and known weaknesses. For build
and run instructions see [build.md](build.md) / [dev_manual.md](dev_manual.md); for
the rework history see [serverless_plan.md](serverless_plan.md).

> **Status:** early-stage (`v0.1.0`). The cryptography is production-grade (OpenMLS),
> but several integration-level hardening items remain open — see
> [Security & privacy considerations](#9-security--privacy-considerations) and
> [Roadmap](#roadmap). This document is candid about them on purpose.

---

## 1. Design

Enigma is a **serverless, peer-to-peer, end-to-end-encrypted chat**, packaged as a
[Tauri 2](https://tauri.app) desktop/mobile app (Vue 3 frontend + Rust backend).

Design principles:

- **No app server.** There is no relay WebSocket, no REST gateway, no login, no
  server-side directory. Enigma operates no backend of its own. (This is *not* the
  same as "no infrastructure" — see [§6](#6-is-it-truly-p2p-intermittent-nodes).)
- **Rendezvous by QR code.** Two people meet when one shares a QR code carrying the
  room's *ticket*; scanning it (camera or image) or pasting it joins the room.
- **Pair once, reconnect forever.** After the one-time QR pairing, each peer's stable
  NodeId is persisted per room and re-resolved through iroh's discovery when
  addresses change — no fresh QR needed on reconnect.
- **End-to-end encryption by default.** All message content is encrypted with **MLS**
  (Messaging Layer Security, RFC 9420) via OpenMLS. The crypto layer never leaves the
  device.
- **Local-first identity.** Identity is a locally stored profile — no accounts, no
  PKI, no phone number. `APP_PROFILE` isolates storage; `CHAT_USER` sets the MLS
  identity, so multiple instances can run side-by-side.

### Layered architecture

```
┌───────────────────────────────────────────────────────────────┐
│  apps/enigma/src  (Vue 3 UI: Chat + Settings, QR create/scan)  │
├───────────────────────────────────────────────────────────────┤
│  packages/rakotis (TS)                                          │
│   • useChatChannel — MLS envelope state machine / orchestration │
│   • chatTransport  — iroh transport bridge                      │
│   • crypto         — bridge to the mls_* Tauri commands         │
│   • services       — appStorage, localDb (kv), i18n             │
├───────────────────────────────────────────────────────────────┤
│  Tauri IPC  (invoke commands + realtime://* events)            │
├───────────────────────────────────────────────────────────────┤
│  apps/enigma/src-tauri  (Rust)                                  │
│   • p2p_iroh.rs  — iroh-gossip transport (default)              │
│   • p2p_tor.rs   — peer-hosted Tor onion transport (opt-in)     │
│   • realtime.rs  — realtime_* gateway (offline-gated, dispatch) │
│   • lib.rs       — mls_* commands, state persistence, audio     │
│   • kv.rs (fjall) · fs_local.rs · tor.rs (outbound Arti client) │
├──────────────────────────┬────────────────────────────────────┤
│  cryptorotor/rotor_core  │  iroh 0.98 + iroh-gossip 0.98        │
│  (OpenMLS, path dep)     │  (QUIC P2P, n0 relay + discovery)    │
└──────────────────────────┴────────────────────────────────────┘
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
| P2P transport | iroh 0.98 (QUIC endpoint, NodeId identity, NAT traversal) + iroh-gossip 0.98 (topic broadcast); **or** peer-hosted Tor onion services (opt-in) |
| Cryptography | OpenMLS 0.7 (RFC 9420 MLS) via the vendored `rotor_core` crate |
| Local storage | fjall (pure-Rust LSM key/value store); JSON profile state; OS app-data dir |
| Media capture | cpal (microphone) + hound (WAV) for native voice notes |
| Tor (opt-in transport) | arti-client 0.43 `onion-service-service` — peer-hosted onion transport (`p2p_tor.rs`); the "use Tor" switch routes rendezvous + chat over it (star topology) |
| Build/CI | `build_desktop.sh` one-click; GitLab CI (`.gitlab-ci.yml`); Node 22 |

Rust backend crate: `enigma` → `enigma_lib` (`staticlib`/`cdylib`/`rlib`). Bundle
identifier `com.spectrumaipl.enigma`. The tauri.conf `targets: "all"` governs the
desktop bundle formats (Linux `.deb`/`.AppImage`/`.rpm`); Android APK/AAB are produced
by the separate `scripts/build_android.sh` path.

---

## 3. Dependencies & libraries

Versions are the declared spec (resolved pins live in `apps/enigma/src-tauri/Cargo.lock`,
which is gitignored, and `cryptorotor/Cargo.lock`, which is committed).

### Rust backend (`apps/enigma/src-tauri/Cargo.toml`)

| Crate | Ver | Role |
|---|---|---|
| `tauri` (+ `tauri-plugin-opener`/`-dialog`/`-notification`) | 2 | App framework, IPC, bundler, OS integration |
| `rotor-core` | path | MLS crypto engine (vendored `cryptorotor/rotor_core`) |
| `iroh` | 0.98 | QUIC P2P endpoint, NodeId identity, n0 relay + discovery |
| `iroh-gossip` | 0.98 | Epidemic broadcast over a topic (one room = one topic) |
| `postcard` | 1 | Serialize the pairing `Ticket` |
| `blake3` | 1 | Topic id = `blake3(room name)` |
| `data-encoding` | 2 | BASE32 (no-pad) ticket text encoding |
| `bytes`, `futures-lite`, `anyhow` | — | Gossip stream plumbing, error handling |
| `arti-client`, `tor-rtcompat` | 0.43 | Embedded Tor: outbound client (`tor.rs`) **and** `onion-service-service` hosting for the onion transport (`p2p_tor.rs`) |
| `tor-hsservice`, `tor-cell`, `safelog` | 0.43 / 0.8 | Onion-service hosting types (launch/config, accept relay cell, unredacted `.onion` display) |
| `hyper`, `hyper-util`, `http-body-util`, `tokio-rustls` | — | HTTP-over-Tor plumbing (outbound `tor.rs` client only) |
| `tokio` | 1 | Async runtime |
| `cpal` | 0.15 | Microphone capture (native voice notes) |
| `hound` | 3 | WAV encoding of recordings |
| `fjall` | 2 | Local key/value cache (pure-Rust LSM; avoids a second SQLite link) |
| `zeroize` | 1 | Wipe plaintext/state buffers in RAM |
| `serde`/`serde_json`, `uuid` | — | Serialization, ids |
| `webkit2gtk` (Linux), `rusqlite` bundled (Android) | — | Platform-specific glue |

### Crypto workspace (`cryptorotor/`, vendored at tag `v0.1.0`)

Three crates (`rotor_wasm` and `rotor_py` depend on `rotor_core` by path):

- **`rotor_core`** — the MLS engine (`RotorSession`). `openmls =0.7.4`,
  `openmls_rust_crypto =0.4.4`, `openmls_basic_credential =0.4.1`,
  `openmls_traits =0.4.1`, `tls_codec 0.4`, `zeroize`.
- **`rotor_wasm`** — `wasm-bindgen` browser bindings (`WasmRotorSession`); built with
  wasm-pack. Used by the sibling *toto* project, not by enigma. (See [Roadmap](#roadmap).)
- **`rotor_py`** — PyO3/maturin Python bindings for toto's Django side.

### Frontend (`apps/enigma/package.json` + `packages/rakotis`)

**Used at runtime:** `vue` 3.5, `vue-router` 5 (`createMemoryHistory`), `pinia`
(one store), `vue-i18n` 9 (en/pl), `tailwindcss` 4, `@fortawesome/*`,
`@tauri-apps/api` 2, `qrcode` (generate ticket/NodeId QR), `html5-qrcode` (scan),
`nanoid` (message ids), and the in-repo `rakotis` workspace package.

**Dormant / carried from the earlier multi-app codebase (declared but unused by this
app):** `cytoscape`, `leaflet`, `ace-builds` (+ their `@types`), and the JS bindings
`@tauri-apps/plugin-{dialog,notification,opener}` (the corresponding Rust plugins are
registered, but nothing on the JS side imports them). These are dead weight worth
pruning.

---

## 4. Architecture & communication flow

### The seams

The frontend talks to Rust through two mechanisms, both guarded by an `isTauri()`
runtime check (in a plain browser there is no backend — chat is inert by design):

- **`invoke` (commands):** `realtime_*` (transport — dispatched to iroh or Tor),
  `mls_*` (crypto), `app_*` (profiles/runtime/airplane/**use-Tor**), `kv_*` (local
  cache), `audio_*` (recording), `fs_*` (local file IO).
- **Events (`listen`):** `realtime://message` `{room, payload}` and
  `realtime://status` `{room, state, peer_id?}`. `chatTransport` registers these once
  and fans them out to per-room handlers in `useChatChannel`.

### Sending a text message (outbound)

```
ChatPanel.send(text)
  → useChatChannel.sendMessage(text)
      if MLS ready:  cryptoService.encrypt → mls_encrypt (Rust) → ciphertext
                     wrap as {type:"mls_app", ciphertext:<base64>, sender fields}
      → chatTransport.send(slug, payload)
          → invoke("realtime_send", {room, payload: JSON.stringify(...)})
              → Rust realtime_send (offline-gated)
                  → p2p_iroh::broadcast → published on the iroh-gossip topic
```

### Receiving (inbound)

```
p2p_iroh receive loop  → emit realtime://message {room, payload}
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

### Persistence

- **MLS session state** → `profiles/<profile>/mls_<room>_<identity>.bin` (one file
  per session, rewritten after every MLS operation).
- **iroh transport key** → `iroh_gossip.key` (32 raw bytes; the stable NodeId).
- **Saved rooms** → fjall kv namespace `p2p:rooms` as `{room, name, ticket, peers[]}`
  — `peers[]` is the persisted NodeId address book that powers ticketless reconnect.
- **Profile / PII** → `profiles/<profile>/profile_state.json`.

---

## 5. Routing & transport

The only transport is **iroh-gossip over QUIC**. There is no WebSocket, no HTTP data
path (the server relay and REST gateway were removed in the serverless rework).

- **Endpoint.** A single process-global iroh `Endpoint` is built with `presets::N0` +
  `RelayMode::Default`, i.e. iroh's built-in **n0 public relays and n0 discovery**
  (pkarr-style signed DNS records). Identity is a stable Ed25519 `SecretKey` →
  **NodeId**. The gossip router accepts a single ALPN (iroh-gossip's `GOSSIP_ALPN`).
- **Room → topic.** `topic = blake3(room_name)` — a deterministic 32-byte id, with
  **no salt and no secret**. The room name is the only thing gating topic membership.
- **Ticket / QR.** `Ticket { topic, name, peers: Vec<EndpointAddr> }` is
  `postcard`-serialized then BASE32-encoded (lowercased). That string **is** the QR
  payload. It contains the topic, the **plaintext room name**, and the creator's
  `EndpointAddr` (NodeId + relay URL + socket addresses).
- **Connecting.** `create_room` subscribes with no bootstrap; `join_room` seeds the
  ticket peers' addresses into a manual lookup and bootstraps from their NodeIds;
  `join_room_by_node` is ticketless (addresses resolved purely via discovery). iroh
  then dials over QUIC, **hole-punching directly where possible and falling back to
  relaying through an n0 relay** when direct connectivity fails. iroh-gossip forms an
  epidemic mesh swarm over the topic.
- **Gossip frame size.** Raised to **16 MiB** so an entire MLS-encrypted image or
  voice note fits in a single broadcast (no chunking).
- **Reconnection.** Neighbor-up gossip events carry the peer's NodeId (`peer_id` on
  `realtime://status`); it is persisted per room. On next launch the app re-opens the
  most-recent room, reusing the saved ticket but seeding the saved NodeIds so
  discovery re-resolves current addresses. There is no app-level retry/backoff loop —
  reconnection relies on iroh's swarm maintenance and discovery freshness.
- **Airplane mode.** A per-profile `offline` flag tears down the endpoint
  (`endpoint.close()`, stops discovery publishing) and every network-touching
  `realtime_*` command refuses while set (`realtime_leave_room` is the one exempt
  command). This is a **cooperative app-level gate**, not an OS firewall.

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
may fail to connect and ticketless reconnect breaks. The relay/discovery operators (or
a network observer) can build a who-talks-to-whom metadata graph even though they
never see plaintext. This n0 metadata exposure applies **only on the default iroh
transport**; flipping **"use Tor"** on routes rendezvous + chat over peer-hosted
onion services instead, which hides the NodeId↔IP graph from n0 (at the cost of
Tor's own latency and a creator-as-host single point of failure).

Topology is **1:1 / small "star" rooms** on both transports; over Tor the room
creator is the onion host + relay. Group scale (gossip fan-out + the naive admin
election) is explicitly unverified for large groups.

---

## 7. Encryption & algorithms

### The MLS engine (`rotor_core`)

All content encryption is **MLS (RFC 9420)** via OpenMLS, wrapped by `RotorSession`.
The single hardcoded ciphersuite is:

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
- **Storage provider:** OpenMLS `MemoryStorage` (in-RAM), serialized to disk by the
  app after each operation.

### RotorSession API → `mls_*` commands

`create_group` / `key_package` / `add_member` (→ welcome+commit) / `join_from_welcome`
/ `process_message` / `encrypt_app` / `members` (authenticated roster) / `remove_member`
/ `export_secret` (RFC 9420 exporter — present but unused by the shipping chat) /
`export_state` + `import_state` (serializable session).

### What is encrypted

- **Text** → `mls_encrypt` → `mls_app` frame.
- **Images** → downscaled client-side to ≤1600 px JPEG (q 0.85), embedded as a base64
  data-URL inside an encrypted `image_message`.
- **Voice notes** → native cpal capture → hound WAV → encrypted `voice_message`.
- **Presence, leave, and control messages** → encrypted inner JSON over the same group.

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
| Metadata to n0 relays/discovery | **Exposed on iroh:** NodeId↔IP, who-talks-to-whom, timing, sizes, online presence. Avoided when "use Tor" is on. |
| QR ticket contents | iroh: leaks the **plaintext room name** + the creator's **NodeId + IP addresses**. Tor: leaks the room name + the creator's `.onion` (no IP). |
| Topic secrecy | `topic = blake3(name)` — anyone who knows/guesses the room name can join. |
| Local at-rest | **Plaintext on disk** — no encryption/passphrase/keychain (see below). |
| Metadata protection (Tor) | **Available, opt-in** — the "use Tor" switch routes rendezvous + chat over peer-hosted onion services (`p2p_tor.rs`); off by default. |

**Local at-rest storage is entirely plaintext** under the OS app-data dir: the iroh
private key (`iroh_gossip.key`), the full MLS session state including the private
signing key and epoch/ratchet secrets (`mls_*.bin`), profile PII
(`profile_state.json`), saved tickets + peer NodeIds (fjall `kvstore`), and — when
the Tor transport is used — the hidden-service identity key in arti's per-profile
keystore (`profiles/<profile>/tor/state/`), which is what keeps the `.onion`
stable across restarts. `zeroize`
scrubs only transient RAM buffers; the disk copies are not encrypted, and `wipe_file`
is a best-effort single-pass overwrite (not a secure erase on SSD/journaling
filesystems). Anyone with read access to the profile directory can decrypt current
messages and impersonate the identity.

---

## 9. Security & privacy considerations

Enigma's cryptographic core (OpenMLS) is solid; the current weaknesses are almost all
at the **integration layer**. Documented candidly here (roughly most- to
least-serious) so they can be addressed:

1. **Plaintext local storage.** Keys, full MLS state (with private keys), PII, and
   tickets are stored unencrypted (see [§8](#8-privacy)). Local device compromise =
   full identity + message-confidentiality compromise. → *Encrypt at rest (OS keychain
   / passphrase-derived key); secure-wipe on delete.*
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
   so the lock indicator can show "encrypted" for a group-of-one. Also, the displayed `sender_name` is an
   attacker-controllable field, not the MLS-authenticated identity.
6. **Metadata exposure to n0 infrastructure** — NodeId social graph, IPs, timing, and
   presence (see [§6](#6-is-it-truly-p2p-intermittent-nodes)). Not mitigated today.
7. **Weak transport-level room access control.** `topic = blake3(name)` with no
   secret; low-entropy names are trivially derived, letting anyone who knows the name
   join the swarm and attempt to be added to the MLS group.
8. **WebView / IPC surface.** `tauri.conf.json` sets `security.csp = null` (no Content
   Security Policy); on Linux the app auto-grants every WebView permission request; and
   `fs_read_text_file` / `fs_write_text_file` are invokable with **unrestricted
   absolute paths** (no scope/allowlist). → *Add a CSP, gate permission requests, and
   scope or remove the raw FS commands.*
9. **`tor.rs` clearnet-TLS footgun.** `tor.rs` (the outbound Arti client, separate
   from the `p2p_tor.rs` onion transport) contains an `AcceptAnyServerCert` TLS
   verifier (no name/CA validation) reachable via a `pub(crate)` clearnet helper.
   Safe for onion use (the `.onion` self-authenticates) but a MITM trap if ever
   reused on clearnet. Currently unused. (The onion transport carries plaintext
   frames over the Tor circuit — no TLS — so it doesn't touch this verifier.)
10. **Minor:** `openmls_rust_crypto` is built with the `test-utils` feature in
    production; the untested orchestration core (`useChatChannel`/`crypto` have no unit
    tests); 16 MiB gossip frames are an amplification consideration.

---

## 10. User interface

A two-screen app (memory-history router, no URL bar):

- **Chat** (`EnigmaChatView` / `ChatPanel`) — a responsive 3-column layout at desktop
  width (rooms sidebar · conversation · participants), collapsing to a hamburger drawer
  on mobile. It hosts:
  - **Create room → QR:** the rooms sidebar's **"New chat"** button opens
    `CreateRoomModal` — name a room, a spinner covers the onion/iroh launch, then the
    ticket renders as a QR (via `qrcode`) + copyable text with a "you're the host" badge
    (gold ★ over Tor).
  - **Join:** the **"Join a chat"** button opens `JoinRoomModal` — paste a ticket,
    **scan a QR with the camera**, or **upload a QR image** (both via `html5-qrcode`);
    a spinner runs through connecting → "encryption active" (waits for MLS). The window
    waits the user-set **connection timeout** (N s) for the connect, then stays one more
    interval with a countdown so the outcome can be read (≤ 2×N total; a hung Tor dial
    is aborted so a retry launches cleanly). Each saved
    room row also has a QR button (`RoomInfoModal`) that re-opens its ticket + host badge.
  - **Compose:** text (Enter to send), image attachments (with preview), voice notes
    (native recording in the app on desktop and mobile, `MediaRecorder` only in a plain
    browser), and an emoji picker.
  - **Status chips:** an MLS lock/encryption badge and a connection-state indicator,
    plus a "reset encryption" action.
- **Settings** (`EnigmaConfigView`) — three tabs: **Profile** (local-only display
  name, email, phone, DOB, bio; multiple named profiles), **Settings** (language en/pl;
  a "My identity" card showing the NodeId as text + QR; a **"Route over Tor"** switch;
  a **"Connection timeout"** field — seconds a room create/join may take, also the join
  window's read countdown), and **Data** (airplane/offline toggle; local data-profile loader).

Styling is Tailwind v4 with a small in-repo "Oya" component kit (button, card). It is
CSS-first: the design-token palette lives in the `@theme` block of
`apps/enigma/src/style.css` (`--color-<role>` tokens), including the gold
`--color-highlight` (`#facc15`) used for the host/captain ★ marker — see
[CONVENTIONS.md](CONVENTIONS.md) for the full palette + naming reference.
Dark mode defaults on but is not persisted across launches; locale is persisted.

---

## Roadmap

Planned/known future work — the canonical trackers are [todo.md](todo.md),
[serverless_plan.md](serverless_plan.md), and (for the Tor transport) [tor.md](tor.md).
Kept intentionally short:

- **`rotor_wasm` → toto artifact handoff** *(top priority — [todo.md](todo.md) #1).*
  Enigma is now the single home of CryptoRotor; enigma CI should build `rotor_wasm`
  (wasm-pack web + bundler) and publish it as an artifact so the *toto* project stops
  building its own copy.
- **✅ Peer-to-peer over Tor (`onion-p2p`) — done.** arti onion-service hosting,
  a per-profile hidden service, a Tor transport carrying the same frames, and a
  `.onion`-bearing QR, behind the "use Tor" switch (star topology). See
  [tor.md](tor.md). Multi-peer mesh-over-Tor remains out of scope.
- **Captain election for the onion host.** The Tor host is currently the room
  creator, hardcoded — a single point of failure. Elect it automatically (e.g.
  lowest NodeId) with failover.
- **Accepted limitations (deferred):** the cold-start edge case (if every member is
  offline long enough for discovery records to lapse *and* all addresses change, a
  fresh QR is needed) and group-scale hardening (gossip fan-out + a real leader
  election instead of the lexicographic rule).

Security hardening items (at-rest encryption, key-fingerprint verification, removing
the pre-MLS plaintext window, CSP, FS-command scoping) are enumerated in
[§9](#9-security--privacy-considerations) and are the recommended pre-production work.
