# Enigma

The serverless **P2P chat** app of the [workspace](../../README.md). One chat
surface, no server, no accounts — see [serverless_plan.md](../../serverless_plan.md)
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
- **Embedded Tor (plumbing)** — kept for a future peer-to-peer onion transport
  (`TODO(onion-p2p)` in `src-tauri/src/tor.rs`).

Voice calls (Vox) and P2P file transfer are parked in
[limbo/](../../limbo/README.md).

## Shared code

- **[rakotis](../../packages/rakotis)** — shared primitives: UI components,
  Tauri helpers, storage, kv cache, i18n, plus the chat channel + MLS envelope
  state machine and the iroh transport bridge.
- **Rotor** ([CryptoRotor](https://gitlab.com/janhagit-group/cryptorotor)) —
  OpenMLS crypto, consumed from `src-tauri` as a pinned cargo git dependency.

The Rust backend (`src-tauri/`) keeps: `mls_*` (Rotor-backed), the iroh P2P
gateway (`realtime.rs`/`p2p_iroh.rs`), native voice-note recording, the fjall
kv cache, local file IO, and the (currently unused) Arti Tor client.

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
[build_android.md](../../build_android.md). The Android manifest declares
CAMERA (QR scan) and RECORD_AUDIO (voice notes).
