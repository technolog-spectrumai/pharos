# Multi-device sync (linked devices) — plan & decision log

> **Status: IMPLEMENTED 2026-07-19, hardened after adversarial review 2026-07-20.**
> All gates green: rakotis 140 vitest · enigma 228 vitest · src-tauri cargo 85 ·
> rotor_core cargo 2 · Playwright 11 · both `vue-tsc` typechecks + the vite
> production build clean. Scope Q&A resolved with Janek 2026-07-19 (device
> model, sync scope, transport, history depth). Manual two-instance
> verification via `run2.sh` remains open (§8).

**Post-review hardening (2026-07-20)** — a 5-dimension adversarial workflow
(25 confirmed findings) drove these fixes:

- **CRITICAL — `dlink_` was never routed through the sync seam.** The prefix
  gate in `useChatChannel` handled `sync_/file_/meeting_/vox_/kanban_` but not
  `dlink_`, so every ongoing-sync frame was silently dropped and *only* the
  one-shot Rust pairing worked. Added `dlink_` to the gate + a regression test
  that dispatches a real `dlink_hello` through the actual handler (the original
  tests masked this by calling the handlers directly).
- **Revocation redesigned around MLS + tombstone, not key rotation.** The old
  rekey path split the link when a sibling was offline and never reached the
  other devices (same routing bug). `admissionCheck` now refuses a
  registry-revoked leaf (closing the re-admission hole even though the shared
  linkKey is known), `unlinkDevice` evicts the leaf from the devlink AND open
  main room and broadcasts the tombstoned registry before any teardown, and
  `dlink_rekey` is now a reserved-but-unused wire type.
- **Rust: bare-user leaf ids + validated join fields.** `user_part_of` strips
  an existing `#dev-` suffix so pairing FROM a secondary yields `alice#dev-<new>`
  (not a double suffix); `sanitize_device` clamps the label (≤60), validates
  kind, and re-mints a bogus device id — an over-long label no longer bricks
  `validateDeviceRegistry` on load.
- **Convergence: meetings LWW uses a recorded change-clock, not send-time**
  `Date.now()` (which always beat the receiver and destroyed newer local
  edits); the devlink channel reconnects after a room change (the stale
  `isConnected` guard is now room-name-aware).
- **Persistence hygiene:** `chat:log` reads dedupe by id (backstop for an
  append/merge interleave); the appender drops a room's buffered writes before
  `wipeLog` (deleted history can't resurrect); the "session not ready"
  placeholder bubble is no longer persisted; `blockedByMute` honors user-part
  mutes.
- **UI dead-ends:** join controls disable while showing your own QR;
  `devlink://error` clears the confirm modal and cancels the live session; an
  expired QR tears the session down instead of sitting at "0 s".

**Deviations from the approved plan** (each deliberate, none scope-changing):

- **Registry MAC is TS-only.** Rust writes the registry with `mac: ""` at
  pairing; the frontend (`useDeviceSync.registryMac`) finalizes it on first
  touch. One HMAC implementation instead of byte-matching canonical JSON across
  Rust and `JSON.stringify` — the pairing channel already authenticates the
  initial registry, so nothing is lost.
- **Text-message ids ride the OUTER envelope.** Text stays raw inside the
  ciphertext (old-build receivers render it as-is), so its stable `msg_id`
  travels next to the ciphertext — a random nanoid correlating nothing an
  observer doesn't already see as a discrete frame. Media/control ids stay
  INSIDE the ciphertext (`sendEncryptedMedia(…, msgId)`).
- **`dlink_room_admit_req` is reserved, not implemented.** v1 accepted
  limitation: the new device completes a room's MLS join when it and an
  admitting member are online in that room together (the primary usually is).
- **Pairing proof is keyed BLAKE3, not HMAC-SHA256.** The pairing handshake is
  Rust↔Rust only, and blake3 is already a dependency; HMAC-SHA256 (WebCrypto)
  is used where TS must verify (registry MAC, kp `link_proof`).
- **`devlink_adopt_identity` added.** The runtime identity comes from
  `CHAT_USER`/profile-name at every launch; a paired device must re-adopt its
  stored leaf id post-unlock. The plan missed this restart path.
- **Session reset keeps the stored log.** `forceResetMls` still clears the live
  timeline; the sealed `chat:log` survives and restores on reopen (data
  preservation beats the transient "history cleared" notice).
- **Meetings sync is whole-value LWW** by locally-recorded mtimes; the room
  seam (`meeting_*` rebroadcast) remains the primary convergence path.
- Drive-by fix (pre-existing, exposed by the 23:xx test run): PollFormModal's
  `defaultRow` proposed a 23:00→24:00 slot whose end wrapped past midnight and
  failed validation — start is now capped at 22:00.

## Decision log (Q&A, resolved 2026-07-19)

- **D1 — Device model: linked devices, one user.** Each device is its own MLS
  leaf + iroh NodeId + Tor onion; secondaries use the rigid-suffix identity
  `"<user>#dev-<8 base32>"` (`LEAF_SUFFIX_RE`), the primary keeps its bare id.
  Rosters group leaves by `userPartOf`; moderation keys by user part (one
  mute/ban/kick covers all of a member's devices); captain stays lowest full
  leaf id. Zero rotor_core changes — `remove_member` matches exact bytes, so
  per-leaf removal is safe. Old-build room-mates see the extra leaf as a
  cosmetic participant (wire-compatible).
- **D2 — Pairing: QR + one-shot E2EE transfer.** Primary `devlink_pair_begin`
  binds an ephemeral iroh endpoint (ALPN `enigma/devlink/0`) and mints ticket
  `base32(0x4C ++ postcard{v, addr, secret[32]})`. Joiner dials with deadline =
  kv `connect_timeout_secs`, proves the secret (keyed BLAKE3 over
  nonce|deviceId|nodeId), the secret is one-time + window-bounded, and the
  primary's human confirm (`devlink://request` → `devlink_pair_confirm`) gates
  everything. Then: bundle frame → chunked history frames → done → 1-byte ack.
  Per-device key material (iroh/Tor/MLS) NEVER transfers.
- **D3 — Device registry** in sealed kv `devices/default/""` (+ `"link"` for
  linkKey/roomName/my ids), HMAC(linkKey)-authenticated between own devices,
  rev-monotonic. Room peers never see or verify it.
- **D4 — Message persistence (net-new):** sealed segmented kv `chat:log/<slug>`
  (`index` + `seg-N`, ≤100 msgs/seg), appended debounced from `pushMessage`,
  capped by the `chat_history_cap_msgs` setting, wiped on room delete/kick/
  close. Sender-minted `msg_id` (inner for media, outer for text) is the
  cross-device dedupe key. Side effect (desired): timelines survive restarts.
- **D5 — Ongoing sync = hidden device room.** Both devices are independent room
  members (live traffic just arrives). Catch-up + registry/kv convergence ride
  a hidden gossip room `"devlink-" + hex(blake3::derive_key("enigma/devlink/v1/room", linkKey))`,
  joined via `joinByNode` (never persisted to `p2p:rooms`) by a HEADLESS second
  `useChatChannel` instance with `admissionCheck`/`keyPackageExtra` enforcing
  `link_proof = HMAC(linkKey, "enigma/devlink/v1/kp\0" + kpB64)`. `dlink_*`
  inner messages: hello / registry / kv / history_req / history / rekey.
- **D6 — Sync allow-list** pinned in `deviceSyncModel.DEVLINK_SYNC_KV` and Rust
  `device_link::SYNC_KV` (a pinning test on each side): contacts, `p2p:rooms`
  (shared fields; `onion`/`host` stripped), meetings + polls, settings
  `max_file_size_mb` / `meeting_reminder_mins` / `file_key_rotation_days` /
  `dht_room_publish_secs`. Never synced: `connect_timeout_secs`, all `map:*`
  (locked decision), `cloud:*`, `keys/*`, `mls/*`, dht secrets, kanban, the
  devlink pacing knobs.
- **D7 — Tor/airplane: file_xfer precedent.** Pairing + devlink are iroh-only;
  airplane → `OFFLINE_BLOCKED`, Tor-exclusive → `TOR_BLOCKED` ("Device linking
  is unavailable in Tor mode."). UI disables with the reason, never hides.
  `device_link::shutdown` hooks the same three teardown sites as file_xfer.
- **D8 — Build/config:** `devices.allow_linking` (default **true** — pure P2P;
  the cloud `false` precedent is for external services) + settings triples
  `devlink_pair_window_secs` 600/60–3600, `devlink_resync_secs` 300/30–3600,
  `chat_history_cap_msgs` 500/50–5000. Full plumbing build.rs →
  `BuildConfigSummary` → rakotis `BuildConfig`/getters.
- **D9 — Naming:** module `device_link.rs`, commands `devlink_*`, events
  `devlink://*`, kv ns `devices` + `chat:log`, inner prefix `dlink_`, i18n ns
  `devices`.
- **D10 — UI:** the pairing surface (list/pair/join/confirm). **Superseded
  2026-07-26:** it moved out of Settings into Files → Devices, split into
  `DevicesTab` (the always-visible device list) + `PairingPanel`, alongside the
  per-file push/pull sync — see fsync.md. Settings has no Devices tab any more.

## 1. Scope

**In:** QR pairing with one-time secret + human confirm; one-shot E2EE bundle
(identity, linkKey, registry, personas, contacts, rooms incl. bearer
tickets/codes, meetings, settings subset) + full stored history; message
persistence (`chat:log`); hidden devlink room for ongoing catch-up (registry,
kv merges, history replay deduped by msg id); roster grouping by user part;
user-part moderation; per-leaf revocation with N>2 rekey; boot-time identity
adoption; Devices UI; i18n en+pl; tests at every tier; docs.
**Out:** rotor_core/gervasius/protasius changes; `map:*` sync; kanban sync (its
room seam converges); any server; Tor-mode pairing/sync; transfer resume;
`dlink_room_admit_req` (reserved); cross-user device sharing.

## 2. Data model (implemented)

- rakotis [`deviceSyncModel.ts`](packages/rakotis/src/deviceSyncModel.ts) —
  leaf-id helpers, `DeviceEntry`/`DeviceRegistry`/`DeviceLinkInfo`/
  `PersistedMessage`, allow-list, merges (`mergeMessages`, `mergeRoomLists`,
  `mergeContactLists`, `shouldAcceptRemoteKv`), all `dlink_*` validators, caps.
- rakotis [`services/chatLog.ts`](packages/rakotis/src/services/chatLog.ts) —
  segmented log CRUD + `createLogAppender` (1 s debounce), serialized writes.
- kv: `devices/default/{"", link, revs}`, `chat:log/<slug>/{index, seg-N}` —
  all sealed by protasius like everything else.

## 3. Wire payloads

All versioned `v:1`, validated on receive, silently dropped when unknown.
Pairing stream (length-prefixed JSON, file_xfer framing; 64 KiB control / 16 MiB
data caps): `hello{v,proof,device}` → `accept|reject` → `bundle{LinkBundle}` →
n×`history{room,chunk,of,msgs}` → `done` → ack. Devlink room inner messages:
`dlink_hello{registryRev, rooms[{slug,latestTs,count}], settingsMtime}`,
`dlink_registry` (MAC + higher rev), `dlink_kv` (allow-list re-checked),
`dlink_history_req{room,sinceTs}`, `dlink_history` (≤100 msgs/frame),
`dlink_rekey{linkKey,roomName}`. Envelope addition: optional `link_proof` on
`mls_key_package` (old builds ignore unknown fields); optional `msg_id` on
`mls_app` (text) and inside media/control inner payloads.

## 4. Rust backend — [`device_link.rs`](apps/enigma/src-tauri/src/device_link.rs)

| Command | Purpose |
| --- | --- |
| `devlink_pair_begin` | gates (flag/offline/Tor/vault) → ephemeral endpoint + one-time secret → `{ticket, expiresAt}` |
| `devlink_pair_confirm(accept)` | resolves the `devlink://request` human gate |
| `devlink_pair_cancel` | drops endpoint + secret |
| `devlink_pair_join(ticket,label,kind)` | dial (deadline = kv `connect_timeout_secs`) → prove → receive/apply bundle + history → `devlink://done` |
| `devlink_status` | `{allow_linking, pairing_active, linked, device_count, my_*}` |
| `devlink_derive_room(linkKey)` | blake3 room-name derivation for the TS rekey path |
| `devlink_adopt_identity` | post-unlock: swap runtime identity to the stored leaf id (no teardown/relock) |

Registration is the standard 3-step in `lib.rs` (+ `.manage(DevLinkState)` +
shutdown hooked at profile-switch / airplane-on / Tor-on beside file_xfer).

## 5. rakotis additions

- [`useDeviceSync.ts`](packages/rakotis/src/useDeviceSync.ts) — headless
  channel owner, `dlink_*` protocol, WebCrypto HMAC (`registryMac`, `kpProof`),
  resync tick, unlink/rekey, `enforceRevocations`, `teardownLink`.
- [`useChatChannel.ts`](packages/rakotis/src/useChatChannel.ts) — options
  `{headless, admissionCheck, keyPackageExtra}`; user-part roster grouping
  (`Participant.leafIds`/`deviceCount`); dual-keyed mutes/bans; kick removes
  all of a user's leaves, `removeLeaf` removes exactly one; msg_id mint/prefer;
  chat-log append/restore/wipe; `mergeHistory` live splice.

## 6. App frontend

| File | Change |
| --- | --- |
| `views/EnigmaConfigView.vue` | `devices` ConfigTab (flag-gated button + body) |
| `components/devices/DevicesPanel.vue` | new — list/pair/join/confirm UI (split into DevicesTab + PairingPanel by fsync.md, 2026-07-26) |
| `stores/devices.ts` | new — pairing state machine over `devlink_*` + events |
| `stores/chat.ts` | instantiates `useDeviceSync` (flag-gated), starts it in `init`, adopts identity in `syncRuntimeIdentity` |
| `i18n/en.ts` + `pl.ts` | `nav.devices` + `devices.*` (parity enforced) |
| `main.ts` | `faMobileScreen` icon |

## 7. Tests (all green)

- rotor_core: 3-leaf same-user spike (`same_user_second_device_leaf_coexists_and_removes_cleanly`).
- src-tauri: ticket round-trip, proof binding, room-name derivation, suffix
  codec, allow-list pin, room stripping, history chunk budgets, rooms merge.
- rakotis: deviceSyncModel (24), chatLog (5), multiDeviceChannel (9 — delivery
  as self, echo guard, dedupe, grouping, admission, headless isolation,
  proof hook, persistence round-trip, **dlink_ real-handler routing
  regression**), useDeviceSync (12 — proof round-trip,
  MAC finalize, hello push/pull, history merge, kv merges, registry
  accept/reject, self-revocation, unlink 2-dev/N-dev, revocation enforcement).
- enigma: DevicesPanel component (4; now devices.test.ts over DevicesTab/PairingPanel/FileSyncPanel), i18n parity, all prior suites.
- Playwright: devices.spec.ts (2, browser-honest degraded states).

## 8. Manual verification (open — needs two machines/instances)

`run2.sh` matrix: pair happy path (QR → confirm → bundle + history land) →
both instances in one room grouped as one user → message from one appears on
the other (live + catch-up after reconnect) → wrong-secret reject → window
expiry → confirm-reject → Tor-mode blocked strings → unlink removes the leaf.
Note `run2.sh` pins `CHAT_USER` per instance; for a true pairing test launch
the secondary with a fresh profile and let `devlink_adopt_identity` set the
leaf id after pairing.

## 9. Risks & accepted limitations

- **No deletion sync (deliberate v1 model).** kv convergence is add/union +
  LWW; there are no deletion tombstones for rooms/contacts. Deleting a room (or
  contact) on device A while device B still holds it means B re-shares it — and
  its `chat:log` history — back to A on the next sync. Deleting on *every*
  device, or unlinking, is the only way to be rid of it. A tombstone layer is
  the natural follow-up if this bites. **Partly taken up 2026-07-26:** the
  Files→Devices allowed-files list (ns `filesync`) does carry sticky removal
  tombstones — its UX promises that removing a file removes it on both devices,
  which a union merge cannot deliver. It is scoped to that one list and does not
  change the rooms/contacts model (fsync.md §1).
- **Catch-up uses per-device receive timestamps.** Each device stamps a message
  at *its* receive time, so `dlink_hello`'s `latestTs` comparison can be off by
  the inter-device delivery skew: a straggler may re-send (harmless — deduped
  by `msg_id`) or, rarely, a message whose receiver-side ts sits above the
  reported `latestTs` is skipped until another sync. Both devices are
  independent room members, so live traffic arrives directly regardless; this
  only affects offline-gap catch-up.
- **Revocation propagates when devices are online together.** A revoked device
  is cut from the MLS group + refused re-admission the moment a peer holds the
  tombstoned registry rev; a peer offline at revocation time enforces it on its
  next sync. Cross-room enforcement (`enforceRevocations`) happens as the acting
  device opens each shared room.
- Both-offline gap (no store-and-forward); no transfer resume; Tor-mode
  pairing/sync blocked; new-device room admission needs an admitting member
  online in that room (mitigation `dlink_room_admit_req` reserved); old-build
  room-mates see the second device as an extra participant; pre-msg_id senders
  don't dedupe; stolen-but-unlocked device keeps already-synced data (MLS
  removal cuts forward access); media-heavy history bounded by
  `chat_history_cap_msgs`; a QR photograph is only stopped by the primary-side
  confirm (by design — confirm copy warns).

### Rust robustness follow-ups (accepted for v1)

The joiner's history-receive loop has no aggregate memory bound or overall
deadline (per-frame caps + the `connect_timeout_secs` dial deadline bound the
common cases; a malicious paired peer is out of scope since pairing is
human-confirmed); the join task is untracked so airplane/Tor/profile-switch
teardown can't abort an in-flight transfer mid-stream (it fails on the next
frame write); the host reports `devlink://paired` and keeps the registry entry
even if the joiner died before its ack; and a re-pair mints a new `device_id`,
leaving the old entry (its leaf still authorized until manually unlinked).

## 10. Full changed/new file list

New: `apps/enigma/src-tauri/src/device_link.rs`,
`packages/rakotis/src/deviceSyncModel.ts`,
`packages/rakotis/src/services/chatLog.ts`,
`packages/rakotis/src/useDeviceSync.ts`,
`apps/enigma/src/components/devices/DevicesPanel.vue`,
`apps/enigma/src/stores/devices.ts`,
`apps/enigma/tests/component/devices.test.ts`,
`apps/enigma/tests/e2e/devices.spec.ts`,
`packages/rakotis/tests/unit/{deviceSyncModel,chatLog,multiDeviceChannel,useDeviceSync}.test.ts`,
`sync.md`.
Modified: `apps/enigma/src-tauri/{build_config.yaml, build.rs, src/lib.rs}`,
`cryptorotor/rotor_core/src/lib.rs` (test only),
`packages/rakotis/src/{useChatChannel.ts, index.ts, services/appStorage.ts, services/types.ts}`,
`packages/rakotis/tests/unit/torJoinMls.test.ts` (mock completion),
`apps/enigma/src/{views/EnigmaConfigView.vue, stores/chat.ts, main.ts, i18n/en.ts, i18n/pl.ts}`,
`apps/enigma/src/components/calendar/PollFormModal.vue` (drive-by fix),
`technology.md` (§14/§15/§16), `build.md`.

