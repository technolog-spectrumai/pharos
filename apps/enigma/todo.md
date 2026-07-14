# Enigma — TODO / Deferred & Parked Work

Everything that was **deliberately deferred** during the serverless P2P rework,
plus every feature **parked in [limbo/](limbo/README.md)**. Sources of truth:
[serverless_plan.md](serverless_plan.md) (§ Deferred) and
[limbo/README.md](limbo/README.md). Update those first, then mirror here.

---

## Staged for later (deferred TODOs)

### 1. ✅ `rotor_wasm` → toto static handoff (DONE 2026-07-14, telegraph scope)
CryptoRotor lives **only** inside this repo at [cryptorotor/](cryptorotor/)
(crates `rotor_core`, `rotor_py`, `rotor_wasm`) — enigma is the single source of
truth. Toto's Django telegraph chat now consumes a **static, committed copy** of
the wasm instead of compiling its own `toto/rotors/` copy in Docker. **No GitLab
anywhere in toto's path** (decided during implementation — the original
"toto pulls enigma CI artifacts" design was dropped: enigma's GitLab project is
private and toto lives on GitHub).

**Implemented — enigma side:**
- [cryptorotor/build_wasm.sh](cryptorotor/build_wasm.sh) — one-click WASM build
  (`web` → `rotor_wasm/build_web/`, `bundler` → `rotor_wasm/build/`).
- `.gitlab-ci.yml` `rotor:wasm` job runs that same script on every branch/tag
  pipeline as a build gate; publishes both packages as artifacts (30 days) with a
  `COMMIT` provenance stamp. **Enigma-side only** — toto does not fetch them.

**Implemented — toto side (telegraph/HTML use only):**
- Deploy config YAMLs carry a **required** top-level `rotor_wasm_dir:` prop
  pointing at the local `build_web/` output (e.g. this checkout's
  `cryptorotor/rotor_wasm/build_web`).
- `portal/scripts/deploy.py` `sync_rotor_wasm()` copies it into
  `toto/toto/telegraph/static/js/rotor_wasm/` on `up`/`push` (fails loud if the
  path is missing/unbuilt); the files are **tracked in toto's git**, so plain
  checkouts and images work without an enigma checkout.
- Both Dockerfiles dropped the `rust:1-slim` rotor-wasm build stage — the wasm
  rides in with `COPY toto/`.

**Still open (out of scope for this item):**
- `toto/edge/apps/*` still build from `toto/rotors/` (npm `file:` dep on
  `rotor_wasm/build` **and** `rotor-core` Rust path deps in each `src-tauri`), so
  **`toto/rotors/` cannot be deleted yet** — repointing edge (or retiring it in
  favor of this repo's app) is a separate decision.

### 2. ✅ `onion-p2p` — peer-to-peer over Tor (DONE)
**Implemented.** `p2p_tor.rs` hosts a per-profile hidden service via arti's
`onion-service-service`; a **"use Tor"** switch (Settings) routes rendezvous +
chat over it exclusively, and the QR carries a `.onion`. **Star** topology: the
room creator hosts one onion service and relays MLS ciphertext to joiners (1:1 is
N=2). Full record in [tor.md](tor.md). Multi-peer **mesh over Tor** stays out of
scope. `tor.rs` remains the outbound Arti client base.

**Follow-up — captain election for the onion host. ✅ DONE.** The onion host is now
**auto-elected** (lowest MLS identity among members) with loop-free tree-relay and
failover, so hosting is no longer tied to the creator (offline captain ⇒ re-election).
The captain is marked with a gold **★** on their profile row. Full record in
[capitan.md](capitan.md).

### 3. Cold-start reconnection edge case
If **every** member of a room is offline long enough for iroh's n0 discovery
records to lapse **and** all addresses have changed, reconnection needs a fresh
QR. **Accepted limitation** — a bare NodeId still resolves as long as the peer has
been online recently.

### 4. Group scale
Gossip fan-out and MLS admin election (`ourId < theirId`) are unchanged from the
original implementation — **fine for small rooms**, not yet hardened for large
groups.

### 5. ✅ Encryption at rest (DONE)
**Implemented.** A per-profile passphrase (Argon2id → wrapped DEK → XChaCha20-Poly1305)
encrypts ALL app state through the new **`protasius`** store (built on the
**`gervasius`** primitives crate): profile PII/settings, MLS session/signing keys,
iroh key, room list. Unlock gate on launch; "Reset passphrase" in Settings → Data;
**no forgot-recovery** — a lost passphrase is unrecoverable and the gate has no wipe
(the only destructive reset is Settings → "Clear all data"). The arti onion keystore
is **managed** (sealed into protasius,
materialized on disk only while unlocked, wiped on lock/exit) behind the "keep onion
stable" switch. Full record in [at_rest.md](at_rest.md).

**fs-mistrust resolution:** the `dangerously_trust_everyone` relaxation in
`p2p_tor.rs::ensure_started` **stays** — with the managed encrypted keystore the HS
key is sealed in protasius and only transiently on disk while unlocked, so the
dir-permission check adds little; do not re-enforce it.

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
