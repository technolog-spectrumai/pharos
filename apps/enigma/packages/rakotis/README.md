# Rakotis

Shared **MLS-over-WebSocket relay chat** orchestration for
[Enigma](../../apps/enigma) and [Aurora](../../apps/aurora).

Rakotis owns the chat-channel logic that both apps need: the Rotor-backed crypto
bridge, the relay transport, and the MLS envelope state machine. It contains **no
P2P/WebRTC, no voice calls, and no product UI**, and it **does not reimplement
crypto** — all MLS operations are delegated to the Rotor-backed `mls_*` Tauri
commands via the crypto bridge.

## What's inside (`src/`)

| Module | Purpose |
|--------|---------|
| `crypto.ts` | MLS bridge — thin wrappers over the Rotor-backed `mls_*` Tauri commands (init/key-package/add/welcome/commit/encrypt/process/members/remove). No-ops in a plain browser. |
| `chatTransport.ts` | Room-multiplexing chat transport. In Tauri, the Rust realtime gateway (`realtime_*` + `realtime://*` events); in the browser, Euclid's `wsService` (relay only). |
| `chatCommands.ts` | Pluggable relay-only command registry (seam for future `@system:` powers). |
| `useChatChannel.ts` | The chat-channel composable + full MLS envelope state machine (`mls_key_package` / `mls_welcome` / `mls_commit` / `mls_app`, participants, reset). Parametrized by `kind: "relay" \| "p2p"`. |

## Composition

`useChatChannel(kind, api)` takes the app's `api` instance (injected — both apps'
`api` extend Euclid's `ApiBase`, which satisfies the `RelayChatApi` surface).

```ts
import { useChatChannel } from "rakotis";
import { api } from "../services/api";

const relay = useChatChannel("relay", api);   // Aurora uses relay only
const p2p   = useChatChannel("p2p",   api);   // Enigma also runs a P2P channel
```

- **Aurora** instantiates the `relay` channel only — its Rust backend exposes no
  P2P commands, so the P2P methods are never invoked.
- **Enigma** runs both; its Rust backend provides the iroh P2P transport behind
  the same `realtime_*` commands.

## Layering

Rakotis depends on **Euclid** (for `wsService`, Tauri invoke, kv, runtime config
and shared DTO types) and on **Rotor** (indirectly, via the `mls_*` commands).
Euclid never depends on Rakotis.

## Build / test

```bash
npm run build -w rakotis   # vue-tsc --noEmit
npm test -w rakotis        # vitest (jsdom)
```
