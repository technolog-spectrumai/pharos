# Enigma — encryption at rest (passphrase-gated vault)

Companion to `serverless_plan.md` / `tor.md` / `capitan.md`. Plan for encrypting
**all app data at rest** behind a user passphrase, via two new Rust crates.
Inspired by toto's `gervazy` module (a 3-tier Argon2id→AES-GCM strongbox).

## Context

Everything Enigma persists is **plaintext on disk today**: profile PII + settings
(`profile_state.json`), the full MLS session state incl. signing keys + ratchet
secrets (`mls_*.bin`), the iroh identity key (`iroh_gossip.key`), the Tor presence
id + arti onion keystore, and the saved-rooms list (fjall `kvstore` — room names,
join tickets, peer onions/NodeIds). Anyone with read access to the profile dir can
decrypt current messages and impersonate the identity (`technology.md` §8 flags
this). It is also why `p2p_tor.rs` had to relax arti's fs-mistrust check.

Goal: on every app **launch** the user enters a passphrase; that passphrase derives
the encryption keys; **all** app data — including settings — is encrypted with them.
Password change lives in **Settings → Data → "Reset passphrase."**

### Decisions (confirmed)

1. **Two crates, named to match their host projects (no `_rs` suffix):**
   - **`gervasius`** — crypto **primitives**, a new member of the **cryptorotor**
     cargo workspace (siblings `rotor_core`/`rotor_wasm`/`rotor_py`). Pure, no
     Tauri/app/fs knowledge. The Rust port of `gervazy`'s crypto layer.
   - **`protasius`** — Enigma's **centralized, unified, per-profile encrypted data
     store**, a standalone crate in the enigma repo. Tauri-agnostic (operates on a
     directory); `lib.rs` wires the commands. It **replaces** the scattered
     persistence. (Gervasius & Protasius — the paired saints, mirroring `gervazy`.)
2. **Unified per-profile store.** protasius owns ONE `fjall` keyspace per profile
   holding everything as **sealed values** (plaintext key prefixes preserved for
   scans). Replaces `kv.rs`, `profile_state.json`, `mls_*.bin`, and the key files.
   A one-time migration imports existing plaintext, then deletes it.
3. **Wrapped-key vault** (2-tier): passphrase → **Argon2id** UKEK (never stored) →
   wraps a random 32-byte **DEK** → **XChaCha20-Poly1305** seals all data with the
   DEK. **Password change re-wraps only the DEK** — data is never re-encrypted.
   Wrong passphrase fails closed (AEAD tag). Keys held in memory only (`zeroize`).
4. **Onion key encrypted at rest (managed), stable by choice.** A Settings switch
   **"keep onion stable"** (default OFF):
   - **OFF → ephemeral:** arti's in-memory keystore (or a per-launch temp dir) —
     the HS key never persists; the `.onion` regenerates each session.
   - **ON → stable + encrypted:** the HS key is stored **encrypted in protasius**;
     materialized into arti's keystore dir only **while unlocked**; on lock/close
     arti is stopped, the dir is re-encrypted into protasius and the plaintext
     securely wiped. Stable onion **and** no plaintext key at rest (except a crash
     window, swept on the next unlock). The switch's UI explains the tradeoff.
5. **Unlock on launch only** (v1). One unlock per process; the DEK lives in memory
   for the session. No idle/background auto-lock yet (future enhancement).
6. **Forgot passphrase → destructive wipe.** No recovery by design; the unlock
   screen offers a strongly-confirmed "erase all data & start over."

## Architecture

```
   gervasius  (cryptorotor workspace)   — Argon2id, XChaCha20-Poly1305, vault envelope
        ▲ path dep
   protasius  (enigma repo, standalone) — per-profile fjall store, seals all values,
        ▲ path dep                         vault lifecycle + migration (Tauri-agnostic)
   enigma/src-tauri (lib.rs)            — vault_* commands, gating, wires persistence
        ▲ invoke
   App.vue unlock gate + Settings       — setup/unlock/reset/forgot, stable-onion switch
```
Dependency paths: `src-tauri → protasius (../../../protasius) → gervasius
(../cryptorotor/gervasius)`; `src-tauri → gervasius (../../../cryptorotor/gervasius)`.
**Add `gervasius` to the NESTED `enigma/cryptorotor/` workspace** (that's the copy
the build resolves via `../../../cryptorotor/...`); mirror the change to the outer
`../cryptorotor/` copy.

---

## A. `gervasius` — crypto primitives

`enigma/cryptorotor/gervasius/`. Deps: `argon2` 0.5, `chacha20poly1305` 0.10,
`aead`, `rand_core`(getrandom), `serde`, `zeroize`. Pure-Rust, wasm-clean.

Modules: `kdf.rs` (Argon2id), `aead.rs` (XChaCha20-Poly1305 seal/open), `vault.rs`
(envelope), `lib.rs` (`CryptoError`, re-exports).

**Wire formats.** AEAD frame = `nonce(24) ‖ ciphertext+tag`. `VaultHeader` (serde,
persisted by protasius as `vault.json`): `{ version:1, kdf:{m_kib:65536,t:3,p:4,out:32},
salt:[u8;16], wrapped_dek: <AEAD frame> }`. Params live in the header so a future
cost bump never bricks old vaults.

**API:**
```rust
pub struct Dek([u8;32]); // ZeroizeOnDrop
pub fn create_vault(passphrase:&str) -> Result<(VaultHeader, Dek)>;      // random salt+DEK, wrap DEK under UKEK
pub fn unlock(h:&VaultHeader, passphrase:&str) -> Result<Dek>;           // wrong pass ⇒ AEAD err (fail-closed)
pub fn rewrap(h:&VaultHeader, dek:&Dek, new:&str) -> Result<VaultHeader>;// fresh salt, re-wrap SAME DEK (password change)
pub fn seal(dek:&Dek, aad:&[u8], pt:&[u8]) -> Result<Vec<u8>>;
pub fn open(dek:&Dek, aad:&[u8], ct:&[u8]) -> Result<Vec<u8>>;
```
Argon2id params match `gervazy` (64 MiB / t=3 / p=4 / 32 B, 16-byte salt). 2-tier
(no VMK) is sufficient for Enigma's single scope; note it with a one-line marker.

**Tests:** KDF determinism (same salt/params ⇒ same key; different ⇒ different);
seal/open roundtrip; AAD binding rejects wrong aad; tamper/truncation fails;
wrong-passphrase fails; `rewrap` preserves the DEK and old-passphrase then fails;
header serde roundtrip.

---

## B. `protasius` — unified per-profile encrypted store

`enigma/protasius/`. Deps: `gervasius` (path), `fjall` 2, `serde`, `serde_json`,
`zeroize`. Tauri-agnostic.

**Schema.** One fjall keyspace at `<profile_dir>/protasius`, partition `data`.
**Keys plaintext, values sealed.** Encoded key = `ns\0<subkey>`:
- kv passthrough (frontend `kv_*`): full key `ns\0scope\0k` — **identical to today's
  `kv.rs::enc_key`**, so prefix scans (`clear_ns`/`count`) still work and the room
  list stays under ns `p2p:rooms` (frontend untouched).
- internal: `profile\0state`, `mls\0{room}\0{identity}`, `keys\0iroh_gossip`,
  `keys\0tor_peer_id`, `keys\0tor_keystore` (the sealed onion keystore, §D).
- value = `gervasius::seal(dek, aad, plaintext)`, `aad = "protasius:v1:" ‖ full_key`
  (binds each record to its exact location).
- `VaultHeader` is a plaintext `<profile_dir>/vault.json` (safe in the clear; makes
  `status()` a cheap `exists` check and lets setup/rewrap commit via atomic rename).

**Lifecycle + data API:**
```rust
Protasius::open(dir) -> Result<Self>            // opens keyspace, loads vault.json if any, dek=None
status() -> { exists, unlocked }
setup(passphrase, &MigrationPlan) -> Result<()> // create vault + MIGRATE legacy plaintext
unlock(passphrase) / lock() / change_passphrase(cur,new) / wipe()
get/put/delete(ns,key)   +   kv_get/kv_put/kv_delete/kv_clear_namespace/kv_count(...)
```
Data ops require unlock (else `Locked`); writes end with `persist(SyncAll)` (as
`kv.rs`). DEK zeroized on lock/wipe/drop.

**Migration** (`MigrationPlan` = explicit source paths supplied by `lib.rs`, keeping
protasius tauri-free). `setup()` phases, ordered for crash-safe atomicity:
1. Guard: `vault.json` exists ⇒ `VaultExists`.
2. `create_vault` in memory.
3. **Seal + put all legacy** (originals NOT yet deleted): `profile_state.json`;
   each `mls_*.bin` keyed by the `room_slug`+`identity` parsed from its
   `ExportedRotorState` JSON (lossless, avoids reversing the filename); the 32-byte
   `iroh_gossip.key`; `tor/peer.id`; and every record from the legacy global
   `kvstore` (incl. `p2p:rooms`). `persist(SyncAll)`.
4. **Commit:** write `vault.json` via tmp+fsync+rename; set `header`/`dek`.
5. **Retire originals** (best-effort): overwrite-then-remove each source (reuse the
   `wipe_file` pattern), `remove_dir_all` the legacy `kvstore`.

Crash before step 4 ⇒ no `vault.json` ⇒ setup re-runs cleanly (idempotent, fresh
DEK re-seals). Crash between 4 and 5 ⇒ an **opportunistic sweep** on every
`unlock()`/`setup()` retires any leftover plaintext source. `change_passphrase`
verifies current (fail-closed) → `rewrap` → atomic `vault.json` rewrite. `wipe`
drops keys, `remove_dir_all`s the keyspace + `vault.json`, reopens empty.

**Tests** (temp dir): setup→lock→reopen→unlock; get/put roundtrip; locked-ops
error; wrong passphrase; change-pass keeps data; stored value is ciphertext while
key bytes are `ns\0…`; full migrate-all (seed fake profile/mls/iroh/peer/kvstore →
assert readable + originals deleted); migrate idempotent after simulated crash; wipe.

---

## C. `lib.rs` + transport refactor

- **Managed state:** `ProtasiusState(Mutex<protasius::Protasius>)`. In `run().setup`
  replace `app.manage(kv::init(...))` with opening protasius at the active
  `profile_dir`; delete `mod kv` once the `kv_*` command names are backed by
  protasius.
- **New commands** (register in `generate_handler!`): `vault_status`, `vault_setup`
  (builds the `MigrationPlan` from app paths), `vault_unlock`, `vault_lock`,
  `vault_change_passphrase`, `vault_wipe` (also clears in-memory `Sessions`).
- **Gating (defense-in-depth):** a `require_unlocked(&ProtasiusState)` helper errors
  `"vault is locked"`; call it at the top of every data/network command (`app_*`,
  `mls_*`, `kv_*`, `realtime_*`). Exempt: `vault_*`, `current_profile`,
  `current_identity`, `app_get_runtime_config` (needed pre-unlock).
- **Call-site swaps** (thread `State<ProtasiusState>` — these commands already take
  `State<AppConfigState>`):
  - `load_profile_state`/`save_profile_state` → `get/put("profile","state",…)`.
  - MLS `persist`/`restore`/`wipe_file` (`mls_*.bin`) → `mls` namespace (blob keyed
    `room\0identity`); keep the existing `zeroize()` of the exported bytes.
  - `p2p_iroh::load_or_create_secret` → `keys/iroh_gossip` (now fallible + **moves
    per-profile**, fixing today's global-key sharing); `p2p_tor::load_or_create_peer_id`
    → `keys/tor_peer_id`. Thread state through `ensure_started`/room fns + realtime.rs.
  - `kv_*` commands delegate to protasius (frontend unchanged).
- **Profile switch** (`app_set_active_profile`): after swapping `AppConfig` + clearing
  `Sessions`, **re-open protasius for the new profile dir, locked**; do not
  load/save state there. Frontend re-runs the gate for the new (per-profile) vault.

---

## D. Onion key at rest — the managed encrypted-stable design

Add `#[serde(default)] pub stable_onion: bool` (default false) to `AppProfileState`
+ `app_get/set_stable_onion` (mirror `use_tor`; setter calls `p2p_tor::shutdown` so
the mode is re-evaluated). arti has **no encrypted keystore** (only on-disk plaintext
`ArtiNativeKeystore` or in-memory `ArtiEphemeralKeystore`), so we manage it:

- **`stable_onion == false` (ephemeral):** point arti at an in-memory keystore
  (`ArtiEphemeralKeystore`) if wiring through `TorClientConfig` is feasible, else a
  per-launch **temp** `state` dir recorded on `Node` and `remove_dir_all`'d in
  `p2p_tor::shutdown`. Either way nothing persists → `.onion` changes each session.
- **`stable_onion == true` (encrypted-at-rest, stable):** protasius holds the sealed
  keystore under `keys/tor_keystore` (a serialized archive of arti's keystore files).
  Lifecycle around `p2p_tor::ensure_started` / `shutdown`:
  - **On first Tor use after unlock:** if `keys/tor_keystore` exists, decrypt +
    extract it into the persistent `<profile>/tor/state` keystore dir (first sweep
    any leftover plaintext from a prior crash into protasius, then wipe). arti then
    finds the existing HS key → **stable `.onion`**. First-ever run: arti generates
    the key.
  - **On lock / airplane / switch-off / app close (`shutdown`):** stop arti (drop
    client + services), read the keystore dir, `seal` it into `keys/tor_keystore`,
    then securely wipe the plaintext dir.
  - **Crash while unlocked:** plaintext keystore remains until the next unlock sweep
    captures + wipes it — the one accepted exposure window (documented).

Keep the `dangerously_trust_everyone` fs-mistrust relaxation in both modes (temp
`/tmp` is world-writable; app-data may be group-writable). **This resolves
`todo.md` §5:** with the managed encrypted-stable design the keystore is no longer a
standing plaintext exception, but the fs-mistrust check stays relaxed — update the
`p2p_tor.rs` "INTERIM" comment + todo §5 to record this.

---

## E. Frontend

- **Unlock/Setup gate — `App.vue`.** Gate the three `onMounted` loaders
  (`chatStore.syncRuntimeIdentity` / `userStore.loadOfflineProfile` / `chatStore.init`)
  behind unlock. On mount call `vaultStatus()`: `!exists` → **Setup** (new+confirm →
  `vault_setup`); `exists && !unlocked` → **Unlock** (enter → `vault_unlock`; wrong →
  error; "Forgot passphrase?" → strong-confirm `vault_wipe` → back to Setup). Render
  a **non-dismissable** full-screen overlay (mirror `OyaModal`'s `fixed inset-0`
  teleport, **no** click-outside) instead of header/`RouterView`/footer until
  unlocked; only then run the loaders. `OyaTextField type="password"` + `OyaButton`;
  spinner while Argon2 derives (~0.3–1 s).
- **Reset passphrase — Settings → Data tab.** New `OyaCard` + button opening an
  `OyaModal` (mirror `QrScannerModal.vue`): current/new/confirm → `vault_change_passphrase`.
- **"Keep onion stable" switch — Settings.** A `role="switch"` like the existing
  offline/use-Tor toggles, bound to `stable_onion`, with i18n explaining the tradeoff
  (stable = `.onion`/QR persist across restarts, briefly on disk while unlocked;
  off = fully in-memory, `.onion` changes each restart so peers re-pair).
- **`appStorage.ts`:** `vaultStatus/vaultSetup/vaultUnlock/vaultLock/
  vaultChangePassphrase/vaultWipe` + `getStableOnion/setStableOnion` wrappers;
  `stable_onion?` on the TS `AppProfileState`. **Browser fallback:** `vaultStatus`
  returns `{exists:true,unlocked:true}` so the gate no-ops (encryption at rest is a
  Tauri-only feature); reset/stable-onion controls hide when `!isTauri()`.
- **i18n:** new `vault:` block + `config.stableOnion*` keys in `en.ts` **and** `pl.ts`.

---

## Edge cases & risks

- **Global → per-profile move.** Today `kvstore` and `iroh_gossip.key` are global.
  The first profile to run `vault_setup` inherits them; other profiles start with an
  empty room list and a fresh iroh NodeId → those need a new QR pairing. Acceptable
  pre-release; surface it once.
- **Managed onion keystore is the riskiest piece** — the arti-stop → archive →
  encrypt → wipe handshake must be correct, and the crash window leaves the key
  plaintext until the next unlock sweep. Build it last, behind the switch (default
  off), and test the sweep path explicitly.
- **Argon2 cost** (~0.3–1 s) only on setup/unlock/change-pass; show a spinner. Params
  fixed + stored in the header for cross-device portability.
- **FFI zeroization limit:** values decrypted for the webview cross into JS and can't
  be zeroized there — same as today; accepted.
- **Passphrase policy:** enforce a minimum length (≥ 8) + confirm match; no strength
  meter in v1.

## Files to create / modify

| Path | Change |
|---|---|
| `enigma/cryptorotor/gervasius/` (+ both `cryptorotor/Cargo.toml` members) | **new crate** — primitives |
| `enigma/protasius/` | **new crate** — unified encrypted store + migration |
| `apps/enigma/src-tauri/Cargo.toml` | add `protasius`/`gervasius` path deps |
| `apps/enigma/src-tauri/src/lib.rs` | `ProtasiusState`, `vault_*` commands, gating, profile-switch re-open, swap profile/MLS persistence, `stable_onion` field+commands; drop `mod kv` |
| `apps/enigma/src-tauri/src/kv.rs` | removed (superseded by protasius; `kv_*` names re-backed) |
| `apps/enigma/src-tauri/src/p2p_iroh.rs` | `load_or_create_secret` → protasius `keys` (per-profile, fallible) |
| `apps/enigma/src-tauri/src/p2p_tor.rs` | `load_or_create_peer_id` → protasius; `stable_onion` state-dir branch + managed keystore seal/extract in `ensure_started`/`shutdown` |
| `apps/enigma/src-tauri/src/realtime.rs` | thread `ProtasiusState` through room commands |
| `apps/enigma/src/App.vue` | unlock/setup/forgot gate |
| `apps/enigma/src/views/EnigmaConfigView.vue` | reset-passphrase card+modal; stable-onion switch |
| `packages/rakotis/src/services/appStorage.ts` | `vault_*` + stable-onion wrappers, TS type |
| `apps/enigma/src/i18n/{en,pl}.ts` | vault + stable-onion strings |
| `todo.md` §5, `technology.md` §8, `p2p_tor.rs` comment | update at-rest posture |

## Build order

1. **`gervasius`** (+ register in both cryptorotor workspaces) → `cargo test -p gervasius`.
2. **`protasius`** (store + vault + migration) → `cargo test` in the crate.
3. **`lib.rs`**: `ProtasiusState`, `vault_*` commands, gating, drop `mod kv` → `cargo check`.
4. **Persistence swaps**: profile + MLS via protasius; thread state through commands.
5. **Transport keys**: iroh/tor id via protasius.
6. **`stable_onion`**: field, get/set, ephemeral state-dir; then the **managed
   encrypted keystore** seal/extract lifecycle (last, most complex).
7. **Frontend**: appStorage wrappers, App.vue gate, reset modal, stable-onion switch, i18n.
8. **CI**: add `cargo test` for gervasius + protasius.

## Implementation notes (as built)

Deltas from the plan discovered while building + an adversarial review of the diff:

- **Persistence sites reach the store via `app.state::<ProtasiusState>()`** rather
  than threaded params, so `realtime.rs` and most signatures are unchanged; being
  locked surfaces naturally as a `protasius` error.
- **Migration split:** protasius handles byte-copyable legacy files (profile state,
  iroh key, tor peer id, old kvstore); `lib.rs::migrate_mls` handles `mls_*.bin`
  (it parses `room_slug`/`identity`). Both are idempotent (import + `persist` before
  deleting the original), run on setup AND unlock (crash sweep). `setup` migration
  is best-effort so a mid-migration error never strands a just-created vault.
- **Namespace tag bytes** (`0x01` internal / `0x02` kv) keep the generic and kv
  keyspaces disjoint in the one partition — a future kv namespace can't collide with
  reserved `profile`/`mls`/`keys`.
- **Managed onion keystore** is archived (dir → postcard blob), sealed into
  `keys/tor_keystore`, and wiped on `shutdown`; extracted on `ensure_started` when
  the persistent state dir is empty. A Tauri `RunEvent::Exit` handler runs
  `shutdown` on normal quit. **Review fix:** the plaintext keystore is wiped **only
  after a successful seal** (else the key is kept, re-entering the crash window,
  never destroyed), and **profile switch tears down the transports first** (while
  the old vault is still unlocked/active) so the keystore seals into the correct
  profile — `app_set_active_profile` is now async and shuts down iroh + Tor before
  swapping the config/store.
- **Profile switch reloads the webview** so `App.vue`'s gate re-runs for the new
  (locked) profile.
- **kv.rs deleted** (superseded by protasius + `vault.rs`).

Verified: `cargo test` — gervasius 10, protasius 7, backend 16; `cargo check` 0
warnings; `vue-tsc` clean (both packages); `vitest` 70. The live desktop run
(first-run passphrase → restart→unlock, reset, stable-onion, forgot→wipe) is the
remaining manual check below.

## Verification

- **Automated:** `cargo test` for gervasius + protasius (all §A/§B cases); `cargo
  check` src-tauri; `npm test` + `vue-tsc`.
- **Manual E2E** (desktop, two `APP_PROFILE`s):
  1. First run → Setup gate; set+confirm → app loads. Restart → Unlock; correct →
     loads, wrong → rejected (no partial unlock). On disk: `<profile>/protasius/`
     values are ciphertext; no legacy plaintext files remain; `vault.json` present.
  2. Pair two instances (QR), reach "Encrypted", exchange text+image → migrated iroh
     key + MLS state survived encryption.
  3. Reset passphrase (current/new/confirm); restart → new works, old fails, data intact.
  4. Stable-onion ON → create a Tor room, note `.onion`, restart → same `.onion`; on
     disk while running the keystore exists, after clean close it's sealed in
     protasius + plaintext gone. Stable-onion OFF → `.onion` changes each restart.
  5. Forgot passphrase → wipe (strong confirm) → back to Setup, store empty.
  6. Switch profile A→B while A unlocked → B shows its own Setup/Unlock gate.
