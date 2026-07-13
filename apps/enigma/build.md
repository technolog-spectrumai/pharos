# Enigma — Build Instructions

Packaging Enigma into installable artifacts. Enigma is a Tauri 2 (Vue 3 frontend +
Rust backend) app; a "build" compiles the frontend (`vue-tsc` + Vite) and the Rust
core, then bundles them. To run it in dev instead, see [dev_manual.md](dev_manual.md).

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 20+ (CI uses 22) | frontend build (Vite) + Tauri CLI |
| Rust | stable | Tauri core + `rotor-core` |
| System libs (Linux desktop) | — | WebKitGTK stack + bundling tools |

Debian/Ubuntu desktop deps:

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev pkg-config build-essential curl file
```

**No GitLab account needed.** The crypto crate `rotor-core` is **vendored in-repo**
at [cryptorotor/rotor_core](cryptorotor/rotor_core) and consumed by `src-tauri` as a
path dependency — there is nothing to authenticate or configure. (`rakotis` is
likewise an in-repo workspace package.) The whole build is offline-friendly once
crates.io/npm are cached.

Android has its own, larger toolchain (JDK 17, Android SDK/NDK, cargo-ndk) — see
[build_android.md](build_android.md).

---

## Desktop build

One-click (installs workspace deps, then builds — the frontend build runs
automatically via Tauri's `beforeBuildCommand`):

```bash
./build_desktop.sh            # release bundles (.deb / .AppImage / .rpm)
./build_desktop.sh --debug    # faster, unoptimized debug bundle

# equivalently, via npm:
npm run build                 # -> ./build_desktop.sh
npm run build:debug           # -> ./build_desktop.sh --debug
```

Output:

```
apps/enigma/src-tauri/target/release/bundle/     # release
apps/enigma/src-tauri/target/debug/bundle/       # --debug
  deb/enigma_<ver>_amd64.deb
  appimage/enigma_<ver>_amd64.AppImage
  rpm/enigma-<ver>-1.x86_64.rpm
```

### Piecemeal (frontend / Rust separately)

```bash
npm run build -w rakotis                 # vue-tsc typecheck (shared package)
npm run build -w enigma                  # vue-tsc --noEmit && vite build (frontend only)
( cd apps/enigma/src-tauri && cargo build )          # Rust debug
( cd apps/enigma/src-tauri && cargo build --release ) # Rust release
```

The frontend build emits `apps/enigma/dist/` (`index.html` + assets); Tauri reads
it via `frontendDist: "../dist"`.

---

## Android build

```bash
npm run build:android                             # debug APK for enigma (default)

# full control (build type + ABIs):
bash scripts/build_android.sh enigma debug                    # debug APK, aarch64
bash scripts/build_android.sh enigma release aarch64,x86_64   # release APK + AAB
```

`build_android.sh <app> [debug|release] [abi-spec]` runs `npm install`,
`tauri android init` (first time only), then `tauri android build`. Valid ABIs:
`aarch64` (modern phones), `x86_64` (emulator), `armv7` (old 32-bit), `i686`
(32-bit emulator), or `all`.

Output:

```
apps/enigma/src-tauri/gen/android/app/build/outputs/
  apk/debug/app-debug.apk
  apk/release/app-release.apk       # release only
  bundle/release/app-release.aab    # release only
```

Release APK/AAB are unsigned — see [build_android.md](build_android.md) (Step 7)
for keystore/signing, plus the full SDK/NDK/Java setup.

---

## CI builds

[.gitlab-ci.yml](.gitlab-ci.yml) builds Enigma on GitLab:

| Job | Stage | When | What |
|---|---|---|---|
| `frontend:build` | check | every commit | `vue-tsc` + `vite build`, asserts `dist/index.html` |
| `tauri:build` | build | every branch commit | full desktop bundle, asserts a `.deb`/`.AppImage`/`.rpm` was produced |
| `tauri:desktop` | build | tags / manual | release bundle, 30-day artifacts |
| `android:build` | build | manual | stubbed (not provisioned to a CI image yet) |

---

## Troubleshooting

- **`No space left on device` / linker (`collect2`) failure at the final link** —
  the release binary link step is large; this is almost always **disk space, not a
  code bug**. Free space (clear `target/`, docker/build caches) and retry.
- **`rotor-core` build error** — it's the vendored crate at `cryptorotor/rotor_core`
  (no fetch involved); reproduce in isolation with `cd cryptorotor && cargo check -p rotor-core`.
- **`webkit2gtk` / `soup` not found** — install the desktop system libs above.
- **`frontendDist` doesn't exist** — the frontend build didn't run/produce
  `apps/enigma/dist/`; run `npm run build -w enigma` (or a full `./build_desktop.sh`).
- **Android: `ANDROID_HOME` / NDK not found, linker errors** — see the
  Troubleshooting section of [build_android.md](build_android.md).
