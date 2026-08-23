# Enigma26

A **serverless, peer-to-peer, end-to-end-encrypted chat** — a Tauri 2 + Vue 3
desktop/mobile app. There is no app server: peers meet by **sharing a QR code**
and talk directly over [iroh](https://iroh.computer) (QUIC), with all message
content encrypted by **MLS** (OpenMLS via the Rotor crate) and all local state
**encrypted at rest** behind a passphrase.

**Docs:** this README (orientation) · [build.md](build.md) (run in dev, desktop +
Android builds, CI, troubleshooting) · [technology.md](technology.md) (the deep
dive: architecture, transports, crypto, privacy posture, conventions, config
sources of truth, rework history) · [pland.md](pland.md) (the Basic / Standard /
Professional product line and how an edition is built) ·
[tools/enigma_builder/README.md](tools/enigma_builder/README.md) (the GUI/CLI
tool that configures and builds a product) · [icons.md](icons.md) (the one
shipped app mark, `sun-key2`, and how to change it).

## How it works

- **Rooms are iroh-gossip topics** (`blake3(room name)`). Creating a room mints
  a **ticket** (topic + name + your `EndpointAddr`, postcard + base32) which the
  app renders as a **QR code**.
- **Pairing**: the other person scans the QR (camera or image file) or pastes
  the ticket — both peers subscribe to the same topic and the **MLS handshake
  runs over the topic itself** (key package → welcome/commit). No server ever
  sees anything but ciphertext.
- **Reconnecting**: each peer's stable **NodeId** is persisted per room; on
  restart the app rejoins its last room and resolves current addresses through
  iroh's built-in n0 discovery — pair once, reconnect forever. Only a full cold
  start (everyone offline, all addresses changed) needs a fresh QR.
- **NAT traversal** uses iroh's public n0 relays (`RelayMode::Default`); the
  relay only ever carries MLS ciphertext.
- **Tor (optional)**: flip **"use Tor"** in Settings and rooms run over
  peer-hosted onion services — the QR then carries a `.onion`, and the relaying
  **captain** is auto-elected with failover (gold ★ in the roster; iroh is off
  while on). See [technology.md](technology.md) §11.
- **DHT discovery (optional)**: an opt-in toggle adds ticketless room joins by
  a short **room code**, plus presence and search-by-nickname in the
  **Contacts** tab (which exists either way) — all over the community-run
  BitTorrent Mainline DHT. §12.
- **Beyond chat**: 1:1 **voice calls**, P2P **file transfer**, per-file
  **local locking**, a room **calendar** (meetings + polls), and offline
  **maps** — including a location you share into a room by tapping the spot
  (never from the device's GPS). §10.
- **Build policy is compiled in**: `build_config.yaml` bakes allow flags
  (hosted relays, the DHT), per-feature kill switches (calls, contacts,
  calendar, maps, key ring, PIN unlock), crypto declarations, and setting
  defaults/clamps into the binary at build time. Which file is used is chosen
  by `ENIGMA_EDITION` — see [pland.md](pland.md) and [build.md](build.md).

| Package | What it is |
|---------|-----------|
| **[apps/enigma](apps/enigma)** | The Enigma26 app — P2P MLS chat, QR pairing, calls, files, contacts, calendar, maps. |
| **[packages/rakotis](packages/rakotis)** | Shared primitives (in-repo workspace) — UI primitives, Tauri helpers, storage, i18n, plus the P2P chat orchestration (Rotor-backed crypto bridge, transport bridge, chat-channel composable + MLS envelope state machine). |
| **Rotor** ([cryptorotor/](cryptorotor)) | The crypto layer. **Vendored in-repo** as its own nested cargo workspace: `rotor_core` (OpenMLS engine), `gervasius` (at-rest primitives), plus `rotor_wasm`/`rotor_py` bindings consumed by the sibling *toto* project. `src-tauri` consumes everything via path dependencies (no GitLab access needed to build). **All MLS crypto stays here.** |
| **[protasius/](protasius)** | The per-profile **encrypted-at-rest store** (fjall + gervasius): all app state persists as sealed values behind the launch passphrase gate. |

### Dependency layering

```
Rotor (crypto, Rust)   protasius/gervasius     iroh (P2P)  arti (Tor)
   ▲                    (at-rest, Rust)           ▲            ▲
   │  mls_* commands       ▲  vault_*/kv_*        │  realtime_*/dht_*/…
   │                       │                      │
Rakotis (non-crypto foundation + P2P chat orchestration, TS)
   ▲
   │
apps/enigma (Vue 3 UI)
```

## Layout

```
enigma/
├── package.json              # workspace root: workspaces = packages/* + apps/*
├── packages/
│   └── rakotis/              # shared primitives + P2P chat orchestration
├── apps/
│   └── enigma/               # the app (bundle id: com.spectrumaipl.enigma26)
├── cryptorotor/              # vendored crypto (Rust): rotor_core / gervasius / rotor_wasm / rotor_py
├── protasius/                # encrypted-at-rest store (Rust)
├── tools/                    # enigma_builder (configure + build) · map_packager
├── limbo/                    # parked features (restore playbook) + limbo/removed/ (records of deleted ones)
├── build.md                  # run in dev + desktop/Android build guide
├── technology.md             # architecture, crypto, privacy, conventions, config
├── run_dev.sh · run2.sh      # dev instance launchers (profile-isolated)
├── build_desktop.sh          # one-click release build
└── scripts/                  # Android toolchain + build helpers
```

Naming, colour palette, and where each config value canonically lives:
[technology.md](technology.md) §14–§15 — brand / policy / dev constants live in
[`apps/enigma/src/config/app.ts`](apps/enigma/src/config/app.ts), compile-time
build properties in
[`apps/enigma/src-tauri/build_config.yaml`](apps/enigma/src-tauri/build_config.yaml).

## Install

```bash
npm install        # once, at the repo root — sets up the workspace + all packages
```

rakotis is an in-repo workspace package (`packages/rakotis`): npm symlinks it into
the app's `node_modules`, so edits to its source are picked up immediately.

## Run (dev)

```bash
./run_dev.sh                                  # or: npm run dev
# two instances side by side (separate storage + MLS identities):
APP_PROFILE=alice CHAT_USER=alice ./run_dev.sh
APP_PROFILE=bob   CHAT_USER=bob   ./run_dev.sh
```

See [build.md](build.md) for profiles, browser-only mode, and the Android emulator.

## Build

```bash
./build_desktop.sh          # one-click: npm install + tauri release bundle
./build_desktop.sh --debug  # faster debug bundle
npm run build:android       # Android APK/AAB (SDK setup: build.md)

# piecemeal:
npm run build -w rakotis    # vue-tsc typecheck
npm run build -w enigma     # vue-tsc + vite build (frontend)
( cd apps/enigma/src-tauri && cargo build )
```

## Test

```bash
npm test                    # all workspaces
npm test -w rakotis         # transport bridge, storage, i18n, localDb
npm test -w enigma          # chat store bootstrap, components, i18n
( cd apps/enigma/src-tauri && cargo test )   # tickets, DHT, Tor, kv, maps, …
python apps/enigma/e2e.py   # Playwright smoke tier (no backend — there is none)
```

## Pairing quick-start

1. **A**: Chat → *New chat* → name it → **Create**. A modal spins up the room,
   then shows **You're the room host** with the QR to share (gold ★ host badge
   over Tor). Every saved room keeps a **QR** button to reopen its code later.
2. **B**: Chat → *Join a chat* → scan the QR (camera / image) or paste the ticket.
3. Both sides show **Encrypted** once the MLS handshake completes — that's it.
   From now on the app reconnects automatically; no server, no accounts.
