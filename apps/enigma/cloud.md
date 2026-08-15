# Cloud — one tab, one switch, an audited wire (cloud.md)

Status: **REMOVED 2026-08-15** (branch `cleanup_1408`, three commits:
`49e235e` backend, `2965dfa` Builder gate, `6e5664f` frontend). Implemented
2026-07-27, extended with named connections + capability detection 2026-07-29,
deleted whole. The full D1–D13 decision log, the communication audit and the
manual verification scripts are preserved in git at `6e5664f:cloud.md` — read
that before reviving anything.

## What it was

The Cloud tab was the single home for everything that could talk to the user's
**own** toto server (faros or zenobia, one at a time): file storage, an
HPKE-sealed room-invite mailbox, a username→NodeId directory, location beacons,
the saved connections and their logins, a transport badge, and a runtime master
switch in Settings → Connections. The guiding rule was *every Enigma → cloud
connection is explicit and conscious*: off by default, off meant zero bytes, and
turning it on walked the user through what the server would see. Address
publishing had already been withdrawn on 2026-07-27, leaving the feature with no
non-user-initiated traffic at all — every byte followed a press.

## What was deleted

**Rust** (`49e235e`, −3,301): `cloud.rs` (master gate, `connect()`, transport
routing, file commands), `aster.rs` (directory + invite mailbox + fan-out),
`beacon.rs` (8 location commands), `invite_seal.rs` (HPKE seal/open), `tor.rs`
(the cloud-side arti HTTP client — **not** `p2p_tor.rs`, which is untouched),
the command registrations in `lib.rs`, the arti/HTTP dependencies in
`Cargo.toml`.

**Build gates**: the `cloud.allow_connections` block in `build.rs` and in
`build_config.yaml` plus every edition YAML (`49e235e`); the Cloud checkbox in
`tools/enigma_builder` (`2965dfa`).

**Frontend** (`6e5664f`, −3,913): the whole `components/cloud/` tree (14 files),
`EnigmaCloudView.vue`, the route and nav entry, `stores/cloud.ts`,
`stores/beacon.ts`, `map/{BeaconCard,BeaconPublishModal}.vue` and the beacon
layer in `MapPanel.vue`, `BEACON_COLOR` in `pinColors.ts`, `packages/rakotis`
`beaconModel.ts` and every cloud helper in `appStorage.ts` (connection registry,
normalizer, kv accessors), the Contacts "find people on my server" search, the
Local panel's upload-to-cloud path, ~390 i18n strings.

**Tests**: `cloudStore`, `cloudClassify`, `cloudConnections`, `cloudServers`,
`recipientPicker`, `beaconStore`, `beaconModel`, `cloudEnableCard`, `cloudView`,
`cloudInvites`, `beaconCard`, the aster/invite_seal inline Rust tests, and the
cloud/beacon arms of the map and smoke e2e specs. **Docs**: this file,
[rdv.md](rdv.md) and [beacon.md](beacon.md), all three reduced to removal
records.

## What replaced it

Room invites are now purely **out-of-band**: the room QR code, the copyable
ticket, or a DHT room code. Offline invite delivery — leaving a sealed invite
for someone who is not around — has **no replacement**; both parties must be
reachable, or the ticket must travel by another channel. Contacts' server-side
people search is gone; DHT nickname discovery remains, and is unavailable in
Tor-exclusive mode as before. Nothing replaces cloud file storage or beacons.

Untouched: iroh QUIC + gossip, MLS, the peer-hosted onion transport
(`p2p_tor.rs`, which never used the deleted `tor.rs`), file transfer, device
linking, maps, calls. Third-party infrastructure deliberately kept: iroh
n0-hosted relays, the Mainline DHT, Tor directory authorities.

## If it ever comes back

Four things were expensive to get right; do not rediscover them from scratch.

- **URL normalization was FROZEN, and the reason survives the deletion.** The
  normalizer was deliberately naive (it did not strip default ports, so
  `https://h` and `https://h:443` were two scopes for one socket). Fixing it was
  refused because the normalized URL was the *storage key* for
  `cloud:auth/<url>/`: any change makes every stored token unreadable — a silent
  logout, unrecoverable because nothing can enumerate kv scopes — and any drift
  between the Rust `normalize_scope` and the TS `normalizeCloudServerUrl` is
  invisible in review while producing a permanent `unauthorized: not logged in`
  with the token sitting right there. It was handled at the *input* instead:
  duplicate normalized URLs refused, and a display-only same-server warning.
  Any successor must decide the key format once, before the first token is
  written.
- **kv KEYS are plaintext at rest.** `protasius::enc_kv` seals only the value;
  `ns\0scope\0key` goes to disk verbatim. That is why the multi-connection
  registry was **one JSON blob under one fixed key** rather than a scope per
  connection — per-connection scopes would have written every server address and
  every user-chosen connection name to disk in the clear. The general rule it
  produced still holds for the rest of the app: **no user-controlled string may
  ever become a kv `ns` or `scope`.**
- **The master switch was fail-closed and enforced twice.** Runtime kv
  `cloud:settings/default/enabled`, with absent-or-locked-vault meaning off,
  checked per command (`ensure_cloud_ready`: build flag → knob → airplane mode)
  **and** again at the top of `connect()` — the single choke point every byte
  funnelled through, including streamed uploads and every download-redirect hop.
  One layer would not have been enough: the per-command check alone is bypassable
  by any new command that forgets it, and the `connect()` check alone cannot
  produce the early, specific error the UI needs. Note the frontend could already
  write that kv directly (`vault.rs::kv_get`/`kv_put` have no namespace
  allowlist) — the `connect()` guard was what made that harmless.
- **Capability detection: key-absent means UNKNOWN, not false.** A vault-only
  toto host installs neither the directory nor the beacon app, so those surfaces
  had to be hidden rather than left to 404. The descriptor came from
  `GET /api/apps/`, and the discipline that made it deployable was that a
  patched server answers `"aster": false` *as a boolean* while an unpatched one
  omits the key entirely — the two are distinguishable, so the server change was
  an **enhancement, never a dependency**, and only an explicit `false` hid
  anything. The fallback discriminator: Django answers an unmounted prefix with
  HTML while every real API 404 carries `{"error": …}`. Capabilities were never
  persisted — a cached `false` hides a feature on a since-upgraded server with
  no discoverable way back.

One smaller trap worth carrying forward: server-side object ids are sequential
integers, so directory 7 exists on *every* server. Acting on a listing row left
over from a previous connection deleted a real, unrelated folder. Any
multi-connection client needs the ownership stamps (`dataConnectionId`,
`transferOwner`, `switchSeq`) from day one, not after the first data loss.
