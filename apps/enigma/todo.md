# Enigma — TODO / Deferred & Parked Work

Everything that was **deliberately deferred** during the serverless P2P rework,
plus every feature **parked in [limbo/](limbo/README.md)**. Sources of truth:
[serverless_plan.md](serverless_plan.md) (§ Deferred) and
[limbo/README.md](limbo/README.md). Update those first, then mirror here.

---

## Staged for later (deferred TODOs)

### 1. ⭐ `rotor_wasm` → toto artifact handoff (MOST IMPORTANT)
CryptoRotor now lives **only** inside this repo at [cryptorotor/](cryptorotor/)
(crates `rotor_core`, `rotor_py`, `rotor_wasm`) — enigma is the single source of
truth. But **toto** still builds `rotor_wasm` from its own in-tree copy
`toto/rotors/`, which is slated for removal. Goal: **enigma CI builds `rotor_wasm`
and publishes it as an artifact; toto consumes that artifact** instead of building
`toto/rotors/`.

**Enigma CI job to add** (recipe preserved from the dropped
`cryptorotor/.gitlab-ci.yml` `build:wasm` job; or run `python3 cryptorotor/compile.py --tauri …`):
- `rustup target add wasm32-unknown-unknown`; install `wasm-pack`.
- In `cryptorotor/rotor_wasm/`: `wasm-pack build --target web --out-dir build_web`
  **and** `wasm-pack build --target bundler --out-dir build`.
- Publish `cryptorotor/rotor_wasm/build_web/` (web) + `cryptorotor/rotor_wasm/build/`
  (bundler) as CI artifacts; attach to tag/release pipelines, built at the exact
  enigma commit shipping that crate revision. (Deps are already wasm-ready:
  `wasm-bindgen =0.2.100`, `js-sys =0.3.77`, `getrandom` `features=["js"]`, and
  `rotor_core` uses `openmls` `features=["js"]`.)

**toto touchpoints to repoint** (in the toto repo, once the enigma artifact exists):
- `toto/portal/deploy/Dockerfile` + `toto/faros/deploy/Dockerfile` — currently
  `wasm-pack --target web` from `toto/rotors/` into
  `toto/toto/telegraph/static/js/rotor_wasm/`; fetch enigma's **web** artifact instead.
- `toto/edge/apps/*` — consume the **bundler** package via a `file:` npm dep on
  `toto/rotors/rotor_wasm/build`; repoint to enigma's **bundler** artifact.
- Delete `toto/rotors/` once nothing in toto builds from it.

> Not implemented yet — this records the design. The CI wasm job is the concrete
> next step.

### 2. `TODO(onion-p2p)` — peer-to-peer over Tor
Today `apps/enigma/src-tauri/src/tor.rs` is an **outbound Arti client only**,
shipped as compiled-but-unused plumbing. True P2P-over-onion needs hidden-service
**hosting** so a QR can carry a `.onion` address (net-new work). Full breakdown at
the `TODO(onion-p2p)` marker in `tor.rs`.
- Start with **1:1 / star** topology; a multi-peer gossip **mesh over Tor** is
  explicitly out of scope for the first iteration.

### 3. Cold-start reconnection edge case
If **every** member of a room is offline long enough for iroh's n0 discovery
records to lapse **and** all addresses have changed, reconnection needs a fresh
QR. **Accepted limitation** — a bare NodeId still resolves as long as the peer has
been online recently.

### 4. Group scale
Gossip fan-out and MLS admin election (`ourId < theirId`) are unchanged from the
original implementation — **fine for small rooms**, not yet hardened for large
groups.

---

## Parked in `limbo/` (restorable features)

Moved out of the build during the rework. **Not** compiled, bundled, or referenced
anywhere (`limbo/` is outside the npm `workspaces` globs and every `src-tauri`
crate). Restorable — see the checklist below.

### Voice calls (Vox)
1:1 voice calls over iroh QUIC (ALPN `enigma/vox/0`), self-contained MLS handshake.

| Parked file | Original location |
|---|---|
| `limbo/rust/vox.rs` | `apps/enigma/src-tauri/src/vox.rs` |
| `limbo/frontend/VoxPanel.vue` | `apps/enigma/src/components/VoxPanel.vue` |
| `limbo/frontend/useVoxCall.ts` | `apps/enigma/src/composables/useVoxCall.ts` |
| `limbo/frontend/voxCall.test.ts` | `apps/enigma/tests/unit/voxCall.test.ts` |
| `limbo/frontend/voxPanel.test.ts` | `apps/enigma/tests/component/voxPanel.test.ts` |

Restore blockers: depends on the removed `chacha20poly1305` / `rustfft` Cargo deps
and on `load_or_create_secret` (now relocated to `p2p_iroh.rs`); `useVoxCall.ts`
calls the removed `aster_resolve` command (call-by-username) that no longer exists.

### File transfer
P2P file transfer over iroh QUIC.

| Parked file | Original location |
|---|---|
| `limbo/rust/file_xfer.rs` | `apps/enigma/src-tauri/src/file_xfer.rs` |
| `limbo/frontend/FilePanel.vue` | `apps/enigma/src/components/FilePanel.vue` |
| `limbo/frontend/useFileShare.ts` | `apps/enigma/src/composables/useFileShare.ts` |

Restore notes: same `load_or_create_secret` relocation note as Vox;
`useFileShare.ts` rides the p2p channel's MLS group via the `onSync` / `sendSync`
seam (still present in rakotis).

### How to restore a parked feature
1. Move the files back to their original locations (table above).
2. Re-add the `mod` + `invoke_handler` entries in `apps/enigma/src-tauri/src/lib.rs`.
3. `manage()` its state in `lib.rs`.
4. Re-add its removed Cargo deps (e.g. `chacha20poly1305`, `rustfft` for Vox).
5. Re-add its tab in `EnigmaChatView.vue` and the store wiring in `stores/chat.ts`.
