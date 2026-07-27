# Enigma Builder

A PyQt6 desktop tool for configuring and building Enigma: pick the features to
compile in, review the generated build config, choose Linux desktop or Android,
and run the build with live output and a working cancel.

```bash
cd tools/enigma_builder
python -m venv venv && venv/bin/pip install -r requirements.txt
venv/bin/python main.py
```

## What it writes

Two files, and nothing else:

| File | When |
|---|---|
| `apps/enigma/src-tauri/configs/build_config.custom.yaml` | every build (gitignored) |
| `apps/enigma/src-tauri/tauri.conf.json` | only if you change the app identity |

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
- **Identity** — product name, bundle identifier, version, plus the current
  state of `tauri.conf.json` and a restore button if a previous run left it
  modified.
- **Expert** — settings clamps and network tuning behind a toggle, with the
  crypto declarations shown read-only. `max_frame_bytes` is flagged: peers in
  one room must agree on it.
- **Build** — target and build type, Android ABIs, artifact collection, the
  Android toolchain check, free-disk warning, log, and the artifact list.

Validation mirrors `build.rs` rule for rule — same paths, same wording — so an
error here reads the same as the one cargo would print. A blocking error
disables **Start build** and marks the owning tab with ⚠.

## What it runs

| Selection | Command (from the repo root, with `ENIGMA_EDITION=custom`) |
|---|---|
| Desktop | `bash build_desktop.sh [--debug]` |
| Android | `bash scripts/build_android.sh enigma <debug\|release> <abis>` |
| Collect / Both | `bash apps/enigma/deploy/build.sh <desktop\|android\|both> <debug\|release> <abis>` |

`deploy/build.sh` always builds the desktop leg as release — the debug choice
applies to Android only, and the GUI says so when the combination is selected.

Cancel signals the whole process group, then escalates to SIGKILL after ten
seconds: the scripts spawn npm, cargo, tauri and gradle, and terminating only
bash would leave a multi-gigabyte compile running unattended. A gradle daemon
that has already detached survives, harmlessly.

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
drives real subprocesses to prove cancellation reaches grandchildren.

## Repo changes this tool required

- `apps/enigma/src-tauri/build.rs` — `custom` added to `EDITIONS`.
- `.gitignore` — the generated custom config and the Python tool venvs.
