# Cloud rendezvous v1 — your faros server as an optional peer directory (rdv.md)

Status: **IMPLEMENTED 2026-07-26 (uncommitted, branch `rdv`)** — gates at last
run: rakotis 249 vitest · enigma 538 vitest · cargo 123 · vue-tsc + vite
builds clean. Server side: faros `toto.aster` (see the faros repo's
`for_enigma.md` → "Rendezvous").

Enigma stays serverless by default. With **your own** faros server configured
and logged in (the Enigma Cloud substrate), this feature revives the
pre-`e2629c9` aster client: publish *where you can be reached* — the iroh
relay URL only, never an IP — and resolve peers by NodeId or faros username.
Traffic never touches the server; it only swaps addresses.

## Decision log

- **D1 — Optional by contract.** No server URL / logged out / toggle off /
  offline / non-aster server ⇒ byte-identical behavior to today; every failure
  degrades silently to the manual ticket flow. The publisher swallows all
  errors; the lookup returns no stream when gated.
- **D2 — Same server, same session (beacon's D1).** `aster.rs` rides
  cloud.rs's `request_json`/`ensure_online`/`expect_2xx`, the `cloud:auth`
  bearer token and the `.onion`-via-arti routing. No second login, no new
  server-URL field. Derived build gate `ASTER_DISABLED` =
  `cloud.allow_connections && p2p.allow_hosted_relays` (no relay URL exists to
  publish in a no-hosted-relays build).
- **D3 — Isomorphic insertion.** `AsterLookup` is a third stacked iroh
  `AddressLookup` beside `MemoryLookup`/`DhtAddressLookup` — lookups race, so
  the server path costs nothing when absent. Resolved peers are
  `EndpointAddr::from_parts(id, [TransportAddr::Relay(url)])` — relay-only,
  ever. Tickets/QR/join flow untouched.
- **D4 — Opt-in toggle, then auto-refresh.** Kv `p2p:settings/rdv_publish`,
  default **off**. While on, the publisher registers the device then
  refreshes the relay URL every 150 s (half the server's 300 s TTL); each
  round re-checks the toggle + airplane + session, so the Settings switch
  applies live in both directions and an off toggle produces zero traffic.
  The deliberate opt-in is the "explicit action"; the refresh loop is the
  documented deviation from no-background-traffic (a stale directory entry is
  useless), mirroring the DHT announcer precedent.
- **D5 — Publish-privacy note.** The server learns NodeId → home-relay URL +
  coarse online-ness — the same datum the DHT toggle publishes to a PUBLIC
  DHT, here sent only to the user's own server. Never an IP (the publisher
  skips rounds with no relay address rather than falling back).
- **D6 — Username lookup feeds the existing flows.** "Search my server" in
  Contacts → `aster_resolve` → results prefill the same code-validated
  add-contact modal the DHT search uses; invites then ride `enigma/invite/0`
  unchanged. No new connect UX.
- **D7 — Tor-exclusive mode**: iroh (and with it the publisher) is torn down
  as today; the directory entry ages out on the server. Nothing new to gate.

## As-built map

| Piece | File |
|---|---|
| Rust client (publisher, lookup, resolve cmd) | `apps/enigma/src-tauri/src/aster.rs` |
| Endpoint wiring + publisher lifecycle | `apps/enigma/src-tauri/src/p2p_iroh.rs` (Node.rdv_publisher, shutdown abort) |
| Kv accessors | `packages/rakotis/src/services/appStorage.ts` (`get/setRdvPublish`) |
| Settings card (Connections) | `apps/enigma/src/views/EnigmaConfigView.vue` |
| Contacts server search | `apps/enigma/src/views/EnigmaContactsView.vue` |
| Tests | `aster.rs` inline (4), `tests/unit/rdv.test.ts` |

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
- **D10 — explicit join.** Collected invites appear as a card in Contacts with
  the sender named from your saved contacts (raw NodeId if unknown); joining
  is a press and calls the existing `joinByTicket`. Nothing about the Tor
  transport changed.
- **D11 — registration is transport-independent.** `rdv_register` publishes
  only the NodeId (derived from the vault key), so a Tor-exclusive profile —
  where iroh and the relay publisher are down — is still addressable. That is
  exactly when server invites matter.

**Honest limitation:** when you invite someone resolved *by username*, their
NodeId comes from the directory, so an actively malicious server could
substitute its own key and read that one invite. Invites to **saved contacts**
(NodeId verified out-of-band when you added them) are safe even then. The UI
therefore addresses invites by saved contact.

## Accepted limitations

- Gossip endpoint only (`kind = "gossip"`); vox keeps its own discovery paths.
- Resolution requires both sides on the SAME faros server and the publisher
  side opted in.
- Presence is coarse (the server's 300 s TTL window), read-only on the faros
  "Devices" page.
- The device row lingers on the server until removed there (faros Devices tab
  has a Remove button; enigma-side unregister is v2).

## Manual verification (run2.sh + local faros)

Both instances: Settings → set the Cloud server URL, Files → Cloud → log in,
Connections → enable "Publish my address to my server". faros `/aster/devices/`
shows both devices fresh. Contacts → type the other account's username →
"Search my server" → Add → invite from Contacts → room connects with no
ticket pasted. Toggle off → entry goes stale after ~5 min → ticket flow still
works.
