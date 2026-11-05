# Pharos — plan

Plan only, awaiting the owner's approval (2026-11-05). Decisions (work.md): **D1** pair once out of band, **D2** rendezvous onions per friendship, **D5** a directory onion on Proteus, **M3** Proteus as the always-on mailbox. Short messages only, over Tor, sealed with Ferrozine's MLS. **Nautes works without Proteus** (direct, friend to friend); Proteus only makes it easier (offline delivery, finding each other again).

## Stage 0 — Approval
- [ ] 0.1 👤 Owner approves the plan and decisions PD1–PD10 (work.md)

## Stage 1 — Fork and cut down: Enigma becomes Nautes, building on its own
- [x] 1.1 Import Enigma's history (`apps/enigma`) and the shared code it needs (Ferrozine, rotor, gervasius, petalite, calendula, scripts) into this repository
- [x] 1.2 New layout: `nautes/` (the app), `proteus/` (the server), `crates/` (shared), one root Cargo workspace, paths fixed
- [x] 1.3 Cut what is not short messaging over Tor: iroh transport, DHT, calls, file transfer, calendar, editions, everything in `limbo/`
- [x] 1.4 Rename Enigma to Nautes (identifier, words EN/PL, icons) and make it build and pass its remaining tests
- [x] 1.5 Test and build scripts for this repository (`tests.sh`, `run_dev.sh`), and a CI workflow

## Stage 2 — Shared core crates
- [ ] 2.1 `pharos-wire`: the message envelope, framing and version, from Enigma's Tor framing
- [ ] 2.2 `pharos-seal`: Ferrozine's MLS sealing (rotor) without iroh, for 1:1 friendships and small groups
- [ ] 2.3 `pharos-tor`: arti hosting and dialing of onion services, from Enigma's `p2p_tor.rs`, with timeouts and size caps
- [ ] 2.4 `pharos-rendezvous`: deriving a friendship's rotating onion key from its shared secret and the week (D2), with test vectors
- [ ] 2.5 Identity: a device's long-term key, its fingerprint and its contact card (QR / text)

## Stage 3 — Proteus, the server on a Raspberry Pi
- [ ] 3.1 A slim axum service reachable only as an onion service through arti (no clearnet port)
- [ ] 3.2 Mailbox (M3): keep sealed messages for an offline friend until fetched and acknowledged, with expiry and quotas
- [ ] 3.3 Directory (D5): signed, sealed "where to find me" records only friends can open, with expiry
- [ ] 3.4 Access: capability tokens per mailbox and record, rate limits, size caps, fixed-size padding
- [ ] 3.5 Storage: one SQLite file, small and crash-safe, with a backup command
- [ ] 3.7 At rest, as in Zirkel: a `master.key` (0600) seals every stored blob, token and record with XChaCha20-Poly1305 under a per-row label; `proteus check` says whether the data folder is on an encrypted disk; a LUKS guide for the Pi
- [ ] 3.6 Raspberry Pi: aarch64 build, systemd unit, memory and SD-card budget, install guide

## Stage 4 — Nautes, the client
- [ ] 4.1 The cut-down window: friends, conversation, compose a short message, settings
- [ ] 4.2 Pairing (D1): exchange contact cards by QR or text, verify the fingerprint, set up the friendship's secret and Proteus address
- [ ] 4.3 Friendship (D2): host this week's rendezvous onion per friend and dial theirs; deliver directly when both are online
- [ ] 4.4 Offline without Proteus: an undelivered message waits in a local outbox and is retried while both are online; with Proteus (M3) it is left in the friend's mailbox instead and fetched on their start and on a schedule
- [ ] 4.5 Directory (D5), only with Proteus: publish your current reachability and look friends up there when the rendezvous fails; without it, a lost friend is paired again (D1)
- [ ] 4.6 Local state encrypted at rest behind a passphrase (Enigma's vault), and desktop notifications

## Stage 5 — Security and tests
- [ ] 5.1 Threat model and metadata: what Proteus, Tor and a friend can learn; padding and fetch schedules
- [ ] 5.2 Tests: unit, protocol vectors, Proteus with an in-memory transport, Nautes vitest, and end-to-end runs over real Tor both with and without Proteus
- [ ] 5.3 Hostile inputs: oversized and malformed frames, replay, token abuse, a full disk

## Stage 6 — Release
- [ ] 6.1 PROTOCOL.md, README, technology.md, THIRD_PARTY.md
- [ ] 6.2 Packages: Nautes for Linux and Windows (Android later), Proteus as an aarch64 binary and a .deb for Raspberry Pi OS
