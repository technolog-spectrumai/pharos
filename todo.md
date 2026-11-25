# Pharos — plan

Approved and built through Stage 6 (2026-11-05). Decisions (work.md): **D1** pair once out of band, **D2** rendezvous onions per friendship, **D5** a directory onion on Relay, **M3** Relay as the always-on mailbox. Short messages only, over Tor, sealed with Ferrozine's MLS. **Enigma works without Relay** (direct, friend to friend); Relay only makes it easier (offline delivery, finding each other again).

## Stage 0 — Approval
- [x] 0.1 👤 Owner approves the plan ("approved, go on", 2026-11-05); PD9 (Privacy HP) still open

## Stage 1 — Fork and cut down: Vesper becomes Enigma, building on its own
- [x] 1.1 Import Vesper's history (`apps/vesper`) and the shared code it needs (Ferrozine, rotor, gervasius, petalite, calendula, scripts) into this repository
- [x] 1.2 New layout: `enigma/` (the app), `relay/` (the server), `crates/` (shared), one root Cargo workspace, paths fixed
- [x] 1.3 Cut what is not short messaging over Tor: iroh transport, DHT, calls, file transfer, calendar, editions, everything in `limbo/`
- [x] 1.4 Rename Vesper to Enigma (identifier, words EN/PL, icons) and make it build and pass its remaining tests
- [x] 1.5 Test and build scripts for this repository (`tests.sh`, `run_dev.sh`), and a CI workflow

## Stage 2 — Shared core crates
- [x] 2.1 `pharos-wire`: the message envelope, framing and version, from Vesper's Tor framing
- [x] 2.2 `pharos-seal`: Ferrozine's MLS sealing (rotor) without iroh, for 1:1 friendships and small groups
- [x] 2.3 `pharos-tor`: arti hosting and dialing of onion services, from Vesper's `p2p_tor.rs`, with timeouts and size caps
- [x] 2.4 `pharos-rendezvous`: deriving a friendship's rotating onion key from its shared secret and the week (D2), with test vectors
- [x] 2.5 Identity: a device's long-term key, its fingerprint and its contact card (QR / text)

## Stage 3 — Relay, the server on a Raspberry Pi
- [x] 3.1 A slim axum service reachable only as an onion service through arti (no clearnet port)
- [x] 3.2 Mailbox (M3): keep sealed messages for an offline friend until fetched and acknowledged, with expiry and quotas
- [x] 3.3 Directory (D5): signed, sealed "where to find me" records only friends can open, with expiry
- [x] 3.4 Access: capability tokens per mailbox and record, rate limits, size caps, fixed-size padding
- [x] 3.5 Storage: one SQLite file, small and crash-safe, with a backup command
- [x] 3.7 At rest, as in Zirkel: a `master.key` (0600) seals every stored blob, token and record with XChaCha20-Poly1305 under a per-row label; `relay check` says whether the data folder is on an encrypted disk; a LUKS guide for the Pi
- [x] 3.8 Its page: `http://<onion>/` in Tor Browser shows its code (`pharos-relay:…`) as a QR image and as text, to download; `relay code` prints it on the Pi; Enigma connects with it (scan or paste)
- [x] 3.6 Raspberry Pi: aarch64 build, systemd unit, memory and SD-card budget, install guide

## Stage 4 — Enigma, the client
- [x] 4.1 The cut-down window: friends, conversation, compose a short message, settings
- [x] 4.2 Pairing (D1): exchange contact cards by QR or text, verify the fingerprint, set up the friendship's secret and Relay address
- [x] 4.3 Friendship (D2): host this week's rendezvous onion per friend and dial theirs; deliver directly when both are online
- [x] 4.4 Offline without Relay: an undelivered message waits in a local outbox and is retried while both are online; with Relay (M3) it is left in the friend's mailbox instead and fetched on their start and on a schedule
- [x] 4.5 Directory (D5), only with Relay: publish your current reachability and look friends up there when the rendezvous fails; without it, a lost friend is paired again (D1)
- [x] 4.6 Local state encrypted at rest behind a passphrase (Vesper's vault), and desktop notifications

## Stage 5 — Security and tests
- [x] 5.1 Threat model and metadata: what Relay, Tor and a friend can learn; padding and fetch schedules
- [x] 5.2 Tests: unit, protocol vectors, Relay with an in-memory transport, Enigma vitest, and end-to-end runs over real Tor both with and without Relay
- [x] 5.3 Hostile inputs: oversized and malformed frames, replay, token abuse, a full disk

## Stage 6 — Release
- [x] 6.1 PROTOCOL.md, README, technology.md, THIRD_PARTY.md
- [x] 6.2 Packages: Enigma for Linux and Windows (Android later), Relay as an aarch64 binary and a .deb for Raspberry Pi OS — Relay .deb built and install-tested here; Enigma bundles come from release.yml (not yet run)

## Stage 7 — Metadata hardening (open, 2026-11-22)
Gaps found while reviewing Enigma26 (technolog-spectrumai/enigma, `dev_mvp1`) before it moves here, always on Tor.
- [ ] 7.1 Message padding in Enigma26 rooms: pad every frame (chat, key packages, commits, files) to fixed buckets before MLS, as `pharos-wire` does (512 / 2048 / 8192 B, then multiples of 32 KiB); refuse non-zero padding
- [ ] 7.2 Sealed sender: move `device_id`, `user`, `sender_name`, `sender_avatar_url` and `msg_id` out of the plaintext JSON envelope and inside the MLS ciphertext; the outer frame carries only the epoch and the padded blob
- [ ] 7.3 No captain: a proper mesh (decided 2026-11-22). Every member hosts its own onion and links to every other member; messages go to each link directly (no member relays or sees all traffic); a joiner learns the other members' onions from the MLS group state (inside the ciphertext), not from one host; add Tor client authorisation (restricted discovery, arti feature `restricted-discovery`) so only members can fetch a member's descriptor. Remove the captain code (election, failover, relaying)
- [ ] 7.4 Timing correlation: cover traffic while a room is open (one padded frame every T seconds per link, real or dummy, real messages take the next slot; T configurable, longer on mobile data/battery); jittered, randomised fetch times instead of the fixed 60 s tick for Beacon's mailbox; see 7.5
- [ ] 7.5 Vanguards: neither Pharos nor Enigma26 builds arti with the `vanguards` feature (both use `default-features = false`), so onion circuits pick their middle relays at random and the guard of a hosted onion can be found. Enable the feature (arti 0.43 then defaults to vanguards-lite for clients and full vanguards for onion services: 4 L2 relays kept 1–12 days, 8 L3 relays kept 1–48 h), keep arti's state directory across restarts (inside the encrypted profile) so the vanguard sets survive, and test the effect on time to connect

## Stage 8 — Beacon by default, never indispensable (decided 2026-11-25)
Beacon is the default meeting point and mailbox of a room; the mesh keeps working without it.
The gap is kept small: Beacon only ever handles sealed, padded, steady traffic it cannot link to anyone.
- [x] 8.A1 Sealed sender (= 7.2): device id, name and msg id inside MLS; the outer frame only epoch + blob
- [x] 8.A2 Padding (= 7.1): every frame padded to 512 B / 2 KiB / 8 KiB / n × 32 KiB
- [ ] 8.A3 (later, optional) Tor restricted discovery on **Beacon's** onion, off by default; member onions stay open
  - Beacon: `restricted_discovery = true` in its config → arti `key_dirs` = `<data>/clients/*.auth` (plain Linux, file watching is fine there); a client is added by dropping its key file in
  - Phone: when pairing with a restricted Beacon (8.C2), make a discovery key for its onion (arti `generate_service_discovery_key`, needs `experimental-api` + `keymgr`) and show it for the owner to add
  - Checked against the design — no clash, with these rules:
    - Beacon cannot tell which authorised client opened its descriptor, so fresh circuits per post (8.B3) still don't link posts
    - Mailbox ids/tokens (8.B1) still gate every mailbox; restricted discovery is an extra DoS layer, not the access control
    - A room member without a key just can't use that Beacon: they stay on the mesh (8.C3 already works without Beacon), so the room never depends on it
    - Invitation redemption goes to the inviter's onion, not Beacon, so newcomers are unaffected; but Beacon can't be the "door" in restricted mode, and `/v1/pairing` only works for authorised clients
    - Adding a client takes seconds–minutes (descriptor republish is rate-limited); removing one isn't instant — tokens rotate weekly anyway
- [x] 8.B1 Room mailbox ids and tokens from the MLS exporter (current epoch + week number, so they move with every commit and every week; removed members cannot derive them); Beacon keeps only hashes — `mls_mailbox`
- [ ] 8.B2 Beacon endpoints: post / fetch / ack frames per mailbox, 14-day expiry, quotas, rate limits
- [ ] 8.B3 Members post every frame to the mailbox too, each post on a fresh circuit
- [ ] 8.B4 Duplicates from both routes dropped by msg id (inside MLS after 8.A1); our own frames coming back from Beacon are recognised before decrypting (a per-device send log of frame hashes), since MLS cannot open its own messages
- [ ] 8.C1 The room's Beacon address stored with the room and shared inside the MLS group state
- [ ] 8.C2 New rooms use your Beacon if one is set (Settings → Connections, scan its code); none → pure mesh
- [ ] 8.C3 Phones use both routes: Beacon first, mesh links to online members, work on if Beacon is down; status "Via Beacon" / "Direct"
- [ ] 8.C4 Invitations name Beacon's onion; a redemption waits there, sealed to the inviter, until the inviter's phone admits it
- [ ] 8.D1 Constant-rate padded frames to Beacon while a room is open (= 7.4), longer interval on mobile/battery
- [ ] 8.D2 Poisson-timed fetches and dummy fetches
- [ ] 8.D3 Small random release delays on Beacon
- [ ] 8.E1 SECURITY.md: what Beacon still learns (volume, uptime) and does not (who, which room, what)
- [ ] 8.E2 Tests: room works with Beacon down; never-overlapping members still exchange; Beacon's DB reveals no room/member link; real-Tor run
