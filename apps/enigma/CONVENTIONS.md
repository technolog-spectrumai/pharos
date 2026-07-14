# Enigma — conventions & project config

The single reference for **how this project is named, coloured, and configured**. It
complements the build docs (`build.md`, `build_android.md`, `dev_manual.md`) — those
tell you *how to build*; this tells you *what the conventions are* and *where each
config value canonically lives* so copies don't drift.

Enigma is a serverless, end-to-end-encrypted (MLS) peer-to-peer chat, shipped as a
**Tauri 2 + Vue 3 + Rust** monorepo. Canonical display name: **Enigma** (capitalised).

---

## 1. Naming

Two naming schemes coexist by design — know which applies:

| Scheme | Used for | Examples |
| --- | --- | --- |
| **Functional-descriptive** | the app, its lib, and API surface | `enigma`, `enigma_lib`, `rotor-core`/`rotor-py`/`rotor-wasm`, commands `vault_*`/`kv_*`/`mls_*` |
| **Thematic codename** | reusable libraries & subsystems | `cryptorotor` (crypto workspace), `gervasius` + `protasius` (at-rest crypto pair), `rakotis` (UI/chat package), `Oya*` (UI primitives) |

`gervasius` & `protasius` are a deliberate paired hagiography (at-rest **primitives**
vs the **store** built on them). Don't "normalise" the codenames away.

**Rust crates.** Directory + `[lib]` name = `snake_case`; Cargo `[package].name` =
`kebab-case`. So `cryptorotor/rotor_core/` → package `rotor-core`. The Tauri app is
bin `enigma` + lib `enigma_lib` (the `_lib` suffix avoids a Windows bin/lib clash).

**Vue components.**
- Reusable primitives live in `packages/rakotis/src/components/primitives/` with the
  **`Oya`** prefix, PascalCase (`OyaButton`, `OyaModal`, `OyaTextField` … 12 total, zero exceptions).
- App components are PascalCase, **no** prefix, grouped by feature folder
  (`components/chat/`), and carry a type suffix: `*Modal`, `*Chip`, `*Panel`, `*Bar`,
  `*Row`, `*Sidebar`, `*Drawer`, `*List`.
- Route views are `Enigma<Domain>View` (`EnigmaChatView`, `EnigmaFilesView`,
  `EnigmaContactsView`, `EnigmaConfigView`, `EnigmaProfileView`). Stores are lowercase
  domain files (`chat.ts`, `user.ts`). Composables are `useXxx` camelCase.

**Tauri commands.** `snake_case`, `<domain>_<verb>` families — `app_*`, `vault_*`,
`kv_*`, `mls_*`, `realtime_*`, `audio_*`, `fs_*`, `tor_*`, `file_*`, `dht_*`, `invite_*`. All registered in the single
`generate_handler!` block in `apps/enigma/src-tauri/src/lib.rs`. (Two legacy getters,
`current_profile`/`current_identity`, predate the prefix rule — leave or migrate to
`app_*`, don't add new prefix-less commands.)

**Events.** `scheme://path` naming: `realtime://message` and `realtime://status`
(both transports — `p2p_iroh`, `p2p_tor` — emit identical names so the frontend is
transport-agnostic; a single event multiplexes all rooms, the payload carries the
room id), plus `file://progress`, `file://done`, `file://error` from the file-transfer
backend (`file_xfer.rs`), and `invite://incoming`, `invite://resolved` from the
direct-room-invite handshake (`p2p_invite.rs`).

**i18n keys.** Two levels: `namespace.camelCaseLeaf` (`chat.newChat`, `vault.wrongPass`).
9 namespaces (`nav`, `common`, `lang`, `config`, `chat`, `contacts`, `fileShare`,
`profile`, `vault`). Interpolation uses single-brace named tokens (`{n}`).

**protasius storage.** Versioned AAD prefix `protasius:v1:` binds every sealed value;
keyspace tiers are separated by a leading tag byte (`TAG_INTERNAL = 0x01`,
`TAG_KV = 0x02`) with `\0`-separated segments. A new keyspace tier claims a **new tag
byte**; a key-layout change bumps the AAD to `protasius:v2:`.

---

## 2. Colour palette / design tokens

Tailwind v4 is **CSS-first**: the palette lives in the `@theme` block of
[`apps/enigma/src/style.css`](apps/enigma/src/style.css) as `--color-<role>-<light|dark>`
tokens, consumed as `text-<role>-light dark:text-<role>-dark` (class-based dark mode,
`.dark` on `<html>`). This CSS block is the **single source of truth** — do not define
colours in JS. Rakotis component source is `@source`-scanned so its utilities generate.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `primary-bg` | `#f2f3f5` | `#0a0c11` | Page / primary surface |
| `text-main` | `#0f1114` | `#d3d7e0` | Primary body text (most-used foreground) |
| `header-bg` | `#1d2333` | `#0f1420` | Top bar (== `footer-bg`) |
| `footer-bg` | `#1d2333` | `#0f1420` | Footer (== `header-bg`) |
| `appbar-bg` | `#252c3e` | `#151b29` | Secondary chrome |
| `appbar-text` | `#e4e7ef` | `#cfd4df` | Text on appbar (== `footer-text`) |
| `footer-text` | `#e4e7ef` | `#cfd4df` | Footer text (== `appbar-text`) |
| `bubble-bg` | `#e8e9ec` | `#191f2d` | Chat message bubble |
| `sunken` | `#e1e2e5` | `#141821` | Inset / recessed surface (inputs, wells) |
| `accent` | `#2f3d63` | `#4f5fa1` | Primary accent (indigo/navy) |
| `warn` | `#d94a4a` | `#ff4455` | Warning / error / destructive (red) |
| `success` | `#4a8f7a` | `#5fa38c` | Success / positive (teal-green) |
| `link` | `#2a4b8f` | `#5f7fc9` | Hyperlink (blue) |
| `accent-1` | `#4f5fa1` (both) | | Mode-independent accent end (== `accent-dark`) |
| `accent-2` | `#2f3d63` (both) | | Mode-independent accent end (== `accent-light`) |
| `highlight` | `#facc15` (both) | | Host ★ marker / "attention" (MLS key-exchange) |

**Typeface:** Orbitron, via `--font-sans` (currently CDN-loaded from Google Fonts —
see roadmap for the offline-resilience note).

**Rules.**
- Never use a raw Tailwind palette utility (`text-yellow-400`, `bg-red-500`, …) or a
  literal hex for a *thematic* colour — add/point to a token. The gold host ★ is
  `text-highlight`; the recording/destructive red is `warn`.
- Functional black/white is fine where it's **not** theming: QR codes need true
  black-on-white to scan; toggle knobs are conventionally white.
- Native `<select>/<option>` (can't take Tailwind reliably, needs `color-scheme`) may
  use scoped CSS, but must read `var(--color-*)`, not re-hardcoded hexes.

Known un-tokenized bits still worth folding in later: the modal/drawer scrims
(`bg-black/70` vs `bg-black/40` — inconsistent opacity, candidate `--color-scrim`) and
the copy-pasted `text-white border-white/20` modal buttons (candidate rakotis
primitive). Tracked in §4.

---

## 3. Config — sources of truth

**Frontend app config:** [`apps/enigma/src/config/app.ts`](apps/enigma/src/config/app.ts)
— brand identity, UI policy, dev port. Import `brand` / `policy` / `dev` from here
instead of hardcoding.

| Value | Canonical home | Notes / mirrors |
| --- | --- | --- |
| Display name `Enigma` | `config/app.ts` `brand.name` | Also `tauri.conf.json` `productName` + window `title` (kept capitalised to match) |
| Copyright / org / legal URL | `config/app.ts` `brand` | Was hardcoded in `App.vue` |
| Bundle identifier | `tauri.conf.json` `identifier` | Mirror `brand.bundleId` (`com.spectrumaipl.enigma`) |
| Passphrase min length | `config/app.ts` `policy.passphraseMinLen` | **UI-only** today — see §4 |
| Profile field caps | `config/app.ts` `policy.*MaxLen` | `displayNameMaxLen` 150, `profileNameMaxLen` 80 |
| Feature defaults (offline/tor/stable) | Rust `AppProfileState` serde defaults | UI mirrors via `policy.featureDefaults`; **Rust is authoritative** |
| P2P connection timeout | kv `p2p:settings` / `connect_timeout_secs` (rakotis `appStorage.getConnectTimeoutSecs`) | **User-set in Settings**; default 60 s, clamped 5–600. Governs create/join give-up + the join window's read countdown (window ≤ 2×N) — never hardcode a connect deadline. Rust reads the same key (`p2p_dht::connect_timeout_secs`) for the DHT rendezvous-resolver deadline |
| DHT discovery + cadences | kv `p2p:settings` / `dht_discovery`, `dht_room_publish_secs`, `dht_presence_poll_secs` (rakotis `appStorage.getDht*`) | **User-set in Settings**, opt-in (default off). Publish 600 s clamp 60–3600; presence poll 300 s clamp 60–3600. Rust reads the same keys directly (`vault::kv_get_raw`); see `dht.md` |
| Release version `0.1.0` | `tauri.conf.json` `version` | De-facto owner (drives bundle filenames); duplicated in 6 manifests |
| Dev port `1420` | `vite.config.ts` `server.port` | Mirrored in `tauri.conf.json` `devUrl`, `scripts/tauri-dev-server.mjs`, `dev.vitePort` |
| Argon2id params | `cryptorotor/gervasius/src/vault.rs` `KdfParams::Default` | Persisted per-vault in the header |
| AAD prefix / tag bytes | `protasius/src/lib.rs` | `protasius:v1:`, `TAG_INTERNAL`/`TAG_KV` |
| Window size, bundle targets | `tauri.conf.json` | — |
| Two-profile dev instances | `APP_PROFILE` / `CHAT_USER` env | Defaulted in `run_dev.sh`; **`lib.rs` owns the `"default"` fallback** |

**Pairs that MUST be bumped together** (no shared source yet): the `rakotis` source
alias path (`vite.config.ts` + `vitest.config.ts` + `tsconfig.json`); the desktop apt
dependency list (2 docs + 2 CI jobs); the Playwright image tag `v1.60.0` ↔
`@playwright/test ^1.60.0`; the NDK version `27.2.12479018` (docs ↔ installer); the
`*.deb/*.AppImage/*.rpm` bundle glob (`build_desktop.sh` + CI). State one Node floor
(CI uses **node 22**) — docs currently say 18/20/22.

---

## 4. Centralization roadmap (not yet done)

Deliberately deferred to keep this pass low-risk; each is a real drift source the
audit found. Do these when touching the relevant subsystem:

**Rust consts (a shared module, or in-crate):**
- `gervasius`: name the magic sizes — `SALT_LEN = 16`, `KEY_LEN = 32`, `VAULT_VERSION = 1`.
- Transport: `IROH_TAG 0x49` / `TOR_TAG 0x54` / `DHT_TAG 0x44` (ticket/code routing)
  currently one per file, cross-referenced only in comments (and mirrored in
  `useChatChannel.ts` `isTorTicket`/`isDhtCode`) → **one shared module** so they
  can't collide.
- `MAX_P2P_FRAME 16 MiB` — written independently in `p2p_tor.rs` and `p2p_iroh.rs`
  (comment even says "must match") → single const.
- protasius namespace/key strings (`profile`/`keys`/`cache`/`state`, `tor_peer_id`,
  `tor_keystore`, `iroh_gossip`) are bare literals across 4 files → named consts (a
  typo silently loses stored data).
- Fold inline Tor timers (`backoff cap 15s`, `onion-poll 200ms`) in with the named ones.

**Policy enforced on both layers.** `passphraseMinLen` is UI-only — a direct `invoke`
bypasses it, and `gervasius::create_vault` accepts any passphrase. If it's a real
boundary, enforce the same value in Rust (`vault_setup`/`vault_change_passphrase`).

**Frontend consts (rakotis).** LocalStorage keys + the `enigma:` prefix + the on/off
boolean encoding are scattered (`enigma:stableOnion` is inline-duplicated in
get/set) → one constants module. Same for chat timing (`5000`, `30000` duplicated) and
UI copy/confirm delays (`1200`/`1500`/`2000`).

**Build.** A version-bump script (or Tauri reading version from `package.json`) so
`0.1.0` isn't hand-maintained in 6 manifests; extract the apt list to
`scripts/install_desktop_deps.sh`; add `.nvmrc`/`engines` for the Node floor.

**Palette.** Promote a `--color-scrim` token (unify `black/70` vs `black/40`) and lift
the repeated `text-white border-white/20` modal buttons into a rakotis primitive.
Consider self-hosting Orbitron (`@font-face`) — the CDN `<link>` fails in the offline
desktop/mobile shell.
