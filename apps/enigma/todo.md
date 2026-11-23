# Enigma27 — todo

Stages and their steps. `[x]` done and verified, `[~]` partly done, `[ ]` not
started. How things work is in [technology.md](technology.md).

## Stage 1 — Maps

- [x] **1.1 Move maps out to Morion.** The Map tab, `maps.rs`, the `maps`
      feature, the map libraries and `tools/map_packager` are gone from this
      repo; a map share in a room's history shows as a card that cannot be
      opened. What was done and what stays: technology.md §16.

## Stage 2 — Into Pharos (2026-11-22/23)

- [x] **2.1 Copy Enigma26 into Pharos as Enigma27.** From technolog-spectrumai/enigma,
      `dev_mvp1`, copied (not vendored); identifier `com.spectrumaipl.enigma27`; the
      letter E as icon (`scripts/letter_icon.py`). It replaces the Friends + Vesper
      client. technology.md §16.
- [x] **2.2 Always Tor, a mesh.** iroh, iroh-gossip and Ferrozine gone; every member
      hosts an onion per room and links to every other; outbox, backoff, stable
      onions (arti's state sealed in the vault); full vanguards; Tor starts after
      unlock. technology.md §11.
- [x] **2.3 Remove the captain and all moderation** (logo, rules, mute, kick/ban),
      legacy tickets, the "Route over Tor", "Keep onion stable" and file-integrity
      switches.
- [x] **2.4 Room start fixes.** MLS starts on entering a room; a new room is a group
      of one at once; sessions kept across reopens; sending needs only encryption;
      no plaintext sent or shown. technology.md §4.
- [x] **2.5 Invitations over the onion**, with the inviter's device id; the grant
      carries every member's onion. Files downloaded from the sender's onion.
- [ ] **2.6 The reset frame.** `mls_reset_request` is plaintext and unauthenticated:
      any connection to a member's onion can make it start a new group of one, which
      then cannot get back in (key packages from the mesh are refused). Authenticate
      it (inside MLS) or remove it with the "reset encryption" button. §9 item 4.
- [ ] **2.7 The MLS identity is the profile name** (`CHAT_USER`, default `default`).
      Two people who both use the profile "default" collide in one room (each drops
      the other's frames as its own). Use the device id, or a random per-profile id.
- [ ] **2.8 Links accept anyone.** An inbound link is taken on the onion its `Hello`
      claims, and `broadcast` writes to every live link, so whoever knows a member's
      onion receives that member's frames and can displace a member's link by
      claiming its onion. Tor client authorisation (root todo.md 7.3) closes it;
      until then, send only to wanted members.
- [ ] **2.9 Stage 7 of the root todo.md**: padding, sealed sender fields, cover
      traffic.

## Open, outside the stages

Kept from before the stages, one line each; the detail is in technology.md
(§13, §16, §20) and in this file's history.

- [ ] Pins in existing profiles (`map:pins`) have no way out of the vault; an
      export to `.geojson` would carry them to Morion. Decide if it is needed.
- [ ] Region files stay on disk in a profile that used maps
      (`profiles/<p>/maps/*.pmtiles`); they open in Morion as they are.
- [ ] `WEBKIT_DISABLE_DMABUF_RENDERER=1` (`main.rs`) was for the map canvas;
      removing it wants a look on an NVIDIA / hybrid-GPU machine.
- [ ] Playwright smoke tests: check them after the move (three failed in Enigma26:
      the DHT toggle, "find people", Create).
- [ ] Version is duplicated in `Cargo.toml` and three `package.json` files.
- [ ] Stale comments in code still name iroh, tickets and editions
      (`Cargo.toml`, `build_config.yaml`, `invite_ticket.rs`, `vault.rs`).
- [ ] Undecided: per-preset setting defaults; telling a sender that a peer's build
      lacks a feature.
