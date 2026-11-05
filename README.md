# Pharos

A lighthouse in the dark: short messages between friends over Tor, end to end
encrypted, with no company server in the middle.

- **Enigma** — the client (Rust, Tauri 2): pair with a friend once, then
  write to them. Messages travel over Tor onion services, sealed with MLS.
- **Proteus** — optional: Enigma works friend to friend without it. The always-on helper you run yourself, sized for a Raspberry
  Pi (Rust, axum, an onion service only): it keeps sealed messages for friends
  who are offline and a sealed directory of where to find people. It never
  holds a key that opens a message.

Forked from Vesper (technolog-spectrumai/belisario, `apps/vesper`) with its
history, and cut down to this one purpose. (Until 2026-11-05 Vesper was called Enigma and this client Nautes.) The plan is in [todo.md](todo.md)
(short) and [work.md](work.md) (with notes).

## What is here

| Path | What |
|---|---|
| [enigma/](enigma/) | The client. **Friends** (Pharos 1:1, the first tab) and **Groups** (Vesper's rooms) |
| [proteus/](proteus/) | The optional server: [running it on a Raspberry Pi](proteus/docs/raspberry-pi.md) |
| `crates/pharos-wire` | Envelope, padding, frames |
| `crates/pharos-seal` | A friendship's MLS group; labelled XChaCha20-Poly1305 boxes |
| `crates/pharos-rendezvous` | Weekly onion keys, mailbox and directory ids from the friendship secret |
| `crates/pharos-id` | Device key, fingerprint, signed contact card and pairing reply |
| `crates/pharos-tor` | arti: host an onion (with a derived key or its own), dial one |
| `crates/pharos-node` | Enigma' engine without the window, tested end to end |
| `crates/{rotor,gervasius,protasius,ferrozine}` | From Vesper: MLS, crypto primitives, the vault |

- How it works on the wire: [PROTOCOL.md](PROTOCOL.md)
- Who learns what: [SECURITY.md](SECURITY.md)

## How it works

1. **Pair once.** Show your card as a QR code (or text); your friend scans it.
   Their reply comes back as a second QR, or is left on your Proteus. Compare
   fingerprints. The two of you now share a secret no one else has.
2. **Find each other.** From that secret, each of you derives an onion address
   that changes every week, and hosts it while Enigma runs. The other derives
   the same address and dials it. Nothing is published anywhere.
3. **Write.** Messages up to 1000 characters, padded and sealed with MLS, are
   delivered directly when you are both online. Otherwise they wait in your
   outbox — or, if your friend has a Proteus, in their mailbox there.

## Run and test

```sh
npm ci
./run_dev.sh            # Enigma, profile "default"
./run_dev.sh bob        # a second profile, in another terminal, to pair with
./tests.sh              # every suite: ./tests.sh js | ./tests.sh rust
cargo run -p proteus -- serve -c proteus/packaging/config.yaml --tcp 127.0.0.1:8080   # Proteus on loopback
```

### Enigma for Android

Needs the Android SDK and NDK (`ANDROID_HOME`, `NDK_HOME`), Java 17+, and the
Rust target (`rustup target add aarch64-linux-android`).

```sh
cd enigma
npx tauri android build --debug --apk --target aarch64        # a debug APK, signed with the debug key
ORG_GRADLE_PROJECT_enigmaAllowUnsignedRelease=true \
  npx tauri android build --apk --target aarch64               # a release APK, unsigned
```

The APK lands in `enigma/src-tauri/gen/android/app/build/outputs/apk/`. A signed
release takes a keystore through `ENIGMA_KEYSTORE_FILE`, `ENIGMA_KEYSTORE_PASSWORD`,
`ENIGMA_KEY_ALIAS` and `ENIGMA_KEY_PASSWORD`, or `gen/android/keystore.properties`
(see `keystore.properties.example`). The app is `com.spectrumaipl.enigma`, Android 7.0
(API 24) and up; it asks for the camera (QR codes) and notifications, not the microphone.

Releases (Enigma for Linux and Windows, Proteus for arm64) are built by
`.github/workflows/release.yml` on a `v*` tag. A run over the real Tor network
is `.github/workflows/real-tor.yml` (by hand).

Licence: AGPL-3.0. Third-party notices: [enigma/THIRD_PARTY.md](enigma/THIRD_PARTY.md), [proteus/THIRD_PARTY.md](proteus/THIRD_PARTY.md).
