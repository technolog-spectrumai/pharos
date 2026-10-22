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

```
enigma/
├── rutile/            the base — a git submodule shared with Morion (crypto crates,
│                      sealed-file frame, shared front end, build tooling)
├── apps/enigma/       the app: Vue 3 frontend (src/) and Rust backend (src-tauri/)
├── packages/rakotis/  Enigma's app library and P2P chat orchestration
├── protasius/         the encrypted-at-rest store
├── scripts/           dev-run helpers (profile reset, build dirs), the signing tests
├── limbo/             parked features, each with a restore playbook
├── pro.yaml  std.yaml the two presets: which features a build contains
└── build.sh  run_dev.sh  tests.sh  todo.md
```

## Getting started

```bash
git clone --recurse-submodules <this repo>   # or, afterwards: git submodule update --init

./run_dev.sh                 # one dev instance (installs dependencies on first run)
./run_dev.sh --dual          # two instances side by side, to pair on one machine
./run_dev.sh std.yaml        # …with the Standard preset's features instead of Pro's
./run_dev.sh --reset         # start over with a fresh profile and passphrase
```

Prerequisites: Node 20+, Rust stable, and on Linux the WebKitGTK development
libraries (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev` and friends).

## Build

```bash
./build.sh                   # Professional (pro.yaml): a release .deb and .rpm
./build.sh std.yaml          # Standard
./build.sh --dry-run         # show the commands, run none
```

A preset — [pro.yaml](pro.yaml), [std.yaml](std.yaml) — lists the features a
build contains, and sets debug or release, package formats, Android and tests.
There are no build flags. Packages land in `dist/pro/enigma/` and
`dist/std/enigma/`.

| | Standard | Professional |
|---|:-:|:-:|
| Relays and discovery, contacts, key ring, PIN unlock | ✓ | ✓ |
| DHT (room codes, nicknames), voice calls, calendar | – | ✓ |

## Test

```bash
./tests.sh                   # everything: vitest, Rust, signing checks, the bundle, Playwright
./tests.sh rust              # one group (js | rust | py | build | e2e)
./tests.sh --list            # what it would run
```

Every step runs even if an earlier one fails, and the run ends with a pass/fail
table.

## Documentation

Everything else is in **[technology.md](technology.md)**: architecture and
message flow, transports, the cryptography and its known weaknesses, privacy,
the UI, who owns which setting, and — from §19 on — running, building,
features and presets, releasing, installing and troubleshooting. Open work is
in [todo.md](todo.md). The base is documented in
[rutile/technology.md](rutile/technology.md).
