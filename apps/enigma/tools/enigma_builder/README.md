# Enigma Builder

A PyQt6 desktop tool for configuring and building Enigma: pick the features to
compile in, review the generated build config, choose Linux desktop or Android,
and run the build with live output and a working cancel.

```bash
cd tools/enigma_builder
python -m venv venv && venv/bin/pip install -r requirements.txt
venv/bin/python main.py
```

## Standalone

`bash package.sh` produces `dist/enigma-builder`: one ~73 MB file with Python
and Qt inside it, needing neither on the machine that runs it. Copy it anywhere.

It does not have to live in the repo. The checkout is *resolved* rather than
assumed — `--repo`, then the remembered choice, then `$ENIGMA_REPO`, then a
search upwards from the program and from the working directory. On a first run
that finds nothing, it asks; after that it remembers. You can also change it any
time from the **Repository** row on the Build tab.

```bash
./enigma-builder                       # asks on first run, remembers after
./enigma-builder --repo ~/src/enigma   # explicit, for this run only
ENIGMA_REPO=~/src/enigma ./enigma-builder
./enigma-builder --check               # print what it resolved, then exit
```

`--check` is the thing to run when a build behaves oddly: it prints which
checkout is in use, where that came from, whether every required file is
present, and the default output folder. It exits non-zero if the repo is
missing or incomplete.

PyInstaller does not cross-compile — run `package.sh` on the platform you want a
binary for.

## Two tools in one binary

The Builder is splitting into **Config Builder** (define the product, save a
deterministic, git-friendly product-config file) and **Builder** (consume that
file and produce the app). One codebase, three launch modes:

```bash
enigma-builder                       # the classic combined window (unchanged)
enigma-builder config [product.yaml] # Config Builder: no Build tab; its output
                                     # is a FILE, never an artifact
enigma-builder build product.yaml    # Builder: consumes the file read-only —
                                     # headless by default, --gui for a window
enigma-builder build product.yaml --platform android --release
```

A product config is the build-config YAML itself (same schema build.rs
compiles, rendered deterministically so diffs stay meaningful) plus an
optional Builder-owned `branding:` block for the icon — stripped before
anything reaches build.rs. The checked-in edition presets ARE product configs.
The boundary is structural: config mode never invokes a build script, build
mode never shows an editing surface, and a headless product build records
`build-info.json` (config path + sha256, identity, options, and — for Android
release — each artifact's signing classification and fingerprint) beside the
collected artifacts.

## CLI

The same binary is a headless CLI when given a subcommand (the program is
`enigma-builder`; if you want the short name, `ln -s enigma-builder enigma` —
the help text keeps the real name):

| Command | What |
|---|---|
| `enigma-builder build android [--release] [--unsigned] [--abi SPEC]` | run scripts/build_android.sh exactly as the Build tab would |
| `enigma-builder signing android status` | report whether a release would sign, and where each credential comes from |
| `enigma-builder signing android create` | mint a release keystore (outside the repo) with the loss warnings |
| `enigma-builder signing android verify [ARTIFACT]` | classify DEBUG / UNSIGNED RELEASE / SIGNED RELEASE with package, version and SHA-256 |
| `enigma-builder signing android pin --from <apk> [--rotate]` | record the release fingerprint every later build must match |

All of these run without opening a window; `signing_cli.py` itself needs no
Qt and is what `scripts/build_android.sh` calls for its own checks — one
implementation, no drift.

## What it writes

Three things, and nothing else:

| Path | When |
|---|---|
| `apps/enigma/src-tauri/configs/build_config.custom.yaml` | every build (gitignored) |
| `apps/enigma/src-tauri/tauri.conf.json` | if you change the app identity or narrow the target distribution |
| `apps/enigma/src-tauri/icons/**` and the Android launcher | only if you change the app icon |
| your chosen **output folder** | after a successful build, if collecting is on |

**It never runs git.** If a build changes the identity, the Builder says so
first, and restores the committed values afterwards unless you turn that off on
the Identity tab.

## Why every build is `ENIGMA_EDITION=custom`

`build.rs` bakes one YAML into compile-time consts, chosen by `ENIGMA_EDITION`:
unset picks `build_config.yaml`, and `basic` / `standard` / `professional` / `custom` pick
`configs/build_config.<edition>.yaml`. The Builder always materializes the form
into the `custom` file and builds that — even when the form matches a preset
exactly.

The reason is the identity assert. `build.rs` requires
`app.{name,identifier,version}` to equal `tauri.conf.json`'s
`productName` / `identifier` / `version`. If the Builder edited identity *and*
built preset editions, one identity change would invalidate all four checked-in
configs at once. Writing only `custom` means the product-line files stay exactly
as `pland.md` defines them, and at most one tracked file is ever touched.

Presets are therefore value *sources* for the form, not build targets. Their
values are read from the checked-in YAML at runtime, never hardcoded — a
comment drifting from a value has happened before in the edition files, and
the values are what compiles.

One consequence worth knowing: after an automatic identity restore, a *manual*
`ENIGMA_EDITION=custom cargo build` fails the equality assert until the Builder
regenerates. The custom YAML is builder-owned output; regenerate it from the GUI.

## Tabs

- **Features** — Basic / Standard / Professional presets, the ten build gates, the four
  runtime defaults, and a live preview of the YAML that will be written. The
  Custom chip is an indicator: change any gate and it lights up on its own.
- **Identity** — product name, bundle identifier, version and the app icon,
  plus the current state of `tauri.conf.json` and a restore button if a
  previous run left it modified.
- **Expert** — settings clamps and network tuning behind a toggle, with the
  crypto declarations shown read-only. `max_frame_bytes` is flagged: peers in
  one room must agree on it.
- **Build** — the repository being driven, target platform and distribution,
  build type, Android ABIs, the output folder, the Android toolchain check,
  free-disk warning, log, the installed-package card with its Uninstall
  button, and the artifact list.

Validation mirrors `build.rs` rule for rule — same paths, same wording — so an
error here reads the same as the one cargo would print. A blocking error
disables **Start build** and marks the owning tab with ⚠.

## What it runs

| Selection | Command (from the repo root, with `ENIGMA_EDITION=custom`) |
|---|---|
| Desktop | `bash build_desktop.sh [--debug]` |
| Android | `bash scripts/build_android.sh enigma <debug\|release> <abis>` |
| Both | `bash apps/enigma/deploy/build.sh both <debug\|release> <abis>` |

Only **Both** needs `deploy/build.sh`, because that script is what sequences the
two legs — and it always builds the desktop bundle as release, so the debug
choice applies to Android only. The GUI says so when you pick that combination.

### Only packages this build produced

Ticked by default. `deploy/build.sh` collects a **Both** build with
`find … -exec cp {} deploy/dist/`, which sweeps up *every* package sitting in
`src-tauri/target/release/bundle` — including ones left by earlier builds and by
older app identities — and `cp` stamps each copy with the current time, so a
timestamp cannot tell them apart from what this build just made. A single build
would otherwise report (and re-collect) a decade of `Enigma_*`, `EnigmaApp_*`
and `enigma_*` packages as its own output.

So the Builder digests the output directories *before* building and, afterwards,
drops any package whose bytes are unchanged. A rebuild that produces the same
filename with different content still counts — it is the content, not the name,
that decides.

**Nothing is ever deleted.** Old installers stay exactly where they are, to be
archived by hand; they are only kept out of the artifact list and the output
folder. Untick the box to go back to collecting everything the old way.

Collecting into the **output folder** is a copy step performed afterwards in
Python, with a freshly generated `SHA256SUMS`. Doing it here rather than letting
`deploy/build.sh` do it means the folder you choose never changes which script
runs, and it works identically for all three targets. Android files pick up the
`enigma-` prefix on the way, because Tauri's `app-universal-*.apk` names are
otherwise indistinguishable between builds.

Cancel signals the whole process group, then escalates to SIGKILL after ten
seconds: the scripts spawn npm, cargo, tauri and gradle, and terminating only
bash would leave a multi-gigabyte compile running unattended. A gradle daemon
that has already detached survives, harmlessly.

## Target distribution

Two choices, both ticked by default: **Ubuntu / Debian (.deb)** and
**Fedora / RHEL (.rpm)**. The selection is written to `bundle.targets` in
tauri.conf.json for the duration of the build, because both `build_desktop.sh`
and `deploy/build.sh` call a bare `npx tauri build` — editing the config reaches
every path without changing either script. The file is restored afterwards, the
same as the app identity.

**This picks a package format, not a build environment.** Tauri packages what
the host just compiled, so an `.rpm` produced on Ubuntu links against Ubuntu's
glibc and webkit2gtk and will very likely refuse to run on Fedora. The Builder
detects the host from `/etc/os-release` and says so, rather than letting the
label imply a cross build:

> ⚠ You are building on Ubuntu 24.04.4 LTS. The Fedora / RHEL package will be
> linked against this system's glibc and webkit2gtk, so it is unlikely to run on
> a real target. For a package that works, run the build inside a container or
> VM of that distribution.

Untick everything and **Start build** is disabled — a desktop build with no
format selected produces nothing. Artifact discovery follows the selection too,
so a Fedora-only build never reports a leftover `.deb` as its output.

## Test run

The **Test run** card on the Build tab launches the binary the build produced
(`src-tauri/target/<type>/enigma`) with `ENIGMA_EDITION=custom`, the chosen
`APP_PROFILE`/`CHAT_USER`, `RUST_LOG=info` and `RUST_BACKTRACE=1`, streaming the
app's own output into the log pane. The app runs until you close its window;
Cancel stops it (whole process group, SIGKILL after ten seconds).

The launch environment is **scrubbed, not inherited** (`runenv.py`): a Builder
started from VS Code's snap carries `/snap/core20` library paths that make the
GTK app die at exec (`symbol lookup error: __libc_pthread_init` — observed),
and the frozen Builder adds PyInstaller's own `LD_LIBRARY_PATH`. Snap and
bundle entries are filtered out; a sandboxed `XDG_DATA_HOME` is dropped so the
app reads its real data.

**Reset profile…** (and the "Reset it first" checkbox for a one-click
fresh-run) delegates to the repo's own `scripts/reset_profile.sh` rather than
reimplementing it — the same script behind `run_dev.sh --reset`. It archives
the profile aside as `<name>.reset-<stamp>` (recoverable by renaming back) and
clears the global webview caches, which per-profile deletion alone would miss.

## Uninstall

Linux only. Installing a built `.deb`/`.rpm` happens outside the Builder, but
the **Installed package** card on the Build tab knows whether one is on this
machine and offers the one button to remove it. Detection is read-only
(`dpkg-query` / `rpm -q`) and tries the package names Tauri could have derived
from the product name — `productName` kebab-cased, lowercased, verbatim, and
the `enigma` slug — so a renamed custom build is still found. The removal runs
`pkexec apt-get remove -y` (or `dnf remove -y`; the low-level `dpkg -r` /
`rpm -e` only as fallback), so polkit asks for the password and the Builder
never sees it; output streams to the log and Cancel works as usual.

Only the package is removed. App data under `~/.local/share/<identifier>`
stays — a reinstall finds the old vault again, exactly like an upgrade — and
clearing that remains **Reset profile…**'s job.

## Why a new build knows your old passphrase

It is not the build. Enigma stores everything under Tauri's `app_data_dir()` —
on Linux `~/.local/share/<identifier>/profiles/<profile>/` — keyed on the bundle
identifier, not on anything inside the binary. A new build looks in the same
place, finds `vault.json`, and protasius reports the vault as already set up, so
the app opens the unlock gate instead of first-run passphrase setup. That is
what you want when a real user upgrades, and not what you want when testing.

The Test run card's badge says which it will be on the next launch
("vault present" / "first run"), and **Reset profile…** gives you a genuine
first run — see above; it archives aside as `<name>.reset-<stamp>`, so:

```bash
mv .../profiles/default.reset-20260727-204512 .../profiles/default  # restore
```

Two details worth knowing. The tool checks **both** `$XDG_DATA_HOME/<identifier>`
and `~/.local/share/<identifier>` when reporting state, because a Builder
launched from a sandboxed editor (VS Code's snap) sees the editor's
`XDG_DATA_HOME` and would otherwise look straight past the app's real data. And
the reset never takes a path from the GUI — only a profile *name*, which
`scripts/reset_profile.sh` validates itself before touching anything.

## The app icon

Choose one square PNG or SVG (≥512px, 1024 recommended) on the Identity tab and
the build gains a first step: `npx tauri icon <source>`, run from `apps/enigma`,
which regenerates every desktop size plus an `icons/android/` mipmap tree.

That is not sufficient on its own. `tauri android init` copies those mipmaps
into `gen/android/app/src/main/res/` once, and the two trees drift apart from
then on — they already differ in this checkout. So the icon step is followed by
a mirror of `icons/android/` into the generated project; without it the APK
would keep shipping the old launcher.

Both trees are tracked in git, about 90 files. The Builder snapshots them in
memory before generating and restores them byte-for-byte when the run
ends — on success, failure *and* cancellation — unless you clear "Restore
identity and icons after every build". If the tool is killed between the two,
recover with:

```bash
git checkout -- apps/enigma/src-tauri/icons \
                apps/enigma/src-tauri/gen/android/app/src/main/res
```

The log prints that command before touching anything.

## Things that are not flags

- **Always compiled**: local locked files, the panic code / vault, chat, file
  transfer. They have no build gate.
- **Parked in `limbo/`**: kanban, mind, sketch-collab and friends. Restoring one
  is file moves plus `lib.rs`, router, store and i18n edits, and a new
  `build.rs` section — not a checkbox.
- **The device-sync allow-list** (`DEVLINK_SYNC_KV` / `SYNC_KV`) is hand-curated
  and mirrored on both sides with drift tests. The Builder does not touch it.

## Tests

```bash
QT_QPA_PLATFORM=offscreen venv/bin/python -m pytest tests/
```

The suite reads the real repo files on purpose. `test_yaml_gen.py` compares the
generated key set against `build_config.yaml`, so a schema change in `build.rs`
fails here loudly instead of failing a build half an hour in;
`test_presets.py` pins the edition matrix and the invariant that crypto,
settings and network are identical across editions; `test_build_worker.py`
drives real subprocesses to prove cancellation reaches grandchildren;
`test_paths_and_output.py` covers repo resolution, the standalone first run
with no checkout at all, and the artifact copy; `test_icons.py` builds real
PNGs with nothing but `zlib` and proves the icon snapshot restores every
tracked file it touched; `test_bundles.py` pins the distribution mapping and
the cross-build warning.

Several of these drive code paths that legitimately write into the checkout, so
an autouse fixture in `conftest.py` snapshots `tauri.conf.json` and both icon
trees around **every** test and puts them back. QSettings is redirected into a
temp directory for the same reason. Running the suite must never show up in
`git status`.

A second autouse fixture redirects **`HOME` and `XDG_DATA_HOME`** into a temp
directory for every test. Overriding `XDG_DATA_HOME` alone is not enough,
precisely because `appdata` also checks `~/.local/share` — and a test that
redirected only the one variable once selected, and deleted, a real 320 MB
app-data directory. No test can reach real user data by any route now.

## Repo changes this tool required

- `apps/enigma/src-tauri/build.rs` — `custom` added to `EDITIONS`.
- `.gitignore` — the generated custom config and the Python tool venvs.
