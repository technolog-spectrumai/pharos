# Enigma27

An **end-to-end-encrypted group chat with file transfer, always over Tor** — a
Tauri 2 + Vue 3 app for Linux and Android. Every member of a room hosts its own
Tor onion service for it and keeps a link to every other member; all content is
encrypted with **MLS** (OpenMLS), and everything the app keeps is **encrypted at
rest** behind a passphrase.

- **Rooms** — a mesh: nobody relays for anyone, there is no host to lose. Frames
  are padded, links carry cover traffic, and the sender is sealed inside the
  ciphertext.
- **Invitations** — the only way in. *Personal* ones are sealed to a friend's
  device; *general* ones are bearer codes. They expire and can be revoked.
- **Friends** — pair two phones by scanning each other's device code and
  comparing a 12-digit check code. Share your code with friends, not publicly.
- **Beacon (optional)** — add your own Beacon server in Settings → Connections.
  Rooms you create then also leave every sealed frame in a mailbox there, so
  members who are never online together still get each other's messages, and an
  invitation can wait there for an offline inviter for up to 30 minutes.
- **Files** — downloaded from the sender's onion, checked by BLAKE3.
- **No pictures of people** — everyone's icon is the first letter of their
  nickname.

Enigma27 came from technolog-spectrumai/enigma (where it was Enigma26) and was
copied into Pharos on 2026-11-22/23; Pharos owns the code now. It is
`com.spectrumaipl.enigma27`, version 0.2.4; its icon is the letter E
(`scripts/letter_icon.py`).

## Layout

```
apps/enigma/
├── src/                   the Vue 3 front end
├── src-tauri/             the Rust core: mesh.rs (Tor), beacon.rs, files.rs, invite_*.rs, device.rs, vault.rs, lib.rs (mls_*)
├── packages/rakotis/      the room engine in TypeScript (useChatChannel, chatTransport, history)
├── scripts/               dev helpers (profile reset, build dirs), the signing tests
├── run_dev.sh  tests.sh  todo.md  technology.md
└── dromon.yaml            how it is built (one variant)
```

The shared crates are in the repo root's `crates/` (`rotor`, `gervasius`,
`protasius`, `enigmatite`); see the [root README](../../README.md).

## Getting started

```bash
./run_dev.sh                   # from the repo root: profile "default"
./run_dev.sh bob               # from the repo root: another profile
apps/enigma/run_dev.sh --dual  # two instances side by side (alice, bob)
apps/enigma/run_dev.sh --reset # start over with a fresh profile and passphrase
```

Prerequisites: Node 20+ (CI uses 22), Rust stable, and on Linux the WebKitGTK
development libraries (`libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev` and friends).
Tor starts right after unlock; a room you have just created takes 30–90 s to
be reachable by others while its onion is published.

## Build

```bash
./build.sh enigma                 # a release .deb and .rpm
./build.sh enigma --dry-run       # show the commands, run none
```

[dromon.yaml](dromon.yaml) sets debug or release, package formats, Android,
signing and tests. There are no build flags. Packages land in
`dist/enigma/enigma/`, with a `SHA256SUMS` and a `build.json`. Before anything
compiles, the build checks with `cargo tree` that Enigma links none of
OpenSSL, the DHT's `mainline` or the call equalizer's `rustfft`
([dromon/README.md](../../dromon/README.md#feature-isolation)). An Android APK:

```bash
tools/android/build_android.sh enigma debug aarch64
```

## Test

```bash
./tests.sh                   # from the repo root: every suite (js | rust)
apps/enigma/tests.sh         # Enigma's long run: vitest, Rust, signing checks, the bundle
apps/enigma/tests.sh rust    # one group (js | rust | py | build)
./test_tor2.sh               # two instances over the real Tor network
```

Every step runs even if an earlier one fails, and the run ends with a pass/fail
table.

## Removed features

When Enigma26 became Enigma27 in Pharos (2026-11-22/23): iroh, iroh-gossip and
Ferrozine (no direct P2P at all), the Tor and "Keep onion stable" switches, the
file integrity switch, legacy room tickets, the captain (star topology,
election, failover, relaying) and all moderation (room logo, rules, mute, kick
and ban). Privacy HP went on 2026-11-22. Profile photos and avatars went later
(letter icons instead). The DHT (Heliodor) was never in Enigma27. Details:
[technology.md §16](technology.md#16-history--the-serverless-rework).

Earlier removals, when Enigma lived in Belisario; the commits named are
Belisario's (restore a file with `git show <commit>:<path> > <path>`):

| Feature | Removed | Last commit that has it | Files | Instead |
|---|---|---|---|---|
| **Voice calls** (Vox), the Mainline **DHT** (room codes, nickname directory, presence), **contacts** and direct invites, the room **calendar** (meetings, polls), iroh's hosted relays and discovery, and the Pro/Standard editions | 2026-11-16 | `998d5360da06f571f5d0c21f5d012888b8e5e453` | `src-tauri/src/{vox,p2p_dht,p2p_dht_off,p2p_invite}.rs`, `src/components/{vox,calendar,contacts}/`, `src/views/Enigma{Vox,Calendar,Contacts}View.vue`, `packages/rakotis/src/services/contacts.ts`, `buildFeatures.ts`, the cargo features and their tests | Vesper |
| Files → Local **SVG drawing editor** | 2026-10-23 | `a0b6224a4fcced186b455736b8745901c27e1931` | `src/components/local/SvgEditor.vue`, its tests `tests/component/svgEditor.test.ts`; it used `packages/wisteria` | Morion's sketch editor |
| Files → Local **text/notes editor** (Ace) | 2026-10-23 | `a0b6224a4fcced186b455736b8745901c27e1931` | `src/components/local/NoteEditor.vue`, `src/components/local/aceSetup.ts`, their tests and `tests/stubs/{ace,fakeAce}.ts`; it used `ace-builds` | Morion's text and code editors |
| Files → Local **file encryption** (lock, unlock, rotate; ENIGLOCK), Files → Keys **key ring** (`.enigr`), Settings' key-rotation reminder and **Delete files on panic** | 2026-10-23 | `cf2c6c559bed487cb5daa98ca59d8c8734a0cab4` | `src/components/local/`, `src-tauri/src/local_lock.rs`, `src-tauri/src/keyring.rs`, `src-tauri/src/fs_local.rs`, the `keyring` cargo feature, protasius's panic-targets sidecar | — (files locked with Enigma can only be opened by a build of that commit) |

## Documentation

- [technology.md](technology.md) — how it works: the mesh, padding and cover
  traffic, MLS and sealed sender, Beacon mailboxes, invitations, encryption at
  rest, the UI, config, and from §19 on running, building, releasing and
  installing.
- [todo.md](todo.md) — open work here; the root [todo.md](../../todo.md)
  Stages 7–8 for the Beacon and metadata work.
- [SECURITY.md](../../SECURITY.md) — who learns what;
  [PROTOCOL.md](../../PROTOCOL.md) — the wire.
