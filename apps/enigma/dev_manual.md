# Enigma — Dev / Launch Manual

How to run Enigma locally. Enigma is a **serverless P2P chat** (Tauri 2 + Vue 3;
iroh QUIC transport, MLS encryption). There is no backend to start — two app
instances pair directly over a QR code. For build/packaging see
[build.md](build.md); for the rework background see
[serverless_plan.md](serverless_plan.md); for naming/palette/config conventions
and where each config value canonically lives, see [CONVENTIONS.md](CONVENTIONS.md).

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20+ (CI uses 22) | Vite / Vue / Tauri CLI |
| Rust | stable | Tauri Rust core + `rotor-core` |
| System libs (Linux) | — | WebKitGTK + friends, see below |

Desktop `tauri dev`/`build` needs the WebKitGTK stack. On Debian/Ubuntu:

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev pkg-config build-essential
```

`rotor-core` (the crypto crate) is **vendored in-repo** at
[cryptorotor/rotor_core](cryptorotor/rotor_core) and consumed via a path dependency —
no GitLab account or git setup is needed to build.

---

## First-time setup

```bash
npm install        # once, at the repo root — sets up the workspace + all packages
```

`rakotis` is an in-repo workspace package (`packages/rakotis`); npm symlinks it
into the app's `node_modules`, so edits to its source are picked up immediately —
no rebuild step.

---

## Launch (desktop dev)

```bash
./run_dev.sh          # or: npm run dev
```

Both run `npm run tauri dev` inside `apps/enigma`: Vite starts on
`http://localhost:1420` and Tauri opens the native window pointed at it. Frontend
edits hot-reload; Rust edits trigger a rebuild.

> The first launch compiles the full Rust dependency tree (incl. OpenMLS + iroh)
> and is slow. Later runs are incremental.

### Profiles & two-instance pairing

Two env vars isolate instances so you can pair two on one machine:

| Var | Default | Effect |
|---|---|---|
| `APP_PROFILE` | `default` | Storage namespace (separate kv cache / profile dir) |
| `CHAT_USER` | `default` | MLS identity namespace |

```bash
# terminal 1
APP_PROFILE=alice CHAT_USER=alice ./run_dev.sh
# terminal 2
APP_PROFILE=bob   CHAT_USER=bob   ./run_dev.sh
```

### Pairing quick-start

1. **A**: Chat → *New chat* → name it → **Create**. A QR code appears.
2. **B**: Chat → *Join a chat* → scan the QR (camera / image) or paste the ticket.
3. Both sides show **Encrypted** once the MLS handshake completes.

After the one-time pairing the app reconnects automatically (peer NodeIds are
persisted per room and re-resolved via iroh n0 discovery) — no server, no
accounts. Restart B and it reopens the room and reconnects.

---

## Browser-only mode (UI shell, no P2P)

```bash
npm run dev -w enigma        # http://localhost:1420
```

Plain Vite with no Tauri runtime — renders the UI shell only. P2P and MLS need
the Rust backend, so chat does not function here; use it for pure-frontend work.

---

## Android emulator

Full walkthrough (boot AVD, `npm run tauri android dev`, driving via `adb`) is in
[apps/enigma/emulator.md](apps/enigma/emulator.md). One-time SDK/NDK/Java setup is
in [build_android.md](build_android.md). Short version, from `apps/enigma/`:

```bash
"$ANDROID_HOME/emulator/emulator" -avd Pixel_9 -no-snapshot-save -gpu swiftshader_indirect &
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 5; done
npm run tauri android dev     # auto-detects the emulator, builds, installs, launches
```

---

## Tests (during dev)

```bash
npm test                                   # all workspaces
npm test -w enigma                         # vitest: chat store, components, i18n
npm test -w rakotis                        # vitest: transport bridge, storage, i18n
( cd apps/enigma/src-tauri && cargo test ) # Rust: ticket round-trip, kv, …
python apps/enigma/e2e.py                  # Playwright smoke tier (no backend)
```

---

## Troubleshooting

- **Port 1420 already in use** — a stray Vite server is running.
  `npm run dev:tauri` reuses an existing server on `:1420`; otherwise kill the
  process holding the port (`lsof -i :1420`) and relaunch.
- **`rotor-core` build error** — it's the vendored crate at `cryptorotor/rotor_core`
  (nothing is fetched); check it alone with `cd cryptorotor && cargo check -p rotor-core`.
- **Window opens blank / WebKit errors** — the WebKitGTK dev libs above are
  missing or mismatched; reinstall them.
- **First Rust compile is very slow / high memory** — expected for the initial
  build; subsequent runs are incremental.
