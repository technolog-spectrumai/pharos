# enigma-slint

Enigma's main app in [Slint](https://slint.dev) 1.x, for desktop and Android (stage 5 of
`b2.md`). Binary: `enigma`. It is a **client**: it attaches to *Your Beacon* (a Raspberry
Pi or Linux PC running `apps/enigma-beacon` or the `beacon` binary) over Tor and never
runs a Beacon itself (b2.md: client and Beacon are separate apps). Parity with the Tauri
app: `PARITY.md`.

```sh
cargo run -p enigma-slint                      # the real app: lock screen, then Your Beacon over Tor
cargo run -p enigma-slint -- --data /tmp/e27   # profiles somewhere else (default: the Tauri data dir)
cargo run -p enigma-slint -- enigma://room/Harbour   # open a deep link once unlocked
cargo run -p enigma-slint -- --demo            # in-memory world with a simulated Ann
cargo run -p enigma-slint -- --demo --lang pl  # Polish (default: from $LANG)
```

## First run

1. The Welcome screen asks for a passphrase (twice). It seals the profile vault
   (protasius) under `~/.local/share/com.spectrumaipl.enigma27/profiles/<profile>/`, the
   same place and layout as the Tauri app, so an existing Tauri profile opens with its
   passphrase (the lock screen says so).
2. Settings → **Your Beacon**: paste the `pharos-beacon:` code from the Beacon's screen,
   or read its QR from a picture. Rooms reach nobody until this is set.
3. If the Beacon has **Only my phones** on, copy this device's discovery key (shown under
   Your Beacon once Tor is up) and allow it on the Beacon (Phones → Allow, or
   `beacon allow NAME KEY`).

## Shape

- `ui/*.slint`: the UI only (`app.slint` window, pages, lock gate; `widgets.slint` avatar,
  buttons, cards; `theme.slint` colours from the Vue app's tokens).
- `src/lib.rs`: glue. Owns a `Host`: the lock `Session` (enigma-app) around a `Core` on the
  real backend, or a demo `Core`; pushes state into the window (`refresh`), maps callbacks
  to actions (`wire`), ticks every 250 ms (`tick`: idle lock, lock on hide, notifications,
  narrow layout). Pictures are decoded once per message.
- `src/audio.rs`: voice notes (cpal + WAV on desktop).
- `src/headless.rs`: a software-renderer platform for tests and screenshots.
- `src/main.rs`: desktop entry; `android_main` in `lib.rs` is the Android entry.

What lives in `crates/enigma-app` (shared with `enigma-tui`): `Core` (rooms, timeline,
friends, invitations with TTL / personal / peek / revoke, files, pictures, voice, banners,
deep links, settings), `RealBackend` (vault-backed engine state, `enigma-client` to Your
Beacon over `pharos-tor`, redemptions through the inviter's Beacon with
`admit_invited_via`, offline mode, connection timeout, discovery key), `Session` (create /
unlock / PIN / lock / idle / lock on hide / profiles / erase / change passphrase), the
vault (panic code wipes every profile), `media` (pictures, QR from images), `files`.

## Tests and screenshots

```sh
cargo test -p enigma-slint                          # drives the window headless (demo + a real profile)
cargo test -p enigma-app                            # incl. tests/real.rs: apps on in-memory Beacons
cargo run -p enigma-slint --example slint-screens   # PNGs at 2x into docs/screens/slint/
```

No test uses real Tor: the real backend takes `Net::Test(dialer)` in tests, with
beacon-node relays in an in-memory `Directory`.

## Deep links

`enigma enigma://room/<name>[/<tag>][?to=<name>&quote=<text>]` opens the room (by name or
id) once unlocked and puts `#tag @to quote` in the composer, as the Tauri app.
Registering the scheme with the OS is packaging: on Linux a `.desktop` file with
`MimeType=x-scheme-handler/enigma;` and `Exec=enigma %u`; on Windows the
`HKCU\Software\Classes\enigma` key; on Android an intent filter (cargo-apk
`[[package.metadata.android.application.activity.intent_filter]]`, scheme `enigma`).

## Media

- Pictures: 🖼 in the composer, then a path. Scaled to 1280 px and re-encoded as JPEG (no
  EXIF / location leaves the device), sent sealed in the room.
- Voice notes: 🎤 starts / ■ stops and sends (WAV, up to 2 minutes); ▶ plays. Desktop only
  for now (cpal); on Android the buttons say "not yet".
- Files: the Files page (tab or ☰). Offer by path; others accept; chunks (Settings → chunk
  size) go as MLS-sealed sync messages through the Beacons, checked by sha256 and saved
  to `~/Downloads/Enigma27` (`$ENIGMA_DOWNLOADS`).
- Notifications: desktop notifications (notify-rust) for messages that arrive while the
  window is hidden or another page is open; off in Settings.

## Camera (not yet)

Slint 1.x has no camera widget. Today a QR is read from a picture (Join, Friends, Your
Beacon: "Read a QR code from a picture"), which works with a photo or screenshot. For
Android the plan is an `ACTION_IMAGE_CAPTURE` intent through `android-activity`'s JNI
(the APK already asks for `CAMERA`), then the same rqrr decoder; on desktop, `nokhwa`
frames into rqrr. Neither is wired yet.

## Android

The crate is also a `cdylib` (`libenigma_slint.so`) with `android_main`, on Slint's
`backend-android-activity-06`; the phone runs the real client (profiles in the app's
internal storage). Package an APK with cargo-apk (metadata in `Cargo.toml`):

```sh
cargo install cargo-apk
rustup target add aarch64-linux-android
cd apps/enigma-slint
ANDROID_HOME=$HOME/Android/Sdk ANDROID_NDK_ROOT=$HOME/Android/Sdk/ndk/27.2.12479018 cargo apk build --lib
```

(Needs SDK platform 35 and NDK 27.) xbuild (`x build --platform android --arch arm64`)
works too.

## Windows

Nothing here is Linux-only except the Beacon (which the client does not include): cpal
uses WASAPI, notify-rust uses WinRT toasts, arti and Slint build on Windows. A Windows
build was not run in this environment (no `x86_64-pc-windows-*` target installed);
check with `cargo build -p enigma-slint --target x86_64-pc-windows-msvc` on Windows or
`cargo xwin build` from Linux.

## Packaging / CI

- Desktop: `cargo build -p enigma-slint --release` gives one binary `enigma` (the Tauri
  app's binary has the same name; build them separately until it is retired). Linux
  packages: a `.desktop` file (with the `enigma` URL scheme above) and an icon; system
  needs: ALSA (cpal) and a notification daemon (D-Bus) at run time.
- CI: `cargo test -p enigma-app -p enigma-slint -p enigma-tui` runs headless (software
  renderer, in-memory Beacons; no display, no Tor, no audio device needed);
  `cargo run -p enigma-slint --example slint-screens` refreshes `docs/screens/slint/`;
  the Android job runs `cargo apk build --lib` with the SDK/NDK above.
