# Cloud — one tab, one switch, an audited wire (cloud.md)

Status: **IMPLEMENTED 2026-07-27** — all gates green
(rakotis 249 vitest · enigma 574 vitest · cargo 140 · Playwright 19 ·
vue-tsc + vite builds clean). Server contract: the faros repo's
`for_enigma.md`. Branch `relay`.

The Cloud tab is the **single home for everything that can talk to the user's
own faros server**: file storage (moved from Files → Cloud), sealed room
invites (moved from Contacts), server URL + login (moved from Settings), a
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
| Connection sub-tab card (server URL, login, badge, force-Tor) | `apps/enigma/src/components/cloud/CloudSetupCard.vue` |
| Files browser (moved unchanged) | `apps/enigma/src/components/cloud/CloudPanel.vue` |
| Invites panel (username picker + create-room) | `apps/enigma/src/components/cloud/CloudInvitesPanel.vue` |
| Recipient chips (typed usernames, resolved one at a time) | `apps/enigma/src/components/cloud/{CloudRecipientPicker.vue,useRecipientPicker.ts}` |
| Tor drops location sharing | `apps/enigma/src/stores/beacon.ts` (`torBlocked`), `components/map/{MapPanel,BeaconCard}.vue` |
| Login modal (register mode stripped) | `apps/enigma/src/components/cloud/CloudLoginModal.vue` |
| Store (`enabled` / `forceTor` / `transport`, setter side effects) | `apps/enigma/src/stores/cloud.ts` |
| Route + nav | `apps/enigma/src/router/index.ts`, `apps/enigma/src/App.vue` |
| Tests | `tests/unit/cloudStore.test.ts`, `tests/component/{cloudEnableCard,cloudView}.test.ts`, updated `beaconStore`/`beaconCard` tests, `tests/e2e/smoke.spec.ts` |

## Communication audit — every byte Enigma can send to the server

Gate algebra: **edition flag ∧ master switch ∧ airplane-mode-off ∧ session ∧
per-feature gate**. With the master switch off, none of the rows below can
fire — enforced twice (per command AND inside `connect()`). Since 2026-07-27
**every row is user-initiated**: the 150 s relay publisher was the only timer
and it is gone (D6).

### Session & files (`cloud.rs`)

| Command | Wire | Trigger |
|---|---|---|
| `cloud_status` | — (local kv only; knob-exempt by design) | tab open / store init |
| `cloud_set_enabled`, `cloud_set_force_tor` | — (local kv write + transfer abort) | the two knobs |
| `cloud_login` | `POST /telegraph/api/login/` | Login button (plain password, sent once, never stored) |
| `cloud_logout` | `POST /telegraph/api/logout/` (best-effort; local clear always) | Logout button |
| `cloud_me` | `GET /telegraph/api/me/` | session validation |
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
