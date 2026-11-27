# Pharos — technology stack

What Pharos is built from, layer by layer, and why each piece is there. For how
the client works inside, see [apps/enigma/technology.md](apps/enigma/technology.md);
for who learns what, [SECURITY.md](SECURITY.md); for the wire formats,
[PROTOCOL.md](PROTOCOL.md).

## At a glance

| Layer | Choice |
|---|---|
| Client app | **Enigma27**: Tauri 2 (Rust back end, system WebView), Linux and Android |
| Client UI | Vue 3.5 + TypeScript 5.6, Pinia 3, vue-router 5, vue-i18n 9 (English, Polish), Tailwind CSS 4, Font Awesome |
| Front-end build and tests | Vite 8, Vitest 4 (jsdom), vue-tsc |
| Room engine (TS) | `packages/rakotis` inside the app: MLS orchestration, transport seam, history, mailbox |
| Shared UI kit | `packages/petalite`: theme, palette, i18n helpers, Oya primitives |
| Network | **Tor only**, embedded: arti 0.43 (`arti-client`, `tor-hsservice`), rustls with ring, full vanguards for hosted onions |
| Group encryption | **MLS** (RFC 9420) via OpenMLS 0.7.4, ciphersuite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` |
| Device identity | Ed25519 (`ed25519-dalek`); the public key (64 hex) is the device id and the MLS identity |
| Symmetric crypto | XChaCha20-Poly1305, BLAKE3 (hashing, keyed MACs, key derivation), Argon2id (passphrase) |
| At rest (client) | `protasius`: per-profile encrypted store (fjall + `gervasius` sealing) |
| Server | **Beacon** (optional): Rust, axum 0.8 (HTTP/1 only), tokio, SQLite (rusqlite, bundled), served as an onion service only |
| Serialisation | JSON (serde_json) for room frames and the API, postcard for tickets and codes |
| Rust toolchain | Rust 1.94, Cargo workspace |
| Packaging | Dromon (`./build.sh`): .deb and .rpm for Enigma, binary and .deb for Beacon (amd64, arm64/Raspberry Pi); Gradle + NDK for Android APKs |
| CI | GitHub Actions: `ci.yml` (tests), `release.yml` (Linux, Windows, Android, Beacon arm64 on a `v*` tag), `real-tor.yml` (end to end over the real Tor network, by hand) |
| Licence | AGPL-3.0 |

## The Slint apps (b2)

Three apps on the same crates (`enigma-app`, `enigma-core`, `enigma-client`,
`beacon-node`, `beacon`); Slint 1.19 UI, the Tauri app (`apps/enigma`) until parity.

| App | Path / binary | What | Platforms |
|---|---|---|---|
| **Enigma27** | `apps/enigma27`, `enigma27` (Android `com.spectrumaipl.enigma27`) | the client: chats, friends, settings; attaches to Your Lighthouse over Tor | Ubuntu (Linux desktop), Android |
| **Pharos Lighthouse** | `apps/pharos-lighthouse`, `pharos-lighthouse` | the Beacon app: run and manage a Beacon (overview, clients, rooms, settings, log) | Linux desktop, Raspberry Pi |
| **Enigma27 Combo** | `apps/enigma27-combo`, `enigma27-combo` | both in one window: the client attached in-process to its own Lighthouse | Linux desktop |

## The client: Enigma27

**Shell.** Tauri 2 gives a small native binary with the system WebView (WebKitGTK
on Linux, Android System WebView on phones) instead of a bundled browser. All
networking, crypto and storage live in Rust (`apps/enigma/src-tauri`); the WebView
only draws the UI and calls Rust commands. Android builds go through Tauri's
Android target, the NDK (aarch64 first) and Gradle (`tools/android/`).

**UI.** Vue 3 single-file components in TypeScript, state in Pinia stores, routes
with vue-router, texts in vue-i18n catalogues (`src/i18n/en.ts`, `pl.ts`),
styling with Tailwind 4. People's icons are SVG letters drawn on the device
(`avatarIcon.ts`); no images of people are stored or sent.

**Room engine.** `packages/rakotis` (TypeScript) runs a room: it drives MLS
through Rust commands, seals and opens frames, keeps the roster and history, and
talks to the transport through one interface (`ChatTransport`), so the engine is
tested on in-memory fakes. Its Rust half is `crates/enigmatite` (MLS sessions per
room, kept in the store).

**Transport** (`src-tauri/src/mesh.rs`). Each member hosts one onion service per
room and keeps a link to every other member (a mesh, no relay member). Frames are
length-prefixed JSON, padded to fixed sizes, with cover traffic while a room is
open. Links are signed with the device key and accepted only from current members
of the room's MLS group. Files are fetched over the sender's onion and checked
against a BLAKE3 commitment.

**Storage.** One encrypted store per profile (`crates/protasius`), unlocked with
a passphrase (Argon2id, then XChaCha20-Poly1305 via `crates/gervasius`). It holds
the device key, MLS state, rooms, friends, history and arti's own state (sealed
on exit), so guards and vanguard sets survive restarts.

## The server: Beacon (optional)

A single Rust binary (`beacon/`) sized for a Raspberry Pi: axum on tokio,
SQLite for mailboxes, every value sealed with a master key and every id and
token stored as a keyed hash. It is reachable only as an onion service (through
`crates/pharos-tor`, arti with full vanguards); a loopback TCP mode exists for
development. It serves:

- **room mailboxes** for Enigma27: phones post sealed frames to mailbox ids
  derived from the MLS exporter, each request on a fresh Tor circuit; Beacon holds
  new frames back for a random 0–10 s;
- **invitation drops**: a redemption waits there while the inviter is offline;
- **a page** with its code (`pharos-beacon:…`) as text and QR, in English or Polish;
- optionally **restricted discovery** (Tor client authorisation) so only allowed
  phones can find it (`beacon allow / deny / clients`);
- the older Pharos friend protocol (mailbox, directory, pairing drop-off).

Packaged as a .deb with a systemd unit (`beacon/packaging/`); see
[beacon/docs/raspberry-pi.md](beacon/docs/raspberry-pi.md).

## Shared crates

| Crate | Role |
|---|---|
| `crates/rotor` (`rotor_core`) | MLS on OpenMLS: groups, key packages, commits, welcomes, the exporter |
| `crates/enigmatite` | Enigma27's MLS sessions per room, kept in the app's store |
| `crates/gervasius` | Argon2id, XChaCha20-Poly1305, sealing to a key |
| `crates/protasius` | The per-profile encrypted store (fjall + gervasius) |
| `crates/pharos-tor` | Hosting and dialling onions with arti (vanguards, restricted discovery) |
| `crates/pharos-id` | Device identity, contact cards, Beacon codes |
| `crates/pharos-wire` | Friend-protocol envelope, padding and framing |
| `crates/pharos-seal` | Friend-protocol sealing (a friendship's MLS group, labelled boxes) |
| `crates/pharos-rendezvous` | Friend-protocol weekly onion keys and mailbox ids |

## Build, test, release

- `npm ci` once; `./run_dev.sh` for a dev profile; `./tests.sh` runs every suite
  (`./tests.sh js`, `./tests.sh rust`).
- `./build.sh enigma`, `./build.sh beacon [pi|all]`, `./build.sh all`: packages in
  `dist/` with `SHA256SUMS` and `build.json` (Dromon, configured per app in
  `dromon.yaml`).
- Android: `tools/android/build_android.sh enigma debug aarch64` (release builds
  need a signing key; see `tools/android/`).
- `./test_tor2.sh` and `.github/workflows/real-tor.yml`: two instances, and Beacon,
  over the real Tor network.

## Why these choices

- **Tor only, embedded:** no IP addresses between members, no system Tor to
  install, and the same code on desktop and Android. arti is Rust, so it lives in
  the same process and memory-safe language as the rest.
- **MLS:** a standard (RFC 9420) for group end-to-end encryption with forward
  secrecy and post-compromise security, instead of a home-made scheme.
- **A mesh, plus an optional Beacon:** no member sees all traffic, and a room keeps
  working with no server at all; Beacon only adds delivery to members who are
  never online together, and never learns who is in a room.
- **Tauri and Rust:** a small app, one language for everything security-relevant,
  and a WebView kept to drawing the UI.
