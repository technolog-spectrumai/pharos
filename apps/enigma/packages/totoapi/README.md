# totoapi

Everything an app says to a **toto platform** server: capsules, jobs,
workspaces, files, and one verb that runs them.

Lifted out of `limbo/cloud` on 2026-09-10. That code was parked in 8/2026
because zinnia is local-first and the platform connection was the one part that
could not run offline. `py_editor` and `tex_editor` are remote by definition,
so it came back — see `limbo/cloud/LIMBO.md` for exactly what moved and what
stayed.

## Why it is a package and not a folder in one app

Two apps need it, and the alternative is two copies of the frozen URL rule, the
error taxonomy and the Rust command set. `limbo/cloud/LIMBO.md` is explicit that
`normalizeServerUrl` must not drift, because that string is the keyring account
name; two copies is how it drifts.

## The shape

```
src/api/client.ts       the one HTTP door — URL rule, headers, status → error
src/api/errors.ts       the taxonomy every caller switches on
src/api/transport.ts    the fetchImpl that routes through Rust
src/api/auth.ts         capsule API tokens
src/api/capsules.ts     pool, capsules, jobs, logs, output   (anastasia half)
src/api/workspaces.ts   workspaces, tree, files, run          (ambrosia half)
src/platform/settings.ts what an app remembers — NEVER the token
```

Every DTO is transcribed from the server's own dict literal, and the server
freezes those keys with a contract test. A rename there goes red there.

## Two things that look like details and are not

**The token never reaches JavaScript.** `transport.ts` routes every request
through a Rust command, which reads the token from the OS keyring and attaches
it. That is not only about secrecy: the apps' CSP is
`connect-src 'self' ipc: http://ipc.localhost`, so a `fetch()` at a remote host
is blocked by the webview before it reaches the network — silently, as CSP
violations are. Widening the CSP to allow a user-supplied origin means widening
it to `https:`, which is the protection gone. `ipc:` is already allowed.

**`normalizeServerUrl` is FROZEN.** It keys the stored credential. Changing the
rule orphans every saved token with nothing able to enumerate what was lost.

## Testing

```bash
npx vitest run --root packages/totoapi
npx tsc --noEmit -p packages/totoapi/tsconfig.json
```

Node, not jsdom, and that is the point of the package existing separately:
everything is logic over a `fetchImpl` the test supplies, so the whole client is
exercised without a browser, without Tauri and without a server. One file needs
a DOM (`localStorage`) and asks for jsdom with a per-file docblock.
