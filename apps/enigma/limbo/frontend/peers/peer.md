# Peer sync (person-to-person links) — plan & decision log

> **Status: IMPLEMENTED 2026-07-22.** Scope Q&A resolved with Janek the same day
> (sync shape, data classes, direction, edition, conflicts, revocation,
> verification, board model). All gates green: rakotis 193 vitest · enigma 385
> vitest · src-tauri cargo 108 · both `vue-tsc` typechecks + the vite production
> build · all three editions compile with Light/Plus generating
> `peers::ENABLED = false`. Manual two-instance verification via `run2.sh`
> remains open (§6).

A **peer link** is a durable, revocable, explicitly-scoped sync relationship
between **two different people**. It is the [sync.md](sync.md) linked-device
architecture rebuilt for a peer you do *not* trust with everything: a per-peer
allow-list instead of a global one, per-direction grants, a conflict rule that
needs no clock trust, and nothing disclosed before the other person accepts.

**Related:** [sync.md](sync.md) (linked devices — the architecture this mirrors)
· [pland.md](pland.md) (editions; this is **Pro only**) ·
[technology.md](technology.md) §15 (config sources of truth).

## Decision log (Q&A, resolved 2026-07-22)

- **P1 — Shape: a scoped peer link**, not a per-object share and not a profile
  mirror. One durable grant per peer, carried by a private 2-person MLS channel
  in a hidden gossip room, converging whenever both are online — *including when
  they share no room at all*.
- **P2 — Data classes (v1): calendar, chat-history backfill, board, contact
  card.** Each is an independently grantable **scope**.
- **P3 — Per-direction scopes.** Alice's grant to Bob and Bob's grant to Alice
  are separate records with separate scope sets, separately revocable. The
  request names what the requester *wants* and what it *offers*; the accepter
  chooses what it actually grants (and may grant less).
- **P4 — Pro only.** New build gate `peers.enabled`; Light and Plus do not
  register the ALPN and never instantiate the composable (pland.md §5).
- **P5 — Conflicts: monotonic counter + NodeId tiebreak.** Every synced item
  carries `{c, by}` — a per-item counter that advances *only on a real local
  edit*, and the NodeId that made it. Higher `c` wins; equal `c` breaks by the
  lexicographically lower `by`. **No wall clock anywhere on the wire.** This
  replaces LWW-by-mtime, which is unsafe with exactly two peers: the receiver
  cannot verify a timestamp, so a fast (or lying) clock would win permanently.
- **P6 — Revocation stops future sync and says so.** Revoking tombstones the
  grant, removes the peer's leaf from the link room, and refuses re-admission.
  Data already on their disk stays there and the confirm dialog says exactly
  that — it is the only claim that is true.
- **P7 — Safety number, shown but not enforced.** Both sides see the same short
  fingerprint derived from the two NodeIds during the request/accept dialog.
  Displayed, never mandatory. It is the app's first identity-verification
  primitive (there is none today — a NodeId is the only identity anywhere).
- **P8 — The board scope is a NEW per-link board**, owned by the link, not any
  room. Room boards and their captain-election authority are untouched; a peer
  board has a fixed owner/guest pair instead.
  - *Editor shipped 2026-07-22* (`components/peers/PeerBoardPanel.vue`, opened
    from a per-link action in `PeerLinksPanel`). Three judgement calls, recorded
    because the model does not force them: **(a)** the default columns are seeded
    **in memory only** — persisting them would broadcast a `columnsClock` of
    `c:1` that could out-tiebreak the peer's real columns purely on NodeId
    order; **(b)** every write re-reads storage and folds it in with
    `mergePeerBoards(local=mine, remote=stored)` before `putBoard`, so a frame
    that landed since the last poll is not overwritten by the full-document
    write; **(c)** cards whose column a peer deleted are rendered in a
    "without a column" tray rather than hidden — column deletes are one clocked
    document while cards are per-item, so a live card can outlive its column.

## 1. Safety rules (non-negotiable — each is a real hazard found in review)

1. **Never reuse `DEVLINK_SYNC_KV`.** It carries `p2p:rooms` — which holds
   **bearer join tickets and room codes for every room you are in** — and your
   whole contact list. A peer link has its own allow-list, `PEER_SCOPE_KV`, and
   the two must never be confused.
2. **Never reuse the `#dev-` leaf identity.** `sameUser()` would collapse both
   people into one roster row and make one mute/kick apply to both. A peer keeps
   its own bare identity in the link room; no identity is ever adopted.
3. **Nothing before accept.** The request frame carries a *description only*
   (who, what scopes, the safety number). The link key is minted and sent only
   after the human accepts. (`p2p_invite` sends the room ticket *before* the
   answer — do not repeat that.)
4. **No third-party data leaves.** Calendar sync shares only meetings **you
   organize**. History backfill covers only rooms both parties are in, and the
   check runs on **both** sides: the sender re-authorises at send time (not just
   at request time — the peer may have left since asking) and the receiver
   refuses a log for any room it does not itself consider shared, so a peer
   cannot fabricate history or create a log for a room you never joined.
   *Implementation note:* membership is the saved room's peer-NodeId list, which
   is the app's own record of who it paired that room with — see §5 for why this
   is weaker than an MLS roster check and what would strengthen it. Even so,
   backfill re-discloses other people's messages, which is why it is its own
   opt-in scope carrying an explicit warning.
5. **Register the prefix.** `plink_` MUST be added to the sync-family gate in
   `useChatChannel` — the exact omission that made every devlink frame silently
   drop (sync.md, 2026-07-20 CRITICAL). A regression test dispatches through the
   real handler, not the handler function.
6. **Enforce scopes on both sides.** Send only what *I* granted; accept only
   what *they* granted. A frame outside the grant is dropped, not merged.

## 2. Data model

**kv namespaces (all sealed per-profile like everything else):**

| Key | Holds |
|---|---|
| `peers/<nodeId>/""` | the `PeerGrant` — scopes both ways, link key, room name, safety number, tombstone |
| `peers/<nodeId>/"clock"` | per-item counters for outbound items (never leaves the device) |
| `peer:cal/<nodeId>/""` | the peer's shared meetings (mirror — never merged into `meetings`) |
| `peer:board/<nodeId>/""` | the per-link board (shared doc, both edit) |
| `peer:card/<nodeId>/""` | the peer's contact card |

History backfill is the one exception: it merges into the real
`chat:log/<slug>` (that is the point) via the existing `mergeIntoLog`.

**`rakotis/peerSyncModel.ts`** (new, pure — the `deviceSyncModel.ts` pattern):
`PeerScope`, `PeerGrant`, `LClock` + `lclockWins`, `PeerMeeting`/`PeerCard`/
`PeerBoard` shapes, `PEER_SCOPE_KV`, every `plink_*` wire type and validator.

## 3. Wire protocol

**Handshake** — new ALPN `enigma/plink/0` on the **main** endpoint (so a contact
is reachable at the stable NodeId they already have), length-prefixed JSON,
`p2p_invite` framing:

```
R→A  PlinkRequest { v, fromName, want: Scope[], give: Scope[] }   ← description only
     A: emits plink://request, human decides (window = connect_timeout_secs)
A→R  PlinkVerdict { v, status: accept|reject, name, give: Scope[] } ← A may grant less
R→A  PlinkSeal    { v, linkKey: b64-32, room }                     ← only after accept
A→R  1-byte ack
```

**Ongoing** — `plink_*` inner messages on the hidden room
`"plink-" + hex(blake3::derive_key("enigma/plink/v1/room", linkKey))`, admission
double-gated (unguessable topic **and** `link_proof = HMAC(linkKey, kp)`):
`plink_hello` (grant rev + per-scope digests) · `plink_cal` · `plink_board` ·
`plink_card` · `plink_hist_req` / `plink_hist` · `plink_revoke`.

Safety number: `blake3::derive_key("enigma/plink/v1/sas", sorted(nodeA, nodeB))`
→ 16 digits, grouped 4×4. Symmetric, so both sides render the same string.

## 4. Components (as built)

| File | Role |
|---|---|
| `src-tauri/src/peer_link.rs` | new — ALPN, handshake, `peer_*` commands, SAS + room derivation, `PEERS_DISABLED` gate |
| `src-tauri/src/p2p_iroh.rs` | registers `enigma/plink/0` on the main router, gated |
| `src-tauri/{build.rs, build_config.yaml, configs/*.yaml}` | new `peers.enabled` + `settings.peer_resync_secs` |
| `src-tauri/src/lib.rs` | `PeerLinkState`, 5 command registrations, `BuildConfigSummary` fields |
| `rakotis/peerSyncModel.ts` | new — scopes, grant, `LClock`/`lclockWins`, mirrors, merges, all `plink_*` validators |
| `rakotis/usePeerSync.ts` | new — one headless channel per link, both-way scope enforcement, history authorisation |
| `rakotis/useChatChannel.ts` | `plink_` added to the sync-family gate |
| `rakotis/services/appStorage.ts` | `peers_enabled`, `peer_resync_secs` + getter/setter |
| `apps/enigma/src/stores/peers.ts` | new — request/accept machine, data sources, per-item conflict clocks |
| `apps/enigma/src/stores/chat.ts` | instantiates `usePeerSync` (flag-gated) + `setPeerSources` |
| `components/peers/{PeerRequestModal,PeerLinksPanel,PeerRequestForm,PeerBoardPanel}.vue`, `peerScopes.ts` | new — the whole surface |
| `views/EnigmaContactsView.vue`, `App.vue`, `main.ts` | Sync action + links section, app-wide request modal + nav dot, icons |
| `i18n/en.ts` + `pl.ts` | `peers.*` (86 keys, parity enforced) |

## 5. Deviations from the plan

- **Membership is the room's peer-NodeId list, not an MLS roster query.** A peer
  is identified by NodeId; `cryptoService.members` returns MLS leaf identities,
  and nothing maps one to the other today. The saved room's `peers` array is the
  app's own record of who it paired that room with, and the check runs on both
  sides — but a stale entry would authorise a backfill an MLS check would refuse.
- **Revocation does not evict the peer's MLS leaf.** Same root cause: the link
  room keys members by leaf identity. Enforcement is the grant tombstone plus
  teardown — `admissionCheck` re-reads the grant on every key package, so a
  revoked peer is refused re-admission even holding the link key. Unlike an
  eviction, this also works while they are offline.
- **`peer:*` mirrors do not follow you to your own other devices.**
  `DEVLINK_SYNC_KV` is an explicit allow-list and the peer namespaces are not on
  it, so a peer link is per-device. Deliberate for v1: replicating another
  person's data across your fleet is a separate consent question.
- **The accepter side has no result state.** `respond()` closes the modal and
  swallows any error; the requester has a full state machine. Cosmetic, but the
  asymmetry is real.
- **Board editor judgement calls** — recorded inline under P8 above.

## 6. Verification

```bash
npm test                                        # rakotis 193 · enigma 385
( cd apps/enigma/src-tauri && cargo test )      # 108, incl. 7 peer_link
npm run build -w rakotis && npm run build -w enigma
for e in light plus pro; do ENIGMA_EDITION=$e ( cd apps/enigma/src-tauri && cargo check ); done
```

The `plink_` routing regression is the one to keep: it dispatches a real frame
through `useChatChannel`'s actual handler and fails if the prefix leaves the
gate — verified by reverting the gate and watching both assertions fail.

**Open — manual two-instance run (`run2.sh`):** request → accept with narrowed
scopes → both sides converge the granted scopes only → a scope the peer did not
grant never arrives → revoke on one side cuts the other → a revoked peer is
refused re-admission → offline/Tor disable the request with the reason shown.

## 7. Accepted limitations (v1)

- **Both must be online.** No store-and-forward exists anywhere in the app; a
  link converges on the next overlap. With N=2 there is no third party to heal
  from.
- **iroh only.** Tor-exclusive and airplane modes block the handshake and the
  link channel (the `file_xfer`/`device_link` precedent — a direct QUIC dial
  leaks the IP). UI disables with the reason, never hides.
- **Revocation reaches an offline peer late** — on their next connection, where
  admission is refused and the tombstone lands.
- **Data already delivered cannot be recalled.** P6 by design; the confirm
  dialog says so rather than implying otherwise.
- **The safety number is advisory.** Nothing forces a comparison, and there is
  still no key-change detection anywhere in the app.
- **No cross-edition capability signalling.** A request to a Light or Plus peer
  fails at ALPN negotiation and the requester cannot say why (pland.md §6.2).
- **8 links max** (`PEER_LINK_MAX`) — each owns a headless MLS channel and a
  gossip subscription, so this is a resource rail, not a UI limit.
