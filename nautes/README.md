# Nautes

The Pharos client. **Friends**: pair once by QR or text, then exchange short
messages over Tor, directly or through a friend's Proteus. **Groups**: Enigma's
rooms. See [../README.md](../README.md), [../PROTOCOL.md](../PROTOCOL.md).

---

What follows is Enigma26's README, from which Nautes was cut:

# Enigma26

A **serverless, peer-to-peer, end-to-end-encrypted chat** — a Tauri 2 + Vue 3
desktop and Android app. There is no app server: peers meet by **sharing a QR
code** and talk directly over [iroh](https://iroh.computer) (QUIC), with all
message content encrypted by **MLS** (OpenMLS) and all local state **encrypted
at rest** behind a passphrase.

- **Rooms and pairing** — a room is an iroh-gossip topic; creating one mints a
  ticket shown as a QR. Scan it (or redeem a sealed, expiring invitation) and
  the MLS handshake runs over the topic itself. Pair once, reconnect forever.
- **Transports** — direct QUIC with relay-assisted NAT traversal, or peer-hosted
  **Tor** onion services with an auto-elected relaying captain. Optional
  ticketless joins, presence and nicknames over the Mainline **DHT**.
- **Beyond chat** — voice calls, P2P file transfer and a room calendar. File editing is Morion's (see [Removed features](#removed-features)).
- **Privacy HP** — a budget that puts one comparable price beside every
  exposing action, so the cost of a choice is visible before the tap.
- **Two products, one source** — Standard and Professional are the same code
  built with a different list of features. A feature a build leaves out is not
  in that binary: not its code, not its dependencies, not its screens.

## Layout

Enigma is one app in the Belisario monorepo; the code it shares with the other
apps (crypto crates, the sealed-file frame, the shared front end, the build) is
at the repo root — see the [root README](../../README.md).

```
apps/enigma/
├── src/  src-tauri/       the app: Vue 3 frontend and Rust backend
├── packages/rakotis/      Enigma's app library and P2P chat orchestration
├── crates/protasius/      the encrypted-at-rest store
├── scripts/               dev-run helpers (profile reset, build dirs), the signing tests
├── limbo/                 parked features, each with a restore playbook
└── run_dev.sh  tests.sh  todo.md
dromon.yaml                how it is built: the two presets, pro and std
```

## Getting started

From the repo root:

```bash
./run_dev.sh enigma                            # one dev instance (installs dependencies on first run)
./run_dev.sh enigma --dual                     # two instances side by side, to pair on one machine
./run_dev.sh enigma std    # …with the Standard preset's features instead of Pro's
./run_dev.sh enigma --reset                    # start over with a fresh profile and passphrase
```

Prerequisites: Node 20+, Rust stable, and on Linux the WebKitGTK development
libraries (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev` and friends).

## Build

```bash
./build.sh enigma pro             # Professional: a release .deb and .rpm
./build.sh enigma std             # Standard
./build.sh enigma pro --dry-run   # show the commands, run none
```

A preset — a variant in [dromon.yaml](dromon.yaml) — lists the features a
build contains, and sets debug or release, package formats, Android, signing and
tests. There are no build flags. Packages land in `dist/enigma-pro/enigma/` and
`dist/enigma-std/enigma/`. Before anything compiles, the build checks with
`cargo tree` that Standard links neither the DHT's `mainline` nor the
equalizer's `rustfft`, and that no Enigma build links OpenSSL
([dromon/README.md](../../dromon/README.md#feature-isolation)).

| | Standard | Professional |
|---|:-:|:-:|
| Relays and discovery, contacts, PIN unlock | ✓ | ✓ |
| DHT (room codes, nicknames), voice calls, calendar | – | ✓ |

## Test

```bash
./tests.sh enigma            # everything: vitest, Rust, signing checks, the bundle, Playwright
./tests.sh enigma rust       # one group (js | rust | py | build | e2e)
./tests.sh enigma --list     # what it would run
```

Every step runs even if an earlier one fails, and the run ends with a pass/fail
table.

## Removed features

Features taken out of Enigma because another app in Belisario does the job.
The code is in the history; restore a file with
`git show <commit>:<path> > <path>` and re-add its dependencies.

| Feature | Removed | Last commit that has it | Files | Instead |
|---|---|---|---|---|
| Files → Local **SVG drawing editor** | 2026-10-23 | `a0b6224a4fcced186b455736b8745901c27e1931` | `src/components/local/SvgEditor.vue`, its tests `tests/component/svgEditor.test.ts`; it used `packages/wisteria` | Morion's sketch editor |
| Files → Local **text/notes editor** (Ace) | 2026-10-23 | `a0b6224a4fcced186b455736b8745901c27e1931` | `src/components/local/NoteEditor.vue`, `src/components/local/aceSetup.ts`, their tests and `tests/stubs/{ace,fakeAce}.ts`; it used `ace-builds` | Morion's text and code editors |
| Files → Local **file encryption** (lock, unlock, rotate; ENIGLOCK), Files → Keys **key ring** (`.enigr`), Settings' key-rotation reminder and **Delete files on panic** | 2026-10-23 | `cf2c6c559bed487cb5daa98ca59d8c8734a0cab4` | `src/components/local/`, `src-tauri/src/local_lock.rs`, `src-tauri/src/keyring.rs`, `src-tauri/src/fs_local.rs`, the `keyring` cargo feature, protasius's panic-targets sidecar | — (files locked with Enigma can only be opened by a build of that commit) |

## Documentation

Everything else is in **[technology.md](technology.md)**: architecture and
message flow, transports, the cryptography and its known weaknesses, privacy,
the UI, who owns which setting, and — from §19 on — running, building,
features and presets, releasing, installing and troubleshooting. Open work is
in [todo.md](todo.md). The base is documented in
[docs/technology.md](../../docs/technology.md).
