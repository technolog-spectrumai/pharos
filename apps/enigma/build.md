# Enigma26 — Build & Run

How to run Enigma26 in dev and package it into installable artifacts. Enigma26 is a
Tauri 2 (Vue 3 frontend + Rust backend) app; a "build" compiles the frontend
(`vue-tsc` + Vite) and the Rust core, then bundles them. For how the app *works*
(architecture, crypto, conventions, config sources) see
[technology.md](technology.md).

Contents: [Prerequisites](#prerequisites) · [First-time setup](#first-time-setup) ·
[Run (dev)](#run-dev) · [Build configuration](#build-configuration-build_configyaml) ·
[Editions](#editions-enigma_edition) ·
[Building](#building-buildyaml) ·
[Desktop build](#desktop-build) · [Android](#android--toolchain-setup--build) ·
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
([crates/rotor/](crates/rotor) — `rotor-core`, `gervasius`) and consumed by
`src-tauri` as path dependencies, as are [protasius/](protasius) and the
`rakotis` npm workspace package — there is nothing to authenticate or configure.
The whole build is offline-friendly once crates.io/npm are cached.

Android has its own, larger toolchain (JDK 17, Android SDK/NDK, cargo-ndk) — see
[Android](#android--toolchain-setup--build) below.

---

## First-time setup

```bash
npm ci             # once, at the repo root — sets up the workspace + all packages
```

`./run_dev.sh`, `./run2.sh` and `./build.sh` do this themselves when the root
`node_modules` is missing, so a fresh clone can go straight to either.

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

The launchers work from VS Code's integrated terminal even when VS Code is the
snap: they restore the environment the snap overrides before starting the app
(`scrub_snap_env` in [scripts/lib.sh](scripts/lib.sh)). Without that the build
succeeds and the window never opens — see [Troubleshooting](#troubleshooting).

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

To wipe *everything* Enigma26 owns, including the global bits, use the app's own
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
[below](#android--toolchain-setup--build). Short version, from `apps/enigma/`:

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
  rejects the combination. Standard and up.
- `crypto` — declared algorithms are **compile-asserted** against the vendored
  rotor_core/gervasius crates (editing the strings can't change the crypto; drift
  in either direction is a build error). Argon2id costs apply to newly created
  vaults only.
- `calls` / `contacts` / `calendar` / `maps` — feature kill switches
  (`enabled: false` builds without the tab, redirects the route, and never
  instantiates the composable — so the feature's sync handlers and, for
  calls/contacts, its ALPN are absent from the binary). `calls` additionally
  makes every `vox_*` command error `CALLS_DISABLED`. These are what the product
  editions are made of — see [pland.md](pland.md). `maps` has no other knobs,
  because the app has no tile-fetch path at all — region packages are produced
  by the standalone `tools/map_packager` and imported from the device (see
  map.md Part II).
  (The `kanban`, `sketch` and `mind` sections were removed on 2026-07-27 when
  those features were parked — `limbo/frontend/*/NOTES.md` carries the exact
  YAML to paste back. `devices.allow_linking` and `peers.enabled` went the same
  way on 2026-08-18, taking the `settings.devlink_pair_window_secs`,
  `settings.devlink_resync_secs` and `settings.peer_resync_secs` clamps with
  them; the restore playbooks are
  [limbo/frontend/devices/NOTES.md](limbo/frontend/devices/NOTES.md) and
  [limbo/frontend/peers/NOTES.md](limbo/frontend/peers/NOTES.md). The `cloud`
  section went in 2026-08 with Enigma Cloud itself; unlike the parked features
  it was deleted outright, so there is no YAML to restore — see
  [limbo/removed/cloud.md](limbo/removed/cloud.md) and technology.md §16.)
- `lock.pin_unlock` / `keyring.enabled` — two smaller kill switches: `false`
  removes the PIN keypad (`vault_pin_*` → `PIN_UNLOCK_DISABLED`) and the key
  ring (`keyring_*` → `KEYRING_DISABLED`). The key ring is an edition
  differentiator, PIN unlock is on in all three. Per-file locking sits under
  neither — it is always compiled in.
- `features` / `settings` — new-profile defaults and settings defaults+clamps.
- `network` — frame cap (**wire-interop**: all peers must agree), onion port,
  chunk sizes, Tor timeouts.

`app:` must match `tauri.conf.json` (`productName`/`identifier`/`version`) —
`tauri.conf.json` stays authoritative and `build.rs` rejects drift. For an
edition with a `tauri.<edition>.conf.json` overlay, the comparison is against the
**merged** result (see *One fixed app identity* below). The same
YAML drives desktop and Android builds (the codegen is target-agnostic).

### Editions (`ENIGMA_EDITION`)

The product line — **Basic / Standard / Professional** — is three checked-in
configs under
[`apps/enigma/src-tauri/configs/`](apps/enigma/src-tauri/configs/), selected by
an environment variable that `build.rs` reads:

```bash
ENIGMA_EDITION=basic        ./run_dev.sh    # contacts, calendar, PIN unlock
ENIGMA_EDITION=standard     ./run_dev.sh    # + relays, DHT, keyring, voice calls
ENIGMA_EDITION=professional ./run_dev.sh    # + maps (the dev default)
```

A **build** names its edition in [build.yaml](build.yaml) instead
(`apps.enigma.edition`), and `./build.sh` sets the variable from it — see
[Building](#building-buildyaml).

Unset keeps the historical behavior: the top-level `build_config.yaml` is the
default. An **unknown** edition name fails the build rather
than falling back, and `build.rs` declares `rerun-if-env-changed=ENIGMA_EDITION`,
so switching editions always regenerates rather than reusing a cached binary
(the Rust crate does recompile — expect a full rebuild when you switch).

The dev launchers `run_dev.sh` and `run2.sh` now default to
`ENIGMA_EDITION=professional`, the everything-on edition, so every gated surface is
exercisable in a dev run; shipped/CI defaults are unchanged, and an explicit
`ENIGMA_EDITION=…` in the environment still wins.

Editions differ **only** in feature gates; `crypto`, `network` and `settings` are
identical across all three, deliberately — `network.max_frame_bytes` is
wire-interop sensitive and a Basic peer must be able to share a room with a
Professional peer. Who gets what, and why, is [pland.md](pland.md).

#### One fixed app identity

Every edition now builds as the same installable app:

| Value | Fixed setting |
|---|---|
| App name | `Enigma26` |
| Bundle identifier / Android package id | `com.spectrumaipl.enigma26` |
| Desktop binary name from edition overlays | `enigma26` |
| Data directory | `…/com.spectrumaipl.enigma26/` |

Editions differ only in feature gates. They do **not** get separate Android
package ids or separate desktop data roots, so they update/replace the same app
instead of installing side by side.

The overlays are still `apps/enigma/src-tauri/tauri.<edition>.conf.json`,
passed with `--config` by `run_dev.sh` and `run2.sh` (via
[`scripts/edition_conf.sh`](scripts/edition_conf.sh)) and by `build.sh`. They keep the same
fixed identity, and `build.rs` rejects any hand-edited config that tries to
change the app name or identifier.

> **Moving existing data.** The package id changed from
> `com.spectrumaipl.enigma` to `com.spectrumaipl.enigma26`. Existing desktop
> data is not deleted; the new build looks in a new app-data directory. To carry
> a profile across:
> ```bash
> mv ~/.local/share/com.spectrumaipl.enigma/profiles/default \
>    ~/.local/share/com.spectrumaipl.enigma26/profiles/default
> ```
> Or just start fresh with `./run_dev.sh --reset`.

### Building (`build.yaml`)

There is one way to build, for both apps: edit [build.yaml](build.yaml) at the
repo root and run `./build.sh`. There is no builder GUI and there are no build
flags — the file is the whole interface.

```bash
./build.sh                 # every app in build.yaml
./build.sh enigma          # one app (or several: ./build.sh enigma morion)
./build.sh --dry-run       # print the commands the file resolves to, run none
./build.sh --config FILE   # read another file with the same shape
npm run build              # -> ./build.sh
```

```yaml
output_dir: dist              # packages are copied to dist/<app>/ with a SHA256SUMS

apps:
  enigma:
    edition: professional     # -> configs/build_config.professional.yaml
    test: false               # run the frontend + Rust suites first
    desktop:
      enabled: true
      profile: release        # release | debug
      bundles: [deb, rpm]     # this host's formats only
    android:
      enabled: false
      profile: debug          # debug | release (release needs a signing key)
      abis: [aarch64]
      allow_unsigned_release: false
  morion:
    test: true
    desktop: { enabled: true, profile: release, bundles: [deb, rpm] }
```

| Key | Meaning |
|---|---|
| `output_dir` | where finished packages are copied, one folder per app, with `SHA256SUMS`. Omit to leave them where cargo and gradle put them |
| `apps.<app>` | any directory under `apps/` with a `src-tauri/` — today `enigma` and `morion` |
| `edition` | Enigma only. Names `configs/build_config.<edition>.yaml`, which is where the **features** are set (previous section); `build.sh` exports `ENIGMA_EDITION` and passes the edition's `tauri.<edition>.conf.json` overlay. Omit for the plain `build_config.yaml`. `custom` is a gitignored file of your own |
| `test` | run `npm run test -w apps/<app>` and the Rust suite before building; a failure stops the build |
| `desktop.profile` | `release` or `debug` |
| `desktop.bundles` | package formats. Tauri does not cross-compile, so a format this host cannot produce is **refused before anything runs**. Omit to use `bundle.targets` from the app's `tauri.conf.json` |
| `android.*` | handed to [`scripts/build_android.sh`](scripts/build_android.sh) — see [Android](#android--toolchain-setup--build) |
| `enabled: false` | on `desktop` / `android`: keep the settings, build nothing |

An unknown key or value is an error that names its path
(`apps.enigma.desktop.profile: must be release or debug`), never a silent
default, and every problem is reported at once.

`build.sh` is a preflight (toolchain, a working npm, dependencies, the snap
environment) and hands over to [`scripts/build.mjs`](scripts/build.mjs); the
mapping from the file to commands is
[`scripts/build_plan.mjs`](scripts/build_plan.mjs), covered by
`npm run test:build`.

The **app icon is fixed** — not a per-build choice. One mark, whose master is
[`apps/enigma/app-icon.png`](apps/enigma/app-icon.png); the generated sizes
under `src-tauri/icons/` are committed. Changing it is a code change:
[icons.md](icons.md).

---

## Desktop build

Set `apps.enigma.desktop` in [build.yaml](build.yaml) and run:

```bash
./build.sh enigma
```

`profile: debug` gives a faster, unoptimized bundle. The frontend build runs
automatically via Tauri's `beforeBuildCommand`.

Which formats come out is `desktop.bundles` in `build.yaml` (falling back to
`bundle.targets` in `tauri.conf.json` when the key is omitted). The build fails
if *no* package appears, but not if fewer appear than you expected — read the
"Built" list it prints before a release. Output, also copied to
`dist/enigma/`:

```
apps/enigma/src-tauri/target/release/bundle/     # release
apps/enigma/src-tauri/target/debug/bundle/       # profile: debug
  deb/Enigma26_<ver>_amd64.deb
  rpm/Enigma26-<ver>-1.x86_64.rpm
  appimage/Enigma26_<ver>_amd64.AppImage         # only if "appimage" is in bundle.targets
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

Set `apps.enigma.android.enabled: true` in [build.yaml](build.yaml) — with
`profile` and `abis` — and run `./build.sh enigma`. That calls:

```bash
bash scripts/build_android.sh enigma debug                    # debug APK, aarch64
bash scripts/build_android.sh enigma release aarch64,x86_64   # release APK + AAB
```

`build_android.sh <app> [debug|release] [abi-spec]` runs `npm install`,
`tauri android init` (first time only — the generated project under
`src-tauri/gen/android/` is committed), then `tauri android build`. Valid ABIs:
`aarch64` (modern phones), `x86_64` (emulator), `armv7` (old 32-bit), `i686`
(32-bit emulator), or `all`.

Output — the selected ABIs are packed into ONE `universal` APK (Gradle's
`universal` flavour), so the paths do not vary with `abi-spec`:

```
apps/enigma/src-tauri/gen/android/app/build/outputs/
  apk/universal/debug/app-universal-debug.apk
  apk/universal/release/app-universal-release.apk     # release only
  bundle/universalRelease/app-universal-release.aab   # release only
```

`build.sh` copies these into `dist/enigma/` with the app name in place of
Tauri's generic `app-` prefix (`enigma-universal-release.apk`), because the
Tauri names are identical between apps.

### Signing a release build

Release signing **fails closed**: with no keystore configured, a release build
is refused before any work starts, and the SDK debug key (publicly known) is
rejected for release outright — by path, filename, or the `androiddebugkey`
alias. Debug builds keep the debug key and are unaffected.

One-time setup, with the stdlib-only checker the build itself calls
([scripts/android_signing/](scripts/android_signing)):

```bash
SIGN="python3 scripts/android_signing/signing_cli.py"
GEN=apps/enigma/src-tauri/gen/android

# Mint a release keystore (outside the repo, chmod 600, RSA 4096) — the tool
# warns loudly: losing this key permanently orphans every distributed install.
$SIGN create

# Would a release sign, and where does each credential come from?
$SIGN status --gen $GEN

# Build a signed release (android: { enabled: true, profile: release } in
# build.yaml). Artifacts are verified with apksigner afterwards and the report
# prints package, version, signer and SHA-256 fingerprint.
./build.sh enigma

# After confirming the first build, pin the fingerprint (committed file) so a
# swapped or regenerated keystore FAILS the build instead of shipping:
$SIGN pin --pin-file apps/enigma/deploy/android-release-key.properties --from <apk>

# Inspect any artifact:
$SIGN verify <apk-or-aab>
```

Credentials resolve per key from: a `${VAR}` placeholder in
`gen/android/keystore.properties` → the `ENIGMA_KEYSTORE_FILE` /
`ENIGMA_KEYSTORE_PASSWORD` / `ENIGMA_KEY_ALIAS` / `ENIGMA_KEY_PASSWORD`
environment variables → a literal in `keystore.properties` → 
`~/.config/enigma-builder/signing.properties` (must be chmod 600). Passwords
never live in source control and never appear on an argv.
`gen/android/keystore.properties.example` is the committed template and
documents the four keys; `signing_cli.py --help` lists the commands.

An **unsigned release** for internal inspection is a deliberate act, never a
fallback: `allow_unsigned_release: true` under `android:` in `build.yaml`
(`scripts/build_android.sh enigma release aarch64 --allow-unsigned-release`).
It installs nowhere, says so loudly, and still refuses the debug
key. The pinned fingerprint lives in
`apps/enigma/deploy/android-release-key.properties` — deliberately outside
`gen/android`, which `tauri android init` regenerates.

### Install & inspect on a device

```bash
adb devices
adb install apps/enigma/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb logcat -s RustStdoutStderr enigma
```

---

## CI builds

[.gitlab-ci.yml](.gitlab-ci.yml) builds Enigma26 on GitLab:

| Job | Stage | When | What |
|---|---|---|---|
| `frontend:build` | check | every commit | `vue-tsc` + `vite build`, asserts `dist/index.html` |
| `tauri:build` | build | every branch commit | `./build.sh enigma` — the desktop bundle `build.yaml` describes; fails if no package was produced |
| `tauri:desktop` | build | tags / manual | release bundle, 30-day artifacts |
| `android:build` | build | manual | stubbed (not provisioned to a CI image yet) |

---

## Tests

```bash
npm test                                   # all workspaces
npm test -w enigma                         # vitest: chat store, components, i18n, …
npm test -w rakotis                        # vitest: transport bridge, storage, i18n
( cd apps/enigma/src-tauri && cargo test ) # Rust: tickets, DHT, Tor, kv, maps, …
( cd crates/rotor/gervasius && cargo test ) # at-rest primitives
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
- **Every `npm` command dies with `Cannot find module 'graceful-fs'`** — npm
  itself is broken, not the repo: npm keeps its own dependencies in a
  `node_modules` beside it, and a disk cleanup that deletes every `node_modules`
  it finds takes that one too. Reinstall the Node version
  (`nvm install <version>`); the launchers detect this and say so.
- **`sh: 1: vite: not found` / `tauri: not found`** — the root `node_modules` is
  gone (same cleanup, usually). `npm ci` at the repo root; the launchers do it
  themselves when the directory is missing.
- **Build succeeds, then `symbol lookup error: /snap/core20/…/libpthread.so.0:
  undefined symbol: __libc_pthread_init`** — the app was started with a snap's
  GTK environment (VS Code's integrated terminal, when VS Code is the snap).
  `run_dev.sh`, `run2.sh` and Morion's runner undo that themselves; a binary
  started by hand from such a terminal still needs a normal shell.
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
- **`rotor-core` build error** — it's the in-repo crate at
  `crates/rotor/rotor_core` (no fetch involved); reproduce in isolation
  with `cd crates/rotor && cargo check -p rotor-core`.
- **`webkit2gtk` / `soup` not found** — install the desktop system libs above.
- **`frontendDist` doesn't exist** — the frontend build didn't run/produce
  `apps/enigma/dist/`; run `npm run build -w enigma` (or a full `./build.sh enigma`).

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
