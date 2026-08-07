# Enigma — Build & Run

How to run Enigma in dev and package it into installable artifacts. Enigma is a
Tauri 2 (Vue 3 frontend + Rust backend) app; a "build" compiles the frontend
(`vue-tsc` + Vite) and the Rust core, then bundles them. For how the app *works*
(architecture, crypto, conventions, config sources) see
[technology.md](technology.md).

Contents: [Prerequisites](#prerequisites) · [First-time setup](#first-time-setup) ·
[Run (dev)](#run-dev) · [Build configuration](#build-configuration-build_configyaml) ·
[Editions](#editions-enigma_edition) ·
[Desktop build](#desktop-build) · [Android](#android-toolchain-setup--build) ·
[CI](#ci-builds) · [Tests](#tests) · [Troubleshooting](#troubleshooting)

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

**No GitLab account needed.** The crypto crates are **vendored in-repo**
([cryptorotor/](cryptorotor) — `rotor-core`, `gervasius`) and consumed by
`src-tauri` as path dependencies, as are [protasius/](protasius) and the
`rakotis` npm workspace package — there is nothing to authenticate or configure.
The whole build is offline-friendly once crates.io/npm are cached.

Android has its own, larger toolchain (JDK 17, Android SDK/NDK, cargo-ndk) — see
[Android](#android-toolchain-setup--build) below.

---

## First-time setup

```bash
npm install        # once, at the repo root — sets up the workspace + all packages
```

`rakotis` is an in-repo workspace package (`packages/rakotis`); npm symlinks it
into the app's `node_modules`, so edits to its source are picked up immediately —
no rebuild step.

---

## Run (dev)

```bash
./run_dev.sh          # or: npm run dev
```

Both run `npm run tauri dev` inside `apps/enigma`: Vite starts on
`http://localhost:1420` and Tauri opens the native window pointed at it. Frontend
edits hot-reload; Rust edits trigger a rebuild.

> The first launch compiles the full Rust dependency tree (incl. OpenMLS + iroh +
> arti) and is slow. Later runs are incremental.

### Profiles & two-instance pairing

Two env vars isolate instances so you can pair two on one machine:

| Var | Default | Effect |
|---|---|---|
| `APP_PROFILE` | `default` | Storage namespace (separate encrypted store / profile dir) |
| `CHAT_USER` | `default` | MLS identity namespace |

```bash
# terminal 1
APP_PROFILE=alice CHAT_USER=alice ./run_dev.sh
# terminal 2
APP_PROFILE=bob   CHAT_USER=bob   ./run_dev.sh
# or both at once, sharing one Vite server:
./run2.sh
```

### Starting over (`--reset`) — new passphrase, clean cache

There is no "forgot my passphrase" flow: the passphrase wraps the store's DEK,
so a fresh one means a fresh store. Both launchers take a flag for it:

```bash
./run_dev.sh --reset              # reset profile "default", then run
APP_PROFILE=alice ./run_dev.sh --reset
./run2.sh --reset                 # reset BOTH profiles (alice + bob), then run
./run2.sh --reset carol dave      # flags mix with the positional names, any order
ENIGMA_RESET=1 ./run_dev.sh       # env equivalent (ENIGMA_RESET=purge for --purge)
```

The next start is a **first run**, so the app asks you to set a new passphrase.

| | |
|---|---|
| **What it clears** | `profiles/<profile>/` (protasius store, `vault.json`, `profile_state.json`, `tor/`) and the global webview caches (`WebKitCache`, `CacheStorage`, `storage`, …) |
| **What it keeps** | `iroh_gossip.key` and the legacy `kvstore/` at the app-data root — those are **global**, shared by every profile, so wiping them while resetting one would silently change the others' identity too |
| **Default is archive** | the profile dir is renamed to `<profile>.reset-<UTC stamp>`, not deleted — a dev vault holds a real identity (iroh key, MLS state, room history) and a mistyped profile name should not be unrecoverable |
| **`--purge`** | deletes instead, and asks you to type `purge` to confirm (`-y` skips the prompt). Use it when the archives pile up |

The work is done by `scripts/reset_profile.sh`, which both launchers call before
they start anything (the app holds the store open while it runs). You can call
it directly: `scripts/reset_profile.sh [--purge] [-y] <profile>…`. It reads the
bundle identifier from `tauri.conf.json` rather than hardcoding the data
directory, and refuses a profile name containing a path separator.

To wipe *everything* Enigma owns, including the global bits, use the app's own
panic code (Settings → Lock) instead — that is the audited path.

### Pairing quick-start

1. **A**: Chat → *New chat* → name it → **Create**. A QR code appears (gold ★ host
   badge over Tor).
2. **B**: Chat → *Join a chat* → scan the QR (camera / image) or paste the ticket.
3. Both sides show **Encrypted** once the MLS handshake completes.

After the one-time pairing the app reconnects automatically (peer NodeIds are
persisted per room and re-resolved via iroh discovery) — no server, no accounts.
Restart B and it reopens the room and reconnects.

### Browser-only mode (UI shell, no P2P)

```bash
npm run dev -w enigma        # http://localhost:1420
```

Plain Vite with no Tauri runtime — renders the UI shell only. P2P and MLS need
the Rust backend, so chat does not function here; use it for pure-frontend work.

### Android emulator

Full walkthrough (boot AVD, `npm run tauri android dev`, driving via `adb`) is in
[apps/enigma/emulator.md](apps/enigma/emulator.md). One-time SDK/NDK/Java setup is
[below](#android-toolchain-setup--build). Short version, from `apps/enigma/`:

```bash
"$ANDROID_HOME/emulator/emulator" -avd Pixel_9 -no-snapshot-save -gpu swiftshader_indirect &
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 5; done
npm run tauri android dev     # auto-detects the emulator, builds, installs, launches
```

---

## Build configuration (`build_config.yaml`)

[`apps/enigma/src-tauri/build_config.yaml`](apps/enigma/src-tauri/build_config.yaml)
is the compile-time build config: `build.rs` parses + validates it and generates
Rust consts (`enigma_lib::build_config`); the shipped binary never re-reads the
file. **An invalid or missing file fails the build** with the offending YAML paths
listed. The checked-in defaults reproduce stock behavior exactly.

What it owns (see the file's comments and [technology.md](technology.md) §15 for
details):

- `cloud.allow_connections` — `false` builds a binary with no Enigma Cloud at
  all. Beacon (server location shares on the Maps tab, beacon.md) has no switch
  of its own: it exists exactly when this **and** `maps.enabled` are both true.
- `p2p.allow_hosted_relays` — `false` removes n0 relays + pkarr/DNS discovery
  (and, transitively, the DHT — it rides the same endpoint); direct QUIC
  (tickets) and Tor keep working, but reconnecting to a bare NodeId does not.
  `true` in every shipped edition for that reason.
- `dht.enabled` — `false` removes the **Mainline DHT only**: no ticketless
  join-by-room-code, no nickname directory, no presence. `discovery_enabled` /
  `nick_publish_enabled` return false ahead of the user's setting (so a profile
  carrying `dht_discovery: "on"` from a DHT-capable build reads as off without
  the key being rewritten), `dht_presence` / `dht_publish_nick` /
  `dht_find_nick` / `dht_apply` error `DHT_DISABLED`, and the whole DHT UI is
  hidden rather than disabled. Requires `p2p.allow_hosted_relays` — build.rs
  rejects the combination. Pro only.
- `crypto` — declared algorithms are **compile-asserted** against the vendored
  rotor_core/gervasius crates (editing the strings can't change the crypto; drift
  in either direction is a build error). Argon2id costs apply to newly created
  vaults only.
- `calls` / `contacts` / `calendar` / `peers` / `maps` — feature kill switches
  (`enabled: false` builds without the tab, redirects the route, and never
  instantiates the composable — so the feature's sync handlers and, for
  calls/contacts, its ALPN are absent from the binary). `calls` additionally
  makes every `vox_*` command error `CALLS_DISABLED`. These are what the product
  editions are made of — see [pland.md](pland.md). `peers` additionally
  withholds the `enigma/plink/0` ALPN and makes every `peer_*` command error
  `PEERS_DISABLED` (see peer.md); `maps` has no other knobs, because the app has
  no tile-fetch path at all — region packages are produced by the standalone
  `tools/map_packager` and imported from the device (see map.md Part II).
  (The `kanban`, `sketch` and `mind` sections were removed on 2026-07-27 when
  those features were parked — `limbo/frontend/*/NOTES.md` carries the exact
  YAML to paste back.)
- `devices.allow_linking` — `false` builds without device linking: no
  Files→Devices tab (pairing + per-file sync), every `devlink_*` command
  errors `DEVLINK_DISABLED`
  (see sync.md). Linking is pure P2P, so the shipped default is `true`.
- `features` / `settings` — new-profile defaults and settings defaults+clamps.
- `network` — frame cap (**wire-interop**: all peers must agree), onion port,
  chunk sizes, Tor timeouts.

`app:` must match `tauri.conf.json` (`productName`/`identifier`/`version`) —
`tauri.conf.json` stays authoritative and `build.rs` rejects drift. For an
edition with a `tauri.<edition>.conf.json` overlay, the comparison is against the
**merged** result (see *Each edition is its own installable app* below). The same
YAML drives desktop and Android builds (the codegen is target-agnostic).

### Editions (`ENIGMA_EDITION`)

The product line — **Light / Plus / Pro** — is three checked-in configs under
[`apps/enigma/src-tauri/configs/`](apps/enigma/src-tauri/configs/), selected by
an environment variable that `build.rs` reads:

```bash
ENIGMA_EDITION=light ./build_desktop.sh      # basic encrypted chat only
ENIGMA_EDITION=plus  ./run_dev.sh            # + voice calls (Vox), nothing else
ENIGMA_EDITION=pro   npm run build:android   # + DHT, contacts, device linking, calendar, maps, peers, cloud
./build_desktop.sh                           # unset → build_config.yaml (everything on)
```

Unset keeps the historical behavior: the top-level `build_config.yaml` is the
default and is what CI builds. An **unknown** edition name fails the build rather
than falling back, and `build.rs` declares `rerun-if-env-changed=ENIGMA_EDITION`,
so switching editions always regenerates rather than reusing a cached binary
(the Rust crate does recompile — expect a full rebuild when you switch).

The dev launchers `run_dev.sh` and `run2.sh` now default to
`ENIGMA_EDITION=pro` (cloud-capable, so the Cloud tab is exercisable — see
[cloud.md](cloud.md)); shipped/CI defaults are unchanged, and an explicit
`ENIGMA_EDITION=…` in the environment still wins.

Editions differ **only** in feature gates; `crypto`, `network` and `settings` are
identical across all three, deliberately — `network.max_frame_bytes` is
wire-interop sensitive and a Light peer must be able to share a room with a Pro
peer. Who gets what, and why, is [pland.md](pland.md).

#### Each edition is its own installable app (own data directory)

Tauri derives `app_data_dir` from the **bundle identifier** alone, so two builds
sharing an identifier share *everything*: the same `vault.json` (hence the same
passphrase prompt), the same protasius keyspace, the same rooms and MLS state.
That is why every edition declares its own identity, via a partial config the
tauri CLI deep-merges over `tauri.conf.json`:

| Edition | Identifier | Data directory | Binary |
|---|---|---|---|
| `light` | `com.spectrumaipl.enigma.light` | `…/com.spectrumaipl.enigma.light/` | `enigma-light` |
| `plus` | `com.spectrumaipl.enigma.plus` | `…/com.spectrumaipl.enigma.plus/` | `enigma-plus` |
| `pro` | `com.spectrumaipl.enigma.pro` | `…/com.spectrumaipl.enigma.pro/` | `enigma-pro` |
| `custom` | whatever the Enigma Builder sets | that identifier's directory | from its `productName` |
| unset | `com.spectrumaipl.enigma` | `…/com.spectrumaipl.enigma/` | `enigma` |

So a **release install and a test install can coexist** — separate packages,
separate desktop entries, separate vaults, separate passphrases.

The overlays are `apps/enigma/src-tauri/tauri.<edition>.conf.json`, passed with
`--config` by `run_dev.sh`, `run2.sh` and `build_desktop.sh` (all via
[`scripts/edition_conf.sh`](scripts/edition_conf.sh)). `build.rs` applies the
**same merge** before asserting the YAML matches — `edition_conf_overlay()`
there and the launcher helper must stay in lockstep, or a bundle would carry one
identity while the assertion checked another.

`custom` deliberately has **no** overlay: the Enigma Builder writes
`tauri.conf.json` directly (`tools/enigma_builder/identity.py`), so for that
edition the base file already *is* the effective identity — set the identifier
in the Builder's **Identity** tab to keep a custom build separate.

> **Moving existing data.** Changing an identifier means the app looks in a new
> directory; nothing is deleted. To carry a profile across:
> ```bash
> mv ~/.local/share/com.spectrumaipl.enigma/profiles/default \
>    ~/.local/share/com.spectrumaipl.enigma.pro/profiles/default
> ```
> Or just start fresh with `./run_dev.sh --reset`.

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

## Android — toolchain setup & build

Building an Android APK/AAB from an Ubuntu dev machine.

### Toolchain overview

| Tool | Version | Purpose |
|---|---|---|
| Java (OpenJDK) | 17 | Gradle & Android build tools |
| Android Studio | 2024.3.x | SDK manager UI (optional but recommended) |
| Android SDK | platform 35 | Android platform headers |
| Android NDK | 27.2.12479018 | Native (C/Rust) cross-compilation |
| Android Build Tools | 35.0.0 | `aapt2`, `d8`, `apksigner`, `zipalign` |
| CMake | 3.31.6 | Required by NDK toolchain |
| Rust | stable | Tauri Rust core + vendored crates |
| cargo-ndk | latest | Rust → Android NDK bridge |

### One-time setup (scripted)

```bash
bash scripts/setup_java.sh              # OpenJDK 17 (+ JAVA_HOME in ~/.bashrc)
bash scripts/install_android_studio.sh  # Studio, SDK 35, NDK, build tools, CMake, i386 libs
bash scripts/setup_rust_android.sh      # rustup Android targets + cargo-ndk
bash scripts/patch_cargo_android.sh     # Cargo.toml Android-compat check
source ~/.bashrc
```

Environment written to `~/.bashrc` / `~/.profile` (full reference):

```bash
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk-amd64"
export ANDROID_HOME="${HOME}/Android/Sdk"
export NDK_HOME="${ANDROID_HOME}/ndk/27.2.12479018"
export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"
```

Verify:

```bash
java -version                                   # must print "openjdk 17..."
sdkmanager --list_installed
ls "$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/" | grep aarch64
rustup target list --installed | grep android   # aarch64 / armv7 / x86_64 / i686
cargo ndk --version
```

Native-dependency notes: `webkit2gtk` is Linux-only (cfg-guarded; Android uses the
system WebView); `cpal` uses the `oboe-shared-stdcxx` feature on Android (already
declared in `Cargo.toml`); arti's transitive `rusqlite` is pinned `bundled` on
Android (the NDK ships no `libsqlite3` — the pin compiles SQLite from source); all
vendored crates are pure Rust and cross-compile fine; `pmtiles` (Maps) is pure
Rust too (mmap via `fmmap`) — no extra native deps.

Offline map assets: `apps/enigma/public/map/` bundles the Map tab's glyphs (a
Latin/Greek/Cyrillic subset of the Noto Sans stacks, OFL-licensed — `OFL.txt`
sits alongside) and the v4 light sprite sheet from
[protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets), so map
styling never fetches from a CDN. To widen script coverage, copy more range
`.pbf` files from that repo into the same folders. Sprites are bundled for
BOTH theme flavours (`sprites/v4/light*` and `sprites/v4/dark*`) — the Map tab
switches flavour with the app's dark mode, so a missing dark sheet would show
up as broken icons at night.

Map region packages are NOT built here: the standalone PyQt6 tool
[tools/map_packager](tools/map_packager) (`pip install -r requirements.txt`,
`python main.py`; pytest suite in `tools/map_packager/tests`) extracts
bbox/zoom subsets from any PMTiles archive over HTTP range requests and writes
`<name>.pmtiles` + `<name>.manifest.json` — the pair the app's
Maps → Regions → Import verifies (BLAKE3 + manifest, sidecar auto-detected).
For a no-GUI download, the same folder ships one-command scripts
(`./download_warsaw.sh`, `./download_gdansk.sh`) and a `download_map.py` CLI for
any bbox — see the tool's README.

### Build the APK / AAB

```bash
npm run build:android                             # debug APK (default)

# full control (build type + ABIs):
bash scripts/build_android.sh enigma debug                    # debug APK, aarch64
bash scripts/build_android.sh enigma release aarch64,x86_64   # release APK + AAB
```

`build_android.sh <app> [debug|release] [abi-spec]` runs `npm install`,
`tauri android init` (first time only — the generated project under
`src-tauri/gen/android/` is committed), then `tauri android build`. Valid ABIs:
`aarch64` (modern phones), `x86_64` (emulator), `armv7` (old 32-bit), `i686`
(32-bit emulator), or `all`.

Output:

```
apps/enigma/src-tauri/gen/android/app/build/outputs/
  apk/debug/app-debug.apk
  apk/release/app-release.apk       # release only
  bundle/release/app-release.aab    # release only
```

### Signing a release build

Generate a keystore once, then sign:

```bash
keytool -genkey -v -keystore enigma-release.jks -alias enigma \
  -keyalg RSA -keysize 4096 -validity 10000

apksigner sign --ks enigma-release.jks --ks-key-alias enigma \
  --out enigma-release-signed.apk app-release.apk
```

Or configure `src-tauri/gen/android/app/build.gradle.kts` with your signing config
before the release build — see the
[Tauri Android signing docs](https://tauri.app/distribute/sign/android/).

### Install & inspect on a device

```bash
adb devices
adb install apps/enigma/src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk
adb logcat -s RustStdoutStderr enigma
```

---

## CI builds

[.gitlab-ci.yml](.gitlab-ci.yml) builds Enigma on GitLab:

| Job | Stage | When | What |
|---|---|---|---|
| `frontend:build` | check | every commit | `vue-tsc` + `vite build`, asserts `dist/index.html` |
| `rotor:wasm` | build | every branch/tag | wasm-pack build of `rotor_wasm` (web + bundler) as a gate; 30-day artifacts with a `COMMIT` provenance stamp |
| `tauri:build` | build | every branch commit | full desktop bundle, asserts a `.deb`/`.AppImage`/`.rpm` was produced |
| `tauri:desktop` | build | tags / manual | release bundle, 30-day artifacts |
| `android:build` | build | manual | stubbed (not provisioned to a CI image yet) |

---

## Tests

```bash
npm test                                   # all workspaces
npm test -w enigma                         # vitest: chat store, components, i18n, …
npm test -w rakotis                        # vitest: transport bridge, storage, i18n
( cd apps/enigma/src-tauri && cargo test ) # Rust: tickets, DHT, Tor, kv, cloud, …
( cd cryptorotor/gervasius && cargo test ) # at-rest primitives
( cd protasius && cargo test )             # encrypted store
python apps/enigma/e2e.py                  # Playwright smoke tier (no backend — there is none)
```

---

## Troubleshooting

**Dev:**

- **Port 1420 already in use** — a stray Vite server is running.
  `npm run dev:tauri` reuses an existing server on `:1420`; otherwise kill the
  process holding the port (`lsof -i :1420`) and relaunch.
- **Window opens blank / WebKit errors** — the WebKitGTK dev libs above are
  missing or mismatched; reinstall them.
- **First Rust compile is very slow / high memory** — expected for the initial
  build; subsequent runs are incremental.
- **Map tab renders blank / "WebGL is unavailable" (Linux)** — WebKitGTK's
  DMABUF renderer breaks WebGL on NVIDIA and some hybrid-GPU stacks: the map
  canvas stays fully transparent while the rest of the UI paints normally.
  The app disables DMABUF itself on Linux (`main.rs` sets
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` before WebKit initializes), so this should
  not occur since 2026-07-21; export `WEBKIT_DISABLE_DMABUF_RENDERER=0` to
  re-enable DMABUF on a stack where it works. Only the map canvas needs WebGL,
  everything else is unaffected.

**Desktop build:**

- **`No space left on device` / linker (`collect2`) failure at the final link** —
  the release binary link step is large; this is almost always **disk space, not a
  code bug**. Free space (clear `target/`, docker/build caches) and retry.
- **`build_config.yaml is invalid` / `not found`** — the compile-time build config
  failed validation; the panic message lists the offending YAML paths (see
  [Build configuration](#build-configuration-build_configyaml)).
- **`rotor-core` build error** — it's the vendored crate at `cryptorotor/rotor_core`
  (no fetch involved); reproduce in isolation with `cd cryptorotor && cargo check -p rotor-core`.
- **`webkit2gtk` / `soup` not found** — install the desktop system libs above.
- **`frontendDist` doesn't exist** — the frontend build didn't run/produce
  `apps/enigma/dist/`; run `npm run build -w enigma` (or a full `./build_desktop.sh`).

**Android:**

- **`ANDROID_HOME` / NDK not found during `tauri android build`** —
  `source ~/.bashrc`, or export `ANDROID_HOME`/`NDK_HOME` per the reference above.
- **`linker aarch64-linux-android-clang not found`** — NDK not on PATH or wrong
  version; confirm with `ls "$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/" | grep aarch64`.
- **`ld.lld: unable to find library -lsqlite3`** — the Android `rusqlite { bundled }`
  pin in `Cargo.toml` is missing/removed; restore it.
- **`webkit2gtk` compile error when targeting Android** — should not happen (it's
  cfg-guarded to Linux); verify you're running `tauri android build`, not plain
  `cargo build`.
- **Gradle Java version mismatch** — `JAVA_HOME` must point at JDK 17 (not 11/21);
  re-run `scripts/setup_java.sh`.
