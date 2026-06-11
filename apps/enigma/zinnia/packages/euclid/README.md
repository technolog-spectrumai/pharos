# Euclid

Shared **non-crypto** UI + application foundation for [Enigma](../../apps/enigma)
and [Aurora](../../apps/aurora). Euclid contains **no crypto, MLS, P2P, voice
calls, or app/domain logic** — that separation is the whole point of the package.

## What's inside (`src/`)

| Module | Purpose |
|--------|---------|
| `services/tauri.ts` | `isTauri()` + lazy `invoke()` — the one Tauri runtime bridge. |
| `services/ws.ts` | Generic reconnecting WebSocket client (`WsService`/`wsService`) for the toto telegraph relay, with exponential backoff. |
| `services/appStorage.ts` | Auth token / server URL / onion / offline / server-data / runtime-config / profile-state — Tauri-backed with a `localStorage` browser fallback. |
| `services/apiBase.ts` | HTTP transport core: `ApiBase` (request + offline cache + silent mode + auth/identity calls + telegraph room endpoints), shared DTOs (`Me`, `Health`, `Room`, `Participant`), `uploadViaRust`, cache + error helpers. |
| `services/localDb.ts` | Local key/value store (`kv*`) — Rust fjall in Tauri, `localStorage` in the browser. |
| `services/types.ts` | Transport-agnostic shared DTO types (`Participant`). |
| `i18n/index.ts` | i18n framework: locale resolution/persistence helpers + a `createAppI18n(messages)` factory. Each app supplies its own catalogs. |
| `components/` | `OyaButton`, `OyaCard`, `OyaHelloWorld` UI primitives. |

## How apps use it

Each app builds its own `api` by extending `ApiBase`:

```ts
import { ApiBase } from "euclid";
class ApiService extends ApiBase {
  // app-specific endpoints (this.request is protected)
}
export const api = new ApiService();
```

Apps resolve `euclid` to `packages/euclid/src/index.ts` via a Vite alias +
tsconfig path (consumed as source). UI components are scanned by Tailwind through
an `@source "../../../packages/euclid/src"` directive in each app's `style.css`.

## Build / test

```bash
npm run build -w euclid    # vue-tsc --noEmit
npm test -w euclid         # vitest (jsdom)
```
