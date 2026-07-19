# Maps feature — implementation plan (map.md)

Status: **IMPLEMENTED 2026-07-19** — all steps landed, all gates green
(rakotis 90 vitest · enigma 225 vitest · cargo 72 · Playwright 9 · both
`vue-tsc`+vite builds clean). Decisions were resolved with Janek on 2026-07-18
(Q&A log below). The step-0 spike PASSED (pmtiles 0.23.1 writer + custom
`AsyncBackend` + gzip round-trip), so the hard gate never fired.

**Deviations from this plan (all deliberate, noted in the final report):**
- `map_` was NOT added to the sync-prefix gate in `useChatChannel` — the gate
  runs *before* the mute check and would have swallowed card payloads; the three
  card types are handled inline after the mute check, and any other/invalid
  `map_*` payload is dropped silently (never a raw-JSON bubble).
- `map_region_estimate` returns tile count + storage budget, not a byte
  estimate (that would need a full remote directory walk); the budget is
  enforced live while the download streams.
- Extra command `map_region_recv_path` keeps incoming transfers inside
  `maps/tmp` until verification; no Rust tile LRU (MapLibre caches tiles).
- Glyphs trimmed to Latin/Greek/Cyrillic (assets total 1.6 MB); redirecting
  source URLs are rejected with a clear error (keep-alive range backend);
  region downloads fix minZoom=0, user picks maxZoom ≤ 14.
- Two pre-existing `dht.spec.ts` e2e failures (DHT card had moved to the
  Connections sub-tab before this work) were repaired in passing.

Guiding rule: **simplest and safest route** that satisfies every requirement.
Every decision below reuses an existing in-repo pattern; the named "template"
file is the thing to copy, not reinvent.

**Decision log (Q&A, 2026-07-18):**
- D1/D2 → Rust-only tile path; browser mode degrades honestly.
- D3 → `default_source_url` ships **empty**; Settings shows a sourcing hint.
- D4 → region blobs plaintext, hash-named; everything sensitive stays sealed.
- D5 → step-0 spike is a **hard gate**: if the `pmtiles` crate writer is
  unusable there is NO fallback format — stop and reconsider together.
- D6 → one-shot chat cards only; no synced room layer in v1.
- D7 → region sharing in Tor mode: controls **disabled with a reason**, not
  hidden.
- D9 → bundle glyphs + sprites (~4 MB), fully offline styling.
- Limits → `map_storage_limit_mb {default 512, min 64, max 65536}`,
  `max_region_tiles 20000`.

---

## 1. Scope

**In:** Maps tab (MapLibre GL), remote `.pmtiles` over HTTP range requests,
downloaded/imported local PMTiles regions (progress, cancel, errors, size,
storage limit), P2P region sharing over the existing iroh file-transfer path
(BLAKE3-verified, content-addressed, deduped), pin + route sharing as compact
versioned MLS payloads rendered as chat cards, encrypted-at-rest persistence,
i18n (en+pl), unit tests, one e2e happy path, technology.md + build.md updates.

**Out (explicitly):** backend/servers of ours, Google Maps, live location
tracking, any routing/directions engine, background location, analytics,
automatic sharing, and **any change to cryptorotor/Rotor/MLS internals or the
transport abstractions**. `protasius`/`gervasius` are consumed as-is.

---

## 2. Core decisions (each = simplest + safest available)

**D1 — One tile path, resolved in Rust.** MapLibre gets a custom protocol
(`maplibre.addProtocol("enigma-map", ...)`) whose loader invokes one Tauri
command `map_get_tile(z, x, y)` returning raw tile bytes
(`tauri::ipc::Response`, zero-copy). Rust resolves **local regions first**
(any imported/downloaded PMTiles whose bbox/zoom covers the tile), then falls
back to the remote source via HTTP range requests — only if remote tiles are
enabled and the app is online. Rationale: one code path, offline-first, no
CORS games in the webview, and requirement 9 wants range download in Rust
anyway. No `pmtiles` npm dep at all.

**D2 — Browser-only mode degrades honestly.** Outside Tauri the Maps view
renders its chrome + an honest "Maps require the desktop/mobile app" state
(exact precedent: `StubChatTransport` and every P2P feature). This keeps a
single tile path and is what the Playwright tier (no Tauri) will assert.

**D3 — Remote tile fetch is an external-service contact → gated like DHT/Tor.**
- Compile-time kill switch `maps.allow_remote_sources` in `build_config.yaml`
  (pattern: `cloud.allow_connections`).
- Runtime per-profile toggle `map_remote_tiles`, **default off** (pattern: DHT
  toggle). With it off, Maps still fully works from local/imported regions.
- **Resolved:** `default_source_url` ships **empty** — the Settings URL field
  carries a hint (`config.mapSourceHint`) pointing at protomaps.com builds /
  self-hosting. No third-party contact is even possible until the user pastes
  a URL *and* flips the toggle.
- All clearnet fetches go through the **cloud.rs transport policy**
  (`connect`/`send_request` style: WebPKI-verified TLS, Tor-exclusive routing
  respected, `connect_timeout_secs` from Settings per house rule). No new
  clearnet path outside the policy (technology.md §9 item 9).

**D4 — Regions are real PMTiles files, content-addressed on disk.**
A downloaded/imported region is a single immutable `.pmtiles` archive stored at
`<profile_dir>/maps/<blake3-hex>.pmtiles`. Manifests (JSON, sealed in the
encrypted kv store) reference blobs by hash → dedup is free, "remove region"
deletes the manifest and garbage-collects the blob when unreferenced.
**Blobs stay plaintext on disk** — deliberate: they contain only public map
data, filenames are hashes (no coordinates anywhere outside the vault), and
random-access range reads are incompatible with gervasius whole-blob sealing.
The *sensitive* facts (which bbox you have, your pins/routes) live only sealed
in protasius. Documented as an accepted posture note in technology.md §8/§13.

**D5 — Region extraction in Rust with the `pmtiles` crate.**
Add crates: `pmtiles` (reader + `writer` feature) and `flate2` (tile/directory
de/compression). Download-visible-region = open remote archive through a small
`AsyncBackend` impl (`read_bytes(offset, len)` → range request over the D3
transport), walk directories, enumerate tile IDs intersecting the bbox for
`minZoom..=maxZoom`, stream tile data into a local `PmTilesWriter`, atomic
temp+rename (idiom: `local_lock::atomic_write`), then BLAKE3 the file.
**Step 0 of the build order is a spike** confirming the crate's writer +
custom-backend + compression APIs. **Resolved — the spike is a hard gate:**
if the writer proves unusable there is NO fallback container format;
implementation stops after step 0 and the approach is reconsidered with Janek
before any dependent code is written.

**D6 — Pin/route shares are chat-timeline cards, not a synced collection.**
One-shot shares, exactly like `image_message`/`voice_message` today: new inner
MLS types `map_pin` / `map_route` / `map_region` handled in
`useChatChannel.handleMessage` beside image/voice, becoming `Message` entries
rendered by `ChatBubble.vue` as cards. No CRDT/rev-sync of a shared pin set
(that's the meetings/kanban pattern — heavier and not required). Cards do
nothing until the user acts ("Open in Maps" / region "Download"). Payloads are
versioned (`v: 1`) and strictly validated on receive; invalid frames are
dropped silently. Map bytes NEVER ride MLS — the 16 MiB
`network.max_frame_bytes` cap (minus base64 overhead) is enforced by
validation caps far below it (§5).

**D7 — Region P2P transfer reuses `file_xfer.rs` verbatim.** The Rust commands
are already generic (any path in, any dest out, 64 KiB chunked QUIC, progress
events). The MLS `map_region` card carries `{manifest, offerId, addr}` from
`file_offer_create`; accepting calls `file_download` to a temp path, then
`map_region_import` verifies **BLAKE3 + manifest fields before import** and
dedupes by hash. No changes to file_xfer beyond a tiny path-lookup wrapper.
Known consequence (accepted, surfaced in UI): file transfer is blocked in Tor
mode (`TOR_BLOCKED`) — region *sharing* is unavailable over Tor; remote tile
*downloads* still work because they use the Tor-aware cloud transport.
**Resolved UI treatment:** while Tor is on, region Share/Accept controls
render **disabled with an "unavailable over Tor" reason** (tooltip + card
note) — never hidden, never fail-on-click.

**D8 — Naming (technology.md §14).** View `EnigmaMapView`, folder
`apps/enigma/src/components/map/`, route `/map`, nav key `nav.map`, i18n
namespace `map`, command family `map_*`, events `map://progress|done|error`
(camelCase payload keys), kv namespaces `map:regions` / `map:pins` /
`map:routes`. Icon: `faMap` (already registered in main.ts).

**D9 — Offline style assets are bundled, not fetched.** MapLibre needs a style
+ glyphs (+ sprites) — normally CDN-loaded, which would be a silent clearnet
contact. Instead: dep `protomaps-themes-base` (style layers as code, no
runtime fetch) + a trimmed glyph set (one Noto Sans stack) and the basemaps
sprite sheet bundled under `apps/enigma/public/map/` and referenced by
relative URL. Budget ≤ ~4 MB; provenance noted in build.md. Zero network for
styling, works fully offline.

---

## 3. Data model

### 3.1 Region manifest (required shape, verbatim)

```ts
// rakotis src/mapModel.ts
export interface MapRegionManifest {
  id: string;          // uuid v4, local identity (stable across re-shares)
  name: string;        // user label, ≤ 120 chars
  bbox: [number, number, number, number]; // [west, south, east, north], validated
  minZoom: number;     // 0..=22, minZoom <= maxZoom
  maxZoom: number;
  size: number;        // bytes of the .pmtiles blob, must match file
  blake3: string;      // lowercase hex, 64 chars — content address of the blob
  sourceUrl: string;   // origin archive URL ("" for manual imports)
  version: 1;          // manifest schema version
}
```

`validateManifest(x: unknown): MapRegionManifest | null` in rakotis — shared
by the chat-card receive path and mirrored field-for-field by the Rust import
check (Rust re-verifies independently; it never trusts the frontend).

### 3.2 Persistence (encrypted profile store ONLY — requirement 4)

| kv namespace / scope / key | Value | Notes |
|---|---|---|
| `map:regions` / `default` / `""` | `MapRegionManifest[]` JSON | pattern: `p2p:rooms` single-key array; Rust reads via `vault::kv_get_raw` for tile resolution, TS via `localDb.kvGet` |
| `map:pins` / `default` / `""` | `MapPin[]` JSON | |
| `map:routes` / `default` / `""` | `MapRoute[]` JSON | |
| `p2p:settings` / `default` / `map_remote_tiles` | `"true"/"false"` | default off |
| `p2p:settings` / `default` / `map_source_url` | string | seeded from build config default |
| `p2p:settings` / `default` / `map_storage_limit_mb` | number | clamp-on-read (pattern: `setting_secs`) |

```ts
export interface MapPin  { id: string; name: string; lat: number; lng: number;
                           color?: string; note?: string; createdAt: number }
export interface MapRoute{ id: string; name: string; color?: string;
                           points: [number, number][]; createdAt: number }
```

Coordinates exist **only** here (sealed), in MLS ciphertext (shares), and in
volatile UI state. Never in filenames, logs, events with persistence, or
plaintext files. (Browser-only vitest/dev mode falls back to localStorage —
existing posture for *all* kv, unchanged and out of scope.)

### 3.3 On-disk (per profile)

```
<app_data>/profiles/<profile>/maps/
  <blake3>.pmtiles        # immutable region blobs (public map data)
  tmp/                    # in-flight downloads/imports; atomic rename on success
```

Storage accounting = sum of blob sizes; enforced (Rust) before any
download/import against `map_storage_limit_mb`. Error string `MAPS_STORAGE_LIMIT`
(pattern: `CLOUD_DISABLED`/`OFFLINE_BLOCKED` contract prefixes).

---

## 4. Wire payloads (MLS inner types — compact, versioned, validated)

Sent via the existing `sendEncryptedMedia`/`sendSync` seam; **no crypto code
touched**. All three handled directly in `handleMessage` (like
`image_message`), becoming timeline `Message` entries.

```jsonc
{ "type": "map_pin",    "v": 1, "name": "…", "lat": 52.4, "lng": 16.9,
  "color": "#…?", "note": "…?" }
{ "type": "map_route",  "v": 1, "name": "…", "points": [[lat,lng], …] }
{ "type": "map_region", "v": 1, "manifest": { …MapRegionManifest… },
  "offerId": "uuid", "addr": "base32…" }
```

Validation caps (both send and receive, in `mapModel.ts`): name ≤ 120,
note ≤ 500, `lat ∈ [-90,90]`, `lng ∈ [-180,180]`, route points 2..=2000,
unknown `v` → drop. Worst-case route ≈ 60 KB ≪ frame cap. Unknown/invalid
frames are dropped without a bubble (defensive-narrowing house style).

Receive → `Message { type: "map_pin" | "map_route" | "map_region",
map: <validated payload> }` (union + optional field extension in
`useChatChannel.ts`). The `map_` prefix is also added to the sync-family gate
at `useChatChannel.ts:838` for forward-compat, though cards don't need onSync.

---

## 5. Rust backend (`src-tauri/src/maps.rs`, new)

Registered in `lib.rs` (`mod maps;` + `generate_handler!` additions +
`.manage(maps::MapsState::default())`); `maps::shutdown(app)` hooked into the
airplane-mode / Tor toggles beside `cloud::shutdown`.

**State** (pattern: `CloudState`):
`MapsState { tasks: Mutex<HashMap<String, JoinHandle<()>>>, readers: <small cache of open local readers + remote directory cache>, tile_lru: <in-memory LRU, ~32 MB> }`

**Commands** (all `Result<T, String>`, camelCase JSON):

| Command | Purpose |
|---|---|
| `map_get_tile(z,x,y) -> Response(bytes)` | local-regions-first → remote-range fallback; decompresses per archive `tile_compression` so MapLibre gets raw MVT; empty response = no tile |
| `map_source_info() -> {minZoom,maxZoom,bbox,attribution}` | from remote/local header, for style bootstrap |
| `map_region_estimate(bbox,minZoom,maxZoom) -> {tiles,bytes}` | directory walk, no tile fetches; also rejects > `maps.max_region_tiles` |
| `map_region_download(name,bbox,minZoom,maxZoom) -> taskId` | async task; emits `map://progress {taskId, transferred, total}` then `map://done` / `map://error`; atomic write; BLAKE3; manifest → kv |
| `map_region_cancel(taskId)` | aborts JoinHandle, removes temp |
| `map_regions_list() -> Vec<MapRegionManifest>` | reads `map:regions` kv |
| `map_region_remove(id)` | drop manifest; GC blob when last reference |
| `map_region_offer(id) -> {offerId, addr, size}` | wraps `file_xfer` offer registration with the blob path |
| `map_region_import(path, manifestJson?) -> manifest` | **verify before import**: PMTiles header parses; BLAKE3(file) == manifest.blake3; size matches; bbox/zoom fields valid; storage limit; then content-addressed move + dedup + kv. Manual imports without a manifest derive one from the header (`sourceUrl:""`) |
| `map_region_export(id, destPath)` | copies `<name>.pmtiles` + sidecar `<name>.manifest.json` (via existing dialog plugin) |
| `map_storage_usage() -> {usedBytes, limitBytes}` | |

**Range transport:** a `RangeHttpBackend` implementing the `pmtiles` crate's
`AsyncBackend` over the cloud.rs-style `connect` + `send_request` with a
`Range: bytes=start-end` header (lift the private helpers into a small shared
`http.rs` module or re-export from `cloud.rs` — decided at implementation; the
transport policy itself is untouched). Honors `ensure_online`, Tor-exclusive
routing, WebPKI verification, redirects ≤ `MAX_REDIRECTS`.

**No capability changes** — plain `invoke` commands run under `core:default`.
No new Tauri plugins.

### build_config.yaml additions (+ build.rs struct/validate/codegen, +
`BuildConfigSummary` / `app_get_build_config`, + rakotis `BuildConfig` type,
+ `initBuildConfig` seeds in `main.ts` and both `tests/setup.ts`):

```yaml
maps:
  enabled: true                 # hides route/nav like kanban_enabled
  allow_remote_sources: true    # compile-time kill switch for clearnet tile fetch
  default_source_url: ""        # ships empty (D3 resolved): user must set; Settings shows hint
  max_region_tiles: 20000       # per-download cap; build.rs asserts > 0
features:
  map_remote_tiles: false       # per-profile runtime default: OFF
settings:
  map_storage_limit_mb: { default: 512, min: 64, max: 65536 }
```

---

## 6. rakotis additions (reusable, pure — requirement 9)

- **`src/mapModel.ts`** (new, no Vue/Tauri imports — pattern `meetingModel.ts`):
  `MapRegionManifest` / `MapPin` / `MapRoute` types, `validateManifest`,
  `validatePinShare` / `validateRouteShare` / `validateRegionShare`, payload
  builders (`buildPinShare(pin)` etc.), tile math
  (`bboxTileCount(bbox,minZ,maxZ)`, `lonLatToTile`), and caps as exported
  consts. Barrel-exported from `src/index.ts`.
- **`src/useChatChannel.ts`**: extend `Message` union with
  `map_pin | map_route | map_region` + optional `map` field; three
  `handleMessage` branches (validate → push Message); add `map_` to the
  sync-prefix gate. *(Only rakotis file with behavioral change; crypto bridge
  untouched.)*
- **`src/services/appStorage.ts`**: `getMapRemoteTiles/set…`,
  `getMapSourceUrl/set…`, `getMapStorageLimitMb/set…` (+ clamp consts from
  build config) over `p2p:settings` kv — exact `meeting_reminder_mins`
  pattern.
- **`src/services/mapData.ts`** (new): kv-backed CRUD for `map:pins` /
  `map:routes` / `map:regions` read-side (single-key JSON array pattern) —
  Tauri-agnostic via `localDb`, hence testable and reusable.
- **Tests**: `tests/unit/mapModel.test.ts`, `tests/unit/mapData.test.ts`.

---

## 7. App frontend (`apps/enigma`)

New deps: `maplibre-gl`, `protomaps-themes-base` (+ bundled glyph/sprite
assets in `public/map/`, see D9). `leaflet` stays untouched (pre-existing,
unused — flag for separate cleanup).

| File | Change |
|---|---|
| `src/views/EnigmaMapView.vue` (new) | shell (pattern `EnigmaFilesView`): sub-tabs `map` / `regions` via local `ref`; browser-mode honest-degraded state; WebGL feature-detect with honest fallback message |
| `src/components/map/MapPanel.vue` (new) | MapLibre init, `addProtocol("enigma-map")` → `invoke("map_get_tile")` (ArrayBuffer), style from protomaps-themes-base + local glyphs/sprites; pin add (long-press/click), route draw (click-to-add waypoints, double-click to finish), select → popup with Rename / Delete / **Share to room** (enabled only when a room is joined and MLS is `ready`); pending-share focus overlay + "Save" |
| `src/components/map/RegionsPanel.vue` (new) | region list (name, size, zoom span), **Download visible region** (zoom-range picker + estimate + limit check before confirm), per-task progress bar + Cancel, Remove, Share to room, Import…/Export… (dialog plugin), storage usage bar |
| `src/components/map/MapShareCard.vue` (new) | chat card for the three kinds; pin/route: summary + **Open in Maps** (router push + handoff — never auto-opens); region: manifest summary + Download (drives `file_download` → `map_region_import`, progress via `file://progress` filtered by offerId) / Dismiss |
| `src/components/ChatBubble.vue` | three `v-else-if` branches → `MapShareCard` |
| `src/stores/map.ts` (new, Pinia — pattern `cloud.ts`) | regions/pins/routes state over rakotis `mapData` + `map_*` invokes; download-task map fed by `map://*` events; `pendingFocus` handoff from chat cards; `reload()` on profile switch (wire beside existing reloads in `stores/chat.ts`) |
| `src/router/index.ts` | `/map` route, `beforeEnter: () => getBuildConfig().maps_enabled \|\| "/chat"` |
| `src/App.vue` | desktop + mobile `RouterLink` (`v-if="mapsEnabled"`, icon `map`) |
| `src/i18n/en.ts` + `pl.ts` | `nav.map`, full `map:` namespace, `config.map*` strings — identical key trees (enforced by `i18n.test.ts`) |
| `src/views/EnigmaConfigView.vue` | Maps settings card: remote-tiles toggle (hidden when `!allow_remote_sources`), source URL field with a "where to get a `.pmtiles` build" hint (`config.mapSourceHint`), storage limit (clamped via build-config triple) |
| `src/config/app.ts` | `policy.map = { defaultCenter, defaultZoom, maxRoutePoints, … }` (Vue-free consts) |
| `vitest.config.ts` / `tests/setup.ts` | stub `maplibre-gl` (no WebGL in jsdom — same trick as ace-builds); extend `initBuildConfig` seed |

No background location, no geolocation permission, no analytics: the map never
calls `navigator.geolocation`; nothing is shared without an explicit button
press (requirement 8).

---

## 8. Tests

- **rakotis (vitest)**: manifest/payload validation matrices (valid, boundary,
  hostile junk, wrong `v`, oversized route), tile math, pin/route CRUD
  round-trip via localStorage-backed localDb.
- **app unit/component (vitest)**: `tests/unit/mapStore.test.ts` (mocked
  invoke/events: download task lifecycle incl. cancel + error + limit
  rejection); `tests/component/maps.test.ts` (mount `MapShareCard` for all 3
  kinds + `EnigmaMapView` shell with `{ plugins: [i18n], stubs: { teleport: true } }`);
  the existing `i18n.test.ts` enforces en/pl parity automatically.
- **Rust (inline `#[cfg(test)]`, temp dirs via `env::temp_dir()+uuid`)**:
  bbox→tile enumeration (incl. antimeridian rejection), manifest
  validate/reject matrix, import happy path + BLAKE3-mismatch + size-mismatch
  + limit-exceeded rejections, content-addressed dedup + GC on remove, spike
  round-trip write→read of a tiny generated PMTiles.
- **e2e (`tests/e2e/map.spec.ts`, one happy path)**: `goto("/")` → click nav
  `Map` link → assert heading + regions sub-tab + honest degraded/empty state +
  Settings maps card persistence across `page.reload()` (pattern
  `dht.spec.ts`). No tile-pixel assertions (no Tauri/WebGL in CI).

**Gates to run at the end** (all must pass): `npm test` (workspaces),
`npm run build -w rakotis`, `npm run build -w enigma`, and
`cd apps/enigma/src-tauri && cargo test`.

---

## 9. Docs

- **technology.md**: §3 dep additions; **§10** Map tab bullet
  (`**Map** (\`EnigmaMapView\` / \`MapPanel\`) — …`); **§8/§9** privacy notes
  (remote tile fetch = optional external contact, off by default, rides the
  cloud transport policy; plaintext-but-content-addressed blob posture per
  D4); **§13** at-rest note for `map:*` namespaces + blob rationale; **§14**
  add `map` to the i18n namespace list; **§15** config-table rows for the
  `maps:` block + `map_storage_limit_mb`; **§16** "shipped since" bullet.
  No new numbered section (avoids renumbering; Kanban precedent — Maps adds
  no new *transport*, only a gated HTTP source on the existing policy).
- **build.md**: `maps:` bullet in the build-config "What it owns" list; glyph/
  sprite asset provenance note; Troubleshooting entry for WebKitGTK WebGL
  (`WEBKIT_DISABLE_DMABUF_RENDERER=1`).

---

## 10. Build order (each step ends green before the next)

0. **Spike** (throwaway, in-tree test only): `pmtiles` crate writer +
   `AsyncBackend` + compression round-trip on a generated 4-tile archive.
   **Hard gate (D5 resolved): if the writer is unusable, stop here and
   reconsider with Janek — do not proceed to any dependent step.**
1. `build_config.yaml` + build.rs + summary command + rakotis `BuildConfig` +
   both `initBuildConfig` seeds. (`cargo test`, `npm test` stay green.)
2. rakotis: `mapModel.ts`, `mapData.ts`, `appStorage` settings, barrel exports
   + their tests.
3. rakotis: `useChatChannel` Message union + 3 branches + prefix gate.
4. Rust `maps.rs`: tile resolver + range backend + `map_get_tile`; then
   regions (estimate/download/cancel/list/remove/usage); then
   import/export/offer; lib.rs wiring + shutdown hooks; inline tests.
5. App UI: view/panels/cards/store/router/App.vue/i18n/settings/assets/stubs.
6. Tests: remaining unit/component + `map.spec.ts`.
7. Docs (§9 above).
8. Full gates (§8 above) + manual two-instance run via `run2.sh` (share pin →
   card → open; share region → transfer → verified import).

---

## 11. Risks & accepted limitations

- **`pmtiles` crate writer capability** — spiked first (step 0) as a **hard
  gate**: if unusable, work pauses for a joint decision; no fallback format
  gets improvised.
- **WebGL in WebKitGTK** can be flaky on Linux → feature-detect + honest
  in-app message + build.md troubleshooting entry. Not a blocker for any
  non-map feature.
- **Tor mode blocks region P2P sharing** (existing `TOR_BLOCKED` in file_xfer;
  a direct QUIC dial would leak IP). Pins/routes/tiles still work over Tor.
  Controls disabled with an explicit reason (D7 resolved); accepted.
- **Region blobs are plaintext on disk** (D4 rationale) — public map data,
  hash-named, association sealed in the vault. Accepted + documented.
- **No resume** for interrupted region downloads/transfers (file_xfer has
  none) — a cancelled/failed task deletes its temp; retry restarts. Accepted
  for v1.
- **Sender-side region offers** live until cancelled/app close (no decline
  signalling for region cards in v1) — matches file_xfer offer semantics.
- Chat-card persistence follows whatever the timeline already does for
  image/voice messages — no new history mechanism.

---

## 12. Full changed/new file list (expected — Part I, as shipped)

```
build_config.yaml                                   ~ maps/features/settings blocks
apps/enigma/src-tauri/build.rs                      ~ struct+validate+codegen
apps/enigma/src-tauri/Cargo.toml                    ~ + pmtiles, flate2
apps/enigma/src-tauri/src/maps.rs                   + (commands, backend, tests)
apps/enigma/src-tauri/src/lib.rs                    ~ mod/manage/handler/shutdown/summary
apps/enigma/src-tauri/src/cloud.rs (or new http.rs) ~ expose shared transport helpers
packages/rakotis/src/mapModel.ts                    +
packages/rakotis/src/services/mapData.ts            +
packages/rakotis/src/services/appStorage.ts         ~ settings + BuildConfig type
packages/rakotis/src/useChatChannel.ts              ~ union + branches + prefix gate
packages/rakotis/src/index.ts                       ~ exports
packages/rakotis/tests/unit/{mapModel,mapData}.test.ts +
apps/enigma/package.json                            ~ + maplibre-gl, protomaps-themes-base
apps/enigma/public/map/{glyphs,sprites}/…           + bundled assets
apps/enigma/src/views/EnigmaMapView.vue             +
apps/enigma/src/components/map/{MapPanel,RegionsPanel,MapShareCard}.vue +
apps/enigma/src/components/ChatBubble.vue           ~ card branches
apps/enigma/src/stores/map.ts                       +
apps/enigma/src/stores/chat.ts                      ~ profile-switch reload hook
apps/enigma/src/router/index.ts                     ~ route
apps/enigma/src/App.vue                             ~ 2 nav links
apps/enigma/src/i18n/{en,pl}.ts                     ~ nav.map + map + config.map*
apps/enigma/src/views/EnigmaConfigView.vue          ~ Maps settings card
apps/enigma/src/config/app.ts                       ~ policy.map
apps/enigma/src/main.ts                             ~ initBuildConfig seed
apps/enigma/{vitest.config.ts,tests/setup.ts}       ~ maplibre stub + seed
apps/enigma/tests/unit/mapStore.test.ts             +
apps/enigma/tests/component/maps.test.ts            +
apps/enigma/tests/e2e/map.spec.ts                   +
technology.md, build.md                             ~ per §9
```

---

# Part II — PIVOT (planned 2026-07-19): packager tool + app simplification

Status: PLAN approved by Janek 2026-07-19. Supersedes the (never-implemented)
"place search + bundled world map" extension. Rationale: make the app simpler
and free of direct map-download APIs — a standalone tool owns all tile-server
contact; the app only ever imports files.

## Decisions (Q&A 2026-07-19)

- **D-II.1 — Remove ALL remote-fetch machinery from the app**: commands
  `map_region_download`/`map_region_estimate`/`map_region_cancel`, the
  `RangeHttpBackend`, settings `map_remote_tiles`/`map_source_url`, build keys
  `maps.allow_remote_sources`/`default_source_url`/`max_region_tiles`, the
  download form/progress UI and `map://*` download events. What stays: region
  list, **import from device**, export, P2P share, remove, storage budget,
  tile serving from local blobs.
- **D-II.2 — Extension dropped**: no in-app town search, no draw-rect, no
  compiled-in world map. A coarse world overview is **just another package**
  the tool produces; imported like any region, it renders as the base layer.
- **D-II.3 — Tool UX = form, no embedded map**: source URL, optional Nominatim
  town lookup (fills the bbox), manual W/S/E/N + zoom range, live tile count,
  progress + cancel. No QtWebEngine.
- **D-II.4 — Distribution fully manual** (USB / own Enigma Cloud via Files
  tab / any channel); the BLAKE3-verified `map_region_import` stays the single
  entry point. No in-app Cloud→Maps coupling.

## Part A — app simplification

Deletions across `maps.rs` (remote backend, download task machinery,
task registry + events; `map_get_tile`/`map_source_info` become
regions-only), `lib.rs` (handler list, shutdown hooks, BuildConfigSummary
fields), `build_config.yaml`+`build.rs` (`maps:` shrinks to `enabled`;
`features.map_remote_tiles` gone), `cloud.rs` (revert pub(crate) widenings),
rakotis `appStorage.ts` (remote settings + BuildConfig fields), app UI
(RegionsPanel download card, store download state, ConfigView remote rows),
i18n en+pl, and the affected tests. Plus one polish: `map_region_import`
auto-detects a `<stem>.manifest.json` sidecar when none is passed, so tool
packages get full BLAKE3 verification automatically.

## Part B — `tools/map_packager/` (PyQt6, video_tools conventions)

Flat module dir run with `python main.py`; requirements.txt = PyQt6,
pmtiles>=3.7, requests, blake3. QThread worker + pyqtSignal progress +
threading.Event cancel; QSS-token theme. Modules: main/window/theme/utils,
`packager.py` (tab+worker), `pm_source.py` (requests range `get_bytes` +
extraction loop), `tile_math.py` + `manifest.py` (pure, pytest-covered),
`geocode.py` (Nominatim jsonv2, honest UA, editable endpoint). Output package
= `<name>.pmtiles` + `<name>.manifest.json` in the exact `MapRegionManifest`
shape the app verifies. "Coarse world (z0–5)" one-click preset. Python
`pmtiles` 3.7.0 has reader+writer (verified); exact signatures pinned by a
step-0 spike (hard gate — writer unusable ⇒ stop and reconsider).

## Steps

0 spike (gate) · 1 app deletions (all suites green + grep-clean) ·
2 sidecar auto-detect + tests · 3 tool pure modules + pytest · 4 tool UI +
real-archive run (city + world packages) · 5 end-to-end import/share in app ·
6 docs (technology.md, build.md, tool README, this file's outcome note) ·
7 full gates.
