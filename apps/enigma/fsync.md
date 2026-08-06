# Files → Devices — implementation plan (fsync.md)

**Status: IMPLEMENTED 2026-07-26** (branch `device_files`) — rakotis 208 vitest ·
enigma 502 vitest · cargo 112 · Playwright 16 · vue-tsc + vite build clean.

**Tree redesign 2026-08-06** (§0 below) — rakotis 278 · enigma 657 · cargo 153 ·
enigma_builder 226 · vue-tsc + vite build clean.

## 0. The tree redesign (2026-08-06) — decisions D9–D15

The flat allowed-files list became a **file tree** (the toto-vault flat-DFS
pattern: `{id, pid, depth}` rows, `FileTree.vue` + `treeBuilder.ts`), and the
model moved from "picker paths anywhere" to **the enigma folder is the bucket**.

- **D9 — the enigma folder.** `~/Enigma` (default profile; `~/Enigma-<profile>`
  otherwise — two dev instances on one machine must not collide) is created on
  demand (`filesync_root`) and is both the scan root and the import landing
  folder (new imports no longer land in `<profile_dir>/synced/`; old absolute
  paths in the local record stay valid). `filesync_scan` walks it (no symlinks,
  no dotfiles, depth ≤ 16, 2 000 files, then `truncated`). Legacy entries at
  picker paths get a one-shot **copy-in** via `filesync_migrate` (sources are
  never deleted); the picker's Add file now copies into the root first.
- **D10 — `dir` on the wire.** `SyncedFileEntry.dir` = POSIX-relative directory
  inside the folder ("" = root; the name stays separate). Validation demotes a
  bad dir to root rather than rejecting the entry; merge treats it
  immutable-after-add with local-wins, because a down-level device's validator
  REBUILDS entries without unknown fields and its echo must not strip it.
  Directories are derived from file dirs — empty dirs never replicate and cost
  no cap. `dlink_file_push` items carry `dir` so imports land in the matching
  subfolder (per-segment sanitization Rust-side).
- **D11 — receiver consent.** An unsolicited `dlink_file_push` no longer
  downloads: it parks as a session-only pending offer (cap 8, oldest drops) in
  `useDeviceSync` until the user Accepts (replays the frame through the store's
  existing download path) or Declines (`dlink_file_result` status `"declined"`,
  new). A push carrying `reqId` answers our own pull — that press was the
  consent — and passes straight through. Down-level compat: an old receiver
  still auto-accepts (it never parks), an old sender shows a declined row as
  dropped-frame silence; our sender coerces unknown statuses to `failed`.
- **D12 — markers.** Per file, relative to each sibling: **missing** (listed,
  no bytes on that side), **excess / only here** (bytes on one side only),
  **changed** (both hold it, BLAKE3 differs — the hashes were already in
  `copies`), **not shared** (in my folder, not on the list).
- **D13 — changed ⇒ pull-only.** A hash-diverged file never enters a push
  batch (`pushSelected` filters it; the panel disables Push and says why).
  Divergence is resolved by pulling the version you want, on the device that
  wants it.
- **D14 — share is explicit.** A file dropped into the folder shows in MY tree
  immediately but replicates nothing until its per-row **Share** action puts it
  on the list. Three consents total: share the name → push (sender) → accept
  (receiver).
- **D15 — buckets.** My bucket: the scan plus ghost rows for listed files
  absent here. One names-only bucket per linked sibling (labels from the
  registry), markers per D12 — their paths never leave their device.

The **key ring** (Files → Keys, `keyring.enabled` gate, Pro-only default) is a
separate feature that shipped alongside: one passphrase, many files, sealed
per-file DEKs wrapped under a ring KEK in `<profile_dir>/keyring.enig`,
device-local by design (never in `DEVLINK_SYNC_KV`) — see `keyring.rs`.

Per-file **Push/Pull** between the user's **own** linked devices, plus the new
home for everything device-related: Settings → Devices is gone; Files → Devices
took its place.

## Decision log (Q&A, 2026-07-26)

- **D1 — no automatic transfers, ever, and no auto-sync knob.** The surface is a
  list of *allowed files* with a checkbox per row and a Select all; **Push** and
  **Pull** act on the selection in one batch. Direction is chosen at action time,
  never stored per entry. (Two earlier drafts — auto-sync, then an opt-in
  auto-sync knob — were both superseded by the user before implementation.)
- **D2 — shared list.** Entries are added from local files only (native picker;
  no remote browsing). The list replicates to the linked devices, so either side
  can push its copy or pull the peer's. Removing an entry removes it on both.
- **D3 — landing folder.** Received files land in `<profile_dir>/synced/`; each
  device tracks its own path. Removing an entry never deletes bytes.
- **D4 — Settings → Devices removed entirely.** No deep links existed (`?tab=`
  greps clean; an unknown tab already falls back to "settings").
- **D5 — the device list is a first-class header** in the Devices tab, visible
  above both sub-sub-tabs, not buried in the pairing forms.
- **D6 — own devices only.** Everything rides the devlink machinery (registry,
  hidden room, link-key admission). A friend can never appear here; this is
  disjoint from the room-peer P2P file share in Files → P2P.
- **D7 — overwrite, skip identical.** The button press is the consent: the
  destination copy is replaced, and entries whose hash already matches are
  skipped. Per-file outcomes are surfaced.
- **D8 — no new build knobs.** The tab rides `devices.allow_linking`; caps are
  model constants (linked devices must agree on validation limits — the
  `DEVLINK_MAX_DEVICES` precedent).

## 1. Data model (rakotis `src/fileSyncModel.ts`)

```ts
FileCopyInfo  { hash /*blake3 hex64*/, size, updatedAt }
SyncedFileEntry {
  id /*nanoid*/, name, addedBy /*deviceId*/, addedAt, updatedAt,
  removedAt?,                      // sticky tombstone
  copies: Record<deviceId, FileCopyInfo>,   // each device writes ONLY its slot
}
```

Caps: `FILESYNC_MAX_ENTRIES` 200 live, wire lists ≤ ×4, save-time tombstone trim
past ×2, names ≤ 120 chars.

**Storage** (sealed kv, both device-local at rest):
- `("filesync","default","")` — the shared list. Replicated ONLY via the
  `dlink_files` message; deliberately absent from `DEVLINK_SYNC_KV` /
  Rust `SYNC_KV` (negative pinning tests on both sides).
- `("filesync","default","local")` — `{entryId → {path,hash,size,verifiedAt}}`.
  **Never on the wire**: a path leaks this device's directory layout, and the
  peer's copy lives somewhere else anyway. Hash/size travel inside `copies`.

**Merge** (`mergeFileLists`) is conflict-free by construction: union by id;
`name`/`addedBy`/`addedAt` immutable after add; `removedAt` earliest-wins and
sticky; `copies` per-slot LWW by `updatedAt` — and since only device X writes
`copies[X]`, offline concurrent edits cannot truly conflict.

**Tombstones are a deliberate departure from sync.md's "no deletion sync"**: the
locked UX promises that removing a file removes it on both devices, which a
union merge cannot deliver (the peer's next `dlink_files` would resurrect it).
Scoped to this one list; rooms/contacts keep their model. Noted in sync.md §9.

## 2. Wire (all `v:1`, over the hidden devlink room)

| message | who sends it | when |
| --- | --- | --- |
| `dlink_files {entries}` | both | every hello (rides `pushMergeableKv`) + after each local mutation. Receiver merges + persists, **never re-broadcasts** (anti ping-pong; the peer converges on its own hello — the contacts rule). |
| `dlink_file_push {reqId?, items[]}` | sender | after creating file_xfer offers; `reqId` present ⇒ it answers a pull. |
| `dlink_file_pull_req {reqId, entryIds}` | puller | on Pull, for entries a sibling has and we don't already match. |
| `dlink_file_result {reqId?, entryId, status}` | receiver | `received / skipped / missing / too-large / failed`. |

`items[]` carries only offer coordinates + `{name,size,hash}` — **bytes never
touch this seam**, they ride file_xfer's QUIC path.

**Seam** (`useDeviceSync.ts`): `dlink_files` is handled inside the composable
(list convergence is its job, sibling of contacts/rooms merging); everything
matching `dlink_file_` passes through `onDevlinkFile(fn)` to the app store, and
`sendDevlinkFile(type,payload)` sends (throwing when the channel is down). Note
`"dlink_files"` does not match the `"dlink_file_"` prefix — that is why both can
coexist. The `dlink_` prefix already passes the chat seam's sync gate
(`useChatChannel.ts:1000`), so **no gate change was needed**.

New useDeviceSync exports: `fileEntries`, `sendFileList`, `upsertFileEntry`,
`tombstoneFileEntry`, `recordFileCopy`, `onDevlinkFile`, `sendDevlinkFile`,
`devOnline`, `onlineLeafIds`. `teardownLink()` also clears ns `filesync`.

## 3. Flows (app store `src/stores/fileSync.ts`)

Preconditions for both buttons: linked **and** `devOnline` **and** no batch in
flight **and** Tauri. Offline/Tor keep the buttons disabled with a reason
(file_xfer hard-blocks both anyway).

**Push** — per selected entry: rehash the local file (gone ⇒ `missing`; changed
⇒ record + announce the new hash), size-guard against `max_file_size_mb`
(⇒ `too-large`), skip when every active sibling's `copies` slot already matches
(⇒ `skipped`), else `file_offer_create`. One `dlink_file_push` broadcast carries
the batch — the devlink room is a group, so every online sibling receives it
(that is the >2-device answer). `file://done dir:"send"` ⇒ row `sent` and the
offer is cancelled; unclaimed offers are GC'd after 120 s ⇒ `failed`.

**Receive** (auto-accept — the frame already passed devlink admission, so the
sender is one of the user's own non-revoked devices): unknown/tombstoned entry ⇒
ignore; hash match ⇒ `skipped`; over cap ⇒ `too-large`; an entry inside our own
outgoing batch ⇒ `failed` ("busy", the crossing-transfers guard); else
`filesync_recv_path` → `file_download` → on done `filesync_import` (BLAKE3
verify → land in `synced/`) → update the local record → `recordFileCopy` (which
broadcasts the new state) → reply `received`.

**Pull** — pre-filter from the replicated `copies` (nobody has it ⇒
`unavailable`; a sibling matches our hash ⇒ `skipped`), then one
`dlink_file_pull_req`. Each sibling holding bytes answers with a `reqId`-tagged
push (or `missing`); the requester downloads through the receive path above.
First responder per entry wins; stragglers' offers die by their own GC.

## 4. Rust (`src-tauri/src/file_sync.rs`, maps-style thin)

Gated on `devices::ALLOW_LINKING`; no managed state, nothing to tear down
(transfers belong to `FileXferState`, already shut down on profile switch /
airplane / Tor).

| command | does |
| --- | --- |
| `filesync_hash(path)` | BLAKE3 + size (reuses `maps::blake3_file`, now `pub(crate)`) |
| `filesync_recv_path(offerId)` | `synced/tmp/recv-<sanitized>.part`, 24 h sweep |
| `filesync_import(offerId, name, expectedHash, priorPath?)` | verify hash (mismatch ⇒ tmp removed + Err), then atomic rename into `synced/`; `priorPath` overwrites only when it is inside `synced/`, else a `unique_dest` name |
| `filesync_dir()` | the landing folder, for "open folder" (opener plugin) |

Helpers with unit tests: `sanitize_offer_id`, `sanitize_file_name` (strips
separators/control/leading dot, ≤120, falls back to `"file"`), `unique_dest`
("a.pdf" → "a (2).pdf"), `verify_and_place`.

## 5. Frontend

| File | Role |
| --- | --- |
| `stores/fileSync.ts` | batches, the file_xfer chain, `dlink_file_*` handling, local records, selection |
| `components/devices/DevicesTab.vue` | device-list header + Files/Pairing sub-sub-tabs |
| `components/devices/FileSyncPanel.vue` | the allowed-files list: checkboxes, Select all, Push/Pull, per-row state + outcome, add/remove/open-folder, blocked-with-reason |
| `components/devices/PairingPanel.vue` | pairing QR + join + confirm modal (extracted from the deleted `DevicesPanel.vue`) |
| `views/EnigmaFilesView.vue` | 4th pill `Devices`, gated by `devices_allow_linking` |
| `views/EnigmaConfigView.vue` | Devices tab removed (import, flag, ConfigTab member, query branch, pill, mount) |
| `App.vue` | `fileSyncStore.init()` after chat init (a push must land with the tab closed) + `isBusy()` covers batches/receives for idle-lock |
| `stores/devices.ts` | + `onlineLeafIds` for the per-row dot |
| i18n | `files.devicesTab` + the `fsync.*` namespace (en/pl) |

## 6. Tests

- rakotis `fileSyncModel.test.ts` (15) — validators, merge matrix (union, sticky
  tombstone, per-slot LWW, idempotence), trim, live filter.
- rakotis `useDeviceSync.test.ts` (+6) — list rides hello, merge-no-rebroadcast,
  `dlink_file_*` forwarded but `dlink_files` not, cap refusal, tombstone
  broadcast, own-slot-only `recordFileCopy`, teardown clears the ns.
- rakotis `deviceSyncModel.test.ts` / Rust `device_link.rs` — negative pins:
  `filesync` never in either allow-list.
- app `fileSyncStore.test.ts` (15) — add/dedupe/remove, push skip-by-hash,
  missing, too-large, sent-on-done, receive chain end-to-end, unknown-entry
  ignore, failed import, pull pre-filter, answering a pull, selection + row state.
- component `devices.test.ts` (9) — header list w/ online dots + unlink, sub-tab
  switch, pairing gates, file-list select-all/toggle, disabled without a peer.
- Rust `file_sync.rs` (4) — sanitizers, unique_dest, verify_and_place (hash
  mismatch discards; prior path outside `synced/` refused).
- e2e `devices.spec.ts` (4) — Files → Devices renders, Pairing carries both
  flows, honest error without the runtime, and Settings has no Devices tab.

## 7. Risks & accepted limitations

- `dlink_files` is the chattiest devlink payload (≈240 KB worst case vs the
  16 MiB gossip frame cap); the tombstone trim bounds it. A rev-gated send is
  the follow-up if it ever bites.
- Partial batch failures are per-file by design; the batch never aborts on one
  file, and offers are GC'd.
- Crossing transfers: a push for an entry inside our own outgoing batch is
  refused as busy; atomic tmp→rename + hash verify means the worst case is a
  wasted transfer, never a torn file.
- Unlink / Tor flip / profile switch mid-transfer: the endpoint is torn down ⇒
  `file://error` ⇒ the row fails; post-unlink frames are refused by admission.
- Browser/vitest kv is plaintext localStorage — the accepted degradation every
  feature shares; the Devices tab shows a desktop-only banner there.

## 8. Full changed/new file list

```
packages/rakotis/src/fileSyncModel.ts                +  model, merge, validators
packages/rakotis/src/useDeviceSync.ts                ~  list convergence + transfer seam
packages/rakotis/src/index.ts                        ~  export the model
packages/rakotis/tests/unit/fileSyncModel.test.ts    +
packages/rakotis/tests/unit/useDeviceSync.test.ts    ~  seam tests
packages/rakotis/tests/unit/deviceSyncModel.test.ts  ~  negative pin
apps/enigma/src-tauri/src/file_sync.rs               +  hash / recv-path / import / dir
apps/enigma/src-tauri/src/lib.rs                     ~  mod + 4 commands
apps/enigma/src-tauri/src/maps.rs                    ~  blake3_file → pub(crate)
apps/enigma/src-tauri/src/device_link.rs             ~  negative pin (test only)
apps/enigma/src/stores/fileSync.ts                   +  batches + transfers
apps/enigma/src/stores/devices.ts                    ~  onlineLeafIds
apps/enigma/src/components/devices/DevicesTab.vue    +  header list + sub-sub-tabs
apps/enigma/src/components/devices/FileSyncPanel.vue +  the allowed-files list
apps/enigma/src/components/devices/PairingPanel.vue  +  pairing (extracted)
apps/enigma/src/components/devices/DevicesPanel.vue  -  deleted (split in two)
apps/enigma/src/views/EnigmaFilesView.vue            ~  4th pill
apps/enigma/src/views/EnigmaConfigView.vue           ~  Devices tab removed
apps/enigma/src/App.vue                              ~  init + isBusy
apps/enigma/src/i18n/{en,pl}.ts                      ~  files.devicesTab + fsync.*
apps/enigma/tests/unit/fileSyncStore.test.ts         +
apps/enigma/tests/component/devices.test.ts          ~  rewritten for the split
apps/enigma/tests/e2e/devices.spec.ts                ~  rewritten via Files
sync.md · technology.md · build.md · fsync.md        ~/+ docs
```
