# Enigma / Aurora workspace

An npm-workspaces monorepo that splits the former single Enigma app into **two
shippable Tauri + Vue 3 apps** that share code through libraries:

| Package | What it is |
|---------|-----------|
| **[apps/enigma](apps/enigma)** | **Secure communication** app — MLS chat over WebSocket relay **and** iroh P2P, voice calls, voice/image messages. |
| **[apps/aurora](apps/aurora)** | **Data workspace** — dashboard, files/storage, tasks/missions, locations, people, events — **plus MLS relay chat over WebSocket only** (no P2P, no voice calls). |
| **[packages/euclid](packages/euclid)** | Shared **non-crypto** foundation — UI primitives, reconnecting WebSocket client, Tauri helpers, auth/server/profile storage, HTTP `ApiBase`, local kv cache, i18n framework. |
| **[packages/rakotis](packages/rakotis)** | Shared **MLS-over-WebSocket relay chat** orchestration — Rotor-backed crypto bridge, relay transport, the chat-channel composable + MLS envelope state machine. |
| **Rotor** (`../toto/rotors/rotor_core`) | The crypto layer (OpenMLS). Lives in the toto repo; both apps depend on it from Rust. **All MLS crypto stays here.** |

### Dependency layering

```
Rotor (crypto, Rust)
   ▲
   │  mls_* Tauri commands
   │
Rakotis (MLS relay chat, TS) ──► Euclid (non-crypto foundation, TS)
   ▲                                ▲
   └──────────────┬─────────────────┘
                  │
        apps/enigma   apps/aurora
```

- **Euclid** never imports Rakotis and contains no crypto/MLS/P2P/voice.
- **Rakotis** depends on Euclid for generic primitives (WS client, Tauri invoke, kv,
  shared DTO types); each app injects its own `api` instance into the chat channel.
  Rakotis delegates all MLS to the Rotor-backed `mls_*` commands — it never
  reimplements crypto.
- Both apps consume Euclid + Rakotis as **source** via a Vite/tsconfig/vitest
  alias (`euclid`, `rakotis` → `packages/*/src/index.ts`); no prebuild step.

## Layout

```
enigma/
├── package.json              # workspace root: workspaces = packages/*, apps/*
├── apps/
│   ├── enigma/               # secure comms app (bundle id: com.spectrumaipl.enigma)
│   └── aurora/               # data-workspace app (bundle id: com.spectrumaipl.aurora)
├── packages/
│   ├── euclid/               # shared non-crypto TS
│   └── rakotis/              # shared MLS-relay-chat TS
├── run_dev.sh                # launch Enigma desktop with a profile
└── scripts/                  # Android build helpers
```

## Install

```bash
cd enigma
npm install        # once — sets up the workspace + all packages
```

## Build

```bash
npm run build -w euclid     # vue-tsc typecheck
npm run build -w rakotis    # vue-tsc typecheck
npm run build -w enigma     # vue-tsc + vite build (frontend)
npm run build -w aurora     # vue-tsc + vite build (frontend)

# Rust (Tauri) — per app:
( cd apps/enigma/src-tauri && cargo build )
( cd apps/aurora/src-tauri && cargo build )
```

Each of the four `npm run build` targets succeeds independently.

## Test

```bash
npm test -w euclid    # 27 tests — appStorage, localDb, ApiBase, i18n framework
npm test -w rakotis   # 6 tests  — relay chat transport (Rust-gateway backend)
npm test -w enigma    # 47 tests — vox call, yStore, chat components, login, i18n
npm test -w aurora    # 81 tests — vaultTree, geojson, reminders, data stores, i18n…
```

## Run (desktop)

```bash
# Enigma (comms) — needs a profile + chat identity
APP_PROFILE=alice CHAT_USER=alice npm run tauri dev -w enigma
# or: ./run_dev.sh

# Aurora (data workspace + relay chat)
APP_PROFILE=alice CHAT_USER=alice npm run tauri dev -w aurora
```

Browser mode (no Rust, MLS disabled → plaintext relay chat):

```bash
npm run dev -w enigma     # http://localhost:1420
npm run dev -w aurora
```

Each app stores its profile state under its own data dir and uses a **separate
identity namespace** (no cross-app identity reuse). Browser-mode MLS is disabled
in both apps (chat falls back to plaintext); MLS is desktop/Tauri-only.

See each package's README for details.
