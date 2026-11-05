# Beacon — server location shares on the Maps tab (beacon.md)

Status: **REMOVED 2026-08-15** (branch `cleanup_1408`, commits `49e235e` /
`6e5664f`). Implemented 2026-07-26, deleted with the Cloud feature — see
[cloud.md](cloud.md). The full D1–D9 log is preserved in git at
`6e5664f:beacon.md`.

## What it was

Beacon was the cloud-backed layer on the Maps tab: users logged in to the same
self-hosted faros server published expiring location shares — one **live pin**
per user (publishing again moved it), **zones** (polygons) and **routes**
(linestrings), each with an optional comment and a **mandatory expiry** — and
saw everyone else's active shares as a teal layer over the offline basemap. It
was the server-side complement to the MLS map chat cards: coarser trust (anyone
logged in to the server sees every active share), but persistent, multi-device,
and reachable over the onion when peers were offline.

It rode Enigma Cloud entirely — same session, same transport policy, same
connect timeout, no second login — and was enabled exactly when
`cloud.allow_connections && maps.enabled`, so it needed no build switch of its
own. Locations were **tapped, never sensed**: `navigator.geolocation` was never
called. Publish and refresh were button presses; a fetch also ran once on Maps
tab open. Nothing was persisted — fetched shares lived in a volatile Pinia
store, so there was no `beacon:*` kv namespace and nothing to add to
`DEVLINK_SYNC_KV`. In Tor-exclusive mode the whole surface was dropped:
publishing a geographic location while hiding your network location is
incoherent, so nothing was published and `/beacon/all` was never fetched.

## What was deleted

`beacon.rs` (8 `beacon_*` commands), `stores/beacon.ts`, `BeaconCard.vue`,
`BeaconPublishModal.vue`, the beacon layer / draw modes / banner in
`MapPanel.vue`, `BEACON_COLOR` in `pinColors.ts`, `packages/rakotis`
`beaconModel.ts`, and the tests `beaconModel.test.ts`, `beaconStore.test.ts`,
`beaconCard.test.ts`, the inline Rust tests and the beacon arm of
`tests/e2e/map.spec.ts`.

## What replaced it

Nothing. Location sharing survives only as the in-room map share — a tapped
spot sent over the encrypted MLS seam to one room, with no server copy and no
cross-room visibility. There is no persistent, multi-device or offline-reachable
share any more. The rest of the Maps feature ([map.md](map.md)) is untouched,
including the rule that `map_*` stays out of the device-sync gate.

## If it ever comes back

- **Tap-only, and keep the trap.** A beacon pin was a tapped point and zones and
  routes were click-drawn; `navigator.geolocation` was never touched, and a
  Playwright trap plus a browser-shell absence test kept that executable rather
  than aspirational. Restore the test with the feature, not after it.
- **Expiry is a render decision; the server is authoritative.** The server never
  returned expired rows and hard-deleted them on a ~10 min cadence, while the
  client culled with `isBeaconLive` on a minute tick between refreshes. A
  mandatory TTL with no "forever" option was the point of the feature — a
  location share that outlives its reason is the failure mode.
- **Visibility was server-wide, and said so.** Every logged-in user of the
  server saw every active share, deliberately coarser than an MLS room, and the
  publish modal stated it in those words before the press. Any successor keeps
  that sentence or narrows the audience; it must not quietly do neither.
- **Its own colour, outside every palette.** Teal `#0d9488`, never offered in
  the pin editor and never carried in a payload, so a server share could not be
  mistaken for a local pin, a room share or a draft.
