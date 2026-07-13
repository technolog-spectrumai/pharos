# Enigma

A **serverless, peer-to-peer, end-to-end-encrypted chat** — a Tauri 2 + Vue 3
desktop/mobile app. There is no app server: peers meet by **sharing a QR code**
and talk directly over [iroh](https://iroh.computer) (QUIC), with all message
content encrypted by **MLS** (OpenMLS via the Rotor crate).

> This repo used to be a three-app monorepo (Enigma / Enigma+ / Aurora) with a
> server relay. The serverless rework is documented in
> [serverless_plan.md](serverless_plan.md); voice calls and file transfer are
> parked in [limbo/](limbo/README.md).

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
- **Tor**: an embedded Arti client ships as plumbing for a future
  peer-to-peer onion transport — see `TODO(onion-p2p)` in
  `apps/enigma/src-tauri/src/tor.rs`.

| Package | What it is |
|---------|-----------|
| **[apps/enigma](apps/enigma)** | The app — P2P MLS chat, QR pairing, voice/image messages. |
| **[packages/rakotis](packages/rakotis)** | Shared primitives (in-repo workspace) — UI primitives, Tauri helpers, storage, kv cache, i18n, plus the P2P chat orchestration (Rotor-backed crypto bridge, iroh transport bridge, chat-channel composable + MLS envelope state machine). |
| **Rotor** ([CryptoRotor](https://gitlab.com/janhagit-group/cryptorotor)) | The crypto layer (OpenMLS). Lives in its own repository; consumed from Rust as a pinned cargo git dependency (see `apps/enigma/src-tauri/Cargo.toml`). **All MLS crypto stays here.** |

### Dependency layering

```
Rotor (crypto, Rust)          iroh (P2P transport, Rust)
   ▲                              ▲
   │  mls_* Tauri commands        │  realtime_* Tauri commands
   │                              │
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
│   └── enigma/               # the app (bundle id: com.spectrumaipl.enigma)
├── limbo/                    # parked features (voice calls, file transfer)
├── serverless_plan.md        # the rework plan/record
├── run_dev.sh                # launch a dev instance with a profile
├── build_desktop.sh          # one-click release build
└── scripts/                  # Android build helpers
```

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

## Build

```bash
./build_desktop.sh          # one-click: npm install + tauri release bundle
./build_desktop.sh --debug  # faster debug bundle
npm run build:android       # Android APK/AAB (see build_android.md for SDK setup)

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
( cd apps/enigma/src-tauri && cargo test )   # ticket round-trip, kv, …
python apps/enigma/e2e.py   # Playwright smoke tier (no backend — there is none)
```

## Pairing quick-start

1. **A**: Chat → *New chat* → name it → **Create**. A QR code appears.
2. **B**: Chat → *Join a chat* → scan the QR (camera / image) or paste the ticket.
3. Both sides show **Encrypted** once the MLS handshake completes — that's it.
   From now on the app reconnects automatically; no server, no accounts.