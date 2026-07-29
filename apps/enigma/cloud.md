# Cloud — one tab, one switch, an audited wire (cloud.md)

Status: **IMPLEMENTED 2026-07-27**, extended with **named connections +
capability detection 2026-07-29** (D12/D13). Server contract: the faros repo's
`for_enigma.md`.

The Cloud tab is the **single home for everything that can talk to the user's
own toto server** — faros or zenobia, one at a time: file storage (moved from
Files → Cloud), sealed room invites (moved from Contacts), the saved
connections and login (moved from Settings), a
live transport badge, and — above all — the **runtime master switch**. The
guiding rule: *every Enigma → cloud connection is explicit and conscious*.
Off by default, off means **zero bytes**, and turning it on walks the user
through exactly what the server will see first.

## Decision log

- **D1 — One home for the workspace, Settings for the switch.** The top-level
  Cloud tab hosts three sub-tabs (Notes pill pattern, `EnigmaNotesView.vue`):
  **Files**, **Invites**, and **Connection** (server URL, login, transport
  badge, route-through-Tor). The master switch itself sits in **Settings →
  Connections**, beside the other network toggles — one switch, one place. With
  it off, Connection is the *only* pill (Files and Invites would be dead ends)
  and shows the explanation plus a link to Settings; a stale Files selection
  falls back to it automatically. The
  Files tab lost its Cloud sub-tab, Settings lost the server-URL card, and
  Contacts keeps only a pointer (`contacts.torRoomsViaCloud` →
  `/cloud?tab=invites`). Contacts' *find-people* server search stays put — it
  is discovery, not invites — now also gated on the master switch.
- **D2 — Master switch enforced in Rust.** Runtime kv
  `cloud:settings/default/enabled` (values `"on"`/`"off"`, absent/locked-vault
  ⇒ off, **fail closed**). Checked per command (`cloud::ensure_cloud_ready` =
  build flag → knob → airplane mode) AND at the top of `cloud::connect()` —
  the single choke point every cloud/beacon/aster byte funnels through
  (`request_json`, streamed uploads, every download-redirect hop). Flipping it
  off calls `cloud::shutdown()` and aborts in-flight transfers (the
  airplane/Tor-toggle precedent, `lib.rs`). The compile-time
  `cloud.allow_connections` edition gate stays on top; all four YAMLs
  untouched.
- **D3 — Explicit Tor.** Runtime kv `cloud:settings/default/force_tor` extends
  the `connect()` routing: clearnet hosts ride the embedded arti client exactly
  like Tor-exclusive profiles (`route_via_tor`, pure + unit-tested). `.onion`
  always rides arti; loopback never does; TLS policy is UNCHANGED — clearnet
  keeps full WebPKI even via a Tor exit. Switching it **on** aborts ALL
  in-flight transfers — the registry carries no route metadata, so a direct
  transfer (which must not keep exposing the IP) takes the onion/loopback ones
  with it as restartable collateral; switching it off lets running transfers
  finish.
- **D4 — Conscious enable.** `CloudEnableCard` (Settings → Connections) states
  what the switch turns on and the metadata price before it is touched.
  Turning it ON opens a danger-style confirm modal (Kanban delete-confirm
  pattern) listing the metadata the server sees and the per-transport risks;
  the kv flag is written only after the confirm press
  (`tests/component/cloudEnableCard.test.ts` proves no early write). Turning it
  OFF is instant — no ceremony to *stop* talking. A failed flip (locked vault)
  shows inline instead of escalating to the global fatal overlay.
- **D5 — No in-app registration.** `cloud_register` deleted (Rust + store +
  modal). Accounts are created in a browser on the server's `/sso/` page; the
  login modal and setup card say so (`cloud.registerExternalHint`). Plain
  password login stays: `POST /telegraph/api/login/`, token (a Django session
  key) into the encrypted kv `cloud:auth/<normalized-url>/`.
- **D6 — Address publishing DELETED (2026-07-27).** The relay publisher, the
  stacked `AsterLookup` and the `rdv_publish` toggle are gone from Rust and the
  UI (rdv.md D3/D4/D5). The server is a name-and-mailbox directory now: it maps
  a username to NodeIds and holds sealed invites, and never learns where a
  device can be reached. **This removed the app's only non-user-initiated
  server traffic** — every byte below now follows a press.
- **D7 — Dev editions.** `run_dev.sh` and `run2.sh` default
  `ENIGMA_EDITION="${ENIGMA_EDITION:-pro}"` so dev builds are cloud-capable;
  shipped/CI defaults unchanged ([build.md](build.md)).
- **D8 — Tor mode hides what it disables.** In Tor-exclusive mode the DHT card
  is **hidden**, not disabled-with-a-reason: it publishes an iroh relay address
  and Tor mode shuts iroh down, so there is no decision left to present.
  (Reachability for sealed invites is unaffected — that registers a NodeId, no
  address.) This deliberately departs from the house "disable with the reason"
  style, which fits controls that are *temporarily* inert, not ones with
  nothing behind them. The rdv card that used to share this gate is now deleted
  outright (D6).
- **D9 — Tor mode drops location sharing entirely.** Both kinds: the map's
  share-a-spot button (in-room, over the encrypted seam) and the whole Beacon
  surface (published to the server, visible to everyone logged into it). Hiding
  your network location while broadcasting a geographic one is incoherent, so
  in Tor mode nothing is published AND `/beacon/all` is never fetched.
  **Sending** is what is blocked — locations a peer already shared still
  render, because receiving leaks nothing and dropping them would silently lose
  data a peer sent.
- **D10 — Invites are addressed by faros username (2026-07-27).** The Invites
  sub-tab picks people by typing their cloud username, validated one at a time
  against `/aster/resolve`; **Create & invite** mints the room (Tor channel in
  Tor mode, direct iroh room otherwise) and leaves one HPKE-sealed copy of the
  ticket per recipient DEVICE. Picking at least one person is mandatory in both
  the UI and `rdv_invite_broadcast` — there is no "open to all". Two things the
  UI states rather than hides: the picked list decides who *receives* a copy,
  not who may join (MLS auto-admits any ticket holder), and a username→NodeId
  mapping comes from the server, so a dishonest one could read a single invite
  (rdv.md's flagged weakness; inviting a verified saved contact is not exposed
  to it). faros has no user-listing endpoint an ordinary account can call, so a
  browsable picker is impossible without server work — hence typed usernames.
- **D11 — Invites say why they are unavailable, before the press (2026-07-27).**
  Four independent reasons the Invites panel can be unusable, and the UI now
  states each one up front instead of failing after a click:
  - **Machine-classifiable transport failures.** `cloud::connect()` tags every
    transport error — Tor bootstrap/connect, TCP connect, TLS handshake, and the
    deadline — with an `unreachable:` prefix, joining the existing `cloud_off:`
    and `unauthorized:` conventions. It is applied at the single exit, so any
    transport added inside `connect()` later inherits it; the `CLOUD_OFF` early
    return sits above that exit and keeps its own prefix (a doubled
    `unreachable: cloud_off: …` would silently break `knobRefused`). Note the
    inner/outer shape: `?` unwraps only the timeout, so the tag goes on a `match`
    covering both arms.
  - **A store-side funnel.** `cloud.call()` wraps a networked command: a resolved
    invoke sets `reachable = true`, a rejection goes through `classify()`, which
    owns all three prefixes. `cloud_status` deliberately stays on the raw invoke
    — it is a local kv read and would otherwise "prove" the server is up on every
    knob toggle. `unauthorized` does **not** set `reachable = true` either,
    because Rust emits `unauthorized: not logged in` as a network-free preflight.
  - **No new traffic.** Reachability is learned only from calls the user already
    causes — the panel's mount already ran `rdv_register` + `rdv_invite_fetch`
    and threw both answers away. **D6 stands: no probe, no poll, no health
    endpoint.** (`GET /api/health/` remains deliberately unwired.)
  - **Airplane mode is a mirror, not a subscription.** Rust emits no event when
    the switch flips, so `cloud.syncOffline()` re-reads it at press-shaped
    moments (reinit, tab mount, retry). Entering the tab remounts the panel
    (`v-if`/`v-else-if` sub-panels), which bounds staleness in practice.
  - **Precedence: knob → airplane → login → unreachable.** Airplane outranks
    logged-out on purpose — signing in is itself a cloud request, so "sign in
    above" would point at a control that cannot work. The reason shown must be
    the one whose removal actually unblocks the user.
  - **Disable, with the escape hatch always live.** Per D8, a *temporarily* inert
    control is disabled with the reason rather than hidden. Unreachable disables
    the submits too — leaving **Create & invite** live is exactly what produced
    an orphan room (the room is minted before the broadcast, which then
    "succeeds" with all-error rows). Because a cold arti bootstrap can exceed the
    connect timeout on a healthy server, the Retry button is never gated by
    `blocked`, clears the verdict optimistically, and the wording branches for
    Tor. Do not raise the connect timeout to compensate — it is the user's shared
    Settings value.
  - **The inbox stopped lying**: a failed fetch says so instead of rendering
    "No invites waiting", which read as "nobody invited you".
  - **Considered and declined**: an `offline:` prefix on `OFFLINE_BLOCKED`. It
    buys nothing here (airplane is knowable locally, ahead of the press) and has
    ~20 call sites across non-cloud surfaces that render the raw string, plus a
    duplicate const in `realtime.rs` versus `file_xfer.rs`. De-duplicate that
    first if it is ever revisited.
- **D12 — Named connections, one active (2026-07-29).** Several saved servers
  (name + address), **exactly one active**, each keeping its own sign-in. This
  cost almost nothing structurally because two things were already true: every
  Rust command takes `server_url` as a parameter, and `cloud:auth` is already
  scoped by the normalized URL — tokens for N servers coexisted all along, with
  nothing to enumerate them. So the feature is mostly *how `cloud.serverUrl` is
  derived*, and every consumer that reads it from the store (beacon ×9,
  Contacts, the invites panel, the picker, LocalPanel) follows a switch for
  free.
  - **The registry is frontend-owned**, exactly as `server_url` was. Rust never
    parses it: it would only be holding an opaque id it cannot use, and "which
    connection is active" is UI state, not a security boundary — the real gates
    (`runtime_enabled`, `ensure_cloud_ready`, the `connect()` re-check) are
    untouched, so D2 stands verbatim.
  - **One JSON blob under one fixed key**, `cloud:settings/default/servers`,
    plus `active_server`. Not one scope per connection — there is no kv
    key-listing primitive, *and* kv KEYS are stored in plaintext (protasius
    `enc_kv` seals only the value), so per-connection scopes would write every
    server address and every user-chosen name to disk in the clear. **Rule: no
    user-controlled string may ever become a kv `ns` or `scope`.**
  - `server_url` is **kept as a mirror** of the active entry rather than
    retired, written by a single private helper, so `getCloudServerUrl()` and
    any reader missed in the sweep cannot drift from the registry.
  - **A switch does NOT abort in-flight transfers.** `cloud_set_force_tor(true)`
    aborts for a *privacy* reason — the route of a live stream changes under it,
    and a direct transfer must stop exposing the IP. A switch changes neither
    route nor policy: the bytes still go to the server the user chose when they
    pressed Upload, and the newly selected server sees nothing. Killing a 2 GB
    upload because the user glanced at another server is hostile, and it is not
    what "off means zero bytes" is about. Contamination is handled by *ownership*
    (below), not by destroying work. Deleting a connection *does* abort its
    transfers — that one is a policy change the user asked for.
  - **Cross-connection contamination is the real hazard, not the registry.**
    Server-side ids are sequential integers, so directory 7 exists on both
    servers: acting on a row left over from the previous connection deletes a
    real, unrelated folder. Three guards, all in `stores/cloud.ts`:
    `dataConnectionId` (every command carrying a server-side id refuses a
    listing that another connection produced), `transferOwner` (`cloud://done` /
    `cloud://error` are routed by owner — otherwise server A's 201 fileDict
    lands in B's listing, and an `unauthorized` from A logs the user out of B),
    and `switchSeq` (every async completion drops its writes if the active
    connection moved, so a slow `cloud_status` or `login` cannot write the wrong
    server's session into the UI). The recipient picker stamps chips with the
    connection they were validated against — a username is server-relative, and
    a room ticket is a bearer credential MLS auto-admits, so sealing one to a
    chip resolved elsewhere would hand the room to a stranger.
  - **Normalization is FROZEN.** Stripping default ports would collapse
    `https://localhost:443` and `https://localhost` (the same socket, different
    kv scopes) — but it would also make every stored `cloud:auth/<old-form>/`
    token unreadable, a silent logout for everyone and unrecoverable since
    nothing can enumerate scopes; and any drift between `normalize_scope` (Rust)
    and `normalizeCloudServerUrl` (TS) is invisible in review while producing a
    permanent "unauthorized: not logged in" with the token sitting right there.
    Handled at the *input* instead: duplicate normalized URLs are refused, and
    `sameCloudServer` (display-only, never a storage key) warns about the
    same-server-different-spelling pair.
  - **`force_tor` stays global.** Only one connection is active, so the knob
    already reads as "route the current connection through Tor"; it is inert for
    onion and loopback either way.
- **D13 — Capabilities: ask once, assume present otherwise (2026-07-29).**
  zenobia (and any vault-only toto host) installs neither `toto.aster` nor
  `toto.beacon`, so sealed invites and Beacon 404 there while file storage and
  auth are byte-identical to faros. Two sources, in that order of authority:
  - `GET /api/apps/` via the new `cloud_apps`. `_FEATURE_APPS` in toto-base now
    reports `aster`/`beacon` too (2 lines, applied to `toto_libs` and both
    vendored trees — **not** a re-vendor: faros is on v1.8, portal on v1.16).
  - **Key-absent is UNKNOWN, not false.** A patched server answers
    `"aster": false` *as a boolean*; an unpatched one omits the key entirely, so
    the two are distinguishable and the server change is an **enhancement, never
    a dependency** — every unpatched faros keeps behaving exactly as today.
    Only an explicit `false` hides anything.
  - The fallback is the rule `for_enigma.md` already prescribed: a 404 on a
    feature's ROOT means the app is absent. The discriminator is that Django
    answers an unmounted prefix with **HTML** (⇒ `Value::Null`) while every real
    API 404 carries `{"error": …}` — verified against a live zenobia. Tagged
    `no_feature:` at five endpoints that address *no object*; deliberately NOT
    at `rdv_invite_ack` or the beacon deletes, where a 404 means someone else's
    row and demoting the capability over one stale id would hide the whole card.
  - **Caps are not persisted.** A cached `false` would hide a feature on a
    since-upgraded server with no discoverable way back; being briefly
    optimistic costs one honest 404. Session-lifetime, per connection,
    refreshed on every login.
  - **Triggers are narrow, for D6.** A successful login, a switch to a
    connection that already has a session, and a re-check press — never
    `init`/`reinit`/knob toggles/app start. `reinit()` runs from six `onMounted`
    sites (including the Local files and Contacts tabs), so wiring it there
    would put a request behind opening an unrelated tab. There is a named
    regression test for exactly this.
  - Surfaces follow D8: the Invites pill is **hidden** (nothing behind it, and
    the fix — pick another connection — lives on the Connection sub-tab, which
    says so), `effectiveTab` now derives from `visibleTabs` so a pinned
    `?tab=invites` cannot render a pill-less panel, `beaconAvailable` gains one
    AND term, and Contacts' `rdvAllowed` gains the same. Precedence in the
    invites panel becomes **knob → airplane → no-aster → login → unreachable**:
    "sign in above" would point at a control that cannot help on a server with
    no mailbox.

## As-built map

| Piece | File |
|---|---|
| Master gate, force_tor routing, transport label, setters, shutdown | `apps/enigma/src-tauri/src/cloud.rs` |
| Directory + invite mailbox + fan-out (`rdv_invite_broadcast`) | `apps/enigma/src-tauri/src/aster.rs` |
| Beacon gating (2-funnel swap covers all 8 commands) | `apps/enigma/src-tauri/src/beacon.rs` |
| Command registry (− `cloud_register`, + `cloud_set_enabled`, + `cloud_set_force_tor`) | `apps/enigma/src-tauri/src/lib.rs` |
| kv accessors (`getCloudEnabled`, `getCloudForceTor`, …) | `packages/rakotis/src/services/appStorage.ts` |
| Cloud tab shell (pills, off-state pointer) | `apps/enigma/src/views/EnigmaCloudView.vue` |
| Master switch + conscious-enable confirm (Settings → Connections) | `apps/enigma/src/components/cloud/CloudEnableCard.vue` |
| Connection sub-tab card (active connection, login, badge, force-Tor) | `apps/enigma/src/components/cloud/CloudSetupCard.vue` |
| Saved-connections list, switch / add / edit / remove (D12) | `apps/enigma/src/components/cloud/{CloudConnectionList,CloudConnectionModal}.vue` |
| Connection registry + frozen normalizer + `sameCloudServer` | `packages/rakotis/src/services/appStorage.ts` |
| Capability descriptor + the `no_feature:` fallback (D13) | `apps/enigma/src-tauri/src/cloud.rs` (`cloud_apps`, `is_missing_app`, `expect_2xx_or_missing`), `aster.rs`, `beacon.rs` |
| Files browser (moved unchanged) | `apps/enigma/src/components/cloud/CloudPanel.vue` |
| Invites panel (username picker + create-room) | `apps/enigma/src/components/cloud/CloudInvitesPanel.vue` |
| Recipient chips (typed usernames, resolved one at a time) | `apps/enigma/src/components/cloud/{CloudRecipientPicker.vue,useRecipientPicker.ts}` |
| Tor drops location sharing | `apps/enigma/src/stores/beacon.ts` (`torBlocked`), `components/map/{MapPanel,BeaconCard}.vue` |
| Login modal (register mode stripped) | `apps/enigma/src/components/cloud/CloudLoginModal.vue` |
| Store (`enabled` / `forceTor` / `transport`, setter side effects) | `apps/enigma/src/stores/cloud.ts` |
| Route + nav | `apps/enigma/src/router/index.ts`, `apps/enigma/src/App.vue` |
| Tests | `tests/unit/{cloudStore,cloudClassify}.test.ts`, `tests/component/{cloudEnableCard,cloudView,cloudInvites}.test.ts`, updated `beaconStore`/`beaconCard` tests, `tests/e2e/smoke.spec.ts` |

## Communication audit — every byte Enigma can send to the server

Gate algebra: **edition flag ∧ master switch ∧ airplane-mode-off ∧ session ∧
per-feature gate**. With the master switch off, none of the rows below can
fire — enforced twice (per command AND inside `connect()`). Since 2026-07-27
**every row is user-initiated**: the 150 s relay publisher was the only timer
and it is gone (D6). Reachability detection (D11) added no row — it reads the
answer to requests already listed below.

### Session & files (`cloud.rs`)

| Command | Wire | Trigger |
|---|---|---|
| `cloud_status` | — (local kv only; knob-exempt by design) | tab open / store init |
| `cloud_set_enabled`, `cloud_set_force_tor` | — (local kv write + transfer abort) | the two knobs |
| `cloud_login` | `POST /telegraph/api/login/` | Login button (plain password, sent once, never stored) |
| `cloud_logout` | `POST /telegraph/api/logout/` (best-effort; local clear always) | Logout button |
| `cloud_me` | `GET /telegraph/api/me/` | session validation |
| `cloud_apps` | `GET /api/apps/` (no auth) | **exactly three presses** (D13): a successful login, a switch to a connection that already has a session, the re-check button. Never a mount, a knob or app start |
| `cloud_list` | `GET /vault/api/files/` + `GET /vault/api/buckets/` | Refresh (two requests) |
| `cloud_upload` | `POST /vault/api/files/upload/` (streamed multipart) | Upload button (also Local tab's upload-to-cloud) |
| `cloud_download` | `GET /vault/api/files/{key}/download/` → 302 → media URL | Download button |
| `cloud_delete` / `cloud_move` | `DELETE` / `PATCH /vault/api/files/{key}/` | row actions |
| `cloud_mkdir` / `cloud_rmdir` | `POST /vault/api/directories/` / `DELETE …/{id}/` | folder actions |
| ~~`cloud_register`~~ | ~~`POST /sso/api/register/`~~ | **REMOVED** (D5) |

### Location shares (`beacon.rs` — extra gates: `maps.enabled`, and NOT Tor mode, D9)

`beacon_all` `GET /beacon/all` · `beacon_near` `GET /beacon/near?lat&lon&radius_m` ·
`POST /beacon/pin` · `POST /beacon/pin/delete` · `POST /beacon/zone` ·
`POST /beacon/route` · `POST /beacon/{zone,route}/{id}/delete` — all
user-pressed or beacon-card-open, all via `cloud::request_json`.

### Directory & invites (`aster.rs` — gate: the master switch; build gate is now `cloud.allow_connections` alone)

| Path | Wire | Trigger |
|---|---|---|
| `rdv_register` | `POST /aster/device` | Invites panel mount + sign-in; Contacts mount — mailbox addressing (NodeId only, no address) |
| `aster_resolve` | `GET /aster/resolve?user&kind` | Contacts "find on my server"; each recipient chip in the Invites picker |
| `rdv_invite_send` | `POST /aster/invite` (HPKE-sealed blob — server stores ciphertext it cannot open) | the NodeId-addressed path (verified saved contact) |
| `rdv_invite_broadcast` | 1 × `GET /aster/resolve` **and** 1 × `POST /aster/invite` per recipient DEVICE, sequential | Create-&-invite / Leave-invite press; stops only on the SENDER-quota 429 (see limitations) |
| `rdv_invite_fetch` | `GET /aster/invites` | Invites panel mount / sign-in / refresh press |
| `rdv_invite_ack` | `POST /aster/invite/{id}/delete` | accept/dismiss press |

*(Deleted 2026-07-27: `spawn_publisher`'s 150 s `POST /aster/addr` loop and
`AsterLookup`'s `GET /aster/addr/{id}` on peer dial. **There is no longer any
non-user-initiated path in this table** — every row is a press or a mount.)*

### Transport policy (per server host class)

| Server host | force_tor off | force_tor on | TLS |
|---|---|---|---|
| `.onion` | embedded arti | embedded arti | accept-any cert (identity = the onion address) |
| loopback (`localhost`, 127/8, `::1`) | direct TCP | direct TCP (badge "Local") | accept-any cert (dev-only) |
| clearnet | direct TCP (arti if the profile is Tor-exclusive) | arti → exit | **full WebPKI**, both routes |

Connect deadline: kv `p2p:settings/default/connect_timeout_secs` — the
Settings-tab value, never a literal. No SOCKS proxy, no external tor daemon —
Tor is only the in-process arti client (`tor.rs`).

### Non-cloud external traffic (contrast — NOT gated by this switch)

- iroh **n0-hosted relays + pkarr/DNS discovery** — when
  `p2p.allow_hosted_relays` (third-party infrastructure, not the user's server).
  This flag no longer gates anything in `aster.rs`: it governs third-party
  infrastructure, while the directory only ever talks to the user's own server.
- BitTorrent **Mainline DHT** bootstrap + announces — opt-in `dht_discovery`.
- **Tor directory authorities/guards** — inherent to arti whenever any
  onion/Tor path is active.

With hosted relays off, DHT off, Tor off and the Cloud switch off, Enigma
generates **no external traffic at all**. Grep-verified: no `reqwest`, one
`TcpStream::connect` in the crate (`cloud.rs::connect`), no proxy env vars.

### Server features available but deliberately NOT wired

faros also offers: vault metrics, per-file password encrypt/decrypt, text-file
content read (`/vault/api/files/{key}/content/`), capability discovery
(`GET /api/apps/`, `GET /api/health/`), mesh-gated socialhub + events APIs, an
OIDC provider. None are called; candidates for later, each one more row in the
table above.

## Accepted limitations

- **kv KEYS are plaintext at rest.** `protasius::enc_kv` seals only the value;
  `ns\0scope\0key` goes to disk verbatim. So `cloud:auth/<url>/token` already
  puts the server address in the clear, and anyone with the profile directory
  but not the passphrase can read the list of servers you have signed in to.
  This is why the connection registry is one blob under a fixed key (D12) rather
  than a scope per connection — names and URLs stay inside an encrypted value.
  Hashing the `cloud:auth` scope would close the remaining leak but would
  detonate every stored session; not attempted.
- **One account per server address.** The session is keyed by the normalized
  URL, so two connections pointing at the same address share one sign-in — the
  registry refuses that outright. Two *different* spellings of the same server
  (`https://h` vs `https://h:443`) are two independent sessions to one account;
  the add/edit form warns, because normalization is frozen (D12).
- **The registry assumes a single writer.** Two windows editing the connection
  list would clobber each other's blob. Enigma is single-window and only the
  Connection sub-tab writes it.
- **A switch leaves transfers running** (D12, deliberate). Their rows stay
  visible, labelled with the owning connection, and keep holding the idle lock
  off — correct, but note `connect()`'s timeout covers establishment only, so a
  hung stream to a dead server can pin the vault unlocked. Pre-existing.
- **Removing a connection is the only revocation.** A bearer-only
  `POST /api/logout/` calls Django's `logout(request)`, which flushes the
  *cookie* session; bearer auth never populates `request.session`, so the token
  survives server-side until it expires (~2 weeks). The confirm dialog says so
  rather than implying the session ends.
- **`kv_get` passthrough**: the frontend *can* read the `cloud:auth` bearer
  token (`vault.rs::kv_get` has no namespace allowlist), contradicting the
  cloud.rs header's intent — pre-existing flaw, documented here, out of scope.
  Same class: a `kv_put` to `cloud:settings/enabled` would bypass the confirm
  modal and the off-flip transfer abort; the Rust `connect()` guard still
  enforces the flag itself either way.
- **Disable is abortive, not graceful**: flipping off (or force-Tor on) kills
  in-flight transfers mid-stream with the message *"transfer cancelled
  (network policy changed)"*; an already-established stream may drain for a
  moment before the abort lands. Deliberate — off means off.
- **Spawn/register race, closed for the knob, residual for force-Tor**:
  `register_transfer` re-checks the master switch after inserting the handle
  (and skips already-finished tasks), so a knob flip landing between spawn and
  registration can no longer leak a transfer past `shutdown()`. What remains:
  a force-Tor flip in that same sub-millisecond window can miss a transfer
  whose direct connection was already established — it drains on the old
  route. Not attacker-schedulable; accepted.
- Buffered JSON requests (login/list/…) already in flight at the flip complete;
  the next `connect()` is refused. Short-lived, accepted.
- **First force-Tor request** may exceed the connect timeout while arti
  bootstraps; a retry succeeds (same as `.onion` today).
- Accept-any-cert TLS for onion/loopback (identity from the address / dev-only);
  clearnet is always WebPKI-verified.
- `GET /vault/api/files/` caps at **200 files, no pagination**; there is **no
  API to make a file public** — "publish" means upload to your private vault.
- Sessions are Django session keys (~2 weeks, no refresh); a silent 401 flips
  the UI logged-out via the `"unauthorized"` prefix convention.
- Invite blobs ≤ 8 KiB (checked before the POST so an oversized ticket is
  explained, not answered with a bare 413), TTL 24 h (the server's own cap, so
  the UI offers no TTL picker and cannot misreport expiry).
- **faros answers 429 for two unrelated caps and checks the recipient one
  first**: "Recipient's invite box is full" (that one device already holds 50
  invites *from anybody*) and "Too many pending invites" (our own 50 outstanding
  to anyone). Only the second may stop a fan-out — conflating them would let one
  inactive person on the list abort delivery to everyone else, permanently,
  because the retry would hit them first again. We read the body to tell them
  apart and assume the recipient cap when the message is unrecognizable, since
  that guess costs a refused request while the other costs the whole run. Both
  clear only on accept or expiry, and there is no endpoint to read your
  outstanding count, so the sender cap can only be discovered by hitting it. The
  picker caps a single fan-out at 20 people.
- **Retry re-sends only where nothing landed.** A `partial` recipient already
  holds a working invite on one device, and the report carries counts rather
  than NodeIds, so retrying them would post a duplicate to the device that
  already succeeded — burning two mailbox slots to fix nothing.
- A recipient must have opened Enigma with Cloud on at least once, or there is
  no device to seal to — indistinguishable from a wrong username, because faros
  answers both with an empty list.
- The Cloud tab is desktop-only in practice (`isTauri()` gates the store), like
  the old Files → Cloud sub-tab.

## Manual verification (run2.sh + a local faros)

1. Local faros up; create two accounts **in a browser** at
   `https://localhost:8443/sso/` (no in-app registration any more).
2. `./run2.sh` (Pro by default — first run recompiles Rust).
3. Both instances: **Settings → Connections** → *Use my Cloud server* **on** →
   the confirm modal lists the metadata + transport risks → confirm. Then
   **Cloud → Connection** → set the server URL → **Log in**.
4. Badge reads **Local** (loopback). On a clearnet URL it reads Clearnet with
   the warn banner; flip **Route through Tor** → badge **Tor**, and the faros
   access log shows a Tor-exit IP, not the LAN one.
5. Files: upload / download / move / delete from the Files sub-tab.
6. **Invites**: alice types bob's username → the chip resolves and shows his
   device count; a typo shows *not found* and cannot be sent. Name a room →
   **Create & invite** → bob's Invites tab → refresh → Accept → both are in the
   room. Repeat with an existing room via the second submit. Try a mixed list
   (one good, one unknown) and confirm the per-person results plus
   *Retry the ones that failed* keeping only the failures.
7. Switch **off** on alice mid-upload (Settings → Connections) → the transfer
   aborts, the Cloud tab's Files and Invites pills disappear, and the server
   access log goes silent — with the publisher gone it now stays silent
   indefinitely, not just between refreshes.
8. Turn **Route over Tor** on → the DHT card disappears from Settings, and the
   Map tab offers neither *Share this spot* nor the Beacon card (D9). Turn it
   off → both return.
9. faros `/aster/devices/` still lists both devices, with the address column
   empty — registration publishes a NodeId and nothing else.

## Manual verification — named connections (D12/D13)

**Port clash first.** Both stacks publish host **8081** (faros
`127.0.0.1:8081:80`, zenobia `8081:80`), so they cannot run together as shipped
— and testing a switch needs both live. That port is only nginx's HTTP→HTTPS
redirect, which Enigma never uses: remap one (`nginx.http_port` in
`zenobia/deploy/configs/zenobia_data_local.yaml` or
`faros/deploy/configs/faros_onion_tls.yaml`) and redeploy.

1. faros on `https://localhost:8443`, zenobia on `https://localhost:443`.
   Account on faros via `/sso/`; zenobia hard-disables self-signup
   (`SSO_OPEN_REGISTRATION=False`, non-overridable), so provision there with
   `manage.py createsuperuser`.
2. Cloud → Connection: the seeded entry is your old `server_url`. Rename it
   *faros*, **Add connection** → *zenobia*. Sign in to each; switching back and
   forth keeps both sessions, no password re-typed.
3. Files on faros: upload / download / mkdir / move / delete. Switch to zenobia
   — the list empties and refills with zenobia's files, nothing from faros
   survives. Repeat there.
4. **Stale-id guard**: with a faros folder listed, switch to zenobia and press
   Delete on the row still on screen → refused ("that list belongs to another
   connection"), and zenobia's folder of the same id is untouched. This is the
   one that would otherwise destroy data — directory ids are sequential, so id 7
   exists on both.
5. **Switch mid-upload** → the transfer *keeps running* against faros, its row
   is labelled *faros*, and nothing appears in zenobia's listing when it lands.
6. **Capabilities**: with zenobia active the Invites pill is gone and the Map
   offers no Beacon card; a pinned `?tab=invites` falls back to Files. Switch to
   faros → both return. Check both paths: before the server patch is deployed
   the demotion comes from the 404 (zenobia answers `/aster/*` and `/beacon/*`
   with an **HTML** 404 — verified), after it from
   `curl -k https://localhost:443/api/apps/` reporting
   `"aster": false, "beacon": false` while `:8443` reports both `true`.
7. **Quota**: force a zenobia 402/429 on upload — the server's own message shows
   on the row *and* in the persistent error slot (it outlives the 6 s row), the
   session survives, and nothing reads as "unreachable".
8. **Delete** zenobia while signed in → the confirm states the non-revocation
   truth, `cloud_logout` runs *before* the entry is dropped, and a neighbour
   activates. Removing the last connection is refused.
