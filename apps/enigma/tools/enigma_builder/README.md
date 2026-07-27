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

## What it writes

Three things, and nothing else:

| Path | When |
|---|---|
| `apps/enigma/src-tauri/configs/build_config.custom.yaml` | every build (gitignored) |
| `apps/enigma/src-tauri/tauri.conf.json` | only if you change the app identity |
| `apps/enigma/src-tauri/icons/**` and the Android launcher | only if you change the app icon |
| your chosen **output folder** | after a successful build, if collecting is on |

**It never runs git.** If a build changes the identity, the Builder says so
first, and restores the committed values afterwards unless you turn that off on
the Identity tab.

## Why every build is `ENIGMA_EDITION=custom`

`build.rs` bakes one YAML into compile-time consts, chosen by `ENIGMA_EDITION`:
unset picks `build_config.yaml`, and `light` / `plus` / `pro` / `custom` pick
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
values are read from the checked-in YAML at runtime, never hardcoded — the
`# Plus and up` comments in `build_config.light.yaml` already disagree with the
values in `build_config.plus.yaml`, and the values are what compiles.

One consequence worth knowing: after an automatic identity restore, a *manual*
`ENIGMA_EDITION=custom cargo build` fails the equality assert until the Builder
regenerates. The custom YAML is builder-owned output; regenerate it from the GUI.

## Tabs

- **Features** — Light / Plus / Pro presets, the nine build gates, the four
  runtime defaults, and a live preview of the YAML that will be written. The
  Custom chip is an indicator: change any gate and it lights up on its own.
- **Identity** — product name, bundle identifier, version and the app icon,
  plus the current state of `tauri.conf.json` and a restore button if a
  previous run left it modified.
- **Expert** — settings clamps and network tuning behind a toggle, with the
  crypto declarations shown read-only. `max_frame_bytes` is flagged: peers in
  one room must agree on it.
- **Build** — the repository being driven, target and build type, Android ABIs,
  the output folder, the Android toolchain check, free-disk warning, log, and
  the artifact list.

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
tracked file it touched.

## Repo changes this tool required

- `apps/enigma/src-tauri/build.rs` — `custom` added to `EDITIONS`.
- `.gitignore` — the generated custom config and the Python tool venvs.
