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
# from the workspace root (edge/)
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
npm test -w aurora                      # vitest (unit/component/integration)
```

## End-to-end (`e2e.py`)

`e2e.py` is the CI/CD-ready end-to-end runner. It spins up the toto backend in
Docker, waits for it to be reachable, seeds a test user + chat room (User →
Person → active TelegraphMember), and runs the Playwright suite against the built
bundle:

- **smoke** tier — always runs, backend stubbed (router, i18n, data-workspace nav);
- **live** tier — runs when a backend is available: telegraph reachability, real
  UI login (token stored end-to-end), authenticated data-workspace + chat UI, and
  a **relay-chat round-trip over the WebSocket** (a sent message is echoed back).

```bash
python apps/aurora/e2e.py                 # Docker backend → live + smoke, then tears down
python apps/aurora/e2e.py --keep-up       # leave the stack running afterwards
python apps/aurora/e2e.py --no-backend    # stubbed smoke tier only (no Docker)
E2E_SERVER=https://localhost python apps/aurora/e2e.py   # use an already-running backend
```

Encryption note: browser-mode chat is **plaintext** (MLS is desktop/Tauri-only),
so the live round-trip verifies reachability + relay-WebSocket delivery. MLS
ciphertext itself is covered by Rust tests in `rotor-core` and the Rakotis
envelope state machine.
