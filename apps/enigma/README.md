# Enigma26

A **serverless, peer-to-peer, end-to-end-encrypted chat with file transfer** —
a Tauri 2 + Vue 3 desktop and Android app. There is no app server: peers meet by **sharing a QR
code** and talk directly over [iroh](https://iroh.computer) (QUIC), with all
message content encrypted by **MLS** (OpenMLS) and all local state **encrypted
at rest** behind a passphrase.

- **Rooms and pairing** — a room is an iroh-gossip topic; you enter one by
  redeeming a sealed, expiring invitation (a QR), and the MLS handshake runs
  over the topic itself.
- **Transports** — direct QUIC to the addresses an invitation carries (no relay
  servers, no discovery service), or peer-hosted **Tor** onion services with an
  auto-elected relaying captain. Tor is what sets Enigma apart from Vesper.
- **Files** — P2P file transfer, verified chunk by chunk.
- **Privacy HP** — a budget that puts one comparable price beside every
  exposing action, so the cost of a choice is visible before the tap.
- **One edition** — chat and files. Voice calls, the DHT (room codes, nicknames,
  presence), contacts and the calendar are Vesper's (see
  [Removed features](#removed-features)).

## Layout

Enigma grew up in the Belisario monorepo and has its own repository now; the
code it still shares with Belisario's apps (the crypto and transport crates,
the encrypted store, the shared front end) is vendored in `vendor/belisario/`,
and the build is at the repo root — see the [root README](../../README.md).

```
apps/enigma/
├── src/  src-tauri/       the app: Vue 3 frontend and Rust backend
├── packages/rakotis/      Enigma's app library and the room engine (Teutates' chat runs on it too)
├── scripts/               dev-run helpers (profile reset, build dirs), the signing tests
├── limbo/                 parked features, each with a restore playbook
└── run_dev.sh  tests.sh  todo.md
dromon.yaml                how it is built (one variant)
```

## Getting started

From the repo root:

```bash
./run_dev.sh enigma                            # one dev instance (installs dependencies on first run)
./run_dev.sh enigma --dual                     # two instances side by side, to pair on one machine
./run_dev.sh enigma --reset                    # start over with a fresh profile and passphrase
```

Prerequisites: Node 20+, Rust stable, and on Linux the WebKitGTK development
libraries (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev` and friends).

## Build

```bash
./build.sh enigma                 # a release .deb and .rpm
./build.sh enigma --dry-run       # show the commands, run none
```

[dromon.yaml](dromon.yaml) sets debug or release, package formats, Android,
signing and tests. There are no build flags. Packages land in
`dist/enigma/enigma/`. Before anything compiles, the build checks with
`cargo tree` that Enigma links none of OpenSSL, the DHT's `mainline` or the call
equalizer's `rustfft` ([dromon/README.md](../../dromon/README.md#feature-isolation)).

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
The code is in the history (the commits named below are Belisario's); restore a file with
`git show <commit>:<path> > <path>` and re-add its dependencies.

| Feature | Removed | Last commit that has it | Files | Instead |
|---|---|---|---|---|
| **Voice calls** (Vox), the Mainline **DHT** (room codes, nickname directory, presence), **contacts** and direct invites, the room **calendar** (meetings, polls), iroh's **hosted relays and discovery**, and the Pro/Standard editions | 2026-11-16 | `998d5360da06f571f5d0c21f5d012888b8e5e453` | `src-tauri/src/{vox,p2p_dht,p2p_dht_off,p2p_invite}.rs`, `src/components/{vox,calendar,contacts}/`, `src/views/Enigma{Vox,Calendar,Contacts}View.vue`, `packages/rakotis/src/services/contacts.ts`, `buildFeatures.ts`, the cargo features and their tests | Vesper |
| Files → Local **SVG drawing editor** | 2026-10-23 | `a0b6224a4fcced186b455736b8745901c27e1931` | `src/components/local/SvgEditor.vue`, its tests `tests/component/svgEditor.test.ts`; it used `packages/wisteria` | Morion's sketch editor |
| Files → Local **text/notes editor** (Ace) | 2026-10-23 | `a0b6224a4fcced186b455736b8745901c27e1931` | `src/components/local/NoteEditor.vue`, `src/components/local/aceSetup.ts`, their tests and `tests/stubs/{ace,fakeAce}.ts`; it used `ace-builds` | Morion's text and code editors |
| Files → Local **file encryption** (lock, unlock, rotate; ENIGLOCK), Files → Keys **key ring** (`.enigr`), Settings' key-rotation reminder and **Delete files on panic** | 2026-10-23 | `cf2c6c559bed487cb5daa98ca59d8c8734a0cab4` | `src/components/local/`, `src-tauri/src/local_lock.rs`, `src-tauri/src/keyring.rs`, `src-tauri/src/fs_local.rs`, the `keyring` cargo feature, protasius's panic-targets sidecar | — (files locked with Enigma can only be opened by a build of that commit) |

## Documentation

Everything else is in **[technology.md](technology.md)**: architecture and
message flow, transports, the cryptography and its known weaknesses, privacy,
the UI, who owns which setting, and — from §19 on — running, building,
features and presets, releasing, installing and troubleshooting. Open work is
in [todo.md](todo.md). The base, as it was when Enigma left Belisario, is documented in
[docs/technology.md](https://github.com/technolog-spectrumai/belisario/blob/b601baa26231785cc32d1b17e854fe5eb866f55b/docs/technology.md).
