# Cloud — one tab, one switch, an audited wire (cloud.md)

Status: **IMPLEMENTED 2026-07-27** — all gates green
(rakotis 249 vitest · enigma 553 vitest · cargo 134 · Playwright 19 ·
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

- **D1 — One home.** The top-level Cloud tab hosts three sub-tabs (Notes pill
  pattern, `EnigmaNotesView.vue`): **Files**, **Invites**, and **Connection** —
  the settings half, holding the master switch, server URL, login, transport
  badge and route-through-Tor. With the switch off, Connection is the *only*
  pill (Files and Invites would be dead ends) and shows just the switch plus
  the explanation; a stale Files selection falls back to it automatically. The
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
- **D4 — Conscious enable.** The knob (in Connection) is the only thing the tab
  shows when off, plus an explanation + warn banner. Turning it ON opens a danger-style
  confirm modal (Kanban delete-confirm pattern) listing the metadata the
  server sees and the per-transport risks; the kv flag is written only after
  the confirm press (`tests/component/cloudView.test.ts` proves no early
  write). Turning it OFF is instant — no ceremony to *stop* talking.
- **D5 — No in-app registration.** `cloud_register` deleted (Rust + store +
  modal). Accounts are created in a browser on the server's `/sso/` page; the
  login modal and setup card say so (`cloud.registerExternalHint`). Plain
  password login stays: `POST /telegraph/api/login/`, token (a Django session
  key) into the encrypted kv `cloud:auth/<normalized-url>/`.
- **D6 — No relay surface in the tab.** The aster relay-address publishing
  (`rdv_publish`) stays in Settings → Connections; the tab is files + invites
  + control only. The rdv card now hides while the master switch is off.
- **D7 — Dev editions.** `run_dev.sh` and `run2.sh` default
  `ENIGMA_EDITION="${ENIGMA_EDITION:-pro}"` so dev builds are cloud-capable;
  shipped/CI defaults unchanged ([build.md](build.md)).

## As-built map

| Piece | File |
|---|---|
| Master gate, force_tor routing, transport label, setters, shutdown | `apps/enigma/src-tauri/src/cloud.rs` |
| rdv/aster gating (5 commands, 150 s publisher, AsterLookup) | `apps/enigma/src-tauri/src/aster.rs` |
| Beacon gating (2-funnel swap covers all 8 commands) | `apps/enigma/src-tauri/src/beacon.rs` |
| Command registry (− `cloud_register`, + `cloud_set_enabled`, + `cloud_set_force_tor`) | `apps/enigma/src-tauri/src/lib.rs` |
| kv accessors (`getCloudEnabled`, `getCloudForceTor`, …) | `packages/rakotis/src/services/appStorage.ts` |
| Cloud tab shell (pills, knob, confirm modal) | `apps/enigma/src/views/EnigmaCloudView.vue` |
| Connection sub-tab card (server URL, login, badge, force-Tor) | `apps/enigma/src/components/cloud/CloudSetupCard.vue` |
| Files browser (moved unchanged) | `apps/enigma/src/components/cloud/CloudPanel.vue` |
| Invites panel (extracted from Contacts) | `apps/enigma/src/components/cloud/CloudInvitesPanel.vue` |
| Login modal (register mode stripped) | `apps/enigma/src/components/cloud/CloudLoginModal.vue` |
| Store (`enabled` / `forceTor` / `transport`, setter side effects) | `apps/enigma/src/stores/cloud.ts` |
| Route + nav | `apps/enigma/src/router/index.ts`, `apps/enigma/src/App.vue` |
| Tests | `tests/unit/cloudStore.test.ts`, `tests/component/cloudView.test.ts`, updated `beaconStore`/`beaconCard` tests, `tests/e2e/smoke.spec.ts` |

## Communication audit — every byte Enigma can send to the server

Gate algebra: **edition flag ∧ master switch ∧ airplane-mode-off ∧ session ∧
per-feature gate**. With the master switch off, none of the rows below can
fire — enforced twice (per command AND inside `connect()`).

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

### Location shares (`beacon.rs` — extra gate: `maps.enabled`)

`beacon_all` `GET /beacon/all` · `beacon_near` `GET /beacon/near?lat&lon&radius_m` ·
`POST /beacon/pin` · `POST /beacon/pin/delete` · `POST /beacon/zone` ·
`POST /beacon/route` · `POST /beacon/{zone,route}/{id}/delete` — all
user-pressed or beacon-card-open, all via `cloud::request_json`.

### Rendezvous & invites (`aster.rs` — extra gate: `p2p.allow_hosted_relays`)

| Path | Wire | Trigger |
|---|---|---|
| `rdv_register` | `POST /aster/device` | Invites panel mount; Contacts mount; rdv toggle on — mailbox addressing (NodeId only) |
| `spawn_publisher` | `POST /aster/device` + `POST /aster/addr` | **background loop, 150 s** — the one non-user-initiated path; requires opt-in kv `rdv_publish` AND the master switch (`rdv_enabled` composes both), self-gates every round |
| `AsterLookup::resolve` | `GET /aster/addr/{endpoint_id}` | on peer dial (stacked iroh `AddressLookup`) — gated by `rdv_enabled`, backstopped by the `connect()` guard |
| `aster_resolve` | `GET /aster/resolve?user&kind` | Contacts "find on my server" button |
| `rdv_invite_send` | `POST /aster/invite` (HPKE-sealed blob — server stores ciphertext it cannot open) | Leave-an-invite press |
| `rdv_invite_fetch` | `GET /aster/invites` | Invites panel mount / refresh press |
| `rdv_invite_ack` | `POST /aster/invite/{id}/delete` | accept/dismiss press |

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
- Invite blobs ≤ 8 KiB, TTL clamped 60 s–24 h, ≤ 50 pending each way (server
  caps).
- The Cloud tab is desktop-only in practice (`isTauri()` gates the store), like
  the old Files → Cloud sub-tab.

## Manual verification (run2.sh + a local faros)

1. Bring up a local faros; create two accounts **in a browser** at
   `https://localhost:8443/sso/` (no in-app registration any more).
2. `./run2.sh` (now Pro by default — first run recompiles Rust).
3. Both instances: **Cloud** tab → it opens on **Connection**, the only pill →
   knob **on** → the confirm modal lists the metadata + transport risks →
   confirm (you stay on Connection, now with the Files and Invites pills
   beside it) → set the server URL → **Log in**.
4. Badge reads **Local** (loopback). On a clearnet URL it reads Clearnet with
   the warn banner; flip **Route through Tor** → badge **Tor**, and the faros
   access log shows a Tor-exit IP, not the LAN one.
5. Files: upload / download / move / delete from the Files sub-tab.
6. Alice → Invites → pick Bob → pick a Tor room → invite sent; Bob → Invites →
   refresh → accept → lands in the room. Contacts' invite modal now points at
   the Cloud tab for Tor rooms.
7. Knob **off** on Alice mid-upload (Connection sub-tab) → the transfer aborts,
   the Files and Invites pills disappear, the server access log goes silent
   (the 150 s publisher included), and the Beacon card, Contacts search and
   Local-tab upload button all show/hide their cloud-off state.
