# Map — hand-drawn routes (parked 2026-07-27)

The Map tab originally let you draw a **route**: click to drop waypoints, press
Finish, name it, and it was saved as a private polyline in the sealed kv store —
listable in a sidebar card, re-focusable, deletable, and shareable to a room as
an MLS chat card that peers could adopt as their own copy. The tab was cut back
to **pins only**; beacon (server-published pins/zones/routes, beacon.md) is a
different feature and is untouched.

These files are the route implementation as it stood when it was parked. They
are **not compiled or referenced** (`limbo/` is outside the npm `workspaces`
globs) and they are **not maintained** — they are snippets rather than whole
files because route code was interleaved with pin, location and beacon code in
shared files, so almost nothing could be moved wholesale.

| file | what it is |
|---|---|
| `model/mapModel.routes.ts.snippet` | the rakotis half: caps, `MapRoute`, `MapRouteShare`, `buildRouteShare`, `validateRouteShare`, `routeCovered`, and the whole `map:routes` block of `services/mapData.ts` |
| `components/MapPanel.routes.snippet` | the UI half: the two MapLibre line layers, the GeoJSON builders, the draw lifecycle, `showRoute`/`shareRoute`, and the four template regions (toolbar button, Finish/Cancel pair, Routes sidebar card, "Name this route" modal) |
| `tests/routes.spec.ts.snippet` | every deleted test, tagged with the file it came from |
| `i18n/{en,pl}.ts.snippet` | the seven `map.*` route strings lifted out of `apps/enigma/src/i18n/{en,pl}.ts` |

## What it did

**Storage was its own kv namespace.** `map:routes` / scope `default` / key `""`,
a single JSON `MapRoute[]`, sibling to `map:pins` and `map:regions` and written
only by TypeScript — **there was never any route code in Rust**. `maps.rs` is
entirely regions/PMTiles, so no Tauri command, no `invoke_handler` entry and no
Rust test changed when routes were removed.

**Deliberately not device-synced.** `map:*` is absent from the devlink allow-list
(`deviceSyncModel.ts` `DEVLINK_SYNC_KV` / `device_link.rs` `SYNC_KV`) — a locked
decision, so removing `map:routes` needed no sync-gate edit and broke no pinning
test.

**Sharing was a chat card, not a synced collection.** A shared route travelled as
`{type: "map_route", v: 1, name, color?, points}` inside an ordinary encrypted
message — `map_*` is deliberately excluded from the `sync_`/`file_`/`meeting_`
wire families (map.md D6), with regression tests pinning that. Receiving was a
plain per-type validator lookup, so **removing the `map_route` arm is wire-safe
by construction**: an incoming route from a peer still running the feature now
validates to `null` and is dropped silently, which is exactly the behaviour
`packages/rakotis/tests/unit/multiDeviceChannel.test.ts` already pins as
"drops an unknown `map_*` kind — forward compatibility". Adopting a shared route
made a fresh local copy; routes never converged across peers.

**Coverage.** `routeCovered` counted a route as covered when *any* waypoint fell
inside an imported region, so a line crossing the edge still drew the part with
a basemap under it. It was a thin wrapper over `coveredByAny`, which stays — it
is load-bearing for pins, locations and the whole shared layer.

## ⚠ Routes and beacon shared one drawing engine

This is the thing to understand before restoring. `MapPanel.vue` has **one**
draft-polyline machine, and beacon zone/route publishing drives the same one. All
of it **stayed in the app**:

`draftPoints`, the click-to-append branch in `onMapClick`, `draftGeoJson()`, the
`draft-route` source + `draft-route-line` layer, `refreshDraft()`, its watcher,
`cancelDraw()`, the `map.finishRoute` i18n string, and `fitLatLngBounds()`.

So restoring is **purely additive** — nothing has to be un-deleted from beacon.
Two fix-ups the removal made, which a restore should reverse or at least notice:

1. **`addOverlayLayers()`'s idempotency guard** was `map.getSource("user-routes")`.
   With that source gone it now keys off `"draft-route"`. Either is fine; what
   must not happen is keying it off a source that is added *later* in the
   function, or a theme switch double-adds the beacon layers and MapLibre throws
   on duplicate layer ids.
2. **The mode-hint ternary** used `draw-route` as its fall-through arm, so
   `map.clickToExtend` was the terminal expression. `beacon-route` is the
   terminal arm now; re-adding `draw-route` needs the chain extended again.

Also note `BEACON_MAX_POINTS = 2000` (`beaconModel.ts`) numerically mirrors the
parked `MAP_ROUTE_MAX_POINTS = 2000` but is an **independent** constant — there
was never an import between them.

## To restore

1. Paste `model/mapModel.routes.ts.snippet` back into
   `packages/rakotis/src/mapModel.ts` and `src/services/mapData.ts`, each block
   into the section named in its comment.
2. Re-add `MapRouteShare` to the `MapShare` union (`useChatChannel.ts`), the
   `map_route` arm of the receive ternary, and `"map_route"` to
   `PersistedMessageType`, `PERSISTED_TYPES` and `validateMapShareByType`
   (`deviceSyncModel.ts`). **All five, or a route card renders as an empty
   bubble instead of being dropped.**
3. `apps/enigma/src/stores/map.ts`: re-add the `routes` ref, the
   `listRoutes()` line in `reload`, `addRoute` / `deleteRoute`, and their entries
   in the return object.
4. Paste `components/MapPanel.routes.snippet` back into `MapPanel.vue`, re-add
   `"draw-route"` to the `Mode` union, restore the `mode.value === "draw-route" ||`
   half of the click-append condition, and undo the two fix-ups above.
5. `MapShareCard.vue` / `SharedSharesCard.vue` / `sharedLayerModel.ts`: re-add the
   `map_route` arms and `"route"` to `SharedKind`.
6. **i18n** — paste `i18n/en.ts.snippet` and `i18n/pl.ts.snippet` into the `map:`
   namespace of `apps/enigma/src/i18n/{en,pl}.ts`. **Both files in lockstep** —
   `apps/enigma/tests/unit/i18n.test.ts` compares the two key trees exactly.
   `finishRoute` is deliberately absent from the snippets: beacon kept it.
7. Restore the tests from `tests/routes.spec.ts.snippet`, and revert the three
   edits the removal made to surviving tests: in
   `apps/enigma/tests/unit/sharedMapLayer.test.ts` the kind assertion is back to
   `[["a","pin"],["b","route"],["c","loc"]]`, the two `msg("b", PIN)` fixtures
   become `msg("b", ROUTE)` again, and two test titles regain "routes".
8. Docs: map.md (§1 Scope, §2 D6, §3.2, §3.3, §4, §6, §7, §8, §11 and Part IV
   D15/D16 + Coverage/Rendering/Pins) and technology.md §12.
9. Gates: `npx vitest run` in `apps/enigma` and `packages/rakotis`,
   `npx vue-tsc --noEmit`, `npm run build`, `npx playwright test`.

## Caveats

- **It does not typecheck against the live tree.** The snippets reference
  `MapRoute`, `MAP_ROUTE_MAX_POINTS`, `store.routes`, `nameModal` and friends,
  none of which exist any more.
- **Existing route cards in a user's history are dropped on next load.**
  `"map_route"` came out of `PERSISTED_TYPES`, so a stored route message fails
  `validatePersistedMessage` and is pruned from `chat:log`. This was the
  conscious choice over the alternative — keeping the type but losing the
  validator, which would have rendered a permanent empty bubble.
- The **route colour picker never existed**: `addRoute` was always called without
  a colour, so `MAP_PIN_COLORS` was pin-only in practice despite `pinColors.ts`
  advertising itself as "pin/route colours". The `color` field survives in the
  parked wire type because *adopted* shares could carry one.
- `map.md` still describes routes in a dozen places; it was updated where the
  text was load-bearing, not exhaustively rewritten.
