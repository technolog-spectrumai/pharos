# Dromon

Belisario's build: one engine that standardizes how every app is built. Each
app has one file, `apps/<app>/dromon.yaml`, saying what the app is and the named
ways to build it. There are no build flags, and an unknown key or value is an
error, never a default.

```sh
./build.sh vesper pro          # Vesper Professional
./build.sh vesper std          # Vesper Standard
./build.sh enigma              # Enigma26 — an app with one variant needs no name
./build.sh teutates            # Teutates
./build.sh vesper all          # every variant of one app
./build.sh all                 # every variant of every app

./build.sh APP [VARIANT] --dry-run    # the commands it resolves to; none run
./build.sh APP [VARIANT] --validate   # check the file against the checkout; build nothing
./build.sh --list                     # the apps and their variants

.\build.ps1 fuxia                     # on Windows: the same, through PowerShell
```

An app is any directory under `apps/` with a `dromon.yaml`; adding one is
adding that file.

| File | What it is |
|---|---|
| `build.ps1` (repo root) | The Windows preflight: node, npm and cargo working, Rust on the MSVC toolchain, the C++ build tools, `node_modules` in step, OpenSSL from vcpkg for an app that links it. Then the same `dromon.mjs`. |
| `build.sh` (repo root) | The preflight: node, npm and cargo present and working, the system libraries, the snap trap, `node_modules` in step with `package-lock.json`. Then hands over to `dromon.mjs`. |
| `dromon/dromon.mjs` | The driver: finds the apps, asks the checkout its facts (cargo metadata, tauri.conf.json), runs the plan, delivers the packages. |
| `dromon/plan.mjs` | The planner: YAML → validated app and variant → ordered steps. Pure — no disk, no processes — so all of it is unit-tested (`plan.test.mjs`, which also validates every app's real file). |
| `tools/android/` | `build_android.sh` and the signing checks, which the plan calls for an Android build. |

## `apps/<app>/dromon.yaml` — schema 1

```yaml
schema: 1

app:                                     # what the app IS
  kind: tauri                            # the only kind so far: a Tauri 2 app
  identifier: com.spectrumaipl.enigma26  # names the app's data directory; never changes
  cargo:
    workspace: .                         # the cargo workspace it builds in ("." = repo root)
    package: enigma                      # the app's crate
    test_packages: [protasius]           # crates it owns, tested beside it in its tests.sh
  frontend:                              # optional
    workspace: apps/enigma               # default: the app's directory
    entry: index.html                    # default: index.html
  android: true                          # has an Android build (default false)
  forbid_crates: [openssl-sys]           # no build of this app may link these
  cli:                                   # optional: command-line tools shipped with the app
    - { package: irena-cli, bin: teutates, workspace: apps/irena }   # workspace: default the app's

variants:                                # the named ways to build it
  std:
    output_dir: dist/vesper-std          # packages land in <output_dir>/<app>/
    features: [hosted_relays, contacts, keyring, pin_unlock]
    forbid_crates: [mainline, rustfft]
    test: false                          # smoke checks first (full suites: ./user_tests.sh)
    desktop:
      enabled: true
      profile: release                   # release | debug
      bundles: [deb, rpm]                # this host's formats only; omit for tauri.conf.json's
      # …or one list per OS, of which each host builds its own:
      # bundles: { linux: [deb, rpm], windows: [msi, nsis], macos: [dmg] }
      windows:                           # required when Windows packages are listed
        signing: certificate             # none | certificate | command
        webview2: embed                  # download | embed | offline | skip
    android:
      enabled: false
      profile: debug                     # debug | release
      abis: [aarch64]                    # aarch64 | x86_64 | armv7 | i686, or [all]
      signing: debug-key                 # debug-key | release-key | none
    cli:                                 # only for an app with app.cli
      enabled: true
      profile: release
      bundle: true                       # also put them in the .deb/.rpm, in /usr/bin
```

The app's directory is where the file is; the app's name is that directory's.
Checked against the checkout on every run: the identifier must equal the one in
`src-tauri/tauri.conf.json`, and every package named must exist in the cargo
workspace.

| Variant key | Meaning |
|---|---|
| `output_dir` | Required. Two variants delivering to the same place are refused. |
| `features` | The **allowlist**: exactly the optional cargo features compiled in. Required for an app whose crate has a `[features]` table, refused for one without. Every id must exist, and the list must be closed under requirements (`dht` needs `hosted_relays`, so a list with `dht` must name both). Cargo gets it as `--features`; the frontend gets it as `<APP>_FEATURES` in the environment, so the bundler drops the omitted features' code too. An app whose crate turns features on by `default` is refused: its list could not be exact. |
| `forbid_crates` | Crates this variant must not link, on top of the app's. Checked with `cargo tree` for exactly this build's selection **before anything compiles**; one found refuses the build. |
| `test` | Smoke checks before packaging: the app's `smoke` npm script (a handful of essential tests). Fast unit tests: `./fast_tests.sh`; everything, integration and e2e included: `./user_tests.sh`. |
| `desktop` | A Tauri bundle. Tauri compiles for the machine it runs on, so a format another OS builds is refused up front, naming the OS that can. |
| `desktop.bundles` | One list (this host's formats: `deb`, `rpm`, `appimage` on Linux; `dmg`, `app` on macOS; `msi`, `nsis` on Windows), or a map `linux:` / `windows:` / `macos:` → list. With a map, each host builds its own list, and a host the map does not name is refused for that variant. |
| `desktop.windows.signing` | Required for Windows packages; never assumed. `certificate`: Authenticode with a certificate in the Windows certificate store, its thumbprint in `DROMON_WINDOWS_CERT_THUMBPRINT` (SHA-256, timestamped at `DROMON_WINDOWS_TIMESTAMP_URL`, default DigiCert's). `command`: `DROMON_WINDOWS_SIGN_COMMAND` signs `%1` (a cloud signer, a hardware token). `none`: unsigned — SmartScreen warns on every install; for testing. The variables are checked on Windows only, before anything compiles. |
| `desktop.windows.webview2` | How the installer gets WebView2 where it is missing: `download` (a bootstrapper fetches it; the default), `embed` (the bootstrapper inside the installer), `offline` (the whole runtime inside, about 130 MB), `skip`. |
| `android` | Through `tools/android/build_android.sh`, with the same feature list. `signing`: `debug-key` (debug builds, always), `release-key` (the app's keystore — the default for release), `none` (a release deliberately not signed: it installs nowhere and must never be distributed). |
| `cli` | `cargo build --locked` of the app's tools, in each tool's workspace (`app.cli[].workspace`, default the app's), before the desktop bundle, delivered beside the packages. `bundle: true` also puts them in the Linux `.deb`/`.rpm` at `/usr/bin/<bin>` (a Tauri `bundle.linux.{deb,rpm}.files` config merged over `tauri.conf.json`, `<target>/dromon/<app>-<variant>-cli.json`); it needs a `deb` or `rpm` in the variant. Teutates ships `teutates`, `bornite` and `prunella` from `apps/irena` this way. |
| `enabled: false` | Keeps a section's settings for later and builds nothing from it. |

`node dromon/dromon.mjs APP VARIANT --print-features` prints a variant's
validated feature list and nothing else — what a dev runner or a test script
uses to build the same thing (`./run_dev.sh vesper std` does).

## Windows

`.\build.ps1 APP [VARIANT]` on a Windows machine with Node 22, Rust (MSVC)
and the Visual Studio C++ build tools; Tauri fetches WiX and NSIS itself. The
Windows settings reach `tauri build` as a config file merged over
`tauri.conf.json` (`<target>/dromon/<app>-<variant>-windows.json`), so nothing
in the app's own config changes. An app that links OpenSSL (Morion) takes it
from vcpkg: `vcpkg install openssl:x64-windows-static-md` and `VCPKG_ROOT`
set; it is linked into the program, so the installer carries no OpenSSL DLL.

`.github/workflows/windows.yml` runs this for Fuxia, Spinnel and Morion on
GitHub's Windows runners and keeps the installers as artifacts; with the
`WINDOWS_CERTIFICATE` (base64 PFX) and `WINDOWS_CERTIFICATE_PASSWORD` secrets
it imports the certificate and passes its thumbprint on.

## What a build leaves

`<output_dir>/<app>/` holds the packages, a `SHA256SUMS`, and `build.json`: the
commit and whether the tree was clean, the app file and variant, the resolved
features and platforms, every step with its command, status and time, and every
artifact with its size and hash. A failed or refused build writes `build.json`
too, with `"result": "failed"` or `"refused"`.

## Feature isolation

Enigma and Morion share one cargo workspace and one `Cargo.lock`. Cargo **unifies
features across every package one invocation selects**: `cargo build --workspace`
would compile gervasius with the `gervazy` half Morion turns on, and so link
OpenSSL into Enigma — and a `--workspace` build of an app's Standard variant
would get whatever its Professional variant's crates turn on in the crates they share.

So Dromon never selects more than one app:

- every cargo command names the app's package with `-p` — plus, for tests, only
  the crates the app's file says it owns — and never `--workspace`;
- every cargo command for an app with features passes `--no-default-features`
  and the exact list;
- `tauri build` runs in the app's `src-tauri/`, which builds that one package;
- before anything compiles, `cargo tree` for exactly that selection must contain
  none of the `forbid_crates` (Enigma: `openssl-sys`, `mainline` and `rustfft`;
  a Standard variant also forbids the crates its Professional features bring).

`plan.test.mjs` holds the planner to all of it, and `./tests.sh base` runs the
preflight for every variant (`./build.sh all --validate`).

## Independence

Each app builds alone: `./build.sh morion` compiles Morion's crate and what it
depends on, nothing of Enigma's or Irena's. The cargo target directory is shared
per workspace, so a crate both apps use at the same features is compiled once;
Irena has its own workspace and target directory (`apps/irena/target`).
