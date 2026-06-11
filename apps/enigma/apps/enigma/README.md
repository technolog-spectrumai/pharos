# Enigma

The **secure-communication** app of the [workspace](../../README.md). Enigma is
chat and real-time media only — the data workspace lives in
[Aurora](../aurora).

## Features

- **Relay chat** — MLS-encrypted group messaging over the toto telegraph WebSocket.
- **P2P chat** — peer-to-peer rooms over iroh (QUIC), MLS-encrypted, no server.
- **Voice calls (Vox)** — real-time 1:1 voice over iroh, keyed by an MLS-exported secret.
- **Voice + image messages** in both relay and P2P chats.
- **P2P file transfer** and a **CRDT data-sync** channel (ride the P2P MLS group).
- Login, settings and profile screens; embedded Tor for `.onion` servers.

Tabs in `/chat`: Forum (relay) · P2P · Vox · Sync · Files. `/` redirects to `/chat`.

## Shared code

- **[euclid](../../packages/euclid)** — UI primitives, WS client, `ApiBase` (Enigma's `api` adds the chat-media uploads), storage, kv cache, i18n.
- **[rakotis](../../packages/rakotis)** — the chat channel + MLS envelope state machine. Enigma runs both a `relay` and a `p2p` channel.
- **Rotor** (`../../../toto/rotors/rotor_core`) — OpenMLS crypto, consumed from `src-tauri`.

The Rust backend (`src-tauri/`) keeps the full comms stack: `mls_*` (Rotor-backed),
relay WebSocket + iroh P2P (`realtime`/`p2p_iroh`), `vox`, `file_xfer`, `y_store`,
the HTTP gateway, embedded Tor and kv.

## Run

```bash
# from the workspace root (edge/)
npm install

# desktop — APP_PROFILE isolates storage, CHAT_USER is the MLS identity
APP_PROFILE=alice CHAT_USER=alice npm run tauri dev -w enigma
# or, from the root:  ./run_dev.sh

# two instances side by side
APP_PROFILE=alice CHAT_USER=alice npm run tauri dev -w enigma
APP_PROFILE=bob   CHAT_USER=bob   npx -w enigma tauri dev --no-dev-server

# browser (MLS disabled → plaintext relay chat; P2P/voice are desktop-only)
npm run dev -w enigma     # http://localhost:1420
```

## Build / test

```bash
npm run build -w enigma                 # vue-tsc + vite
( cd src-tauri && cargo build )         # Rust
npm test -w enigma                      # vitest
```

Android build helpers live in the workspace `scripts/` directory; see
[build_android.md](../../build_android.md).
