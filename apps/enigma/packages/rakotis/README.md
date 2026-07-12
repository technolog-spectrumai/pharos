# Rakotis

Reusable app primitives for the Enigma family (and any other Vite + Vue 3 app).
One package, two layers:

- **Foundation** (formerly the `euclid` package — non-crypto):
  - `services/` — reconnecting WebSocket client (`WsService`), Tauri `invoke` helpers,
    auth/server/profile storage, HTTP `ApiBase` with offline cache semantics, local
    kv cache (`kvGet`/`kvPut`), shared DTO types.
  - `i18n/` — locale framework (`createAppI18n`, `SUPPORTED_LOCALES`, …).
  - `components/` — `OyaButton`, `OyaCard`, `OyaHelloWorld` Vue components.
- **Chat orchestration** (the original `rakotis` surface):
  - `crypto.ts` — bridge to the Rotor-backed `mls_*` Tauri commands (MLS is delegated
    to Rust; never reimplemented in TypeScript). `pinCrypto.ts` — WebCrypto AES-GCM
    for pinned messages.
  - `chatTransport.ts` — relay transport over the WebSocket/realtime gateway.
  - `chatCommands.ts` — pluggable relay-only command seam.
  - `useChatChannel.ts` — the chat-channel composable + MLS envelope state machine.

Everything is exported from the single entry point `src/index.ts`.

## Consumption

rakotis is an **in-repo workspace package** of the Enigma monorepo
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
npm test          # vitest: services, i18n, transport, pin crypto (jsdom)
npm run typecheck # vue-tsc
```

Layering rules: the foundation layer stays non-cryptographic; MLS operations are
delegated to the host app's Rotor-backed Tauri commands via `cryptoService`.
