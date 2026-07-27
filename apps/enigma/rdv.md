# Cloud rendezvous v1 — your faros server as an optional peer directory (rdv.md)

Status: **IMPLEMENTED 2026-07-26**, address publishing **WITHDRAWN 2026-07-27**
— gates at last run: rakotis 249 vitest · enigma 574 vitest · cargo 140 ·
Playwright 19 · vue-tsc + vite builds clean. Server side: faros `toto.aster`
(see the faros repo's `for_enigma.md` → "Rendezvous").

Enigma stays serverless by default. With **your own** faros server configured
and logged in (the Enigma Cloud substrate), the server acts as a **name and
mailbox directory**: it maps a faros username to the NodeIds behind it and
holds HPKE-sealed room invites until the recipient collects them. It never
learns *where* you can be reached — the relay publisher and the stacked iroh
`AddressLookup` were deleted on 2026-07-27 (D3/D4/D5 below), and with them the
last periodic server traffic in the app.

## Decision log

- **D1 — Optional by contract.** No server URL / cloud switched off / logged
  out / offline / non-aster server ⇒ byte-identical behavior to a build without
  cloud; every failure degrades silently to the manual ticket flow. (Until
  2026-07-27 this clause also covered a publish toggle and a lookup — both are
  gone, see D3/D4.)
- **D2 — Same server, same session (beacon's D1).** `aster.rs` rides
  cloud.rs's `request_json`/`ensure_cloud_ready`/`expect_2xx`, the `cloud:auth`
  bearer token and the `.onion`-via-arti routing. No second login, no new
  server-URL field. The build gate is `cloud.allow_connections` **alone**
  (2026-07-27): `p2p.allow_hosted_relays` was only ever in the AND because a
  relay URL was what got published, and it governs *third-party*
  infrastructure, while everything left here talks to the user's own server and
  never touches an address. Dropping it also un-breaks the case D11 calls the
  flagship one — Tor-exclusive with no hosted relays.
- **D3 — WITHDRAWN 2026-07-27.** The stacked `AsterLookup` is deleted. Address
  discovery is n0/pkarr, the DHT and tickets — exactly as in a build without
  cloud. The isomorphic-insertion argument was sound; the feature it inserted
  is gone.
- **D4 — WITHDRAWN 2026-07-27.** The `rdv_publish` toggle, the 150 s refresh
  loop and the Settings card are deleted. **The documented deviation from
  no-background-traffic is revoked**: Enigma now has no periodic server traffic
  at any setting, and every byte to the server follows a press. Profiles that
  had the toggle on keep an inert `p2p:settings/default/rdv_publish` kv entry —
  nothing can read it (see Accepted limitations).
- **D5 — WITHDRAWN 2026-07-27.** Nothing publishes an address. What the server
  can still infer is narrower and event-driven: `POST /aster/device` tells it
  "this NodeId belongs to this account" and bumps `last_seen` when you open the
  Cloud or Contacts tab — no relay URL, no refresh cadence, no continuous
  online signal.
- **D6 — Username lookup feeds the existing flows.** "Search my server" in
  Contacts → `aster_resolve` → results prefill the same code-validated
  add-contact modal the DHT search uses; invites then ride `enigma/invite/0`
  unchanged. No new connect UX.
- **D7 — Tor-exclusive mode needs no carve-out.** With the publisher gone every
  aster path is transport-independent (D11 generalizes from registration to the
  whole module), so there is nothing to tear down and nothing to gate. Tor mode
  does drop **location sharing** — both the in-room share and Beacon — but that
  is a maps decision, recorded in cloud.md D9.

## As-built map

| Piece | File |
|---|---|
| Rust client (register, resolve, invite mailbox + fan-out) | `apps/enigma/src-tauri/src/aster.rs` |
| Contacts server search | `apps/enigma/src/views/EnigmaContactsView.vue` |
| Invite UI (picker + create-room) | `apps/enigma/src/components/cloud/{CloudInvitesPanel,CloudRecipientPicker}.vue`, `useRecipientPicker.ts` |
| Tests | `aster.rs` inline (7), `invite_seal.rs` (8), `tests/unit/recipientPicker.test.ts`, `tests/component/cloudInvites.test.ts` |

*(Deleted 2026-07-27: the `p2p_iroh.rs` publisher wiring, the rakotis
`get/setRdvPublish` accessors, the Settings → Connections card and
`tests/unit/rdv.test.ts`.)*

## Sealed room invites — the QR replacement for Tor rooms

The direct contact invite rides iroh (`enigma/invite/0`) and is hard-blocked in
Tor mode, so a Tor room could previously only be shared by hand-carrying a QR.
Invites now travel through the same faros mailbox, sealed.

- **D8 — the ticket is a bearer credential, so it is sealed.** MLS admission is
  automatic today (no approval UI — `useChatChannel.ts` handlePeerKeyPackage;
  the repo notes this in technology.md §12), and a Tor ticket never rotates
  because `create_room` is idempotent. A plaintext invite on a server would
  therefore hand that server the room. `invite_seal.rs` HPKE-seals the ticket
  to the recipient's NodeId (Ed25519→X25519, DHKEM-X25519/HKDF-SHA256/
  ChaCha20Poly1305 — the openmls primitive already vendored) and **signs the
  envelope**, because HPKE base mode is anonymous and the direct invite gets
  sender authenticity free from QUIC. `info` domain-separates the context; the
  AAD binds recipient ‖ sender ‖ expiry, so an invite cannot be re-addressed
  or have its expiry stretched. faros stores opaque bytes.
- **D9 — expiry twice**: server TTL (default 24 h, clamped) *and* `exp` inside
  the AAD, since the underlying ticket has no expiry of its own. One-shot:
  acknowledged after collection.
- **D10 — explicit join.** Collected invites appear in the **Cloud tab →
  Invites** ("Waiting for you"), with the sender named from your saved contacts
  (raw NodeId if unknown); joining is a press and calls the existing
  `joinByTicket`. Nothing about the Tor transport changed. (They lived in
  Contacts until the Cloud tab was built, cloud.md D1.)
- **D11 — registration is transport-independent.** `rdv_register` publishes
  only the NodeId (derived from the vault key), so a Tor-exclusive profile —
  where iroh and the relay publisher are down — is still addressable. That is
  exactly when server invites matter.

**Honest limitation:** when you invite someone *by username*, their NodeId
comes from the directory, so an actively malicious server could substitute its
own key and read that one invite. Since 2026-07-27 the Cloud tab addresses
invites by username on purpose (cloud.md D10) — the trade-off is stated
in-product beside the picker, and the safe alternative is named there: an
invite sent to a **saved contact** whose NodeId you checked out-of-band is not
exposed to it.

## Two discovery modes

Discovery now follows the transport, because the DHT rides iroh and Tor mode
tears iroh down:

| | **Non-Tor** | **Tor** |
|---|---|---|
| Find people | DHT nickname search + presence | "Look up on my server" (aster) |
| Be findable | DHT nickname claim | device registered on your faros |
| Invite to a room | direct P2P invite over iroh, QR ticket, **or** a sealed invite by username (Cloud tab) | QR ticket **or** a sealed invite by username (Cloud tab) |

- **D12 — the DHT is gated at the source in Tor mode.** `discovery_enabled`
  and `nick_publish_enabled` (p2p_dht.rs) return false when the profile is
  Tor-exclusive, so DhtHandle, DhtAddressLookup, the nick publisher,
  `dht_status` and ticketless joins are all inert regardless of the stored
  toggle. Previously they were *implicitly* dead (no iroh node) while the UI
  still offered them — a nickname claim would have published a relay address
  this profile deliberately isn't using.
- **D13 — hide in Contacts, explain in Settings.** Contacts drops the dead
  surfaces entirely (nickname card, DHT search button, presence dots and its
  polling); the Settings toggle stays visible but disabled with the reason,
  because that is where a user goes looking for it. Both halves stay opt-in:
  with no faros configured, Tor mode simply has no directory, as before.

## Accepted limitations

- Gossip endpoint only (`kind = "gossip"`); vox keeps its own discovery paths.
- Resolution requires both sides on the SAME faros server, and the other person
  must have opened Enigma with Cloud on at least once (no registered device ⇒
  `/aster/resolve` answers with an empty list, indistinguishable from "no such
  user").
- Profiles that had the withdrawn toggle on keep an inert
  `p2p:settings/default/rdv_publish` kv entry. Nothing in either language can
  read it, it lives inside the encrypted vault, and it is absent from
  `device_link.rs`'s `SYNC_KV` so no linked device can re-write it — not worth
  an unlock-time migration.
- The device row lingers on the server until removed there (faros Devices tab
  has a Remove button; enigma-side unregister is still v2).

## Manual verification (run2.sh + local faros)

Both instances: **Settings → Connections** → *Use my Cloud server* on (confirm
the risk modal — it is mandatory, cloud.md D4), then Cloud tab → Connection →
set the server URL → log in.
faros `/aster/devices/` lists both devices (NodeId only — the address column
stays empty now). Contacts → type the other account's username → "Search my
server" → Add. Then Cloud → Invites → type the other username → "Create &
invite" → the other instance's Invites tab shows it → Accept → the room opens
with no ticket pasted.
