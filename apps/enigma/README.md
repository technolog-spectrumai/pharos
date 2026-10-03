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
- **Beyond chat** — voice calls, P2P file transfer, per-file locking, a room
  calendar, and fully offline maps.
- **Privacy HP** — a budget that puts one comparable price beside every
  exposing action, so the cost of a choice is visible before the tap.
- **Editions** — Basic / Standard / Professional are the same source built with
  a different compile-time config: a feature outside an edition is not in that
  binary.

## Layout

```
enigma/
├── rutile/            the base — a git submodule shared with Morion (crypto crates,
│                      sealed-file frame, shared front end, build tooling)
├── apps/enigma/       the app: Vue 3 frontend (src/) and Rust backend (src-tauri/)
├── packages/rakotis/  Enigma's app library and P2P chat orchestration
├── protasius/         the encrypted-at-rest store
├── tools/map_packager/  makes offline map region packages
├── scripts/           dev-run helpers (profiles, editions), the signing tests
├── limbo/             parked features, each with a restore playbook
└── build.yaml  build.sh  run_dev.sh  run2.sh  tests.sh
```

## Getting started

```bash
git clone --recurse-submodules <this repo>   # or, afterwards: git submodule update --init

./run_dev.sh                 # one dev instance (installs dependencies on first run)
./run2.sh                    # two instances side by side, to pair on one machine
./run_dev.sh --reset         # start over with a fresh profile and passphrase
```

Prerequisites: Node 20+, Rust stable, and on Linux the WebKitGTK development
libraries (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev` and friends).

## Build

```bash
./build.sh                   # what build.yaml says — by default a release .deb and .rpm
./build.sh --dry-run         # show the commands, run none
```

Edition, debug or release, package formats, Android and tests are all set in
[build.yaml](build.yaml); there are no build flags. Packages land in
`dist/enigma/`.

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
the UI, config sources of truth, and — from §19 on — running, building,
editions, releasing, installing and troubleshooting. The base is documented in
[rutile/technology.md](rutile/technology.md).
