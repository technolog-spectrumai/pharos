# Enigma27 — todo

`[x]` done, `[~]` partly done, `[ ]` not started. How things work is in
[technology.md](technology.md). The Beacon and metadata work (padding, sealed
sender, cover traffic, mailboxes, invitations through Beacon) is the root
[todo.md](../../todo.md) Stages 7–8; it is done apart from a real-Tor test run
(8.E2).

## Done

- [x] **Maps moved to Morion** (2026-10-03). A map share in an old history shows
      as a card that cannot be opened. technology.md §16.
- [x] **Into Pharos as Enigma27** (2026-11-22/23), from technolog-spectrumai/enigma
      (Enigma26); identifier `com.spectrumaipl.enigma27`, the letter E as icon.
- [x] **Always Tor, a mesh**: every member hosts an onion per room and links to
      every other; outbox, backoff, stable onions, full vanguards. technology.md §11.
- [x] **Room start fixes**: MLS starts on entering a room; sessions kept across
      reopens; no plaintext sent or shown. technology.md §4.
- [x] **Invitations over the onion**, and through Beacon when the inviter is
      offline (ticket format 2). technology.md §17, §18.
- [x] **Padding, sealed sender, cover traffic** (root 7.1, 7.2, 7.4 / 8.A, 8.D).
- [x] **Beacon mailboxes** (root 8.B, 8.C): Settings → Connections → Your Beacon.
- [x] **Friends**: device codes and 12-digit check codes; personal invitations
      picked from Friends.
- [x] **Letter icons** instead of photos and avatars; nickname in Settings.
- [x] **Tor indicator** in the app bar; one ☰ menu; room header with a ⋮ menu.

## Open

- [ ] **The reset frame.** `mls_reset_request` is plaintext and unauthenticated:
      anyone who reaches a member's onion can make it start a new group of one.
      Authenticate it inside MLS, or remove it with "Reset encryption".
      technology.md §9 item 4.
- [ ] **The MLS identity is the profile name** (`CHAT_USER`, default `default`).
      Two people who both use "default" collide in one room. Use the device id or
      a random per-profile id.
- [ ] **Links accept anyone.** An inbound link is taken on the onion its `Hello`
      claims, so whoever knows a member's onion receives that member's (sealed,
      padded) frames and can displace a member's link. technology.md §9 item 7.
- [ ] **Key verification in rooms**: bind the MLS credential to the device key.
- [ ] Real-Tor run of the Beacon paths (root 8.E2).
- [ ] Stale comments in code: `invite_ticket.rs`'s header still says
      `FORMAT_V(0x01)`; `useInviteAdmit.ts` still says "no store-and-forward";
      leftover `avatar_url` fields in rakotis messages.
- [ ] Pins in old profiles (`map:pins`) have no way out of the vault; region
      files stay on disk (`profiles/<p>/maps/*.pmtiles`). Decide if an export is
      needed.
- [ ] `WEBKIT_DISABLE_DMABUF_RENDERER=1` (`main.rs`) was for the map canvas;
      removing it wants a look on an NVIDIA / hybrid-GPU machine.
- [ ] Playwright smoke tests: check them after the move.
- [ ] Version is duplicated in `Cargo.toml` and three `package.json` files.
