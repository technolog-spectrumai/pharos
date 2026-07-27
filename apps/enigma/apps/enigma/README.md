# Enigma

The serverless **P2P chat** app of the [workspace](../../README.md). One chat
surface, no server, no accounts — see [technology.md](../../technology.md) §16
for the rework record.

## Features

- **P2P chat** — peer-to-peer rooms over iroh (QUIC), MLS-encrypted, no server.
- **QR pairing** — a room's ticket is rendered as a QR code; join by camera
  scan, QR image upload, or pasting the ticket.
- **Pair once, reconnect forever** — peer NodeIds are persisted per room and
  re-resolved via iroh's n0 discovery; the app reopens your last room on start.
- **Voice + image messages** — sent inline over the MLS group.
- **Local profiles** — identity is a locally-stored profile (`APP_PROFILE` /
  `CHAT_USER` isolate storage + MLS identity per instance).
- **Route over Tor (optional)** — a "use Tor" switch hosts a per-profile onion
  service; the QR carries a `.onion` and chat rides Tor (star topology: creator
  hosts + relays). Backend in `src-tauri/src/p2p_tor.rs`; see
  [technology.md](../../technology.md) §11.

- **Vox (1:1 voice calls)** — `/vox`, riding the main iroh endpoint on its own
  ALPN; start from a ticket/QR, a room member, or (where the build has the DHT)
  a nickname. Backend in `src-tauri/src/vox.rs`.
- **P2P file transfer** — offer/accept with progress, on the Files tab.

Which of these a given binary actually contains is decided at **compile time**
by the edition config — see [pland.md](../../pland.md). The Kanban, Sketch and
Mind workspaces are parked in [limbo/](../../limbo/README.md).

## Shared code

- **[rakotis](../../packages/rakotis)** — shared primitives: UI components,
  Tauri helpers, storage, kv cache, i18n, plus the chat channel + MLS envelope
  state machine and the iroh transport bridge.
- **Rotor** ([cryptorotor/rotor_core](../../cryptorotor/rotor_core)) — OpenMLS
  crypto, vendored in-repo and consumed from `src-tauri` via a path dependency.

The Rust backend (`src-tauri/`) keeps: `mls_*` (Rotor-backed), the P2P gateway
(`realtime.rs` dispatching to `p2p_iroh.rs` or the Tor onion transport
`p2p_tor.rs`), the outbound Arti client (`tor.rs`), native voice-note recording,
the fjall kv cache, and local file IO.

## Run

```bash
# from the workspace root
npm install
./run_dev.sh

# two instances side by side — APP_PROFILE isolates storage, CHAT_USER is the MLS identity
APP_PROFILE=alice CHAT_USER=alice ./run_dev.sh
APP_PROFILE=bob   CHAT_USER=bob   ./run_dev.sh
```

P2P requires the Tauri runtime (desktop/Android); the plain-browser build
(`npm run dev -w enigma`) renders the shell only.

## Build / test

```bash
../../build_desktop.sh                  # one-click release bundle (from anywhere)
npm run build -w enigma                 # vue-tsc + vite
( cd src-tauri && cargo build )         # Rust
npm test -w enigma                      # vitest (unit/component)
python e2e.py                           # Playwright smoke tier (no backend)
```

Android build helpers live in the workspace `scripts/` directory; see
[build.md](../../build.md). The Android manifest declares
CAMERA (QR scan) and RECORD_AUDIO (voice notes).
