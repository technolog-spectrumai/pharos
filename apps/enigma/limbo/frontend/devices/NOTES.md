# Device linking + multi-device sync (parked 2026-08-18)

Everything that made a second device *yours*: QR pairing, the device registry,
chat-log/kv convergence between your own devices, and the Files→Devices
per-file push/pull. Parked whole because pairing was the only way to create a
device link — with it gone the rest was unreachable code. **Zinnia is
reimplementing this**; the notes below are what that effort should not have to
rediscover.

## What is here

```
rust/devices/device_link.rs   pairing handshake + one-shot bundle/history transfer (1798 lines)
rust/devices/file_sync.rs     the disk half of Files→Devices receiving (632 lines)
frontend/devices/
  components/devices/         PairingPanel, DevicesTab, FileTree, treeBuilder
  stores/{devices,fileSync}.ts
  rakotis/useDeviceSync.ts    the hidden devlink room (headless 2nd chat channel)
  rakotis/deviceSyncModel.ts  ORIGINAL, pre-split — see "The model split" below
  rakotis/fileSyncModel.ts
  i18n/{en,pl}.ts.snippet     devices.* + fsync.* + nav.devices
  tests/                      7 test files
  sync.md, fsync.md           the design docs
```

## The model split — read this first

`deviceSyncModel.ts` was NOT purely device-sync. Chat and peer sync imported
from it, so it was split rather than parked:

* **Stayed** as `packages/rakotis/src/chatHistoryModel.ts` — `PersistedMessage`
  + `validatePersistedMessage`, `mergeMessages`, `CHAT_LOG_SEG_MAX_MSGS`, the
  message caps, and the leaf-identity helpers `LEAF_SUFFIX_RE` / `userPartOf` /
  `sameUser`. Consumers: `services/chatLog.ts`, `useChatChannel.ts`.
* **Parked** here (the full original file): the device registry types and
  validators, `DEVLINK_SYNC_KV` + `isSyncableKv`, the room/contact merge
  helpers, `shouldAcceptRemoteKv`, and the devlink wire payloads.

Restoring means re-adding the parked half — probably as its own module that
imports from `chatHistoryModel`, rather than merging back into one file.

**Leaf identities still parse in the live app.** `#dev-xxxxxxxx` ids are no
longer minted, but a vault written before the park can still contain them, so
`userPartOf`/`sameUser` stayed behind. For a bare id they are the identity
function. Do not "clean up" that grammar — it is what stops an old linked
profile showing its own messages as a stranger's.

## What was expensive to get right

* **The QR ticket must be minted AFTER `endpoint.online()`.** `bind()` returns
  before the home-relay handshake finishes, so `endpoint.addr()` read straight
  after carries local IPs and no relay URL — a ticket that works on one LAN and
  nowhere else, failing later as a generic timeout that blames the connection.
  This was a real, long-lived bug (fixed in `04e1e3a`, then parked).
* **Every wait needs a deadline, and a *typed* failure.** The original hung
  forever waiting for the host's verdict, because the host only answers after a
  human taps Accept and iroh's keepalive means no idle timeout ever fires. Worse,
  the timeout path reported "the other device declined" — telling the user
  someone refused when in truth no prompt was ever shown. Keep `timed_out` and
  `declined` distinct all the way to the UI.
* **The approval window is not the ticket window.** Reusing the ticket's
  remaining time as the human's decision time produced a prompt that rejected
  itself seconds after appearing. They are two different clocks.
* **Connect deadlines must read `p2p:settings/connect_timeout_secs`**, never a
  literal — a house rule, because the user tunes it per device.
* **The reverse (mutual) link rides the already-open stream.** At completion
  both ends are on the same bi-stream — the host reading the closing ack, the
  joiner writing it. Replacing that bare ack byte with `Ack { reverse: bool }`
  buys mutual linking with no second QR and no new connection. The bare byte
  also had its `Result` discarded, so a joiner dying mid-apply still reported
  success.
* **Direction is worth modelling explicitly** (`outbound`/`inbound`/`mutual`),
  merged idempotently so a retry never downgrades or duplicates a registry entry.

## Restore checklist

1. `git mv` the two `.rs` files back to `apps/enigma/src-tauri/src/`.
2. `lib.rs`: re-add `mod device_link;` / `mod file_sync;`, the `devlink_*` +
   `filesync_*` entries in `invoke_handler!`, and
   `.manage(DevLinkState::default())` + `.manage(DevLinkJoin::default())`.
3. `vault.rs`: re-add the `device_link::shutdown` call in `lock_inner`.
4. Re-add the `devices.allow_linking` gate: the `DevicesSection` struct and
   codegen block in `build.rs`, the `devices:` block in `build_config.yaml` and
   every `configs/*.yaml`, `devices_allow_linking` in `BuildConfigSummary`
   (lib.rs) and in rakotis `BuildConfig` + `FALLBACK_BUILD_CONFIG`.
   **`build.rs` uses `deny_unknown_fields` with no serde defaults — the struct
   and all the YAMLs must change in ONE commit or every build breaks.**
5. Re-add `settings.devlink_pair_window_secs` and `settings.devlink_resync_secs`
   (build.rs clamps + YAMLs + `appStorage.ts` accessors).
6. Move the frontend files back; re-export from `packages/rakotis/src/index.ts`.
7. `stores/chat.ts`: re-instantiate `useDeviceSync` and the
   `devlink_adopt_identity` call in `syncRuntimeIdentity`.
8. `App.vue`: the fileSync store init + its two `isBusy()` branches.
9. Files tab: re-add the Devices pill; paste the i18n snippets into `en.ts`
   AND `pl.ts` (a parity test enforces identical key paths).
10. `stores/network.ts`: re-add `canDeviceSync`.
11. Builder tool: `devices.allow_linking` in `features_tab.py` GATE_HINTS,
    `validation.py` FEATURE_GATES, `yaml_gen.py` SCALAR_PATHS + TEMPLATE,
    `window.py` owners map. Note the Builder now REFUSES a config matching no
    edition, so the preset YAMLs must stay mutually consistent.
12. Move the tests back and re-point `usePeerSync.test.ts` at the real
    `kpProof` (it currently inlines the devlink HMAC label — see below).

## Sharp edge for whoever restores

`packages/rakotis/tests/unit/usePeerSync.test.ts` has a domain-separation test
proving a devlink proof cannot open a peer link. It used to import `kpProof`
from `useDeviceSync`; it now mints the same proof with an inlined
`enigma/devlink/v1/kp` label so the property keeps holding with the feature
absent. On restore, point it back at the real function.
