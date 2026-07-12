# Enigma / Aurora workspace

An npm-workspaces monorepo that splits the former single Enigma app into **two
shippable Tauri + Vue 3 apps** that share code through libraries:

| Package | What it is |
|---------|-----------|
| **[apps/enigma](apps/enigma)** | **Secure communication** app — MLS chat over WebSocket relay **and** iroh P2P, voice calls, voice/image messages. |
| **[apps/aurora](apps/aurora)** | **Data workspace** — dashboard, files/storage, tasks/missions, locations, people, events — **plus MLS relay chat over WebSocket only** (no P2P, no voice calls). |
| **[rakotis](https://gitlab.com/janhagit-group/rakotis)** | Shared primitives package (its own repository, pinned git dependency) — the non-crypto foundation (UI primitives, WebSocket client, Tauri helpers, storage, `ApiBase`, kv cache, i18n) plus the MLS-over-WebSocket relay chat orchestration (Rotor-backed crypto bridge, relay transport, chat-channel composable + MLS envelope state machine). |
| **Rotor** ([CryptoRotor](https://gitlab.com/janhagit-group/cryptorotor)) | The crypto layer (OpenMLS). Lives in its own repository; the apps consume `rotor-core` from Rust as a pinned cargo git dependency (see `apps/*/src-tauri/Cargo.toml`). **All MLS crypto stays here.** |

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

- **Rakotis** bundles the former euclid foundation layer (non-crypto primitives)
  and the chat orchestration layer; each app injects its own `api` instance into
  the chat channel. It delegates all MLS to the Rotor-backed `mls_*` commands —
  it never reimplements crypto.
- The apps consume rakotis as **source** from a pinned git dependency via a
  Vite/tsconfig/vitest alias (`rakotis` → `node_modules/rakotis/src/index.ts`);
  no prebuild step.

## Layout

```
enigma/
├── package.json              # workspace root: workspaces = apps/*
├── apps/
│   ├── enigma/               # secure comms app (bundle id: com.spectrumaipl.enigma)
│   ├── enigma_plus/          # secure comms superset app (bundle id: com.spectrumaipl.enigma_plus)
│   └── aurora/               # data-workspace app (bundle id: com.spectrumaipl.aurora)
├── run_dev.sh                # launch Enigma desktop with a profile
└── scripts/                  # Android build helpers
```

## Install

```bash
npm install        # once, at the repo root — sets up the workspace + all packages
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
