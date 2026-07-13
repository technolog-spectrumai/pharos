# Enigma — Android Build Guide

Enigma is a [Tauri 2](https://tauri.app/) desktop/mobile app (Vue 3 frontend + Rust backend).
This guide covers building an Android APK / AAB from the Ubuntu dev machine.

---

## Prerequisites overview

| Tool | Version | Purpose |
|---|---|---|
| Java (OpenJDK) | 17 | Gradle & Android build tools |
| Android Studio | 2024.3.x | SDK manager UI (optional but recommended) |
| Android SDK | platform 35 | Android platform headers |
| Android NDK | 27.2.12479018 | Native (C/Rust) cross-compilation |
| Android Build Tools | 35.0.0 | `aapt`, `dx`, `apksigner` |
| CMake | 3.31.6 | Required by NDK toolchain |
| Rust | stable (≥ 1.80) | Tauri Rust core + `rotor-core` |
| cargo-ndk | latest | Rust → Android NDK bridge |
| Node.js | ≥ 18 | Vue / Vite / Tauri CLI |

---

## Step 1 — Install Java 17

```bash
bash enigma/scripts/setup_java.sh
source ~/.bashrc
java -version   # must print "openjdk 17..."
```

## Step 2 — Install Android Studio, SDK, NDK, and header libs

```bash
bash enigma/scripts/install_android_studio.sh
source ~/.bashrc
```

This script installs:

- Android Studio IDE to `/opt/android-studio`
- Android command-line tools to `~/Android/Sdk/cmdline-tools/latest/`
- **SDK platform 35** — Android framework headers (`android/log.h`, etc.)
- **NDK 27.2.12479018** — full native toolchain including:
  - `aarch64-linux-android` / `armv7-linux-androideabi` compilers
  - `x86_64-linux-android` / `i686-linux-android` compilers
  - sysroot headers: `<android/log.h>`, `<android/asset_manager.h>`, `<jni.h>`, etc.
- **Build tools 35.0.0** — `aapt2`, `d8`, `apksigner`, `zipalign`
- **CMake 3.31.6** — required by NDK for C/C++ submodules
- 32-bit compatibility libs (`libc6:i386`, `libstdc++6:i386`, etc.)

Environment variables written to `~/.bashrc` and `~/.profile`:

```bash
export ANDROID_HOME="${HOME}/Android/Sdk"
export NDK_HOME="${ANDROID_HOME}/ndk/27.2.12479018"
export PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:..."
```

Verify:

```bash
sdkmanager --list_installed
echo $NDK_HOME
ls $NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android35-clang
```

## Step 3 — Add Android Rust cross-compilation targets

```bash
bash enigma/scripts/setup_rust_android.sh
```

Installs:

- `rustup target add aarch64-linux-android` (ARM64 — all modern phones)
- `rustup target add armv7-linux-androideabi` (ARMv7 — older 32-bit phones)
- `rustup target add x86_64-linux-android` (emulator)
- `rustup target add i686-linux-android` (32-bit emulator)
- `cargo install cargo-ndk` — bridges `cargo` to the NDK toolchain

Verify:

```bash
rustup target list --installed | grep android
cargo ndk --version
```

## Step 4 — Rotor dependency (fetched by cargo)

The Rust backend depends on `rotor-core` from [CryptoRotor](https://gitlab.com/janhagit-group/cryptorotor),
pinned as a cargo git dependency. The repository is private, so make sure git
can reach it (one-time setup; `.cargo/config.toml` already enables
`git-fetch-with-cli`):

```bash
git config --global url."git@gitlab.com:janhagit-group/".insteadOf "https://gitlab.com/janhagit-group/"
```

## Step 5 — Check Cargo.toml Android compatibility

```bash
bash enigma/scripts/patch_cargo_android.sh
```

### Key notes on native dependencies

| Dependency | Desktop | Android | Notes |
|---|---|---|---|
| `webkit2gtk` | Linux only (cfg guard) | Skipped automatically | Tauri uses Android WebView |
| `cpal 0.15` | ALSA/PulseAudio | Needs `oboe-shared-stdcxx` feature | See note below |
| `rotor-core` | CryptoRotor git dep | Cross-compiles fine | Pure Rust + openmls |
| `zeroize` | ✓ | ✓ | No platform deps |

**Voice recording on Android:** `cpal` defaults to ALSA on Linux. For Android audio,
edit `enigma/src-tauri/Cargo.toml`:

```toml
# For Android voice recording support:
[target.'cfg(target_os = "android")'.dependencies]
cpal = { version = "0.15", features = ["oboe-shared-stdcxx"] }
```

The `oboe` backend requires the NDK (already installed in Step 2).

## Step 6 — Build the APK

```bash
# Debug build (faster, no signing required)
bash scripts/build_android.sh enigma debug

# Release build (APK + AAB, requires signing — see Step 7)
bash scripts/build_android.sh enigma release
```

(`enigma` ships a committed Android project under `src-tauri/gen/android/`.)

The script:
1. Runs `npm install` in the app directory
2. Runs `tauri android init` (first time only — generates `src-tauri/gen/android/`)
3. Runs `tauri android build --apk [--aab]`

Output artifacts are in:

```
enigma/enigma/src-tauri/gen/android/app/build/outputs/
  apk/debug/app-debug.apk
  apk/release/app-release.apk       # release only
  bundle/release/app-release.aab    # release only
```

## Step 7 — Signing a release build (optional)

Generate a keystore once:

```bash
keytool -genkey -v \
  -keystore enigma-release.jks \
  -alias enigma \
  -keyalg RSA -keysize 4096 \
  -validity 10000
```

Sign the APK:

```bash
apksigner sign \
  --ks enigma-release.jks \
  --ks-key-alias enigma \
  --out enigma-release-signed.apk \
  app-release.apk
```

Or configure `src-tauri/gen/android/app/build.gradle.kts` with your signing config
before running the release build — see
[Tauri Android signing docs](https://tauri.app/distribute/sign/android/).

## Step 8 — Install on a device or emulator

```bash
# List connected devices
adb devices

# Install debug APK
adb install enigma/enigma/src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk

# View logs from the app
adb logcat -s RustStdoutStderr enigma
```

---

## Troubleshooting

### `ANDROID_HOME` not found during `tauri android build`

```bash
source ~/.bashrc
# or explicitly:
export ANDROID_HOME="${HOME}/Android/Sdk"
export NDK_HOME="${ANDROID_HOME}/ndk/27.2.12479018"
```

### `error: linker aarch64-linux-android-clang not found`

NDK is installed but not on PATH, or wrong NDK version. Confirm:

```bash
ls "${NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64/bin/" | grep aarch64
```

### `webkit2gtk` compile error when targeting Android

This should not happen — `Cargo.toml` guards it with
`[target.'cfg(target_os = "linux")'.dependencies]`. If it does, verify you are
running `tauri android build`, not a plain `cargo build`.

### `openmls` feature flag error

`rotor-core` uses `openmls` with `features = ["js"]`. This feature is required for
WASM but is also compatible with Android (it enables the `js` crypto backend via
`openmls_rust_crypto`). No action needed.

### Gradle Java version mismatch

Ensure `JAVA_HOME` points to JDK 17, not 11 or 21:

```bash
java -version      # must be 17
echo $JAVA_HOME
```

Run `setup_java.sh` again if wrong.

---

## Full environment variable reference

```bash
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk-amd64"
export ANDROID_HOME="${HOME}/Android/Sdk"
export NDK_HOME="${ANDROID_HOME}/ndk/27.2.12479018"
export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"
```

---

## Scripts reference

| Script | Purpose |
|---|---|
| `scripts/install_android_studio.sh` | Install Android Studio, SDK, NDK, header libs, build tools |
| `scripts/setup_java.sh` | Install and activate OpenJDK 17 |
| `scripts/setup_rust_android.sh` | Add Android Rust targets + cargo-ndk |
| `scripts/patch_cargo_android.sh` | Check Cargo.toml Android compatibility |
| `scripts/build_android.sh <app> [debug\|release]` | Full build pipeline (npm → tauri android build) |
