# Pharos

A lighthouse in the dark: small group chats over Tor, end-to-end encrypted,
with no company server in the middle.

- **Enigma27** — the client (`apps/enigma`; Tauri 2: Rust in `src-tauri`, Vue in
  `src`, and the shared TypeScript package `packages/rakotis`). Rooms, text,
  images, voice notes and files, always over Tor. It works on its own.
- **Beacon** — optional (`beacon/`; until 2026-11 called Relay, earlier Proteus).
  The always-on helper you run yourself, sized for a Raspberry Pi (Rust, axum,
  an onion service only). Pair it once (Settings → Connections → Your Beacon)
  and rooms you create keep their messages there for members who are offline,
  and let people redeem an invitation while your phone is offline. It never
  sees who is in a room or what they say, and a room never depends on it. It
  also still serves the older Pharos friend protocol.

Enigma27 replaced Pharos's earlier client (Friends 1:1 and Vesper's groups) on
2026-11-22/23. It came from technolog-spectrumai/enigma, branch `dev_mvp1`
("Enigma26"), copied rather than vendored: Pharos owns the code now. The plan
is in [todo.md](todo.md) (short) and [work.md](work.md) (with notes).

## How it works

Every member of a room hosts its own Tor onion service for that room and keeps
a link to every other member: a mesh, with no captain and no member forwarding
anyone else's traffic. You get into a room only by redeeming an invitation
(a QR or text) against the inviter's onion — or, when the inviter is offline
and the room has a Beacon, by leaving the redemption at Beacon for the
inviter's phone to answer later. Frames are padded to fixed sizes and links
carry cover traffic while a room is open. Every
message is sealed with MLS (RFC 9420) before it leaves the device, and
everything the app keeps — keys, MLS state, history, Tor's own state — is
encrypted at rest behind your passphrase. There is no direct (non-Tor)
connection of any kind.

- Who learns what: [SECURITY.md](SECURITY.md)
- On the wire: [PROTOCOL.md](PROTOCOL.md) (Enigma27's mesh, and Beacon's API)
- The technology stack: [technology.md](technology.md)
- The client in depth: [apps/enigma/technology.md](apps/enigma/technology.md)

## Run, build and test

```sh
npm ci
./run_dev.sh                  # Enigma27, profile "default"
./run_dev.sh bob              # a second profile, in another terminal
apps/enigma/run_dev.sh --dual # two profiles (alice, bob) side by side
./tests.sh                    # every suite: ./tests.sh js | ./tests.sh rust
./test_tor2.sh                # two instances over the real Tor network (a few minutes; needs Tor access)

./build.sh enigma             # .deb and .rpm, as apps/enigma/dromon.yaml says
./build.sh beacon              # Beacon for this machine: binary and .deb
./build.sh beacon pi           # Beacon for a Raspberry Pi (aarch64); `all` for both
./build.sh all                # Enigma27, then Beacon
cargo run -p beacon -- serve -c beacon/packaging/config.yaml --tcp 127.0.0.1:8080   # Beacon on loopback
cargo run -p enigma-slint -- --demo   # the new Slint app (stage 5), simulated peer Ann
cargo run -p enigma-tui -- --demo     # the console app
```

Packages land in `dist/enigma/enigma/` and `dist/beacon/<arch>/`, each with a
`SHA256SUMS` and a `build.json`. Android: `tools/android/` (toolchain set-up and
`build_android.sh`) and the `android:` section of
[apps/enigma/dromon.yaml](apps/enigma/dromon.yaml); details in
[technology.md §19](apps/enigma/technology.md#19-run-build-and-test). The app is
`com.spectrumaipl.enigma27`; its icon is the letter E
(`scripts/letter_icon.py`).

CI: `.github/workflows/ci.yml` (tests), `release.yml` (on a `v*` tag: Linux,
Windows, Android arm64, Beacon for the Pi), `real-tor.yml` (by hand:
`./test_tor2.sh`, and Beacon served and probed over the real Tor network).

## What is here

| Path | What |
|---|---|
| [apps/enigma/](apps/enigma/) | Enigma27, the client |
| `apps/enigma/packages/rakotis` | The room engine in TypeScript: MLS orchestration, chat transport, history |
| [beacon/](beacon/) | The optional server: [running it on a Raspberry Pi](beacon/docs/raspberry-pi.md) |
| `crates/rotor` (`rotor_core`) | MLS (OpenMLS) |
| `crates/gervasius` | Crypto primitives: Argon2id, XChaCha20-Poly1305, sealing to a key |
| `crates/protasius` | The encrypted store each profile keeps |
| `crates/enigmatite` | Enigma27's MLS sessions per room, and key-package admission |
| `crates/pharos-{wire,seal,rendezvous,id,tor}` | The friend protocol (Beacon), Beacon codes (`pharos-id`), and Tor hosting/dialling (`pharos-tor`) |
| `packages/petalite` | Shared front end: theme, palette, i18n, Oya primitives |
| `dromon/`, `build.sh`, `install.sh` | The build |
| `tools/android/` | Android toolchain and build scripts |

Licence: AGPL-3.0. Third-party notices: [beacon/THIRD_PARTY.md](beacon/THIRD_PARTY.md).
