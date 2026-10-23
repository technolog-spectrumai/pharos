# Peer links — scoped person-to-person sync (parked 2026-08-18)

A **link between two different humans**: a pairwise key, a hidden gossip room,
and a per-direction allow-list of what each side shares (calendar, contact card,
shared rooms). Not to be confused with device linking (`../devices/`), which
assumes both ends are the same person and therefore filters nothing.

Parked for two stated reasons: **a persistent link key stored per contact is
exposure we did not want**, and the feature was expensive to maintain for the
value it returned.

## What is here

```
rust/peers/peer_link.rs       the enigma/plink/0 ALPN handshake (712 lines)
frontend/peers/
  components/peers/           PeerLinksPanel, PeerRequestForm, PeerRequestModal,
                              PeerBoardPanel, peerScopes.ts, boardKeys.ts
  stores/peers.ts
  rakotis/usePeerSync.ts      the link channel + per-scope convergence
  rakotis/peerSyncModel.ts    grants, scopes, conflict clock, validation
  i18n/{en,pl}.ts.snippet     the peers.* namespace
  tests/                      peers.test.ts, peerSyncModel.test.ts, usePeerSync.test.ts
  peer.md                     the design doc
```

## The exposure that motivated the park

A `PeerGrant` persisted, per contact: `linkKey` (base64 32 bytes, the pairwise
secret), `roomName` (derived from it), `safetyNumber`, and the granted scopes.
That is a long-lived secret sitting in the contact record — readable by anything
that can read the contact list, and outliving any single sync. Any revival
should ask whether the key needs to persist at all, or can be re-derived per
session from something the user already holds.

## What was worth getting right

* **Domain separation from device linking.** Both families used HMAC over the
  link key for key-package admission; only the label differed
  (`enigma/plink/v1/kp` vs `enigma/devlink/v1/kp`). A proof minted for one must
  never admit the other. There is a live test for this in
  `packages/rakotis/tests/unit/usePeerSync.test.ts` — it survived the park with
  the foreign label inlined, so the property still holds with both features gone.
* **Per-grant allow-list, not a global one.** `PEER_SCOPE_KV` is scoped BY
  GRANT. Reusing the device-sync allow-list would have replicated `p2p:rooms` —
  bearer join tickets — to another person. The two allow-lists must never merge.
* **Revocation is a tombstone, not a delete.** A revoked grant refuses admission
  even though the peer still holds the key; without tombstones a peer re-pushes
  its card forever.
* **Both directions are negotiated separately.** "What I share" and "what they
  share" are independent lists, and the requester cannot see why a scope was
  refused (peer.md §6).

## Restore checklist

1. `git mv` `peer_link.rs` back to `apps/enigma/src-tauri/src/`.
2. `lib.rs`: re-add `mod peer_link;`, the five `peer_*` commands in
   `invoke_handler!`, and `.manage(peer_link::PeerLinkState::default())`.
3. `p2p_iroh.rs`: re-add the `PEER_ALPN` accept branch on the main endpoint
   (it rode the same endpoint so a contact could ask at their saved NodeId).
4. Re-add the `peers.enabled` gate: `PeersSection` + codegen in `build.rs`, the
   `peers:` block in `build_config.yaml` and every `configs/*.yaml`,
   `peers_enabled` in `BuildConfigSummary` and in rakotis `BuildConfig` +
   `FALLBACK_BUILD_CONFIG`. **One commit — `deny_unknown_fields`, no defaults.**
5. Re-add `settings.peer_resync_secs` (build.rs clamp + YAMLs + the
   `clampPeerResyncSecs`/`get`/`set` accessors in `appStorage.ts`).
6. Move the frontend files back; re-export `peerSyncModel` + `usePeerSync` from
   `packages/rakotis/src/index.ts`.
7. `stores/chat.ts`: re-instantiate `usePeerSync` with its injected sources and
   restore `setPeerSources` + the profile-switch restart.
8. `App.vue`: the app-wide `<PeerRequestModal>` (the accept window is short, so
   it must not wait behind a route) and the two incoming nav dots.
9. `EnigmaContactsView.vue`: the per-contact sync button, the linked badge, the
   `<PeerLinksPanel>`, and the request modal.
10. `stores/network.ts`: re-add `canPeerSync`.
11. Paste the i18n snippets into `en.ts` AND `pl.ts` (parity test).
12. Builder tool: `peers.enabled` in `features_tab.py`, `validation.py`,
    `yaml_gen.py`, `window.py`.
13. Move the tests back.
