# Aurora

The **data-workspace** app of the [workspace](../../README.md): dashboard, files/
storage, tasks/missions, locations, people and events over the toto Django
backend — **plus MLS-encrypted relay chat over WebSocket**.

Aurora's chat is **relay only**: it uses MLS where supported (desktop) and the
toto telegraph WebSocket relay as the sole transport. There is **no P2P/WebRTC and
no voice calls**. Async **voice messages** (recorded clips) and images are
supported in chat.

## Screens

| Screen | Route | Backed by |
|--------|-------|-----------|
| Dashboard | `/` | aggregated module counts |
| Chat (relay) | `/chat` | `toto.telegraph` WS + MLS (desktop) / plaintext (browser) |
| Files | `/vault` | `toto.vault` (nav label “Files”) |
| Tasks | `/tasks` | `toto.kanban` |
| Locations | `/locations` | `toto.locations` + OpenStreetMap |
| People | `/people` | `toto.socialhub` |
| Events | `/events` | `toto.events` |

## Shared code

Aurora composes the shared packages:

- **[euclid](../../packages/euclid)** — UI primitives, WS client, `ApiBase`, storage, kv cache, i18n. Aurora's `api` (with the data-workspace endpoints) extends `ApiBase`.
- **[rakotis](../../packages/rakotis)** — the relay chat channel (`useChatChannel("relay", api)`). Aurora never instantiates a P2P channel.

The Rust backend (`src-tauri/`) is the **relay-only subset**: app/profile config +
Rotor-backed `mls_*` + the HTTP data gateway + relay WebSocket + embedded Tor + kv
+ the `y_store` CRDT cache. It omits `p2p_iroh`, `vox` and `file_xfer`.

## Run

```bash
# from the workspace root (enigma/)
npm install

# desktop
APP_PROFILE=alice CHAT_USER=alice npm run tauri dev -w aurora

# browser (MLS disabled → plaintext chat)
npm run dev -w aurora
```

## Build / test

```bash
npm run build -w aurora                 # vue-tsc + vite
( cd src-tauri && cargo build )         # Rust
npm test -w aurora                      # vitest
```
