# Beacon — server location shares on the Maps tab (beacon.md)

Status: **IMPLEMENTED 2026-07-26** — all gates green
(rakotis 249 vitest · enigma 536 vitest · cargo 119 · Playwright 18 ·
vue-tsc + vite builds clean). Server contract: the faros repo's
`for_enigma.md` (`toto.beacon`, shipped the same day). Branch `beacon`.

Beacon is the first **cloud-backed map feature**: logged-in users of the same
self-hosted faros server publish expiring location shares — one **live pin**
per user (publishing again moves it), **zones** (polygons) and **routes**
(linestrings), each with an optional comment and a **mandatory expiry** — and
see everyone else's active shares as a layer on the offline Maps tab. It is
the server-side complement to the MLS map chat cards: coarser trust (anyone
logged in to the server), but persistent, multi-device, and reachable over
the onion when peers are offline.

Guiding rule, unchanged from map.md: reuse the existing in-repo pattern for
every piece; the named template is the thing to copy.

## Decision log

- **D1 — Same server, same session.** Beacon rides Enigma Cloud: `beacon.rs`
  calls cloud.rs's `request_json`/`ensure_online` (promoted `pub(crate)`), the
  `cloud:auth` bearer token, the same onion/Tor-exclusive/WebPKI transport
  policy and the settings-driven connect timeout. No new network policy, no
  second login (`/telegraph/api/login/` is aliased server-side).
- **D2 — Derived gating, no new build switch.** Beacon is meaningless without
  the cloud client (no login) and invisible without maps (no canvas), so it is
  enabled exactly when `cloud.allow_connections && maps.enabled` — Rust guard
  `BEACON_DISABLED`, frontend `beaconAvailable` adds `isTauri()`. All four
  build-config YAMLs stay untouched; §15's table gains no row.
- **D3 — Tap-only location, upheld.** map.md D14 applies verbatim: a beacon
  pin is a tapped point, zones/routes are click-drawn; `navigator.geolocation`
  stays untouched and the Playwright trap plus a new browser-shell absence
  test keep it executable.
- **D4 — Explicit action only.** Publish and refresh are button presses;
  fetch also happens once on Maps-tab open (BeaconCard mount). No polling —
  freshness is the user's choice, which is the Tor-friendly default.
- **D5 — Nothing at rest.** Fetched shares live in a volatile Pinia store
  (`stores/beacon.ts`); layer visibility is a session preference
  (`sharedLayerVisible` precedent). There is **no `beacon:*` kv namespace**,
  hence nothing to pin in `DEVLINK_SYNC_KV` and no §13 entry.
- **D6 — Passthrough commands, frontend validation.** The `beacon_*` commands
  return server JSON as-is (the `cloud_list` pattern); every item is then
  narrowed by rakotis `beaconModel` exactly like an MLS wire payload. Rust
  validates only what it constructs (coordinates, ring closure, TTL > 0).
- **D7 — Expiry is a render decision; the server is authoritative.** The
  server never returns expired rows and hard-deletes them (~10 min cadence);
  between refreshes the client culls with `isBeaconLive` on a minute tick.
  TTL presets 15 min / 1 h / 6 h (default 6 h — `MAP_LOC_TTL_MS` kinship);
  the server cap (default 7 d) surfaces as a 400 in the publish modal.
- **D8 — Near-here is viewport-shaped.** "Near here" queries `/beacon/near`
  centered on the map center with radius = distance to the NE corner
  (min 1 km); the server sorts by distance and the card preserves that order,
  showing `distance_m`. Clearing returns to the plain list.
- **D9 — Own colour, outside every palette.** `BEACON_COLOR = #0d9488` (teal)
  in `pinColors.ts` — never offered in the pin editor, never in a payload; a
  server share can't be mistaken for a local pin (blue), a room share
  (violet/orange) or a draft (amber).

## As-built map

| Piece | File |
|---|---|
| Wire model + validation + expiry + haversine | `packages/rakotis/src/beaconModel.ts` |
| Rust client (8 `beacon_*` commands) | `apps/enigma/src-tauri/src/beacon.rs` |
| Store (volatile, cloud-session-coupled) | `apps/enigma/src/stores/beacon.ts` |
| Sidebar card (fetch-on-open, near mode) | `apps/enigma/src/components/map/BeaconCard.vue` |
| Publish modal (TTL presets, comment, name) | `apps/enigma/src/components/map/BeaconPublishModal.vue` |
| Map layer + modes + banner | `apps/enigma/src/components/map/MapPanel.vue` |
| Tests | `packages/rakotis/tests/unit/beaconModel.test.ts`, `apps/enigma/tests/unit/beaconStore.test.ts`, `apps/enigma/tests/component/beaconCard.test.ts`, `beacon.rs` inline, `apps/enigma/tests/e2e/map.spec.ts` |

## Accepted limitations

- **Poll freshness.** faros is HTTP-only (no websocket layer), so there is no
  push; the map is as fresh as the last open/refresh. Fine for the "where is
  everyone roughly" use case; revisit only if the server grows an event path.
- **Server-trust visibility.** Every logged-in user of the server sees every
  active share — deliberately coarser than MLS rooms. The publish modal says
  so ("everyone logged in to your server…").
- **Outer ring only.** Zone holes from the wire are ignored (drawn as the
  outer ring); the enigma publisher never creates holes.
- **No edit.** Shares are create/delete; a pin "moves" by re-publishing.
- **No coverage gating.** Unlike room shares, beacon items draw even over
  uncovered (blank) basemap — the share is true regardless of which offline
  regions this device happens to have.

## Manual two-instance verification (run2.sh)

1. Bring up a GIS faros locally (`deploy_local.sh` or `runasgi`), create two
   accounts.
2. `./run2.sh` → in both instances set the Cloud server URL (Settings) and log
   in (Files → Cloud).
3. Alice: Maps → Publish my pin (tap, 6 h, comment) → publish a zone and a
   route. Bob: Maps → beacon card → Refresh → all three appear (teal), banner
   shows comment + expiry; Near here sorts by distance; Alice retracts →
   Bob refreshes → gone.
