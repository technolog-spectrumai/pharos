# Crypto Audit Inventory

Written 2026-09-16; scope narrowed on 2026-10-03, when Morion moved to its own
repository and the code both apps share moved to Rutile. This document covers
Enigma26 and the Rutile crates it links. Nothing here was re-audited on that
date — only what no longer belongs to this repository was taken out.

## Scope

Active scope:

- Enigma26 desktop app: `apps/enigma`
- Enigma's encrypted store: `protasius`
- The crypto crates, from the Rutile submodule: `rutile/crates/rotor`
  (`rotor_core`, `gervasius`) and `rutile/crates/substrate` (the sealed-file
  frame — Enigma links it WITHOUT `legacy-detect`, so no Fernet and no OpenSSL)

Out of scope here:

- Morion and its file sealing (`padova`, the `ZINNLOCK` frame): its own
  repository. It shares `gervasius` and `substrate` with Enigma through Rutile,
  so a finding in those crates concerns both apps.
- Historical limbo material under `limbo/`

## Algorithm Inventory

| Area | Current algorithm or construction | Where used | Source of truth / notes |
| --- | --- | --- | --- |
| MLS group encryption | `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` via OpenMLS | Enigma room chat payloads, room metadata, membership changes, calendar/map cards, and feature signaling that rides the room channel | Declared in `apps/enigma/src-tauri/build_config.yaml`; asserted by `apps/enigma/src-tauri/build.rs` against `rutile/crates/rotor/rotor_core/src/lib.rs`. Rotor uses pure ciphertext wire format and ratchet-tree extension. |
| MLS credentials | OpenMLS `BasicCredential` with self-asserted device identity | MLS member identities and rosters | `rutile/crates/rotor/rotor_core/src/lib.rs`. This is not a PKI or verified identity binding. |
| At-rest envelope | Passphrase -> Argon2id -> UKEK wraps random 32-byte DEK -> XChaCha20-Poly1305 for values | Enigma profile vault, MLS state, chat/p2p settings, invite records, DHT secrets, iroh/Tor keys, panic sidecars | `rutile/crates/rotor/gervasius/src/*`, `protasius/src/lib.rs`. Vault headers store version, KDF params, salt, and wrapped DEK. |
| Password KDF | Argon2id v1.3, 32-byte output | New Enigma vaults, local file locks, key rings (and Morion's sealed files, through the same crate) | Configured in `build_config.yaml` as 64 MiB, t=3, p=4; validated by `build.rs`; implemented in `rutile/crates/rotor/gervasius/src/kdf.rs`. |
| AEAD for local data | XChaCha20-Poly1305 with 24-byte random nonce and AAD | Gervasius sealed blobs, Enigma local file locks, key-ring files, in-memory PIN passphrase box | `rutile/crates/rotor/gervasius/src/aead.rs`, `apps/enigma/src-tauri/src/local_lock.rs`, `apps/enigma/src-tauri/src/keyring.rs`, `crates/padova/src/lock.rs`. |
| Public-key sealing | Ephemeral-static X25519 -> HKDF-SHA256 -> XChaCha20-Poly1305 | Personal invite ticket body sealed to a recipient NodeId public key | `rutile/crates/rotor/gervasius/src/seal.rs`, `apps/enigma/src-tauri/src/invite_ticket.rs`. Recipient Ed25519 NodeId keys are converted to X25519; small-order/off-curve inputs are rejected. |
| DHT record encryption | BLAKE3-derived keys, ChaCha20-Poly1305, random 96-bit nonce | Mainline DHT room rendezvous, presence, nickname directory | `apps/enigma/src-tauri/src/p2p_dht.rs`. DHT records are public metadata containers; MLS still gates room membership. |
| DHT signatures | Ed25519 signing keys derived with BLAKE3 domain separation | BEP44 mutable DHT records | `apps/enigma/src-tauri/src/p2p_dht.rs`. |
| Invite redemption | Ed25519 signature over random challenge plus BLAKE3 keyed proof with 32-byte invite capability | QR/ticket redemption before MLS add | `apps/enigma/src-tauri/src/invite_redeem.rs`, `apps/enigma/src-tauri/src/invites.rs`. The capability itself does not cross the wire during redemption. |
| File transfer E2EE | Ephemeral 2-member MLS group for transfer chunks | Direct iroh file transfer payloads | `apps/enigma/src-tauri/src/file_xfer.rs`. Transfer auth is tied to a KeyPackage hash signaled through the feature's MLS channel. |
| File transfer integrity | BLAKE3 hash chain with final root | Direct iroh file transfer chunks | `apps/enigma/src-tauri/src/file_xfer.rs`; default enabled by `features.file_integrity` in `build_config.yaml`. |
| Voice media encryption | MLS exporter secrets -> directional ChaCha20-Poly1305 keys, monotonic counter nonce | 1:1 Vox media datagrams | `apps/enigma/src-tauri/src/vox.rs`. Current code can fall back to transport-only crypto if the MLS call handshake fails. |
| P2P transport | iroh QUIC and iroh-gossip; optional hosted relays/discovery | Normal Enigma rooms, direct invites, file transfer, calls | `apps/enigma/src-tauri/src/p2p_iroh.rs`. Relays should see MLS ciphertext for room payloads. |
| Tor transport | Arti onion services and streams | Tor-mode Enigma rooms | `apps/enigma/src-tauri/src/p2p_tor.rs`. The elected captain forwards MLS ciphertext and should not have other members' group keys beyond its own membership. |
| Topic derivation | BLAKE3 hash of room name | iroh gossip topics and Tor room naming helpers | `apps/enigma/src-tauri/src/p2p_iroh.rs`, `apps/enigma/src-tauri/src/p2p_tor.rs`. This is deterministic and not a secret by itself. |
| Legacy platform files | Fernet read/detect path: AES-128-CBC + HMAC | Historical Toto/Zinnia sealed files only — **not compiled into Enigma** | `rutile/crates/rotor/gervasius/src/gervazy.rs` (feature `gervazy`), `rutile/crates/substrate/src/lib.rs` (feature `legacy-detect`). Morion enables them; Enigma must not, and `./tests.sh` asserts `openssl-sys` is absent from its tree. |

Key dependency versions confirmed from the Enigma Rust tree:

- `openmls` 0.7.4 and `openmls_rust_crypto` 0.4.4
- `iroh` 0.98.2 and `iroh-gossip` 0.98.0
- `arti-client` 0.43.0
- `argon2` 0.5.3
- `chacha20poly1305` 0.10.1
- `blake3` 1.8.5
- `mainline` 6.2.0
- `rustls` 0.23.41

## Secret And Data Locations

| Secret or sensitive data | Storage | Protection |
| --- | --- | --- |
| Profile DEK | In memory only after unlock; wrapped in `vault.json` at rest | Argon2id-derived UKEK wraps DEK through gervasius |
| MLS state | Protasius encrypted store, namespace `mls` | XChaCha20-Poly1305 value sealing; exported state is zeroized on Rust paths that handle it |
| Chat/profile settings and room data | Protasius encrypted store | Values sealed with per-key AAD prefixing; keys remain plaintext for scans |
| iroh gossip identity key | Protasius encrypted store, namespace `keys` | Stored sealed; used for stable node identity |
| Tor onion service identity / keystore | Profile Tor area, sealed through the vault integration | Wiped/resealed on shutdown paths described in `p2p_tor.rs` |
| Invite capabilities and records | Protasius internal invite namespace | Sealed at rest; redemption sends only challenge-bound proof |
| DHT room secret | Protasius encrypted store, namespace `dht` | Used to derive DHT record keys; public DHT still leaks bounded metadata |
| PIN unlock passphrase copy | Process memory only | Passphrase sealed under PIN-derived gervasius vault; dropped after 5 wrong PINs or restart |
| Panic code targets | Panic sidecar | Sealed under panic passphrase path; panic unlock returns like a normal unlock |
| Key-ring file keys and absolute paths | Local ring file under profile keyrings | Ring table sealed under ring DEK; raw keys and absolute paths are device-local |

## Existing Cybersecurity Measures

- Build-time crypto declarations are validated in `apps/enigma/src-tauri/build.rs`.
  Unknown YAML fields fail the build, sane KDF ranges are checked, and algorithm
  strings are const-asserted against the vendored crypto crates.
- Enigma room content is designed to be E2EE through MLS. iroh relays, the
  Mainline DHT, and Tor captains are not intended to see plaintext room payloads.
- Local profile data is encrypted at rest through Protasius/gervasius. The
  vault has no password recovery path; a forgotten passphrase means the store is
  unavailable by design.
- The vault can idle-lock. Rust-side watchdog logic tears down Vox, iroh, Tor,
  file transfer, map readers, and in-memory MLS sessions before dropping the DEK.
- PIN unlock is explicitly convenience-only and memory-only. Nothing PIN-derived
  is persisted to disk.
- Panic code support keeps the unlock result indistinguishable from a normal
  unlock and can wipe profile state plus opted-in local files.
- Personal invite tickets hide the room material and capability from a passive
  QR observer by sealing the body to the recipient. General invites are bearer
  credentials by design.
- Invite redemption is challenge-bound and identity-bound: a captured proof
  should not replay against a new challenge or a different NodeId.
- File transfer chunks are MLS-encrypted in a short-lived 2-member group and
  can be protected by a BLAKE3 hash chain.
- Key rings use per-file random DEKs and fsync+rename writes for ring and file
  updates.
- Tauri capabilities for Enigma are narrow at the manifest level: core, opener,
  dialog, and notification defaults; no broad filesystem plugin permission is
  declared in `capabilities/default.json`.
- Remote Toto token handling, if kept in scope, avoids localStorage for tokens,
  requires HTTPS, disables redirects, bounds request bodies, and allowlists
  `/api/v1/` proxy paths.

## Audit Gaps And Required Work

P0 before an external encryption audit:

- Remove or hard-disable the pre-MLS plaintext chat fallback in
  `packages/rakotis/src/useChatChannel.ts`. Current code can send
  `chat_message` over the gossip topic before `mlsStatus === "ready"`.
- Make Vox fail closed when its MLS media handshake fails, or make the
  transport-only fallback an explicit, user-visible degraded mode with audit
  signoff. The current fallback is in `apps/enigma/src-tauri/src/vox.rs`.
- Add a real Tauri Content Security Policy. `apps/enigma/src-tauri/tauri.conf.json`
  currently has `"csp": null`.
- Enforce passphrase minimum and policy in Rust, not only in UI. Direct
  `invoke` calls can currently bypass UI-only policy.
- Run a fresh dependency audit for Rust and npm before the audit package is
  handed over. The lockfiles are the source of truth, and npm currently reports
  high/critical findings during install.

P1 hardening:

- Add member/key verification UX: safety numbers, SAS, or another explicit
  binding between QR/tickets, NodeIds, and MLS credentials. BasicCredential alone
  is self-asserted.
- Add admission approval for room joins and align old/modified-build behavior.
  DHT room codes and leaked general tickets are bearer-style entry paths until
  MLS admission is explicitly approved.
- Define and implement MLS rekey/post-compromise recovery cadence, including a
  user-visible "rekey room now" path and tests around removals.
- Scope native file operations more tightly. `local_lock.rs` operates on paths
  supplied by JS; prefer dialog-granted paths or an allowlist/capability model.
- Add fsync+rename durability to Enigma `local_lock.rs`, matching the stronger
  path in `rutile/crates/substrate` and `apps/enigma/src-tauri/src/keyring.rs`.
- Review all logging for passphrases, invite capabilities, tokens, DHT secrets,
  key material, and decrypted payloads. Add regression tests for redaction where
  practical.
- Document legacy Fernet/OpenSSL handling as read-only migration support and
  ensure it is not enabled in Enigma release builds by accident.

P2 documentation and test depth:

- Write a short threat model that separates confidentiality, integrity,
  authenticity, metadata privacy, local-device compromise, and malicious-room
  member assumptions.
- Document metadata leaks for iroh topics, hosted discovery, DHT room codes,
  nickname records, Tor captain topology, and file/call timing.
- Add fuzz/property tests for frame parsers, invite-ticket decoding, DHT record
  opening, and file-transfer frame handling.
- Review zeroization boundaries. Rust key paths use `zeroize` in several places,
  but webview/TypeScript plaintext and UI strings cannot provide the same memory
  guarantees.
- Add an audit appendix mapping each persisted file or keyspace to its
  encryption state, backup/recovery behavior, and deletion behavior.

## Verification Commands

Useful commands for keeping this document honest:

```bash
rg -n "MLS_128_DHKEMX25519|xchacha20-poly1305|argon2id|ChaCha20Poly1305|blake3|Fernet|csp" \
  apps rutile/crates protasius packages

cargo tree --manifest-path apps/enigma/src-tauri/Cargo.toml -i openmls --locked
cargo tree --manifest-path apps/enigma/src-tauri/Cargo.toml -i iroh --locked
cargo tree --manifest-path apps/enigma/src-tauri/Cargo.toml -i arti-client --locked
cargo tree --manifest-path apps/enigma/src-tauri/Cargo.toml -i chacha20poly1305 --locked

cargo metadata --format-version 1 --no-deps --manifest-path apps/enigma/src-tauri/Cargo.toml
npm query .workspace --json
npm audit
```
