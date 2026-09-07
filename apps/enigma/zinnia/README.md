# Rakotis

Reusable app primitives for Enigma26 (and any other Vite + Vue 3 app).
One package, two layers:

- **Foundation** (non-crypto):
  - `services/` — Tauri `invoke` helpers, local profile storage, local kv cache
    (`kvGet`/`kvPut`), shared DTO types.
  - `i18n/` — locale framework (`createAppI18n`, `SUPPORTED_LOCALES`, …).
  - `components/` — `OyaButton`, `OyaCard`, `OyaHelloWorld` Vue components.
- **P2P chat orchestration**:
  - `crypto.ts` — bridge to the Rotor-backed `mls_*` Tauri commands (MLS is delegated
    to Rust; never reimplemented in TypeScript).
  - `chatTransport.ts` — bridge to the Rust iroh gateway (`realtime_*` commands,
    room-tagged `realtime://*` events).
  - `useChatChannel.ts` — the chat-channel composable + MLS envelope state machine,
    including the per-room peer-NodeId persistence that makes QR pair-once
    reconnects work.

Everything is exported from the single entry point `src/index.ts`.

## Consumption

rakotis is an **in-repo workspace package** of the Enigma26 monorepo
(`packages/rakotis`). Each app depends on it as `"rakotis": "*"`; a root
`npm install` symlinks it into `node_modules/rakotis`, so source edits are picked
up with no build or repin step.

The package ships TypeScript/Vue **source** (no build step) — consumers compile it.
For Vite apps, keep the package out of dependency pre-bundling and point the alias
(and, for TS `paths` users, type resolution) at the entry file:

```ts
// vite.config.ts
resolve: { alias: { rakotis: fileURLToPath(new URL("../../node_modules/rakotis/src/index.ts", import.meta.url)) } },
optimizeDeps: { exclude: ["rakotis"] }
```

```jsonc
// tsconfig.json
"paths": { "rakotis": ["../../node_modules/rakotis/src/index.ts"] }
```

## Development

```bash
npm install
npm test          # vitest: storage, localDb, i18n, chat transport (jsdom)
npm run typecheck # vue-tsc
```

Layering rules: the foundation layer stays non-cryptographic; MLS operations are
delegated to the host app's Rotor-backed Tauri commands via `cryptoService`.
