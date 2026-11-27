# enigma-slint

Enigma's main app in [Slint](https://slint.dev) 1.x, for desktop and Android (stage 5 of
`b2.md`). Binary: `enigma`.

```sh
cargo run -p enigma-slint -- --demo            # in-memory world with a simulated Ann
cargo run -p enigma-slint -- --demo --lang pl  # Polish (default: from $LANG)
cargo run -p enigma-slint                      # real backend: "not connected yet" until stage 2
```

## Shape

- `ui/*.slint`: the UI only (`app.slint` window and pages, `widgets.slint` avatar, buttons,
  cards, the Beacon toggle, `theme.slint` colours from the Vue app's tokens, light/dark
  following the system).
- `src/lib.rs`: glue. Owns an `enigma_app::core::Core` (shared with `enigma-tui`), pushes its
  state into the window (`refresh`) and maps callbacks to core actions (`wire`). QR codes
  are drawn from qrcodegen into a `slint::Image`.
- `src/headless.rs`: a software-renderer platform for tests and screenshots.
- `src/main.rs`: desktop entry; `android_main` in `lib.rs` is the Android entry.

Screens: rooms list + chat (bubbles grouped by author, letter avatars), room header with
"🔒 Encrypted · Linked to N · Direct/Via Beacon" and the ⋮ menu (Invite, Participants, Room
info, Reset encryption, Leave, Delete room), ☰ menu (New chat, Join chat, Friends,
Settings), Friends (your code + QR, add by code, 12-digit check codes), Settings (nickname,
language EN/PL, Connections → Your Beacon, Tor), Invite (QR + copyable code), Join (paste
a code; camera scan is a TODO). The large **Enable Beacon** toggle sits in the sidebar
footer and in Settings on desktop; on Android it is hidden (`BEACON_SUPPORTED` is false
for `target_os = "android"`: phones are clients).

## Tests and screenshots

```sh
cargo test -p enigma-slint                      # drives the window headless
cargo run -p enigma-slint --example slint-screens   # PNGs at 2x into docs/screens/slint/
```

## Android

The crate is also a `cdylib` (`libenigma_slint.so`) with `android_main`, on Slint's
`backend-android-activity-06`. The library cross-builds with the NDK directly:

```sh
rustup target add aarch64-linux-android          # or tools/android/setup_rust_android.sh
N=$HOME/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$N/aarch64-linux-android26-clang
export CC_aarch64_linux_android=$N/aarch64-linux-android26-clang
export AR_aarch64_linux_android=$N/llvm-ar
cargo build -p enigma-slint --lib --target aarch64-linux-android --release
```

(Verified: produces `libenigma_slint.so` exporting `android_main` and
`ANativeActivity_onCreate`.)

To package an APK, use cargo-apk (metadata is in `Cargo.toml`, `[package.metadata.android]`):

```sh
cargo install cargo-apk
export ANDROID_HOME=$HOME/Android/Sdk ANDROID_NDK_ROOT=$HOME/Android/Sdk/ndk/27.2.12479018
cargo apk run -p enigma-slint --lib --release   # or: cargo apk build
```

xbuild (`x build --platform android --arch arm64`) works too. The phone currently runs the
demo world; stage 2 wires the real client.
