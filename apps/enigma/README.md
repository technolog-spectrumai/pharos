# Enigma

A cross-platform desktop chat client with end-to-end encryption via MLS (Messaging Layer Security). Built with Tauri (Rust) + Vue 3.

## Overview

Enigma connects to an Enigma API server and provides real-time encrypted group messaging. Cryptographic operations run in Rust via the Tauri backend; the Vue 3 frontend handles UI and state.

## Tech Stack

- **Frontend:** Vue 3, TypeScript, Pinia, Vue Router, TailwindCSS v4
- **Backend:** Tauri v2, Rust
- **Crypto:** `enigma-core` (local crate), MLS protocol
- **Build:** Vite, Cargo

## Prerequisites

- Node.js + npm
- Rust + Cargo
- An Enigma API server

## Running

Install dependencies once:

```bash
cd enigma
npm install
```

Start a single instance:

```bash
APP_PROFILE=alice CHAT_USER=alice npm run dev:tauri
```

Run two instances in parallel (for local testing):

```bash
# Terminal 1
APP_PROFILE=alice CHAT_USER=alice cargo tauri dev

# Terminal 2
APP_PROFILE=bob CHAT_USER=bob cargo tauri dev --no-dev-server
```

## Environment Variables

| Variable | Purpose |
|---|---|
| `APP_PROFILE` | Namespace for local storage (e.g. `alice`, `bob`) |
| `CHAT_USER` | Default MLS cryptographic identity |

Each profile stores its data independently under `app_data_dir/profiles/{APP_PROFILE}/`.

## Building

```bash
npm run build       # TypeScript check + Vue build
cargo tauri build   # Package desktop app
```

## Features

- Multi-room chat with participant lists
- End-to-end encryption (MLS group messaging)
- WebSocket real-time updates with exponential backoff reconnection
- Multiple isolated profile support — run separate instances without restarting
- QR code scanner for server URL configuration
- Offline profile data (display name, bio, etc.) persisted per profile
- Dark/light mode

## Project Structure

```
enigma/
├── src/                  # Vue 3 frontend
│   ├── views/            # Page-level components (Login, Chat, Profile, Config)
│   ├── stores/           # Pinia stores (chat, user)
│   ├── services/         # API client, WebSocket, crypto bridge, storage
│   └── components/       # Reusable UI components
└── src-tauri/            # Rust/Tauri backend
    └── src/
        ├── main.rs       # Entry point, reads env vars
        └── lib.rs        # AppConfig, profile state, MLS session management
```

## Message Types

| Type | Description |
|---|---|
| `chat_message` | Plaintext message |
| `mls_app` | MLS-encrypted message |
| `image_message` | Base64 image (relayed via HTTP upload API) |
| `voice_message` | Base64 audio/webm (relayed via HTTP upload API) |
| `mls_welcome` / `mls_commit` | MLS group management |
| `system_info` / `system_error` | Server notifications |

## Screens

| Screen | Route | Backed by |
|--------|-------|-----------|
| Chat | `/chat` | `toto.telegraph` WebSocket + MLS |
| Notes | `/notes` | `toto.bento` JSON API |
| Storage | `/vault` | `toto.vault` JSON API |
| Tasks | `/tasks` | `toto.kanban` JSON API |
| Locations | `/locations` | `toto.locations` JSON API |
| People | `/people` | `toto.socialhub` JSON API |
| Wallet | `/wallet` | `toto.assets` + `toto.tariffs` + `toto.invoice` JSON API |

## Voice Recording

Click the microphone button in the chat composer to start recording. A pulsing timer shows elapsed time. Click again (stop button) to send the recording as an audio message. Rendered as `<audio controls>` in the message list for all participants.
