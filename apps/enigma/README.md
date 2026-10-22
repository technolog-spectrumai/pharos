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
- **Beyond chat** — voice calls, P2P file transfer, per-file locking and a
  room calendar.
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
| Relays and discovery, contacts, key ring, PIN unlock | ✓ | ✓ |
| DHT (room codes, nicknames), voice calls, calendar | – | ✓ |

## Test

```bash
./tests.sh enigma            # everything: vitest, Rust, signing checks, the bundle, Playwright
./tests.sh enigma rust       # one group (js | rust | py | build | e2e)
./tests.sh enigma --list     # what it would run
```

Every step runs even if an earlier one fails, and the run ends with a pass/fail
table.

## Documentation

Everything else is in **[technology.md](technology.md)**: architecture and
message flow, transports, the cryptography and its known weaknesses, privacy,
the UI, who owns which setting, and — from §19 on — running, building,
features and presets, releasing, installing and troubleshooting. Open work is
in [todo.md](todo.md). The base is documented in
[docs/technology.md](../../docs/technology.md).
