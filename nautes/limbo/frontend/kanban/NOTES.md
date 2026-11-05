# Group Kanban board (parked 2026-07-27)

A shared Kanban board per chat room — captain-managed columns, cards any member
could create / edit / assign / drag between columns, all converging over the
room's MLS-encrypted sync seam and persisted per-profile in the encrypted kv
store. It shipped as its own **Board** tab, then as the *Board* sub-tab of the
Notes tab; the Notes tab was removed and all three of its sub-tabs were parked.

These files are the implementation as it stood at parking. They are **not
compiled or referenced** — `limbo/` is outside the npm `workspaces` globs
(`packages/*`, `apps/*`) — and they are **not maintained**.

| file | what it is |
|---|---|
| `views/EnigmaKanbanView.vue` | the tab surface: empty states, captain badge, and every modal (card form, column add/rename, both delete confirms) |
| `components/KanbanBoard.vue` | horizontal scroller of columns + the captain's "Add column" tile; pure layout, forwards actions up |
| `components/KanbanColumn.vue` | one column: header, admin controls, its ordered cards, the native drop zone and the drop-index maths |
| `components/KanbanCard.vue` | one draggable card: colour strip, assignee avatar, due/overdue badge, promote/demote/edit/delete |
| `components/CardEditModal.vue` | create/edit form (title, description, assignee from the roster, due date, colour label) |
| `components/dragState.ts` | the module-level dragged-card ref (WebKitGTK workaround, see below) |
| `components/kanbanModel.ts` | pure data model: fractional index, wire types, both reconcilers, ordering, validation — no Vue/Tauri imports |
| `components/useKanban.ts` | the orchestrator: kv persistence, column/card actions, outbox, wire protocol, receive handler |
| `tests/kanbanModel.spec.ts` | unit tests for the model (key ordering, LWW ties, captain rev rule, validation) |
| `i18n/{en,pl}.ts.snippet` | the whole `kanban` namespace plus the `nav.board` key, lifted out of `apps/enigma/src/i18n/{en,pl}.ts` |

## What it did

**Board identity = room slug.** One board per room; there was no board id and no
board list. `useKanban` watches `channel.currentRoom.value?.slug`, reloads on
change, and both the send path (`canSend()`) and the receive path drop anything
whose `roomSlug` is not the currently open board. Persistence is the encrypted kv
store, namespace **`"kanban"`**, scope `"default"`, key = the room slug, value =
a JSON `BoardDoc` (`{ columns, columnsRev, cards }`, tombstones included).

**Two different ownership models on one board.** Columns are *captain-owned*: the
captain (lowest live MLS id, reused from the chat channel — `channel.amCaptain` /
`channel.captainId`) is the only writer, and the whole column list travels as a
single snapshot behind a **monotonic `columnsRev`**, modelled on `room_meta`.
`applyRemoteColumns` accepts the captain's snapshot at *same-or-higher* rev and
anyone else's only when *strictly newer* — the second clause is the handoff path
for when captaincy has just changed. A new captain that adopts a peer's snapshot
immediately re-broadcasts it authoritatively so the room reconverges.

Cards are *collaboratively owned*: any member creates, edits, assigns, moves,
reorders or deletes one, and `applyRemoteCard` reconciles **last-write-wins on
`updatedAt`**. On an equal timestamp, a delete beats a non-delete; otherwise the
higher `author` id wins; otherwise the message is a duplicate and is dropped.
That single rule covers create / edit / move / promote / demote / reorder /
delete, because a move is just an upsert that changes `columnId` / `orderKey` and
a delete is an upsert with `deleted: true`. Tombstones are retained (never
compacted), so a delete heals a concurrent re-add instead of losing to it.

**Wire protocol — `kanban_*` inner types over the MLS `onSync`/`sendSync` seam**
(`useKanban.ts`), the same seam as `file_*` / `meeting_*` / `vox_*`:

- `kanban_columns` — `ColumnsWire`: the full column list + `columnsRev`. Captain
  only (`flushOutbox` gates the send on `amCaptain`).
- `kanban_card_upsert` — `CardWire`: the **full** card, never a delta. Deletes
  ride the same type.

Both carry `roomSlug`, `fromName` and `fromDevice`; the receive handler drops
its own echo (`payload.fromDevice === selfDevice()`) and anything for another
room.

**Delivery model** (copied from `useMeetings`): `sendSync` reaches only the
currently connected members of the open room, so every mutation sets a
`needsBroadcast` outbox flag, `flushOutbox()` runs on mutation and whenever
`mlsStatus` turns `ready`, and `rebroadcastBoard()` re-sends the whole board
whenever the participant count grows. Because upserts are idempotent and LWW,
*any* online holder can heal a late joiner — not only the last writer. Residual
gap accepted for v1: a peer never online at the same time as any holder of a card
never learns it.

**Fractional-index order keys.** Columns and cards both carry an `orderKey`: a
base-62 fraction string compared lexicographically (ASCII order == rank order),
an inline port of rocicorp's `fractional-indexing` midpoint with zero
dependencies. `keyBetween(a, b)` returns a key strictly between two neighbours,
`null` meaning "before everything" / "after everything". An insert or a move
rewrites **one** key instead of renumbering the list, which is what stops two
peers' concurrent moves from reshuffling each other. `compareCards` breaks ties
by `orderKey`, then `author`, then `id`, so two cards that end up with identical
keys still sort identically on every peer. `moveCard` catches the `a >= b` throw
from `keyBetween` (possible when neighbours share a key) and falls back to
"after the lower neighbour", so a drop never fails.

**Cooperative trust model.** `author`, `fromDevice` and the captain id are
self-asserted inside the ciphertext. MLS authenticates *group membership*, not
authorship — a malicious member can forge any of them, including claiming
captaincy to overwrite the columns. Same posture as `meetingModel.ts`; the board
is a collaboration tool for a room whose members already trust each other.

**The WebKitGTK dataTransfer workaround.** Drag-and-drop is native HTML5, no
library. The dragged card id is stashed in a module-level `ref` in
`components/dragState.ts` instead of the `DragEvent`'s `dataTransfer`, because
WebKitGTK (Tauri's Linux webview) is unreliable with custom-MIME `dataTransfer`
round-trips. Only one board is ever on screen, so one shared ref is safe.
`KanbanCard` sets it in `dragstart` and clears it in `dragend`; `KanbanColumn`
reads and clears it in `drop`. The insertion index is derived from the pointer's
`clientY` against the rendered `[data-card-id]` elements (the dragged card's own
node is excluded, since it stays in the DOM until drop). When
`kanban_allow_reorder` is false, a drop within the same column is ignored and a
cross-column drop appends to the end.

**Attention count → nav dot.** `unseen` increments on every accepted remote
`kanban_columns` or `kanban_card_upsert`; `attentionCount` exposes it and
`markSeen()` zeroes it. `App.vue` rendered a pulsing dot next to the nav link
(desktop and mobile) when `kanban.attentionCount.value > 0`, titled
`kanban.attentionTitle`. `EnigmaKanbanView` clears it `onMounted` and again via a
watcher, so the dot only ever shows while the board is off-screen. This is why
the composable was an **app-lifetime singleton in `stores/chat.ts`** rather than
view-local: remote changes had to land while the tab was closed.

**Build-config surface** (all consumed in `useKanban`, except the columns seed
which `seedDefaultColumns` reads): `kanban_enabled`, `kanban_allow_reorder`,
`kanban_default_columns`, `kanban_max_cards_per_board`,
`kanban_max_card_title_len`, `kanban_max_card_description_len`.

**Deliberately not device-synced.** The `"kanban"` kv namespace was excluded from
the linked-device sync allow-list (`packages/rakotis/src/deviceSyncModel.ts`)
because the room seam already converges the board on every device that is in the
room. `packages/rakotis/tests/unit/deviceSyncModel.test.ts` still pins
`isSyncableKv("kanban", "default", "room-1") === false`.

## To restore

1. **Move the files back** (no dependencies to install — the feature has zero npm
   deps, and every FontAwesome icon it uses (`table-columns`, `star`, `plus`,
   `check`, `trash`, `triangle-exclamation`, `arrow-left`, `arrow-right`,
   `pencil`, `clock`) is still registered in `apps/enigma/src/main.ts` for other
   features):
   - `components/{KanbanBoard,KanbanColumn,KanbanCard,CardEditModal}.vue`,
     `components/{dragState,kanbanModel,useKanban}.ts` →
     `apps/enigma/src/components/kanban/`
   - `views/EnigmaKanbanView.vue` → `apps/enigma/src/views/`
   - `tests/kanbanModel.spec.ts` → `apps/enigma/tests/unit/kanbanModel.spec.ts`
     (its import is already `../../src/components/kanban/kanbanModel`)

2. **Decide the fractional-index duplication — this is the one restore step
   unique to this feature.** `kanbanModel.ts`'s `keyBetween` / `seedKeys` /
   `last` / `DIGITS` were copied into
   `apps/enigma/src/components/peers/boardKeys.ts` when this was parked, because
   the **peers board stays in the app** and could not depend on parked code. That
   file also carries `PEER_BOARD_DEFAULT_COLUMNS = ["To Do", "In Progress",
   "Done"]`, which replaced the build-config key `kanban_default_columns`.
   The two copies are byte-identical apart from the error-message prefix
   (`"kanban keyBetween: …"` vs `"board keyBetween: …"`) and the comment header.
   Pick one and say so in the commit:
   - **Re-share:** move the helpers into a neutral module (e.g.
     `packages/rakotis/src/fractionalIndex.ts`, or
     `apps/enigma/src/components/shared/boardKeys.ts`), import from both
     `kanbanModel.ts` and `PeerBoardPanel.vue`, and keep
     `PEER_BOARD_DEFAULT_COLUMNS` with the peers board. One implementation, one
     set of tests — but it couples two features that ship under different build
     flags (`peers_enabled` is Pro-only; see pland.md).
   - **Leave both copies:** cheapest, and the peers board keeps working if the
     Kanban board is parked again. If you take this option, keep
     `tests/unit/kanbanModel.spec.ts`'s `keyBetween`/`seedKeys` blocks *and* add
     the equivalent for `boardKeys.ts`, so neither copy drifts untested.

   `PeerBoardPanel.vue` is the only importer:
   `import { keyBetween, last, seedKeys, PEER_BOARD_DEFAULT_COLUMNS } from "./boardKeys";`

3. **Build config** — restore the `kanban:` section across the four coordinated
   files plus the three edition configs:
   - `apps/enigma/src-tauri/build_config.yaml`:
     ```yaml
     kanban:
       enabled: true
       allow_reorder: true
       default_columns: ["To Do", "In Progress", "Done"]
       max_cards_per_board: 500
       max_card_title_len: 200
       max_card_description_len: 4000
     ```
   - `apps/enigma/src-tauri/configs/build_config.{light,plus,pro}.yaml`: same
     block; `enabled: false` in light and plus (Pro only), `true` in pro. The
     caps must still be present and valid in the disabled editions — `build.rs`
     uses `#[serde(deny_unknown_fields)]` and validates unconditionally.
   - `apps/enigma/src-tauri/build.rs`: the `kanban: KanbanSection` field on
     `RawConfig`, the `KanbanSection` struct, the `validate()` block
     (`default_columns` non-empty and no blank names; each of the three caps
     `> 0`), the `pub mod kanban { … }` codegen template, and the six
     `kanban_*` format args.
   - `apps/enigma/src-tauri/src/lib.rs`: the six `kanban_*` fields on
     `BuildConfigSummary`, their initializers in `app_get_build_config`, and
     `kanban` in that function's `use build_config::{…}` list.
   - `packages/rakotis/src/services/appStorage.ts`: the six fields on the
     `BuildConfig` interface **and** in `FALLBACK_BUILD_CONFIG` (browser/test
     mode reads the fallback — `apps/enigma/tests/setup.ts` seeds only a handful
     of keys and never mentioned kanban).

4. **Re-add the `kanban_` clause to the sync-family allow-list** in
   `packages/rakotis/src/useChatChannel.ts` (~line 1004), beside `meeting_` /
   `vox_` / `dlink_`, and put `kanban_*` back in the routed-families doc comment
   at ~line 362. Without the clause, `kanban_*` messages fall through and render
   as raw JSON chat bubbles. *(Checked at the time of writing: the clause and the
   comment mention are both already gone from the live file.)*

5. **Re-wire the app-lifetime singleton** in `apps/enigma/src/stores/chat.ts`:
   ```ts
   const kanbanEnabled = getBuildConfig().kanban_enabled;
   const kanban = kanbanEnabled ? useKanban(p2p) : null;
   ```
   plus `if (kanban) await kanban.reload();` in `applyRuntimeProfile` (a profile
   switch swaps the kv data dir) and `kanban, kanbanEnabled` on the returned
   object.

6. **Routing and nav.** The `/notes` route, the `/board` → `/notes?tab=board`
   redirect and the Notes nav links are all gone from
   `apps/enigma/src/router/index.ts` and `apps/enigma/src/App.vue`. Two options:
   - Restore the Notes shell (`limbo/frontend/notes-shell/views/EnigmaNotesView.vue`
     → `apps/enigma/src/views/`, plus its `nav.notes` i18n snippet and the
     `note-sticky` icon, which was removed from `main.ts`). Note the shell's
     sub-tab gate reads `buildCfg.kanban_enabled` / `sketch_enabled` /
     `mind_enabled` — if the other two stay parked, the shell degrades to a
     one-button bar and a plain `/board` route is the better shape.
   - Or mount the board as its own top-level tab again: a `/board` route with
     `beforeEnter: () => getBuildConfig().kanban_enabled || "/chat"` (the guard
     must be `beforeEnter`, not a module-eval `if` — the table is evaluated
     before `initBuildConfig` resolves), and the desktop + mobile nav links in
     `App.vue` with the attention dot:
     ```vue
     <span v-if="(kanban?.attentionCount.value ?? 0) > 0"
           class="h-2 w-2 animate-pulse rounded-full bg-warn-dark"
           :title="$t('kanban.attentionTitle')" />
     ```
     `App.vue` needs `const kanban = chatStore.kanban;` /
     `const kanbanEnabled = chatStore.kanbanEnabled;` back.
   Either way, fix `EnigmaKanbanView.vue`'s header comment — it claims the
   `/board` route's `beforeEnter` guarantees `chatStore.kanban` is non-null,
   which was already stale under the Notes shell.

7. **i18n** — paste `i18n/en.ts.snippet` into `apps/enigma/src/i18n/en.ts` and
   `i18n/pl.ts.snippet` into `pl.ts`: the `board:` line into the `nav:` block,
   the `kanban: { … }` namespace at the top level. Both files must land in
   lockstep — `apps/enigma/tests/unit/i18n.test.ts` compares the two key trees
   exactly. Add `kanban` back to the namespace list in `technology.md` §i18n if
   that list has been corrected by then.

8. **Tests** — `apps/enigma/tests/unit/chatStore.test.ts` was edited down when
   the singleton was removed and must go back up:
   - `expect(p2pStub.onSync).toHaveBeenCalledTimes(3)` → `4` in the
     "creates the … singletons" case (and its title/comment).
   - the `kanbanEnabled` / `kanban` / `attentionCount` assertions in that case.
   - `kanban_enabled: false` in the Light-edition `freshStore({…})` override and
     the two `expect(store.kanban…).toBeNull()` assertions.
   - the two stub comments mentioning kanban in `makeP2pStub`.
   Leave `packages/rakotis/tests/unit/deviceSyncModel.test.ts` alone: the
   `isSyncableKv("kanban", …) === false` pin is still correct — the board is
   deliberately not device-synced. Restore the explanatory sentence in
   `deviceSyncModel.ts`'s allow-list comment if you want the reason recorded
   again.

9. **Gates** — `npm run test --workspaces` (vitest: enigma + rakotis),
   `npm run build -w apps/enigma` (`vue-tsc --noEmit` then `vite build`),
   `npm run typecheck -w rakotis`, and a `cargo build` under
   `apps/enigma/src-tauri` (the build-config codegen is a compile-time gate —
   a missing `kanban:` section is a `deny_unknown_fields` / missing-field error,
   not a runtime surprise). Then run each edition config through
   `build_desktop.sh` if you touched `configs/build_config.*.yaml`.

## Caveats

- **It does not typecheck against the live tree.** Nothing was kept compiling.
  The `ChatChannel` surface it uses (`currentRoom`, `participants`, `mlsStatus`,
  `mlsIdentity`, `currentUserName`, `amCaptain`, `captainId`, `onSync`,
  `sendSync`) and the rakotis primitives it imports (`OyaButton`,
  `OyaEmptyState`, `OyaModal`, `OyaTextField`, `OyaTextArea`, `OyaAvatar`,
  `Participant`, `kvGet`/`kvPut`, `getBuildConfig`) were all still present and
  unchanged in shape when this was written — but that was checked once, on the
  day of parking, and is not maintained.
- **Stale cross-references inside the parked code.** `applyRemoteColumns`'s
  docstring cites `useChatChannel.ts:789` for the room_meta handoff rule; that
  logic now lives around `applyRoomMeta` (~line 536) and the rev gate (~line 950).
  Line numbers in these comments should be re-checked, not trusted.
- **Repo docs were not updated when this was parked.** `build.md` still lists
  `kanban` among the feature kill switches with its caps, `sync.md` still
  references kanban in the sync-gate history and the non-synced list, and
  `technology.md` still lists `kanban` among the i18n namespaces. Convenient for
  a restore, wrong for the tree as it stands.
- **`rebroadcastBoard()` is O(cards) MLS messages.** It sends one
  `kanban_card_upsert` per card — tombstones included — on *every* increase in
  participant count. Each `sendSync` is a full MLS state export + AEAD seal +
  fsync, so with `max_cards_per_board: 500` a busy room's join churn is
  expensive. It was acceptable at the board sizes this saw; a restore into a
  larger room should add a compacted snapshot type (the way `useSketch` did) or
  at least a rate limit.
- **Hitting `kanban_max_cards_per_board` fails silently.** `createCard` returns
  early with no error and no toast, and there is no i18n string for a full board
  (the sketch board had `sketch.boardFull`; this never got one). Add one if the
  cap is ever likely to be reached.
- **A demoted captain's pending column edit never sends.** `flushOutbox` gates
  the `columnsNeedsBroadcast` branch on `amCaptain.value`, so a column mutation
  made while offline and flushed after captaincy changed is dropped from the
  outbox on the next successful flush of the card queue. Correct by the
  ownership rule, but it means the ex-captain's local column state can differ
  from the room's until the new captain's snapshot arrives at a higher rev.
- **Cooperative trust only.** See above — a member can forge `author`,
  `fromDevice` or captaincy. Do not restore this into a room model where members
  are not mutually trusted without signing the wire payloads.
