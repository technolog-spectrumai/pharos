# Enigma27 — Technology Overview

> Enigma27 lives in Pharos at `apps/enigma/`. It came from technolog-spectrumai/enigma,
> branch `dev_mvp1`, where it was called Enigma26, and was copied, not vendored:
> Pharos owns the code. The shared crates are the repo root's `crates/`
> (`rotor/rotor_core`, `gervasius`, `protasius`, `enigmatite`); the build is Dromon's:
> `./build.sh enigma`, from `apps/enigma/dromon.yaml`. History is kept short in
> [§16](#16-history--the-serverless-rework).

How Enigma27 works: its design, stack, message flow, cryptography, privacy and
known weaknesses, then its conventions and config, and how to run, build, test,
release and install it. Who learns what is in the root
[SECURITY.md](../../SECURITY.md); the wire format in [PROTOCOL.md](../../PROTOCOL.md).
This document links to them rather than repeating them.

> **Status:** `v0.2.4`, early. The cryptography is OpenMLS; the open items are at the
> integration layer — see [§9](#9-security--privacy-considerations), [todo.md](todo.md)
> and the root [todo.md](../../todo.md) Stages 7–8.

Contents: [1 Design](#1-design) · [2 Stack](#2-technology-stack) ·
[3 Dependencies](#3-dependencies--libraries) · [4 Architecture & flow](#4-architecture--communication-flow) ·
[5 Routing & transport](#5-routing--transport) · [6 Is it truly P2P?](#6-is-it-truly-p2p-intermittent-nodes) ·
[7 Encryption](#7-encryption--algorithms) · [8 Privacy](#8-privacy) ·
[9 Security considerations](#9-security--privacy-considerations) · [10 UI](#10-user-interface) ·
[11 The Tor mesh and vanguards](#11-the-tor-mesh-and-vanguards) ·
[12 How Enigma keeps and encrypts messages](#12-how-enigma-keeps-and-encrypts-messages) ·
[13 Encryption at rest](#13-encryption-at-rest-gervasius--protasius) ·
[14 Conventions](#14-conventions-naming--palette) · [15 Config sources](#15-config--sources-of-truth) ·
[16 History](#16-history--the-serverless-rework) ·
[17 Beacon](#17-beacon--mailboxes-and-invitations) ·
[18 Invitations](#18-invitations--encrypted-expiring-revocable) ·
[19 Run, build, test](#19-run-build-and-test) · [20 Features and presets](#20-features-and-presets) ·
[21 Releasing](#21-releasing) · [22 Installing](#22-installing) ·
[23 App icon](#23-app-icon) · [24 Crypto audit inventory](#24-crypto-audit-inventory) ·
[Roadmap](#roadmap)

---

## 1. Design

Enigma27 is an **end-to-end-encrypted group chat that always runs over Tor**, a
[Tauri 2](https://tauri.app) app (Vue 3 front end, Rust core) for desktop and Android.

- **Always Tor, a mesh.** Every member of a room hosts its own onion service for it
  and keeps a link to every other member. Frames go straight down each link; nobody
  forwards anyone else's traffic. There is no direct connection and no Tor switch
  ([§11](#11-the-tor-mesh-and-vanguards)).
- **No server needed; one optional.** A room works on the mesh alone. If you run a
  Beacon (the `beacon/` server at the repo root), rooms you create also leave every
  frame in a mailbox there, so members who are never online at the same time still
  get each other's messages, and an invitation can wait there for an offline inviter
  ([§17](#17-beacon--mailboxes-and-invitations)).
- **In by invitation only.** Personal (sealed to a friend's device) or general
  (bearer); expiring, revocable, spent once
  ([§18](#18-invitations--encrypted-expiring-revocable)).
- **MLS for everything**, with sealed sender: the outer frame carries only the
  ciphertext ([§12](#12-how-enigma-keeps-and-encrypts-messages)). Frames are padded
  and links carry cover traffic.
- **Encrypted at rest.** Keys, MLS sessions, history, settings, rooms and Tor's state
  live in a per-profile passphrase-gated store
  ([§13](#13-encryption-at-rest-gervasius--protasius)).
- **Local identity.** No accounts and no phone number. A profile has a nickname, an
  MLS identity (`CHAT_USER`, the profile name by default) and an Ed25519 device key
  (`device.rs`). Friends are paired by scanning each other's device code (§10).
- **No pictures of people.** Everyone's icon is the first letter of their nickname.

### Layered architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  apps/enigma/src  (Vue 3: Chat · Files · Friends · Settings;       │
│                    Tor indicator; unlock gate; beaconMailbox.ts)   │
├──────────────────────────────────────────────────────────────────┤
│  packages/rakotis (TS)                                             │
│   • useChatChannel — MLS envelope state machine, mailbox reads     │
│   • chatTransport  — bridge to the Rust mesh (realtime_* / events) │
│   • crypto         — bridge to the mls_* Tauri commands            │
│   • services       — appStorage, localDb (kv), chatLog, i18n       │
├──────────────────────────────────────────────────────────────────┤
│  Tauri IPC  (invoke commands + realtime://* file://* invite://* …) │
├──────────────────────────────────────────────────────────────────┤
│  apps/enigma/src-tauri  (Rust)                                     │
│   • mesh.rs       — onions, links, outbox, padding, cover (§11)    │
│   • beacon.rs     — Beacon client, one circuit per request (§17)   │
│   • invite_*.rs   — tickets, live redemption, via Beacon (§18)     │
│   • device.rs     — the device key (Ed25519)                       │
│   • files.rs      — downloads over the sender's onion              │
│   • vault.rs      — protasius integration (§13)                    │
│   • lib.rs        — mls_* (incl. mls_mailbox), profiles, config    │
├───────────────┬───────────────────┬──────────────────────────────┤
│ rotor_core    │ protasius         │ arti 0.43 (embedded Tor,      │
│ (OpenMLS),    │ gervasius         │ onion services, full          │
│ enigmatite    │                   │ vanguards)                    │
└───────────────┴───────────────────┴──────────────────────────────┘
```

Nearly all chat logic lives in **rakotis** (aliased to source in `vite.config.ts`).
Crypto is delegated to the Rust `mls_*` commands — never reimplemented in TypeScript.

---

## 2. Technology stack

| Layer | Technology |
|---|---|
| UI | Vue 3 (`<script setup>`), Pinia, Tailwind CSS v4, Font Awesome |
| Shell | Tauri 2 (Linux desktop, Android) |
| Languages | TypeScript (Vite), Rust 2021 with Tokio |
| Transport | arti 0.43 embedded: a mesh of onion services, one per member per room, full vanguards ([§11](#11-the-tor-mesh-and-vanguards)); optionally a Beacon mailbox over its onion ([§17](#17-beacon--mailboxes-and-invitations)) |
| Content crypto | OpenMLS 0.7 via `rotor_core`; sessions per (room, identity) in `enigmatite` |
| At rest | `gervasius` (Argon2id → wrapped DEK → XChaCha20-Poly1305) + `protasius` (encrypted fjall store) |
| Media | cpal + hound for voice notes |
| Build config | `src-tauri/build_config.yaml` → build.rs codegen ([§15](#15-config--sources-of-truth)) |
| Build | `./build.sh enigma` ([dromon.yaml](dromon.yaml)); Android `tools/android/build_android.sh enigma debug aarch64` |

Crate `enigma` → `enigma_lib`. Identifier `com.spectrumaipl.enigma27`. Desktop bundle
targets `["deb", "rpm"]`.

---

## 3. Dependencies & libraries

Versions are the declared spec; resolved pins are in the root `Cargo.lock`.

### Rust backend (`apps/enigma/src-tauri/Cargo.toml`)

| Crate | Ver | Role |
|---|---|---|
| `tauri` (+ opener, dialog, notification, deep-link plugins) | 2 | App framework, IPC |
| `rotor-core`, `enigmatite`, `protasius`, `gervasius` | path | MLS, sessions, encrypted store, at-rest primitives and sealing |
| `arti-client` | 0.43 | Embedded Tor: host and dial onions, `vanguards`, discovery keys for a restricted Beacon |
| `tor-guardmgr`, `tor-config`, `tor-hsservice`, `tor-cell`, `tor-rtcompat`, `safelog` | 0.43 | Vanguard mode, onion-service hosting |
| `ed25519-dalek` | 3 | The device key |
| `postcard` | 1 | Invitations, archives of arti's state |
| `blake3` | 1 | Room slug and onion nickname, file hash, download commitment, redemption proof |
| `data-encoding` | 2 | Base32 invitation text |
| `chacha20poly1305` | 0.10 | `OsRng`; sealing invitation drops at Beacon |
| `cpal`, `hound` | — | Voice notes |
| `zeroize`, `serde`, `tokio`, `anyhow`, `uuid` | — | Plumbing |

### Crypto crates (`crates/`)

- **`rotor/rotor_core`** — `RotorSession` on `openmls =0.7.4`; exports the ciphersuite
  for the build-config assert.
- **`gervasius`** — Argon2id, XChaCha20-Poly1305, sealing to an X25519 key.
- **`protasius`** — the encrypted store (`fjall` 2).
- **`enigmatite`** — `mls` (one session per (room, identity), saved after every step)
  and `admission` (unused by Enigma27's own rooms).

### Frontend

`vue` 3.5, `vue-router` (memory history), `pinia`, `vue-i18n` (en/pl), `tailwindcss` 4,
`@fortawesome/*`, `@tauri-apps/api` 2, `qrcode`, `html5-qrcode`, `nanoid`, and the
in-repo `rakotis` and `petalite` packages.

---

## 4. Architecture & communication flow

### The seams

- **Commands (`invoke`):** `realtime_*` (the mesh), `mls_*` (crypto, including
  `mls_mailbox`), `beacon_*` (`beacon_post`, `beacon_fetch`, `beacon_discovery_key`,
  `beacon_parse_code`), `invite_*`, `file_*`, `app_*`, `vault_*`, `kv_*`, `audio_*`,
  `tor_status`, `tor_clean_keystore`.
- **Events (`listen`):** `realtime://message` `{room, payload}`, `realtime://status`
  `{room, state, peers, linked, peer_id}` (`connected` / `waiting` / `disconnected`),
  Tor's own state for the app-bar indicator, `file://progress|done|error`,
  `invite://admit`, `vault://locked`.

### Sending a message

```
ChatPanel.send(text)
  → useChatChannel.sendMessage(text)
      needs MLS ready; inner = {type:"text", text, msg_id, from:{id, name}}
      mls_encrypt(inner) → {type:"mls_app", ciphertext}
      not ready → "Encryption not ready yet", nothing is sent
  → chatTransport.send → realtime_send
      → mesh: pad the frame; write down every live link; queue in the outbox of
        every wanted member without one (256 frames each)
  → if the room has a Beacon: beaconMailbox.ts posts the same sealed frame to the
    room's mailbox (beacon_post, a fresh circuit)
```

### Receiving

```
mesh link reader (drops {"type":"cover"})  ─┐
Beacon mailbox read (Poisson-timed)        ─┴→ useChatChannel.handleMessage
    second copy of a frame (mesh + Beacon) → dropped via the mailbox "seen" list
    mls_app            → mls_process_message → inner {type, msg_id, from, …}
    mls_welcome / mls_commit → MLS handshake
    mls_key_package    → ignored (invitation only)
    mls_reset_request  → rebuild the group (§9 item 4)
    anything else      → ignored; nothing in the clear is shown
```

### The MLS envelope state machine

`idle → initializing → key_exchange → ready → error`.

1. **MLS starts on entering a room.** A room this device is in comes back from its
   saved session and is `ready` at once.
2. **A new room** is an encrypted group of one at once.
3. **A joiner** gets in only by redeeming an invitation: the inviter adds its key
   package, sends the commit to the room and returns the Welcome
   ([§18](#18-invitations--encrypted-expiring-revocable)).
4. **Sessions are kept** across reopens and restarts (sealed in ns `mls`). A member who
   leaves is removed by the remaining member with the smallest MLS identity.
5. **Reset encryption** (⋮ menu, or a `mls_reset_request` frame) starts a new group
   of one — see [§9](#9-security--privacy-considerations) item 4.

### Persistence ([§13](#13-encryption-at-rest-gervasius--protasius))

- MLS state → ns `mls`; device key → `keys\0device_ed25519`; arti's state →
  `keys\0tor_keystore`.
- Saved rooms → kv `p2p:rooms`: `{room, name, peers[], onion?, beacon?}`.
- History → kv `chat:log`, capped by `chat_history_cap_msgs` (500).
- Settings → kv `p2p:settings`; your Beacon and your friends list in the sealed kv.
- Invitations → ns `invites` (internal tier, not writable from the webview).
- The only plaintext file is `vault.json` (salt + wrapped DEK).

---

## 5. Routing & transport

The mesh is in `mesh.rs` ([§11](#11-the-tor-mesh-and-vanguards)); the optional second
route is the room's Beacon mailbox ([§17](#17-beacon--mailboxes-and-invitations)).

- **One arti client per profile**, started right after unlock.
- **A room** is identified by its slug, BLAKE3(name) in hex; its onion key is kept
  under `enigma_<first 16 hex of BLAKE3(name)>`, so the address is stable.
- **Frame size.** 4-byte LE length + JSON, at most `network.max_frame_bytes`
  (16 MiB), padded (§11). An image or voice note rides whole in one MLS message.
- **Connect timeout.** `connect_timeout_secs` (Settings, default 60 s) bounds joining
  and the inviter's wait for the MLS add. Never hardcode a connect deadline
  ([§15](#15-config--sources-of-truth)).
- **Airplane mode.** A per-profile flag makes every network command refuse. App-level,
  not an OS firewall.

### File transfer — over the sender's onion, verified

`files.rs`. Offer and answer travel inside MLS; only the bytes use a Tor stream.

```
sender   file_offer_create → { offerId, addr (our onion), name, size, mime } inside MLS
receiver file_prepare → a 32-byte secret kept in Rust; commitment = BLAKE3(secret)
         → file_accept{offerId, commitment} inside MLS
sender   file_authorize(offerId, commitment)
receiver file_download: dial the onion with Hello{kind:"file"}, send {offer_id, secret};
         the sender checks it, clears it (one download), sends {size, hash} and the bytes
receiver keeps the file only if size and BLAKE3 match
```

Only the member who accepted can download, and only once. The read buffer is the
user's file chunk size (default 256 KiB).

---

## 6. Is it truly P2P? (intermittent nodes)

Content goes from the sender's device to each other member's onion, over Tor; no
member forwards anyone else's traffic. Enigma27 needs no server of its own — Tor's
directory authorities and relays are the only required infrastructure.

On the mesh alone, a member who is offline has no link; frames for it wait in the
sender's outbox while the sender's app runs. Two members who are never online at the
same time do not reach each other that way. A room with a Beacon closes that gap:
every frame is also left in the room's mailbox for 14 days, and a member who comes
back reads it from there ([§17](#17-beacon--mailboxes-and-invitations)). Beacon holds
only sealed frames; it is a mailbox, not a member.

Start-up costs: arti bootstraps in seconds to a minute, and a fresh onion takes
30–90 s to become reachable. A room of N members has N(N−1)/2 links — for small rooms.

---

## 7. Encryption & algorithms

### The MLS engine (`rotor_core`)

Ciphersuite **`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`** (RFC 9420 `0x0001`):
DHKEM(X25519, HKDF-SHA256), AES-128-GCM, HKDF-SHA256, SHA-256, Ed25519. Declared and
compile-asserted in `build_config.yaml`.

- **Wire format:** pure ciphertext — handshake and application messages are MLS
  `PrivateMessage`. The ratchet tree rides in the Welcome.
- **Credentials:** `BasicCredential` with the identity string (the profile name),
  signed by a local Ed25519 key. Self-asserted, no PKI.
- **Storage:** OpenMLS `MemoryStorage`, sealed into protasius by `enigmatite` after
  each operation.
- **Exporter:** `mls_mailbox` derives a room's Beacon mailbox id and token from the
  current epoch's exporter secret and the week number (§17).

API (→ `mls_*`): `create_group` / `key_package` / `add_member` / `join_from_welcome` /
`adopt_session` / `process_message` / `encrypt_app` / `members` / `remove_member` /
`export_secret` / `export_state` + `import_state`.

### What is encrypted

- **Everything a member says**: text, images (downscaled to ≤1600 px JPEG), voice
  notes, presence (with the member's onion and the room's Beacon), leave, room
  closed, file offers and answers — inner JSON inside an `mls_app` frame, with the
  sender (`from: {id, name}`) and `msg_id` inside too.
- **Files** — not MLS: Tor's onion encryption, gated by a secret committed over MLS,
  checked by BLAKE3 (§5).
- **Invitation drops at Beacon** — XChaCha20-Poly1305 under keys from the
  invitation's capability (§17).
- **PIN unlock** — a convenience layer, never an at-rest secret: a copy of the
  passphrase sealed under a PIN-derived key held in **process memory only**
  (`vault.rs`). Nothing PIN-derived reaches disk; five wrong PINs drop it. A panic
  PIN must differ in ≥ 2 digits.
- **Everything at rest** — §13.

On the wire, outside the ciphertext: the frame's `type` (`mls_app`, the handshake
types, `cover`) and its padded size and timing.

### Security properties

- **Forward secrecy** within an epoch through MLS's secret tree.
- **Post-compromise security is limited:** epochs advance only on add/remove; there is
  no periodic self-update.

---

## 8. Privacy

| Aspect | Posture |
|---|---|
| Message content | End-to-end encrypted (MLS), sender inside the ciphertext |
| Your IP | Never shown. Always Tor; members and Beacon see onions only |
| Accounts | None |
| Identity | Local profile; MLS identity = profile name; a device key; an onion per room |
| What members learn | Each other's onions for the room, nicknames, MLS identities, the inviter's device id, the room's Beacon |
| What Beacon learns | That an onion client posts and reads opaque frames; not who, which room or what. See root SECURITY.md |
| Invitation QR | No room name, no MLS material: the inviter's device id and onion, the room's Beacon (if any), an id, a capability, a deadline. Personal ones are sealed to the recipient |
| Device code | Your device id and nickname. Not a secret, but it lets someone seal invitations to you and ties your nickname to your device: share it with friends, not publicly |
| Pictures | None of people: icons are letters (§10) |
| Location | Never read or sent (`tests/e2e/noGeolocation.spec.ts`) |
| Metadata | Always Tor, full vanguards, padding, cover traffic, Poisson-timed mailbox reads with dummy reads |

**At rest.** Everything is sealed in the per-profile vault. Plaintext exceptions:
`vault.json`; arti's directory cache (public); arti's state directory while the app
runs (sealed back on lock/exit; a crash leaves it until the next clean stop); in an
old profile that used maps, the region blobs. No passphrase recovery. Two deliberate
resets: Settings → Data → "Clear all data", and the panic code, which unlocks like an
ordinary passphrase and wipes every profile.

---

## 9. Security & privacy considerations

Integration-level weaknesses, roughly most- to least-serious. Item numbers are
referenced from code; resolved items stay, struck through.

1. ~~**Plaintext local storage.**~~ Resolved (§13). Residual: arti's state after a
   crash; best-effort wipes.
2. **No key verification of room members.** The MLS credential is a self-asserted
   string, and there is no safety number inside a room. Friends compare a 12-digit
   check code when pairing, and invitations bind the redeemer to a device key, but
   the MLS credential is not bound to the device key yet.
3. **Advisory group management.** Who removes a leaver and who may add are app
   convention; OpenMLS here lets any member commit.
4. **Unauthenticated reset frame.** `mls_reset_request` is plaintext. Anyone who can
   reach a member's onion can send one, and that member starts a new group of one it
   cannot leave without a new invitation. → *Authenticate it inside MLS or remove it.*
5. ~~**Pre-MLS plaintext window.**~~ Resolved: sending needs MLS `ready`; nothing in
   the clear is shown. The sender's name is now inside the ciphertext, but it is still
   self-chosen, not verified.
6. **Metadata on the network path.** ~~No padding, sender fields in the clear, no
   cover traffic.~~ Resolved (§11, §12). What remains: someone linked to you sees that
   frames arrive and roughly how large; cover traffic hides when you are quiet, not
   bursts; Beacon sees post volume and times (see SECURITY.md).
7. **Links accept anyone.** Member onions are not restricted: anyone who knows a
   member's onion for a room can open a link, claim an onion in `Hello`, receive that
   member's (encrypted, padded) frames and displace the real member's link. MLS keeps
   the content shut. Restricted discovery exists only for Beacon (§17).
8. **WebView / IPC surface.** `security.csp = null`; on Linux every WebView
   permission request is granted. → *Add a CSP and gate permissions.*
9. ~~**Clearnet TLS.**~~ Gone. The one HTTP client is `beacon.rs`, plain HTTP/1.1
   inside an onion stream (Tor authenticates and encrypts); there is no clearnet path.
10. **Minor:** `openmls_rust_crypto` built with `test-utils`; 16 MiB frames; the outbox
    drops the oldest frame beyond 256.

---

## 10. User interface

Behind the **unlock gate** (`App.vue`: passphrase on first run, unlock every launch).

- **App bar:** the E mark (→ Welcome), the **Tor indicator** (`TorIndicator.vue`,
  `stores/tor.ts`, from `tor_status`: off / starting / on / error), and one **☰ menu**
  with New chat, Join chat, Friends, Settings and the other views as ordinary items.
- **Chat** (`EnigmaChatView`, `ChatPanel`) — rooms sidebar and conversation, a drawer
  on mobile. The **room header** has the name, one line of state (encryption · linked
  count · *Direct* / *Via Beacon* / *Beacon unreachable*), an **Invite** button and a
  **⋮ menu**: Participants (`ParticipantsModal`, each Linked or Away), Room info,
  Reset encryption, Leave, Delete room. Messages are Signal-style bubbles
  (`ChatBubble.vue`); the composer takes text, images, voice notes and emoji.
- **Letter icons.** Nobody has a photo or avatar. Everyone's icon is the first letter
  of their nickname drawn as SVG (`avatarIcon.ts`, `LetterAvatar.vue`); the nickname
  is set in Settings.
- **Friends** (☰ → Friends, `EnigmaFriendsView.vue`, `stores/friends.ts`) — pair two
  phones by each scanning the other's **device code**,
  `enigma27-friend:1:<device id>:<base64url nickname>`, then compare the **12-digit
  check code** both compute from the two device ids. The screen says not to post your
  device code publicly. A personal invitation is made by picking a friend.
- **Invitations** (`RoomShareCard`) — personal (sealed to a friend) or general
  (bearer, marked "not secret"), with a QR and text.
- **Files** (`EnigmaFilesView`) — offers and downloads with progress.
- **Settings** (`EnigmaConfigView`) — Profile (nickname), Settings (language, tabs,
  file limits), **Connections** (Tor always on; connect timeout; **Your Beacon**,
  `BeaconCard.vue`), Lock (auto-lock, PIN, panic code), Data (airplane mode,
  profiles, clear data).
- **Welcome** (`EnigmaWelcomeView`) — what the app is and who you are on it.

Styling: Tailwind v4 with the in-repo primitives (`packages/petalite`, `Oya*`); tokens
in §14.

---

## 11. The Tor mesh and vanguards

*(The design is the header comment of `src-tauri/src/mesh.rs`; the wire is
[PROTOCOL.md](../../PROTOCOL.md).)*

**Every member hosts, every member links.** For each open room every member hosts an
onion and keeps one link to every other member it knows. There is no host, no
relaying member and nothing to elect.

**Who knows whom.** A joiner starts with the onions in the redemption answer. After
that every member announces its onion (and the room's Beacon) in the encrypted
`presence` message; the frontend hands the list to `realtime_set_peers`, and Rust
dials every wanted member it has no link to, with backoff **5 s doubling to 120 s**.
The list is saved per room.

**One link per pair.** When both ends dial at once, both keep the link dialled by the
**smaller onion** address, so they agree without talking.

**The outbox.** Frames for a wanted member with no link wait in a per-member outbox
(**256 frames**, oldest dropped first) and go out in order when the link comes up. It
lives in memory.

**Status.** `connected` (at least one member linked, with the list), `waiting`,
`disconnected`.

**Other streams on the same onion.** `Hello.kind`: absent/`room` a member's link,
`redeem` an invitation redemption, `file` a download.

### Padding

Every frame is padded with trailing spaces (which JSON ignores) to **512 B, 2 KiB,
8 KiB, or a whole multiple of 32 KiB** (`mesh::padded_len`), so its size says little
about what it carries.

### Cover traffic

While a room is open, each link gets a padded dummy `{"type":"cover"}` in any slot of
**30 s (90 s on Android)**, ±20 % jitter, in which no real frame went out. The reader
drops it. Dummies are not posted to Beacon; Beacon gets dummy reads instead (§17).

### Stable onions and start-up

arti's state directory (keystore, guards, vanguard sets) is kept per profile: sealed
into the vault on lock/exit, restored before arti starts. So onions, guards and
vanguards are stable. Deleting a room forgets its onion key; Clear data forgets all.
Tor starts right after unlock; a fresh onion takes 30–90 s to be reachable.

### Vanguards

A long-lived hosted onion is what guard-discovery attacks go after. Vanguards fix the
second and third hops to small sets — **4 L2 relays kept 1–12 days, 8 L3 relays kept
1–48 hours** — so an attacker's relay sees a vanguard, not your guard. `mesh.rs` sets
**full** vanguards (`VanguardMode::Full`) explicitly, since arti 0.43 does not choose
it for onion services by itself. They narrow guard discovery; they do not hide you
from your guard or a global observer.

### Mechanics

`Hello{name, peer_id, kind?, onion?}` → `Ready{ok}`. Writes bounded by
`tor_write_timeout_secs` (20 s), the handshake read by `tor_handshake_timeout_secs`
(30 s). Port `network.onion_port` (9999) for every member.

**Known limitations:** links are not authenticated below MLS (§9 item 7); a full mesh
is for small rooms.

---

## 12. How Enigma keeps and encrypts messages

**On the wire.** `len: u32 LE ‖ JSON`, padded, on a Tor stream between two members.

**Sealed sender.** The outer frame of a message is only

```json
{"type":"mls_app","ciphertext":"<base64 MLS PrivateMessage>"}
```

and inside the ciphertext is `{type, msg_id, from:{id, name}, …}` — `type` being
`text`, `image_message`, `voice_message`, `presence`, `file_offer`, and so on. Who
sent it, under what name, and its id are visible only to members. Duplicates (the
same frame by mesh and by Beacon) are dropped before MLS by the mailbox "seen" list.

**What a linked observer still sees:** the outer `type`, the padded size bucket, and
timing beyond what cover traffic hides. Tor relays see only cells.

**At rest.** One protasius store per profile: history in sealed `chat:log` segments
(500 messages by default, 50–5000), MLS state per (room, identity), the room list with
members' onions and Beacon, and arti's state.

---

## 13. Encryption at rest (gervasius + protasius)

**Model.** `passphrase --Argon2id--> UKEK --wraps--> random 32-byte DEK
--XChaCha20-Poly1305--> data`. A passphrase change re-wraps only the DEK. A wrong
passphrase fails on the wrapped DEK's tag. Keys live in memory and are zeroized on
lock/exit. No recovery.

- **gervasius:** Argon2id v1.3 (default 64 MiB / t=3 / p=4, recorded per vault),
  XChaCha20-Poly1305 with a random 24-byte nonce, the vault envelope, sealing to an
  X25519 key.
- **protasius:** one fjall keyspace per profile, keys plaintext, values sealed; a tier
  tag byte (`TAG_INTERNAL 0x01`, `TAG_KV 0x02`); AAD `"protasius:v1:" ‖ key`. Header in
  `vault.json`. Lifecycle `setup` / `unlock` / `lock` / `change_passphrase` / `wipe`.
- **App integration:** `vault_*` commands and a `require_unlocked` gate. Lock and
  profile switch stop the mesh first (so arti's state seals into the right profile),
  re-open protasius locked, and reload the webview. Unlock starts Tor again.
- **arti's state:** archived, sealed into `keys/tor_keystore`, wiped on stop — only
  after a successful seal.
- **Left behind in old profiles:** files sealed as `ENIGLOCK` / `.enigr` (per-file
  locking removed 2026-10-23), the map region list, pins and blobs (maps moved to
  Morion 2026-10-03), and a sealed `hp` namespace (Privacy HP, removed). Nothing reads
  them; Clear data removes them.

---

## 14. Conventions (naming & palette)

### Naming

**Vue components.**

- Reusable primitives live in `packages/rakotis/src/components/primitives/` with the
  **`Oya`** prefix, PascalCase (`OyaButton`, `OyaModal`, `OyaTextField` … zero exceptions).
- App components are PascalCase, **no** prefix, grouped by feature folder
  (`components/chat/`), and carry a type suffix: `*Modal`, `*Chip`, `*Panel`, `*Bar`,
  `*Row`, `*Sidebar`, `*Drawer`, `*List`.
- Route views are `Enigma<Domain>View` (`EnigmaChatView`, `EnigmaFilesView`,
  `EnigmaConfigView`, `EnigmaProfileView`, …). Stores are
  lowercase domain files (`chat.ts`, `user.ts`). Composables are
  `useXxx` camelCase.

**Tauri commands.** `snake_case`, `<domain>_<verb>` families — `app_*`, `vault_*`,
`kv_*`, `mls_*`, `realtime_*`, `audio_*`, `tor_*`, `file_*`,
`invite_*`. All registered in the single
`generate_handler!` block in `apps/enigma/src-tauri/src/lib.rs`. (Two legacy getters,
`current_profile`/`current_identity`, predate the prefix rule — leave or migrate to
`app_*`, don't add new prefix-less commands.)

**Events.** `scheme://path` naming: `realtime://message` and `realtime://status`
(a single event multiplexes all rooms, the payload carries the room id), plus
`file://progress|done|error`, `invite://admit`, and
`vault://locked` (emitted when the watchdog re-locks the vault).

**i18n keys.** Two levels: `namespace.camelCaseLeaf` (`chat.newChat`, `vault.wrongPass`).
Namespaces: `nav`, `common`, `keys`, `lang`, `network`, `config`, `chat`,
`files`, `sketch`, `local`, `fileShare`, `invite`,
`profile`, `vault`, `welcome`. Interpolation uses single-brace named tokens
(`{n}`). English and Polish live in
[`apps/enigma/src/i18n/`](apps/enigma/src/i18n/) and are the **only** catalogs;
documentation is not translated.

`chat.sys.*` is a namespace of its own for the system notices the chat channel
pushes into the transcript ("🔒 End-to-end encryption active.", "Disconnected.",
"Connected to {room}."). These are emitted from **rakotis**, which
[`packages/rakotis/src/i18n/index.ts`](packages/rakotis/src/i18n/index.ts) says
must carry no app strings — so they reach a catalog through an injected
translator, [`i18n/chatText.ts`](packages/rakotis/src/i18n/chatText.ts), registered
by the app in `main.ts`:

```ts
sysMsg("chat.sys.joined", 'Joined "{name}". Connecting to peers…', { name })
```

The English **fallback stays at the call site**, which is a deliberate softening of
that rule and the reason the seam is shaped this way. A *catalog* in rakotis would
be the drift hazard the rule exists to prevent; one fallback beside its key is not,
and it means an unregistered translator — a headless channel, a unit test, a boot
that failed before `main.ts` ran — degrades to today's English instead of rendering
a raw key at somebody mid-call.

**Dates, times and numbers** go through
[`i18n/dateFormat.ts`](packages/rakotis/src/i18n/dateFormat.ts) — `formatDate`,
`formatTime`, `formatNumber`, `formatBytes` — never `toLocaleDateString` directly.
The reason is that `toLocaleDateString(undefined, …)` reads the **operating
system's** locale, not the app's, so a user who chose Polski still read
"August 2026" in a date header if their OS was English. The formatters read
`currentLocale`, a ref the i18n factory keeps in step with `i18n.global.locale`;
being a ref is what makes a rendered date re-render on a language switch, so a date
formatted in a `computed` or a template updates with everything else. Format one
outside a tracked scope — a plain array built in `setup` — and it will not.

The module holds **no month or weekday names**. Polish declines them: nominative
standing alone, genitive beside a day number, and Intl gets both right on its own
(`{ month: "long", year: "numeric" }` → "sierpień 2026";
`{ day: "numeric", month: "long", … }` → "24 **sierpnia** 2026"). A hand-written
table would have to encode that grammar and would be wrong in one of the two cases.
For the same reason no stylesheet may `capitalize` a formatted date: Polish writes
month and weekday names in lower case, and English arrives capitalised already.

The `DateStyle` union is a **closed set** rather than free-form options, so two
surfaces showing the same kind of date cannot drift apart, and so the coverage test
can tell a formatted date from a hand-rolled one.

**Plurals.** Polish has three forms where English has two, chosen by the last two
digits (1 uczestnik · 2–4 uczestnicy · 5+ uczestników, with 12–14 taking the third
despite their last digit). vue-i18n's default rule is English, so `createAppI18n`
registers a `pl` rule; without it a Polish catalog can only ever offer two forms and
the middle one is unreachable. Counts must be passed **positionally** —
`t("chat.participantCount", n)`, not `{ n }` — since a named param interpolates the
number but never selects a form. That mistake read "1 days" in English too.

Two tests guard this, and they cover different failures.
[`i18n.test.ts`](apps/enigma/tests/unit/i18n.test.ts) checks en/pl define the same
keys; it cannot see a string that never became a key at all, which is how ~41 of
them accumulated. [`i18nCoverage.test.ts`](apps/enigma/tests/unit/i18nCoverage.test.ts)
closes that: it reads `.vue` and `useChatChannel.ts` as text and fails on bare
English in `placeholder=`/`label=`/`alt=`/`title=`/`aria-label=`, in `{{ … }}`
interpolations, in strings computed inside `<script setup>` (the gap that let the
composer's placeholder chain through), in `systemMsg(…)`, and on any raw
`toLocale*String` call. `alt` and `aria-label` are in scope on
purpose — a Polish screen-reader user is still a Polish user. Its allowlist
(protocol and product names: `Tor`, `Enigma27`, `MLS`, `QR`) requires a
reason per entry, so it stays a record rather than a dumping ground.

**protasius storage.** Versioned AAD prefix `protasius:v1:` binds every sealed value;
keyspace tiers are separated by a leading tag byte (`TAG_INTERNAL = 0x01`,
`TAG_KV = 0x02`) with `\0`-separated segments. A new keyspace tier claims a **new tag
byte**; a key-layout change bumps the AAD to `protasius:v2:`.

### Colour palette / design tokens

Tailwind v4 is **CSS-first**: the palette lives in the `@theme` block of
[`apps/enigma/src/style.css`](apps/enigma/src/style.css) as `--color-<role>-<light|dark>`
tokens, consumed as `text-<role>-light dark:text-<role>-dark` (class-based dark mode,
`.dark` on `<html>`). This CSS block is the **single source of truth** — do not define
colours in JS. Rakotis component source is `@source`-scanned so its utilities generate.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `primary-bg` | `#f2f3f5` | `#0a0c11` | Page / primary surface |
| `text-main` | `#0f1114` | `#d3d7e0` | Primary body text (most-used foreground) |
| `header-bg` | `#1d2333` | `#0f1420` | Top bar (== `footer-bg`) |
| `footer-bg` | `#1d2333` | `#0f1420` | Footer (== `header-bg`) |
| `appbar-bg` | `#252c3e` | `#151b29` | Secondary chrome |
| `appbar-text` | `#e4e7ef` | `#cfd4df` | Text on appbar (== `footer-text`) |
| `footer-text` | `#e4e7ef` | `#cfd4df` | Footer text (== `appbar-text`) |
| `bubble-bg` | `#e8e9ec` | `#191f2d` | Chat message bubble |
| `sunken` | `#e1e2e5` | `#141821` | Inset / recessed surface (inputs, wells) |
| `accent` | `#2f3d63` | `#4f5fa1` | Primary accent (indigo/navy) |
| `warn` | `#d94a4a` | `#ff4455` | Warning / error / destructive (red) |
| `success` | `#4a8f7a` | `#5fa38c` | Success / positive (teal-green) |
| `link` | `#2a4b8f` | `#5f7fc9` | Hyperlink (blue) |
| `accent-1` | `#4f5fa1` (both) | | Mode-independent accent end (== `accent-dark`) |
| `accent-2` | `#2f3d63` (both) | | Mode-independent accent end (== `accent-light`) |
| `highlight` | `#facc15` (both) | | Room-creator marker / "attention" (MLS key-exchange) |

**Typeface:** Orbitron, via `--font-sans` (currently CDN-loaded from Google Fonts —
see the centralization roadmap below for the offline-resilience note).

**Rules.**
- Never use a raw Tailwind palette utility (`text-yellow-400`, `bg-red-500`, …) or a
  literal hex for a *thematic* colour — add/point to a token. The gold marker is
  `text-highlight`; the recording/destructive red is `warn`.
- Functional black/white is fine where it's **not** theming: QR codes need true
  black-on-white to scan; toggle knobs are conventionally white.
- Native `<select>/<option>` (can't take Tailwind reliably, needs `color-scheme`) may
  use scoped CSS, but must read `var(--color-*)`, not re-hardcoded hexes.

Known un-tokenized bits worth folding in later: the modal/drawer scrims
(`bg-black/70` vs `bg-black/40` — inconsistent opacity, candidate `--color-scrim`) and
the copy-pasted `text-white border-white/20` modal buttons (candidate rakotis
primitive).

---

## 15. Config — sources of truth

**Build config (compile-time):**
[`apps/enigma/src-tauri/build_config.yaml`](apps/enigma/src-tauri/build_config.yaml)
— baked into the binary by `build.rs` (codegen → `enigma_lib::build_config` consts;
invalid file = build error — see [§19](#19-run-build-and-test)). The same for every
build, and limited to what rarely changes: crypto declarations
(compile-asserted against rotor_core/gervasius) + Argon2id costs for new
vaults, network constants (frame cap, onion port, timeouts), and defaults **and
clamp bounds** of the kv-backed settings. The frontend fetches the relevant subset once at boot via
`app_get_build_config` (rakotis `initBuildConfig`/`getBuildConfig`; `main.ts`
seeds the browser-mode fallback from `config/app.ts` and the build-time feature
literals).

**Build features (compile-time):** none — one edition
([§20](#20-features-and-presets)).

**Who owns what — one authoritative source each.** Nothing below is stated
twice; where a value must be known in two places it is *read* from its owner,
and a test or the build fails if a copy drifts.

| What | Owner | Who reads it |
|---|---|---|
| App name, identifier, version | `tauri.conf.json` | `build.rs` (→ `build_config::app`), the bundler, the dev runner |
| Debug/release, package formats, Android, tests, forbidden crates | [dromon.yaml](dromon.yaml) (one variant, `default`) | `./build.sh enigma`, `./run_dev.sh enigma`, `./tests.sh enigma` |
| Crypto parameters, protocol constants, setting defaults and bounds | `build_config.yaml` | `build.rs` → every Rust module; the frontend through `app_get_build_config` |
| The value of a setting at run time | the profile's encrypted store (kv `p2p:settings`) | Rust and the frontend, clamped to the bounds above |

Precedence follows from that: `dromon.yaml` cannot touch crypto, protocol
constants or setting bounds, and a user's stored setting wins over a default but
never over a bound. There are no opt-in toggles left: Tor is always on, onions
are always stable, files are always verified.

App name and identifier are fixed to `Enigma27` / `com.spectrumaipl.enigma27`;
`build.rs` rejects a `tauri.conf.json` that says otherwise.

**Frontend app config:** [`apps/enigma/src/config/app.ts`](apps/enigma/src/config/app.ts)
— brand identity, UI policy, dev port. Import `brand` / `policy` / `dev` from here
instead of hardcoding.

| Value | Canonical home | Notes / mirrors |
| --- | --- | --- |
| Display name `Enigma27` | `config/app.ts` `brand.name` | Also `tauri.conf.json` `productName` + window `title` |
| Copyright / org / legal URL | `config/app.ts` `brand` | Was hardcoded in `App.vue` |
| Bundle identifier | `tauri.conf.json` `identifier` | Mirror `brand.bundleId` and Android `applicationId` (`com.spectrumaipl.enigma27`); `build.rs` rejects any other value |
| App icon | `apps/enigma/app-icon.png` | **Fixed, not a build choice** — one mark; the sizes generated from it are committed. See [§23](#23-app-icon) |
| In-app branding images | `apps/enigma/src/assets/<logoDir>/` (`logoDir` in `apps/enigma/package.json`, currently `enigma27`) | `app_icon.png` (large — the unlock/welcome gate) and `bar_icon.png` (small — the top bar) |
| Passphrase min length | `config/app.ts` `policy.passphraseMinLen` | **UI-only** today — see the roadmap note below |
| Profile field caps | `config/app.ts` `policy.*MaxLen` | `displayNameMaxLen` 150, `profileNameMaxLen` 80 |
| P2P connection timeout | kv `p2p:settings` / `connect_timeout_secs` (rakotis `appStorage.getConnectTimeoutSecs`) | **User-set in Settings**; default + clamp (60 s, 5–600) come from `build_config.yaml` `settings:`. Governs create/join give-up + the join window's read countdown (window ≤ 2×N) — never hardcode a connect deadline. Rust reads the same key (`net_settings::connect_timeout_secs`) |
| Chat history cap | kv `p2p:settings` / `chat_history_cap_msgs` (rakotis `appStorage.getChatHistoryCapMsgs`) | **User-tunable**; default 500 msgs clamped 50–5000 from `build_config.yaml`. Bounds the sealed per-room `chat:log` kv (oldest segment pruned past it) — the store that lets a room's timeline survive a restart |
| Release version `0.2.4` | `tauri.conf.json` `version` | The owner (drives bundle filenames; `build.rs` reads it into `build_config::app::VERSION`). Still hand-duplicated in `Cargo.toml` and the three `package.json` files. Bumped **with the code**, never chosen per build |
| Dev port `1420` | `vite.config.ts` `server.port` | Mirrored in `tauri.conf.json` `devUrl` (which `scripts/tauri-dev-server.mjs` and `run_dev.sh --dual` read) and `dev.vitePort` |
| Argon2id params | `build_config.yaml` `crypto.kdf` (new vaults, via `lib.rs::kdf_params`) | Persisted per-vault in the header, so old vaults always unlock; `gervasius KdfParams::default()` is the library-level fallback and must stay in sync |
| Frame cap / onion port / Tor timeouts | `build_config.yaml` `network:` | `max_frame_bytes` is **wire-interop** (the cap on a member's link — change in lockstep across a fleet); every member listens on the same onion port |
| Transfer chunk size | `build_config.yaml` `settings.file_chunk_kib` (clamp) → kv `p2p:settings/file_chunk_kib` | User-settable ("file chunk size"); the read/write buffer of a download in `files.rs`. Device-local, no wire impact |
| Invitation state | protasius ns `invites` via `vault::get/put` (**internal** tag) | Per-profile, per-issuer: the capability, recipient binding, deadline and `Active/InFlight/Consumed/Revoked` state of every invitation minted. Deliberately NOT in the `kv_*` keyspace the webview can write. Expiry is decided **here**, on the inviter's clock — the deadline inside a ticket is advisory ([§18](#18-invitations--encrypted-expiring-revocable)) |
| PIN unlock | always built in; `build_config.yaml` `settings.pin_digits` (clamp) | Memory-only convenience re-unlock; the passphrase remains the at-rest secret. Nothing persisted, so no migration and no on-disk mode marker |
| AAD prefix / tag bytes | `protasius/src/lib.rs` | `protasius:v1:`, `TAG_INTERNAL`/`TAG_KV` |
| Window size, bundle targets | `tauri.conf.json` | — |
| Two-profile dev instances | `APP_PROFILE` / `CHAT_USER` env | Defaulted in `run_dev.sh`; **`lib.rs` owns the `"default"` fallback** |

**Pairs that MUST be bumped together** (no shared source yet): the `rakotis` source
alias path (`vite.config.ts` + `vitest.config.ts` + `tsconfig.json`); the desktop apt
dependency list (docs + CI jobs); the Playwright image tag `v1.60.0` ↔
`@playwright/test ^1.60.0`; the NDK version `27.2.12479018` (docs ↔ installer); the
`*.deb/*.AppImage/*.rpm` bundle glob (`scripts/build.mjs`). State one Node floor
(CI uses **node 22**).

### Centralization roadmap (not yet done)

Deliberately deferred; each is a real drift source. Do these when touching the
relevant subsystem:

**Rust consts (a shared module, or in-crate):**
- `gervasius`: name the magic sizes — `SALT_LEN = 16`, `KEY_LEN = 32`, `VAULT_VERSION = 1`.
- Transport: the invitation tag `0x4E` is the only ticket tag left (the old
  `0x49` / `0x54` / `0x44` tags went with iroh tickets, Tor tickets and the DHT);
  comments in `invite_ticket.rs` still name them.
- protasius namespace/key strings (`profile`/`keys`/`cache`/`state`, `tor_peer_id`,
  `tor_keystore`, `device_ed25519`) are bare literals across several files → named consts (a
  typo silently loses stored data).
- Fold inline Tor timers (redial backoff 5 s → 2 min, outbox 256, onion-poll) in with the named ones.

**Policy enforced on both layers.** `passphraseMinLen` is UI-only — a direct `invoke`
bypasses it, and `gervasius::create_vault` accepts any passphrase. If it's a real
boundary, enforce the same value in Rust (`vault_setup`/`vault_change_passphrase`).

**Frontend consts (rakotis).** LocalStorage keys + the `enigma:` prefix + the on/off
boolean encoding are scattered → one constants module. Same for chat timing (`5000`, `30000` duplicated) and
UI copy/confirm delays (`1200`/`1500`/`2000`).

**Build.** A version-bump script (or Tauri reading version from `package.json`) so
the version isn't hand-maintained in eleven files; extract the apt list to
`scripts/install_desktop_deps.sh`; add `.nvmrc`/`engines` for the Node floor.

**Palette.** Promote a `--color-scrim` token (unify `black/70` vs `black/40`) and lift
the repeated `text-white border-white/20` modal buttons into a rakotis primitive.
Consider self-hosting Orbitron (`@font-face`) — the CDN `<link>` fails in the offline
desktop/mobile shell.

---

## 16. History — the serverless rework

Newest first, kept short. Commits named below are in the repositories the app came
from; restore a file with `git show <commit>:<path> > <path>` there.

### Beacon and metadata (0.2.x, root todo.md Stages 7–8)

Padding, sealed sender, cover traffic, the room mailbox on Beacon, invitations through
Beacon, Poisson-timed and dummy reads, and optional restricted discovery on Beacon
([§11](#11-the-tor-mesh-and-vanguards), [§12](#12-how-enigma-keeps-and-encrypts-messages),
[§17](#17-beacon--mailboxes-and-invitations)). Friends with device codes and check
codes; letter icons replaced every picture of a person; one ☰ menu and a room header
with a ⋮ menu; the Tor indicator. Invitation tickets went to format version 2 (they
name the room's Beacon); 0.2.3 tickets are refused as another version.

### Moved to Pharos — Enigma27 (2026-11-22/23)

Enigma26 (technolog-spectrumai/enigma, branch `dev_mvp1`) was copied into Pharos as
`apps/enigma` and renamed **Enigma27** (identifier `com.spectrumaipl.enigma27`, the
letter E as icon, `scripts/letter_icon.py`). It replaced Pharos's previous client.

**Removed then:** iroh, iroh-gossip and Ferrozine (no direct P2P); the "Route over
Tor" and "Keep onion stable" switches; the file-integrity switch; legacy room
tickets; the captain (star topology, election, failover, relaying); all moderation
(room logo, rules, mute, kick, ban, the `room_meta` snapshot). Privacy HP (the
exposure budget) had gone on 2026-11-22. The DHT (Heliodor) was never in Enigma27.

**New then:** the mesh, full vanguards, arti's state sealed per profile, Tor started
after unlock, invitations over the inviter's onion, files from the sender's onion.

**Fixed then** — the "stuck on Connecting… / Not encrypted" bug: MLS starts on
entering a room; a new room is a group of one at once; sessions are kept across
reopens; sending needs only encryption (the outbox); no plaintext is sent or shown.

### Earlier (Belisario and before)

- **2026-11-16 — to Vesper:** voice calls, the Mainline DHT, contacts and direct
  invites, the room calendar, iroh's hosted relays, the Pro/Standard editions. Last
  commit with them: `998d5360da06f571f5d0c21f5d012888b8e5e453`.
- **2026-10-23 — removed:** the SVG drawing editor, the notes editor, per-file locking
  and the key ring (`a0b6224a…`, `cf2c6c55…`; see [README](README.md)).
- **2026-10-03 — maps to Morion.** `map_pin` / `map_loc` / `map_region` are still
  known (`chatHistoryModel.ts`, `MAP_SHARE_TYPES`) so old histories keep them; they
  show as a card that cannot be opened. `WEBKIT_DISABLE_DMABUF_RENDERER=1` in
  `main.rs` stayed from the map canvas.
- **2026-08-18 — parked:** device linking and multi-device sync, and peer links.
  The chat-history half stayed (`chatHistoryModel.ts`, sealed `chat:log`).
- **2026-08-15 — removed:** Enigma Cloud (the client for a self-hosted server, its
  HTTP stack and permissive TLS verifier). Not to be confused with today's Beacon
  client, which is new code over onion streams only.
- **The serverless rework:** the three-app monorepo with a relay server became one
  serverless chat; MLS, QR, arti and voice notes were kept.

---

## 17. Beacon — mailboxes and invitations

Beacon is the optional server at the repo root (`beacon/`, formerly Relay / Sotha),
reached only over its onion. Enigma27 uses it as a **mailbox**: it never sees a
room's name, a member or a plaintext. What Beacon learns and does not is in the root
[SECURITY.md](../../SECURITY.md); its API is in [PROTOCOL.md](../../PROTOCOL.md).

**Setting it up.** Settings → Connections → **Your Beacon** (`BeaconCard.vue`,
`stores/beacon.ts`): scan or paste its `pharos-beacon:` code (`beacon_parse_code`).
Rooms created afterwards use it. A room's Beacon is stored with the room
(`P2pRoomEntry.beacon`) and shared inside the encrypted presence message; the first
one heard is kept. No Beacon → the room is a pure mesh.

**Both routes.** Every frame goes over the mesh **and** to the room's mailbox. The
Rust client (`beacon.rs`) makes each request on a **fresh isolated Tor circuit**, so
Beacon cannot link one post to the next or a post to a read; the adapter
(`src/beaconMailbox.ts`) sends only the sealed frame. If Beacon is down the room
works on; the header says *Direct*, *Via Beacon* or *Beacon unreachable*.

**Mailbox id and token** come from the MLS exporter for the current epoch plus the
week number (`mls_mailbox`), so they move with every commit and every week, and a
removed member cannot derive them. Beacon keeps only hashes. Members read this
week's and last week's mailbox.

**Reads** happen at Poisson-random times (exponential gaps around 30 s, clamped
5 s–2 min), with dummy reads of random mailbox ids about half the time. Cover frames
are not posted. **Dedupe:** frames we sent and frames that came by the mesh are
noted in the mailbox's "seen" list, so the second copy is dropped before MLS.

**Only my phones (optional).** A Beacon can run with Tor restricted discovery, so
only listed clients can fetch its descriptor. The phone shows its discovery key for
that Beacon (`beacon_discovery_key`) and the owner adds it with
`beacon allow NAME KEY`. Member onions stay open.

**Invitations through Beacon** (`invite_drop.rs`). A format-2 ticket names the room's
Beacon. If the inviter's onion does not answer, the redeemer leaves its redemption
request at Beacon, sealed with a key derived from the invitation's capability, in a
mailbox only ticket holders can find. The inviter's phone polls its open invitations
(about every 45–65 s), runs the same checks as a live redemption
(`invite_redeem::decide`) and leaves the sealed answer (the Welcome and the members'
onions). The newcomer waits up to **30 minutes** ("waiting at their Beacon"). As the
redeemer picks the challenge here, a replayed request still admits only the same
device, and an invitation is spent after one admission.

---

## 18. Invitations — encrypted, expiring, revocable

The only way into a room. An invitation carries no room name and no MLS material, is
checked against the **inviter's** clock, and can be revoked or spent once.

- **Personal** — sealed to a friend's device id, picked from Friends. Nobody else who
  photographs it can read it; no key travels with it.
- **General** — a bearer code in cleartext. Not confidential, and the UI says so.

### 18.1 The ticket

```
base32-nopad-lowercase( TAG(0x4E) || FORMAT_V(0x02) || KIND || body )
  KIND 0x50 'P' → body = seal_to(recipient_x25519, AAD, postcard(InviteBody))
  KIND 0x47 'G' → body = postcard(InviteBody)
  AAD = [TAG, FORMAT_V, KIND]

InviteBody { invite_id[16], capability[32], inviter (device id), onion,
             beacon (the room's Beacon onion, optional), issued_at, expires_at }
```

Never carried: the room name, MLS material, or the recipient's identity. The version
byte sits outside the seal so an older build says "needs another version" instead of
"corrupt". `expires_at` is advisory; only the inviter's record decides.

### 18.2 Sealing (`gervasius::seal`)

Ephemeral-static X25519 → HKDF-SHA256 (salt = both public keys) → XChaCha20-Poly1305:
`sealed = eph_pk(32) || nonce(24) || ciphertext+tag`. The recipient is named by its
Ed25519 device id, mapped to X25519 by the standard birational map (as age and
libsodium do). Small-order keys are refused. Forward secrecy is one-sided: right for
something that expires in hours. The recipient's device id comes from pairing in
Friends (§10).

### 18.3 Redemption

Live, over the inviter's onion with `Hello{kind:"redeem"}`:

```
inviter  → redeemer : challenge (32 random bytes)
redeemer → inviter  : invite_id, node_id (device id), key_package, name,
                      sig   = Ed25519(device key, challenge)
                      proof = blake3::keyed_hash(capability, invite_id ‖ challenge ‖ node_id)
inviter checks:  signature → state → expiry (inviter's clock) → recipient → proof
                 → Active → InFlight
inviter  → redeemer : welcome ‖ room name ‖ every member's onion — or a refusal
```

The capability never crosses the wire. The signature exists because Tor
authenticates the server, not the client. One use is a lease:
`Active → InFlight(60 s) → Consumed`; a failed MLS round lets it lapse back. If the
inviter is offline and the ticket names a Beacon, the same exchange goes through
Beacon (§17).

### 18.4 Admission, and the KeyPackage ordering problem

Rust checks, then asks the frontend, because the commit must reach the members over
the room's links. The redeemer makes a key package before it knows the room, under a
scratch key (`invite:<inviter>:<expiry>`); `mls_adopt_session` re-files it onto the
real room, and refuses to overwrite an existing session.

### 18.5 State

ns `invites`, internal tier: the webview can neither read nor forge it. The capability
itself is stored (a keyed MAC needs the key). Retention runs from the terminal event.

### 18.7 Limitations

1. **Without a Beacon, the inviter must be online with the room open.** With one,
   the newcomer can wait up to 30 minutes for the inviter's phone.
2. **A general invitation is not confidential**, and gives away the inviter's onion
   for the room.
3. **Admission is app convention** (§18.8).
4. **`expires_at` in the QR is advisory.**
5. **Identity-key reuse and one-sided forward secrecy** (§18.2) are deliberate.
6. **A member can always re-share** what every member must hold.

### 18.8 Invite-only rooms

Every room is invite only. Every member refuses `mls_key_package` frames from the
mesh, above the admin split (a guard below it would still answer a stranger with our
own key package). A refused joiner is told nothing. The guarantee is only as strong as
the weakest member's client: OpenMLS here lets any member commit an add (§9 item 3).

---

## 18a. Shared room engine (Enigma and Teutates)

Since Belisario `dev_teuta4` step 2, Teutates' chat runs on Enigma's room engine. In
Pharos only Enigma27 uses it, and the options below stay as they were (off by
default); what Teutates needed from the Rust side is reduced to `mls` and
`admission`:

- **The protocol** stays rakotis' `useChatChannel` (`packages/rakotis`). Teutates imports its
  modules by path (`rakotis/*` aliases in `apps/teutates`), and injects what Enigma's Tauri
  shell otherwise provides: `transport`, `crypto` (both default to Enigma's `chatTransport` and
  `cryptoService`) and a kv backend (`setKvBackend` in `services/localDb.ts`).
- **The Rust half** is `crates/enigmatite` (no tauri): `mls` — the per-(room, identity) rotor
  session registry behind Enigma's `mls_*` commands (Enigma keeps its command names and
  protasius store); `admission` — a key package's proof by a device key. (Its `events` and
  gossip `gateway` modules went with iroh on 2026-11-22/23.)
- **Options Teutates added** (all off by default, so Enigma's rooms are unchanged):
  `openAdmission` + `admissionCheck` (a certified roster instead of invitation-only; the
  lowest live member adds), `keepSession` (the group survives a restart: no new handshake — Enigma27 now does this always),
  `mayFound`, `mailbox` (a server's room mailbox in Demio's format
  `{"kind":"demio-room","room","frame"}`, `mailbox.ts`; key packages and Welcomes go there too),
  `threads` (`#tags`, `@mentions`, the sender's device on messages), `inlineFiles` (≤ 256 KiB,
  Demio's `file_inline`), `rosterNotices` (who joined/left on commits, our own removal) and
  `enforceRoster(users)` (re-key on leave). The frames are the same in both apps, so an Enigma
  device and a Teutates device read the same frames (an Enigma device still admits only by
  invitation); they no longer share a transport.
- **Fakes** for tests and demos: `fakes.ts` (`MemHub`, `MlsWorld`/`fakeMls`, `memKv`) and
  `MemMailbox`; `tests/unit/sharedOptions.test.ts` covers the options.


## 19. Run, build and test

How to run Enigma27 in development and package it into installable artifacts. A
"build" compiles the frontend (`vue-tsc` + Vite) and the Rust core, then bundles
them.

### Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 20+ (CI uses 22) | frontend build (Vite) + Tauri CLI |
| Rust | stable | Tauri core + `rotor-core` |
| System libs (Linux desktop) | — | WebKitGTK stack + bundling tools |

Debian/Ubuntu desktop deps:

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev pkg-config build-essential curl file
```

**Nothing is fetched at build time but crates.io and npm.** The crypto crates
(`crates/rotor/rotor_core`, `crates/gervasius`, `crates/protasius`,
`crates/enigmatite`) and the shared front-end package (`packages/petalite`) are in
this repository and consumed by path, as is the `rakotis` workspace package. The
whole build is offline-friendly once crates.io/npm are cached. arti downloads
nothing at build time; at run time it fetches the Tor consensus.

Android has its own, larger toolchain (JDK 17, Android SDK/NDK, cargo-ndk) — see
[Android](#android--toolchain-setup--build) below.

---

### First-time setup

```bash
npm ci                        # once, at the repo root — sets up the workspace + all packages
```

`./run_dev.sh` and `./build.sh` do this themselves when the root
`node_modules` is missing, so a fresh clone can go straight to either.

`rakotis` is an in-repo workspace package (`packages/rakotis`); npm symlinks it
into the app's `node_modules`, so edits to its source are picked up immediately —
no rebuild step.

---

### Run (dev)

```bash
./run_dev.sh                  # from the repo root: profile "default" (./run_dev.sh bob for another)
apps/enigma/run_dev.sh        # the same, with --dual / --reset / --purge
```

Both run `tauri dev` inside `apps/enigma`: Vite starts on
`http://localhost:1420` and Tauri opens the native window pointed at it. Frontend
edits hot-reload; Rust edits trigger a rebuild.

> The first launch compiles the full Rust dependency tree (incl. OpenMLS and arti)
> and is slow. Later runs are incremental. After unlock, Tor bootstraps in the
> background: seconds with a warm cache, up to a minute cold.

The launchers work from VS Code's integrated terminal even when VS Code is the
snap: they restore the environment the snap overrides before starting the app
(`scrub_snap_env` in [scripts/lib.sh](../../scripts/lib.sh)). Without that the build
succeeds and the window never opens — see [Troubleshooting](#troubleshooting).

#### Profiles & two-instance pairing

Two env vars isolate instances so you can pair two on one machine:

| Var | Default | Effect |
|---|---|---|
| `APP_PROFILE` | `default` | Storage namespace (separate encrypted store / profile dir) |
| `CHAT_USER` | the profile name | MLS identity |

```bash
apps/enigma/run_dev.sh --dual             # two instances at once: profiles alice + bob
apps/enigma/run_dev.sh --dual carol dave  # …with other names
# or from the repo root, one per terminal:
./run_dev.sh alice
./run_dev.sh bob
```

`--dual` gives each instance its own profile, identity and Cargo build
directory (`target-<profile>`, so neither waits on the other's link — about
8 GB each), and both share **one** Vite server: the first instance starts it,
the second reuses it. Because that server belongs to the first instance, the
two are tied together — Ctrl-C, or either window closing, stops both, and the
script takes every process it started down with it.

#### Starting over (`--reset`) — new passphrase, clean cache

There is no "forgot my passphrase" flow: the passphrase wraps the store's DEK,
so a fresh one means a fresh store. `apps/enigma/run_dev.sh` takes a flag for it
(the root `./run_dev.sh` takes only a profile name):

```bash
cd apps/enigma
./run_dev.sh --reset              # reset profile "default", then run
APP_PROFILE=alice ./run_dev.sh --reset
./run_dev.sh --dual --reset       # reset BOTH profiles (alice + bob), then run
./run_dev.sh --dual --reset carol dave   # flags mix with the names, any order
ENIGMA_RESET=1 ./run_dev.sh       # env equivalent (ENIGMA_RESET=purge for --purge)
```

The next start is a **first run**, so the app asks you to set a new passphrase.

| | |
|---|---|
| **What it clears** | `profiles/<profile>/` (protasius store, `vault.json`, `profile_state.json`, `tor/`) and the global webview caches (`WebKitCache`, `CacheStorage`, `storage`, …) |
| **What it keeps** | anything at the app-data root outside `profiles/` (e.g. a legacy `kvstore/` from an old build) — it is **global**, shared by every profile |
| **Default is archive** | the profile dir is renamed to `<profile>.reset-<UTC stamp>`, not deleted — a dev vault holds a real identity (device key, onion keys, MLS state, room history) and a mistyped profile name should not be unrecoverable |
| **`--purge`** | deletes instead, and asks you to type `purge` to confirm (`-y` skips the prompt). Use it when the archives pile up |

The work is done by `scripts/reset_profile.sh`, which both launchers call before
they start anything (the app holds the store open while it runs). You can call
it directly: `scripts/reset_profile.sh [--purge] [-y] <profile>…`. It reads the
bundle identifier from `tauri.conf.json` rather than hardcoding the data
directory, and refuses a profile name containing a path separator.

To wipe *everything* Enigma27 owns, including the global bits, use the app's own
panic code (Settings → Lock) instead — that is the audited path.

#### Invitation quick-start

1. **A and B** (for a personal invitation): ☰ → *Friends*, each scans the other's
   code, and both compare the 12-digit check code.
2. **A**: ☰ → *New chat* → name it → **Create**. The room is encrypted (a group of
   one) at once. **Invite** → *personal* (pick B) or *general*.
3. **B**: ☰ → *Join chat* → scan the QR (camera / image) or paste the text. B
   redeems it against A's onion (or, if A is offline and the room has a Beacon, at
   the Beacon, waiting up to 30 min). A freshly created onion takes 30–90 s to be
   reachable, so the first try may wait.
4. Both sides show encryption and, once their link is up, the linked count.

The onions are stable and saved per room, so after a restart each side reopens the
room and links to the other again — no new invitation, no accounts.

#### Browser-only mode (UI shell, no P2P)

```bash
npm run dev -w enigma        # http://localhost:1420
```

Plain Vite with no Tauri runtime — renders the UI shell only. Tor and MLS need
the Rust backend, so chat does not function here; use it for pure-frontend work.

#### Android emulator

One-time SDK/NDK/Java setup is [below](#android--toolchain-setup--build). Tauri
finds the SDK and NDK through `ANDROID_HOME` and `NDK_HOME`; an x86_64 AVD (the
examples use one named `Pixel_9`) needs the `x86_64-linux-android` Rust target.

```bash
"$ANDROID_HOME/emulator/emulator" -list-avds
rustup target list --installed | grep android
```

**Boot it** with a software GPU (works without a physical one) and without
persisting snapshots, so each run is a clean boot. It has to stay up for the
whole session:

```bash
"$ANDROID_HOME/emulator/emulator" -avd Pixel_9 \
  -no-snapshot-save -no-boot-anim -gpu swiftshader_indirect &
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 5; done
adb devices          # -> emulator-5554   device
```

**Build, install and run**, from `apps/enigma/`:

```bash
npm run tauri android dev
```

Tauri detects the emulator and its ABI, runs the `beforeDevCommand` (the Vite
dev server on `:1420`, reverse-tunnelled to the device with `adb reverse`),
cross-compiles the Rust library, builds the APK with Gradle, installs and
launches it (`Starting: Intent { cmp=com.spectrumaipl.enigma27/.MainActivity }`).
Frontend edits hot-reload; Rust or native Android changes trigger a rebuild. The
first build compiles the whole Rust tree for Android and is slow.

**Drive and inspect it** with adb:

```bash
adb exec-out screencap -p > /tmp/enigma.png          # screenshot
adb shell input tap 993 222                          # tap a point (device pixels)
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1        # 0 = portrait, 1 = landscape
adb shell wm size; adb shell wm density              # screen geometry
adb shell am start -n com.spectrumaipl.enigma27/.MainActivity   # relaunch
```

**Shut down:** stop `npm run tauri android dev`, then `adb emu kill`.

---

### Build configuration (`build_config.yaml`)

[`apps/enigma/src-tauri/build_config.yaml`](apps/enigma/src-tauri/build_config.yaml)
is the compile-time build config: `build.rs` parses + validates it and generates
Rust consts (`enigma_lib::build_config`); the shipped binary never re-reads the
file. **An invalid or missing file fails the build** with the offending YAML paths
listed.

It is the same for every build and holds only what rarely changes:

- `crypto` — declared algorithms are **compile-asserted** against the
  rotor_core/gervasius crates (editing the strings can't change the crypto; drift
  in either direction is a build error). Argon2id costs apply to newly created
  vaults only.
- `network` — frame cap (**wire-interop**: all peers must agree), onion port,
  Tor timeouts.
- `settings` — default and bounds of each user-tunable setting. The profile's
  encrypted store holds the live value; these seed and clamp it.

There is no `defaults:` section any more: the toggles it held (use Tor, stable
onion, file integrity) were removed — all three are always on.

What it does **not** hold: how a build is packaged ([dromon.yaml](dromon.yaml) —
below), and the app's name, identifier and version
(`tauri.conf.json`, which `build.rs` reads directly and holds to the fixed
identity). [§15](#15-config--sources-of-truth) lists every owner.

#### Features and presets

None: Enigma has one edition ([§20](#20-features-and-presets)).

#### One fixed app identity

Every build is the same installable app:

| Value | Fixed setting |
|---|---|
| App name | `Enigma27` |
| Bundle identifier / Android package id | `com.spectrumaipl.enigma27` |
| Desktop binary name | `enigma27` |
| Data directory | `…/com.spectrumaipl.enigma27/` |

`build.rs` rejects a
`tauri.conf.json` that tries to change the name or identifier.

> **Moving existing data.** The package id changed from
> `com.spectrumaipl.enigma` to `com.spectrumaipl.enigma27`. Existing desktop
> data is not deleted; the new build looks in a new app-data directory. To carry
> a profile across:
> ```bash
> mv ~/.local/share/com.spectrumaipl.enigma/profiles/default \
>    ~/.local/share/com.spectrumaipl.enigma27/profiles/default
> ```
> Or just start fresh with `./run_dev.sh --reset`.

#### Building

There is one way to build: `./build.sh enigma`, from the repo root. There are no
build flags — [dromon.yaml](dromon.yaml) is the whole interface. The build itself is
Dromon's (`dromon/dromon.mjs`); `./build.sh` checks the toolchain first (`install.sh`).

```bash
./build.sh enigma            # from the repo root, as dromon.yaml says
./build.sh enigma --dry-run  # print the commands it resolves to, run none
npm run build              # -> ./build.sh
```

```yaml
variants:
  default:
    output_dir: dist/enigma   # packages land in dist/enigma/enigma/ with a SHA256SUMS and build.json
    forbid_crates: [mainline, rustfft]
    test: false               # run the frontend + Rust suites first
    desktop:
      enabled: true
      profile: release        # release | debug
      bundles: [deb, rpm]     # this host's formats only
    android:
      enabled: false
      profile: debug          # debug | release (release needs a signing key)
      abis: [aarch64]
      signing: debug-key      # debug-key | release-key | none
```

Every key, what is validated and what each step runs is documented with the
tooling: [dromon/README.md](../../dromon/README.md). An unknown key,
value is an error that names its path, never a silent default
([dromon/README.md](../../dromon/README.md)).

The **app icon is fixed** — not a per-build choice. One mark, whose master is
[`apps/enigma/app-icon.png`](apps/enigma/app-icon.png); the generated sizes
under `src-tauri/icons/` are committed. Changing it is a code change:
[§23](#23-app-icon).

---

### Desktop build

Set `desktop:` in [dromon.yaml](dromon.yaml) and run:

```bash
./build.sh enigma
```

`profile: debug` gives a faster, unoptimized bundle. The frontend build runs
automatically via Tauri's `beforeBuildCommand`.

Which formats come out is `desktop.bundles` in dromon.yaml (falling back to
`bundle.targets` in `tauri.conf.json` when the key is omitted). The build fails
if *no* package appears, but not if fewer appear than you expected — read the
"Built" list it prints before a release. Output, also copied to
`dist/enigma/enigma/`:

```
apps/enigma/src-tauri/target/release/bundle/     # release
apps/enigma/src-tauri/target/debug/bundle/       # profile: debug
  deb/Enigma27_<ver>_amd64.deb
  rpm/Enigma27-<ver>-1.x86_64.rpm
  appimage/Enigma27_<ver>_amd64.AppImage         # only if "appimage" is in bundle.targets
```

#### Piecemeal (frontend / Rust separately)

```bash
npm run build -w rakotis                 # vue-tsc typecheck (shared package)
npm run build -w enigma                  # vue-tsc --noEmit && vite build (frontend only)
( cd apps/enigma/src-tauri && cargo build )          # Rust debug
( cd apps/enigma/src-tauri && cargo build --release ) # Rust release
```

The frontend build emits `apps/enigma/dist/` (`index.html` + assets); Tauri reads
it via `frontendDist: "../dist"`.

---

### Android — toolchain setup & build

Building an Android APK/AAB from an Ubuntu dev machine.

#### Toolchain overview

| Tool | Version | Purpose |
|---|---|---|
| Java (OpenJDK) | 17 | Gradle & Android build tools |
| Android Studio | 2024.3.x | SDK manager UI (optional but recommended) |
| Android SDK | platform 35 | Android platform headers |
| Android NDK | 27.2.12479018 | Native (C/Rust) cross-compilation |
| Android Build Tools | 35.0.0 | `aapt2`, `d8`, `apksigner`, `zipalign` |
| CMake | 3.31.6 | Required by NDK toolchain |
| Rust | stable | Tauri Rust core + the repo's crates |
| cargo-ndk | latest | Rust → Android NDK bridge |

#### One-time setup (scripted)

```bash
bash tools/android/setup_java.sh              # OpenJDK 17 (+ JAVA_HOME in ~/.bashrc)
bash tools/android/install_android_studio.sh  # Studio, SDK 35, NDK, build tools, CMake, i386 libs
bash tools/android/setup_rust_android.sh      # rustup Android targets + cargo-ndk
bash tools/android/patch_cargo_android.sh     # Cargo.toml Android-compat check
source ~/.bashrc
```

Environment written to `~/.bashrc` / `~/.profile` (full reference):

```bash
export JAVA_HOME="/usr/lib/jvm/java-17-openjdk-amd64"
export ANDROID_HOME="${HOME}/Android/Sdk"
export NDK_HOME="${ANDROID_HOME}/ndk/27.2.12479018"
export PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}"
```

Verify:

```bash
java -version                                   # must print "openjdk 17..."
sdkmanager --list_installed
ls "$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/" | grep aarch64
rustup target list --installed | grep android   # aarch64 / armv7 / x86_64 / i686
cargo ndk --version
```

Native-dependency notes: `webkit2gtk` is Linux-only (cfg-guarded; Android uses the
system WebView); `cpal` uses the `oboe-shared-stdcxx` feature on Android (already
declared in `Cargo.toml`); arti's transitive `rusqlite` is pinned `bundled` on
Android (the NDK ships no `libsqlite3` — the pin compiles SQLite from source); all
repo's crates are pure Rust and cross-compile fine.

#### Build the APK / AAB

Set `android.enabled: true` in dromon.yaml — with
`profile` and `abis` — and run `./build.sh enigma`. That calls:

```bash
bash tools/android/build_android.sh enigma debug                    # debug APK, aarch64
bash tools/android/build_android.sh enigma release aarch64,x86_64   # release APK + AAB
```

`build_android.sh <app> [debug|release] [abi-spec]` runs `npm install`,
`tauri android init` (first time only — the generated project under
`src-tauri/gen/android/` is committed), then `tauri android build`. Valid ABIs:
`aarch64` (modern phones), `x86_64` (emulator), `armv7` (old 32-bit), `i686`
(32-bit emulator), or `all`.

Output — the selected ABIs are packed into ONE `universal` APK (Gradle's
`universal` flavour), so the paths do not vary with `abi-spec`:

```
apps/enigma/src-tauri/gen/android/app/build/outputs/
  apk/universal/debug/app-universal-debug.apk
  apk/universal/release/app-universal-release.apk     # release only
  bundle/universalRelease/app-universal-release.aab   # release only
```

`build.sh` copies these into `dist/enigma/enigma/` with the app name in place of
Tauri's generic `app-` prefix (`enigma-universal-release.apk`), because the
Tauri names are identical between apps.

#### Signing a release build

Release signing **fails closed**: with no keystore configured, a release build
is refused before any work starts, and the SDK debug key (publicly known) is
rejected for release outright — by path, filename, or the `androiddebugkey`
alias. Debug builds keep the debug key and are unaffected.

One-time setup, with the stdlib-only checker the build itself calls
([tools/android/android_signing/](../../tools/android/android_signing)):

```bash
SIGN="python3 tools/android/android_signing/signing_cli.py"
GEN=apps/enigma/src-tauri/gen/android

# Mint a release keystore (outside the repo, chmod 600, RSA 4096) — the tool
# warns loudly: losing this key permanently orphans every distributed install.
$SIGN create

# Would a release sign, and where does each credential come from?
$SIGN status --gen $GEN

# Build a signed release (android: { enabled: true, profile: release } in
# dromon.yaml). Artifacts are verified with apksigner afterwards and the report
# prints package, version, signer and SHA-256 fingerprint.
./build.sh enigma

# After confirming the first build, pin the fingerprint (committed file) so a
# swapped or regenerated keystore FAILS the build instead of shipping:
$SIGN pin --pin-file apps/enigma/deploy/android-release-key.properties --from <apk>

# Inspect any artifact:
$SIGN verify <apk-or-aab>
```

Credentials resolve per key from: a `${VAR}` placeholder in
`gen/android/keystore.properties` → the `ENIGMA_KEYSTORE_FILE` /
`ENIGMA_KEYSTORE_PASSWORD` / `ENIGMA_KEY_ALIAS` / `ENIGMA_KEY_PASSWORD`
environment variables → a literal in `keystore.properties` → 
`~/.config/enigma-builder/signing.properties` (must be chmod 600). Passwords
never live in source control and never appear on an argv.
`gen/android/keystore.properties.example` is the committed template and
documents the four keys; `signing_cli.py --help` lists the commands.

An **unsigned release** for internal inspection is a deliberate act, never a
fallback: `signing: none` under `android:` in dromon.yaml
(`tools/android/build_android.sh enigma release aarch64 --allow-unsigned-release`).
It installs nowhere, says so loudly, and still refuses the debug
key. The pinned fingerprint lives in
`apps/enigma/deploy/android-release-key.properties` — deliberately outside
`gen/android`, which `tauri android init` regenerates.

#### Install & inspect on a device

```bash
adb devices
adb install apps/enigma/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb logcat -s RustStdoutStderr enigma
```

---

### CI builds

GitHub Actions, in the repo root's `.github/workflows/`:

| Workflow | When | What |
|---|---|---|
| `ci.yml` | every push | `./tests.sh js` and `./tests.sh rust` |
| `release.yml` | a `v*` tag | Enigma27 for Linux and Windows (`tauri build`), Beacon for arm64 (binary and `.deb`) |
| `real-tor.yml` | by hand | `./test_tor2.sh`: two instances over the real Tor network |

Android is not built in CI.

---

### Tests

```bash
./tests.sh                    # from the repo root: every Pharos suite (js | rust), a table at the end
apps/enigma/tests.sh          # Enigma's long run, with a pass/fail table at the end
apps/enigma/tests.sh rust py  # only these groups (js | rust | py | build)
apps/enigma/tests.sh --list   # the steps and the command each one runs
./test_tor2.sh                # two instances over the real Tor network (needs Tor access; minutes)
```

`tests.sh` keeps going after a failure, so one run tells you everything that is
broken, and saves each step's output under `test-results/tests/`. The steps, for
running one by hand:

```bash
npm test                                   # all workspaces
npm test -w enigma                         # vitest: chat store, components, i18n, …
npm test -w rakotis                        # vitest: transport bridge, storage, i18n
cargo test -p enigma                       # Rust: mesh, invitations, files, kv, …
cargo test -p protasius -p gervasius -p rotor-core -p enigmatite   # the shared crates
python3 -m pytest apps/enigma/scripts/android_signing/tests   # Enigma's signing contract
npm run test:e2e -w apps/enigma            # Playwright smoke tier (no backend — there is none)
./test_tor2.sh                             # mesh_live.rs: Hello/Ready and frames both ways over real Tor
```

---

### Troubleshooting

**Dev:**

- **Port 1420 already in use** — a stray Vite server is running.
  `npm run dev:tauri` reuses an existing server on `:1420`; otherwise kill the
  process holding the port (`lsof -i :1420`) and relaunch.
- **Window opens blank / WebKit errors** — the WebKitGTK dev libs above are
  missing or mismatched; reinstall them.
- **Every `npm` command dies with `Cannot find module 'graceful-fs'`** — npm
  itself is broken, not the repo: npm keeps its own dependencies in a
  `node_modules` beside it, and a disk cleanup that deletes every `node_modules`
  it finds takes that one too. Reinstall the Node version
  (`nvm install <version>`); the launchers detect this and say so.
- **`sh: 1: vite: not found` / `tauri: not found`** — the root `node_modules` is
  gone (same cleanup, usually). `npm ci` at the repo root; the launchers do it
  themselves when the directory is missing.
- **Build succeeds, then `symbol lookup error: /snap/core20/…/libpthread.so.0:
  undefined symbol: __libc_pthread_init`** — the app was started with a snap's
  GTK environment (VS Code's integrated terminal, when VS Code is the snap).
  `run_dev.sh` undoes that itself; a binary
  started by hand from such a terminal still needs a normal shell.
- **First Rust compile is very slow / high memory** — expected for the initial
  build; subsequent runs are incremental.

**Desktop build:**

- **`No space left on device` / linker (`collect2`) failure at the final link** —
  the release binary link step is large; this is almost always **disk space, not a
  code bug**. Free space (clear `target/`, docker/build caches) and retry.
- **`build_config.yaml is invalid` / `not found`** — the compile-time build config
  failed validation; the panic message lists the offending YAML paths (see
  [Build configuration](#build-configuration-build_configyaml)).
- **`rotor-core` build error** — it's the in-repo crate at
  `crates/rotor/rotor_core` (no fetch involved); reproduce in isolation
  with `cargo check -p rotor-core` from the repo root.
- **`webkit2gtk` / `soup` not found** — install the desktop system libs above.
- **`frontendDist` doesn't exist** — the frontend build didn't run/produce
  `apps/enigma/dist/`; run `npm run build -w enigma` (or a full `./build.sh`).

**Android:**

- **`ANDROID_HOME` / NDK not found during `tauri android build`** —
  `source ~/.bashrc`, or export `ANDROID_HOME`/`NDK_HOME` per the reference above.
- **`linker aarch64-linux-android-clang not found`** — NDK not on PATH or wrong
  version; confirm with `ls "$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/" | grep aarch64`.
- **`ld.lld: unable to find library -lsqlite3`** — the Android `rusqlite { bundled }`
  pin in `Cargo.toml` is missing/removed; restore it.
- **`webkit2gtk` compile error when targeting Android** — should not happen (it's
  cfg-guarded to Linux); verify you're running `tauri android build`, not plain
  `cargo build`.
- **Gradle Java version mismatch** — `JAVA_HOME` must point at JDK 17 (not 11/21);
  re-run `tools/android/setup_java.sh`.

---

## 20. Features and presets

**One edition since 2026-11-16.** The crate has no optional cargo features and
[dromon.yaml](dromon.yaml) one variant (`./build.sh enigma`). Enigma is chat and
file transfer, always over Tor, with PIN unlock; voice calls, the
DHT, contacts, the calendar and iroh's hosted relays went to Vesper, and with them
the Professional/Standard split. The build still refuses to link `mainline` or
`rustfft` (`forbid_crates`), so they cannot come back with a merge. The last commit
with the two editions is `998d5360da06f571f5d0c21f5d012888b8e5e453`.

## 21. Releasing

This is the maintainer checklist for producing Enigma27 desktop and Android
release artifacts. For toolchain setup and lower-level build notes, see
[§19](#19-run-build-and-test). For end-user installation, see [§22](#22-installing).

### Release Goals

A release artifact should be:

- built from a known commit;
- versioned consistently across every file that carries the version (§21.2);
- signed when Android release artifacts are produced;
- smoke-tested on the target platform;
- distributed with checksums and enough metadata to diagnose install failures.

### 21.1 Pick The Release Shape

Decide what is being shipped:

- There is one edition ([§20](#20-features-and-presets)), so no product to pick.
- Desktop only: `.deb` / `.rpm` — `desktop:` enabled in dromon.yaml.
- Android sideload/test distribution: a signed `.apk`.
- Android store distribution: a signed `.aab` uploaded to the store, plus an
  APK only when the store or test channel needs one.
- Both desktop and Android: enable both sections; one `./build.sh enigma`
  builds them in turn. See [§19](#building).

Every one of those choices is a line in [dromon.yaml](dromon.yaml) — the only
place a build is configured. Record which commit a release was built from
(`build.json` beside the packages holds it).

### 21.2 Prepare The Checkout

Start from the Enigma27 repo root:

```bash
cd /path/to/enigma
git status --short
npm ci
```

Do not release from a dirty tree unless every change is intentional. The
`dist/enigma/enigma/` output folder can contain old artifacts, so do not use
"whatever is already in dist" as the release set.

The version is a property of the code, not a build-time choice: it is bumped
with the change that earns it — dromon.yaml has no key for it.
`apps/enigma/src-tauri/tauri.conf.json` owns it: the native bundle is built from
that file and `build.rs` reads the Rust side's copy out of it. Keep these in
step by hand:

- root `package.json`, `apps/enigma/package.json`,
  `packages/rakotis/package.json`;
- `apps/enigma/src-tauri/Cargo.toml`.

Android's generated
`apps/enigma/src-tauri/gen/android/app/tauri.properties` is regenerated from
`tauri.conf.json` and tracks that version — 0.1.3 produced `1003`, so 0.2.4
produces:

```text
tauri.android.versionName=0.2.4
tauri.android.versionCode=2004
```

`versionCode` must increase for every Android update with the same
`applicationId`, or Android refuses the install as a downgrade.

### 21.3 Run Pre-Release Checks

Run the normal test gates before packaging:

```bash
npm test
npm run build -w rakotis
npm run build -w enigma
( cd apps/enigma/src-tauri && cargo test )
( cd crates/rotor/gervasius && cargo test )
( cd protasius && cargo test )
npm run test:e2e -w apps/enigma
```

For Android, also smoke-test on at least one real phone or emulator:

```bash
adb devices
npm run tauri android dev
adb logcat -s RustStdoutStderr enigma
```

### 21.4 Build Desktop Artifacts

With `desktop: { enabled: true, profile: release, bundles: [deb, rpm] }` in
dromon.yaml:

```bash
./build.sh enigma
```

Expected release output (copied to `dist/enigma/enigma/` as well):

```text
apps/enigma/src-tauri/target/release/bundle/
  deb/*.deb
  rpm/*.rpm
```

Which formats appear is `desktop.bundles` in dromon.yaml (`bundle.targets` in
`tauri.conf.json` when that key is omitted) — check the "Built" list the
command prints before a release.

An `.rpm` built on Ubuntu links against Ubuntu's glibc and webkit2gtk: it is a
package format, not a cross build, and will very likely refuse to start on
Fedora. Build each distribution's package on that distribution.

### 21.5 Configure Android Release Signing

Android release builds must be signed. Enigma27 deliberately fails closed when a
release key is missing or when the Android SDK debug key is used for a release.

Preferred flow:

```bash
SIGN="python3 tools/android/android_signing/signing_cli.py"
$SIGN status --gen apps/enigma/src-tauri/gen/android
$SIGN create
./build.sh enigma   # android: { enabled: true, profile: release, abis: [aarch64, x86_64] }
$SIGN verify <apk-or-aab>
```

After the first real signed release has been inspected, pin its upload-key
fingerprint:

```bash
$SIGN pin --pin-file apps/enigma/deploy/android-release-key.properties --from <signed-release.apk>
git add apps/enigma/deploy/android-release-key.properties
```

That pinned fingerprint is public metadata. It exists so a swapped, regenerated,
or lost keystore becomes a build failure instead of an update that strands
existing installs.

Secrets must stay outside source control. Each of the four values
(`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) is resolved on its
own, highest first:

1. a `${VAR}` placeholder in `gen/android/keystore.properties`, read from the
   environment;
2. the well-known environment variables `ENIGMA_KEYSTORE_FILE`,
   `ENIGMA_KEYSTORE_PASSWORD`, `ENIGMA_KEY_ALIAS`, `ENIGMA_KEY_PASSWORD`;
3. a literal in `keystore.properties`;
4. `~/.config/enigma-builder/signing.properties`, which is refused unless it is
   mode `0600`.

With the environment or that local file supplying everything,
`keystore.properties` can be absent entirely; the committed
`keystore.properties.example` is the only half that belongs in the repo. No
password is ever passed on an argv. Command reference: `signing_cli.py --help`
([tools/android/android_signing/](../../tools/android/android_signing)).

### 21.6 Build Android Artifacts

Set this in dromon.yaml and run `./build.sh enigma`:

```yaml
android:
  enabled: true
  profile: release
  abis: [aarch64, x86_64]
```

It runs `tools/android/build_android.sh enigma release aarch64,x86_64`.

Expected output — every selected ABI is packed into one `universal` artifact,
so these paths do not change with the ABI list:

```text
apps/enigma/src-tauri/gen/android/app/build/outputs/
  apk/universal/release/app-universal-release.apk
  bundle/universalRelease/app-universal-release.aab
```

Important defaults:

- `android.profile` defaults to `debug` and `android.abis` to `[aarch64]`.
- Debug APKs are installable for testing but are not releasable.
- `signing: none` is only for inspecting packaging output. That APK
  should be treated as installable nowhere and must never be distributed.

### 21.7 Collect And Verify Artifacts

`./build.sh enigma` clears the previous desktop bundle directory before it builds,
fails if the build leaves no package, and copies what it built into
`<output_dir>/enigma/` (`dist/enigma/enigma/`), Android artifacts
renamed from Tauri's generic `app-…` to `enigma-…`. It prints the list under
"Built".

It also writes a `SHA256SUMS` there, over **everything** in that directory —
including older installers left there by earlier builds. Treat that file as an
index of the directory, not as a manifest of this release, and publish checksums
for the exact files you ship:

```bash
( cd dist/enigma/enigma && sha256sum -- Enigma27_<ver>_amd64.deb enigma-universal-release.apk )
```

Before sharing Android files, verify package, version, signer, and fingerprint:

```bash
python3 tools/android/android_signing/signing_cli.py verify dist/enigma/enigma/enigma-universal-release.apk
```

For manual SDK inspection:

```bash
apksigner verify --verbose --print-certs <release.apk>
aapt2 dump badging <release.apk> | head
```

### 21.8 Smoke-Test The Install

Use a clean test device or emulator:

```bash
adb install -r apps/enigma/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
adb shell pm list packages | grep enigma
adb shell am start -n com.spectrumaipl.enigma27/.MainActivity
adb logcat -s RustStdoutStderr enigma
```

If the device already has a debug build, an unsigned build, or a build signed
with another key, Android may refuse the update. Uninstalling can fix the test
device, but it removes the local Enigma27 vault and room state.

### 21.9 Publish

For direct distribution:

- ship only the signed release APK;
- include `SHA256SUMS`;
- include the release signing fingerprint from verification output;
- point users to [§22](#22-installing).

For Google Play or another store:

- upload the signed `.aab` when the store expects bundles;
- keep the upload keystore and password backed up long-term;
- remember that store-generated device APKs may be signed by the store's app
  signing key, while Enigma's local pin records the upload key used by this
  build.

Tag the commit after artifacts are verified:

```bash
git tag -a v<version> -m "Enigma27 <version>"
git push origin v<version>
```

### Known Release Friction Points

#### Android Signing Identity

Android updates are keyed by `(applicationId, signing certificate)`. Losing the
release keystore, changing it without an accepted rotation path, or accidentally
using the debug key means existing users cannot update in place.

What to do:

- create and back up the release keystore before the first release;
- pin the first release fingerprint in
  `apps/enigma/deploy/android-release-key.properties`;
- verify every release artifact before upload or sharing;
- never distribute debug-signed or unsigned releases.

#### Android Package ID Is Fixed

The generated Android Gradle file declares:

```text
applicationId = "com.spectrumaipl.enigma27"
```

Every Enigma27 APK uses this one package id, so two builds do not install side
by side; one updates or replaces the other. Treat the package id printed by
`signing_cli.py verify` as the authority.

#### AAB Is Not A Direct Installer

An `.aab` is for publishing. A phone installs APKs. For sideloading, distribute
the signed release APK; for app stores, upload the AAB and let the store generate
device-specific APKs.

#### ABI Coverage

The default Android build is `aarch64`, which covers modern ARM64 phones but not
the common `x86_64` emulator and not older 32-bit phones.

What to do:

- use `aarch64,x86_64` for phone plus emulator testing;
- use `all` only when the full target set is installed and the artifact size is
  acceptable;
- diagnose `INSTALL_FAILED_NO_MATCHING_ABIS` by rebuilding for the device ABI.

#### Stale Artifact Collection

`dist/enigma/enigma/` can contain artifacts from earlier names, versions,
and signing states. A filename like `enigma-universal-release.apk` is not enough
proof that the file came from the current commit.

What to do:

- start from an empty `dist/enigma/enigma/`, or checksum only the files you ship;
- verify the exact APK/AAB that will be shared.

#### Regenerated Android Project

`tauri android init` can regenerate files under
`apps/enigma/src-tauri/gen/android/`. Enigma27 has custom signing gates in the
generated Gradle project, mirrored by `tools/android/android_signing/signing.py`.

What to do:

- run `python3 tools/android/android_signing/signing_cli.py status --gen apps/enigma/src-tauri/gen/android`
  after regenerating Android files;
- verify that release signing still fails closed when credentials are missing;
- keep signing logic in Gradle and `signing.py` in lockstep.

---

## 22. Installing

This guide is for installing Enigma27 artifacts that were produced by the release
process in [§21](#21-releasing). For building from source, see
[§19](#19-run-build-and-test).

### Choose The Right File

Use the artifact for your platform:

- Ubuntu / Debian: `.deb`
- Fedora / RHEL: `.rpm`
- Linux portable build, when produced: `.AppImage`
- Android direct install: signed `.apk`
- Android store upload: `.aab`

Do not try to install an `.aab` directly on Android. It is a publishing format;
phones install APKs.

Before installing a downloaded release, compare its checksum with `SHA256SUMS`:

```bash
sha256sum -c SHA256SUMS
```

### Linux

Install a Debian package:

```bash
sudo apt install ./Enigma27_<version>_amd64.deb
```

Install an RPM package:

```bash
sudo dnf install ./Enigma27-<version>-1.x86_64.rpm
```

Run an AppImage, when one is shipped:

```bash
chmod +x ./Enigma27_<version>_amd64.AppImage
./Enigma27_<version>_amd64.AppImage
```

If a desktop package refuses to start after installation, run the app from a
terminal and keep the output. Missing WebKitGTK or a package built on the wrong
Linux distribution is usually the first thing to check.

### Android: Install From The Device

Use the signed release APK, for example:

```text
enigma-universal-release.apk
```

Steps:

1. Download or copy the APK to the Android device.
2. Open it from Files, Downloads, a browser, or the app that received it.
3. If Android asks, allow that source to install unknown apps.
4. Tap Install.
5. Open Enigma27 and grant camera or microphone permission only when using QR
   scanning or recording voice notes.

On Android 8.0 and newer, the unknown-app permission is per source. Allowing a
browser does not automatically allow a file manager or chat app to install APKs.

On managed work phones, school phones, or enterprise profiles, the administrator
may block unknown-app installs entirely. In that case, use the approved app
store, MDM channel, or `adb` if the device policy permits it.

### Android: Install With adb

Enable Developer options and USB debugging on the phone, then connect it:

```bash
adb devices
adb install -r ./enigma-universal-release.apk
```

Useful inspection commands:

```bash
adb shell pm list packages | grep enigma
adb shell am start -n com.spectrumaipl.enigma27/.MainActivity
adb logcat -s RustStdoutStderr enigma
```

Uninstalling removes Enigma27's local vault, room state, and device-local data:

```bash
adb uninstall com.spectrumaipl.enigma27
```

Only uninstall as a last resort on a real user's device. Enigma27 is serverless, so
there is no central account that can restore local encrypted state.

### Why An APK May Fail To Install

#### The APK Is Unsigned

Android requires installable APKs to be signed. Enigma27's release build fails
closed: with no release keystore configured the build is refused before any
work starts, and the Android SDK debug key is refused for a release outright. The only way to obtain an
unsigned release artifact is to ask for it with `--allow-unsigned-release`, and
that artifact is for packaging inspection — it installs nowhere and must not be
shared.

What to do:

```bash
python3 tools/android/android_signing/signing_cli.py verify <apk>
bash tools/android/build_android.sh enigma release aarch64,x86_64
```

Share only a signed release APK.

#### The Existing App Was Signed With Another Key

Common adb symptom:

```text
INSTALL_FAILED_UPDATE_INCOMPATIBLE
```

Android treats an update as valid only when the installed app and the new APK
have the same package id and compatible signing certificate. A debug APK cannot
update a release APK, and a release APK signed by a new keystore cannot update an
older release signed by the original keystore.

What to do:

- install an APK signed with the same release key as the existing app;
- use a separate intentionally configured package id only for throwaway test
  builds outside the fixed release path;
- uninstall only if losing local data is acceptable.

#### The APK Version Is Older Than The Installed Version

Common adb symptom:

```text
INSTALL_FAILED_VERSION_DOWNGRADE
```

Android compares `versionCode`, not only the visible version name. If the device
already has a higher `versionCode`, a normal install is blocked.

What to do:

- build a new release with a higher Android `versionCode`;
- for a disposable test device, uninstall the existing app and install again.

#### The APK Does Not Match The Device ABI

Common adb symptom:

```text
INSTALL_FAILED_NO_MATCHING_ABIS
```

The default Enigma27 Android build targets `aarch64`, which is right for most
modern phones but wrong for an `x86_64` emulator and wrong for old 32-bit
devices.

What to do:

```bash
bash tools/android/build_android.sh enigma release aarch64,x86_64
# or, when all targets are installed:
bash tools/android/build_android.sh enigma release all
```

For an emulator, include `x86_64`.

#### The Device Is Too Old

Enigma27's generated Android project currently declares:

```text
minSdk = 24
targetSdk = 36
```

Android devices below API 24 cannot install the app. API 24 is Android 7.0.

What to do:

- use Android 7.0 or newer;
- do not try to bypass this with signing or installer settings.

#### Android Blocks Unknown Apps

Symptoms include a generic "App not installed", a security warning, or a prompt
that sends you to settings.

What to do:

- allow "Install unknown apps" for the source app that opens the APK;
- verify checksums and the release signing fingerprint before proceeding;
- on managed devices, ask the administrator to approve the app or distribute it
  through the managed store;
- use `adb install` for internal testing when USB debugging is allowed.

#### The File Is An AAB, Not An APK

An `.aab` will not install when opened on a phone.

What to do:

- use the `.apk` for direct install;
- upload the `.aab` to Google Play or another store that accepts app bundles;
- use bundletool only when you intentionally need generated APKs from an AAB.

#### The Download Is Corrupt Or Incomplete

Common symptoms are package parse errors, a zero-byte file, or an installer that
fails before showing the app name.

What to do:

```bash
sha256sum -c SHA256SUMS
```

Download the APK again if the checksum does not match. Also confirm the device
has enough free internal storage.

#### Play Protect Or Developer Verification Warns

Sideloaded APKs can show extra warnings, especially for apps outside an app
store or from an unverified developer.

What to do:

- prefer the official release channel when available;
- verify the checksum and signing fingerprint;
- avoid forwarding APKs without the matching release notes and checksums.

#### The App Installs But Does Not Work Correctly

Installation success only proves the package was accepted by Android. If Enigma27
opens blank, crashes, cannot scan QR codes, or cannot record voice notes:

- update or enable Android System WebView / Chrome;
- grant camera permission for QR scanning;
- grant microphone permission for voice notes;
- capture logs with `adb logcat -s RustStdoutStderr enigma`;
- test with a clean profile on a disposable device before touching a real user's
  install.

### Repo-Specific Android Checks

Confirm what is actually inside an APK before distributing it:

```bash
python3 tools/android/android_signing/signing_cli.py verify <apk>
```

The report should show:

- package id, fixed to `com.spectrumaipl.enigma27` in the generated Gradle file;
- visible version and Android `versionCode`;
- signer classification: signed release, debug, or unsigned;
- SHA-256 signing certificate fingerprint.

Once a release fingerprint has been pinned in
`apps/enigma/deploy/android-release-key.properties`, a build signed with any
other keystore fails instead of shipping — so a mismatch between that file and
the fingerprint printed above means the artifact did not come from the release
path. The full command set: `signing_cli.py --help`
([tools/android/android_signing/](../../tools/android/android_signing)).

Preset names and output filenames are not separate Android identities. Android
uses the APK's `applicationId` plus the signing key, and Enigma27 fixes the
release `applicationId` to `com.spectrumaipl.enigma27`.

### Official Android References

- Android app signing:
  <https://developer.android.com/studio/publish/app-signing>
- Prepare an Android app for release:
  <https://developer.android.com/studio/publish/preparing>
- APK vs Android App Bundle:
  <https://developer.android.com/guide/app-bundle/faq>
- Alternative distribution and unknown-app opt-in:
  <https://developer.android.com/distribute/marketing-tools/alternative-distribution>
- PackageInstaller failure categories:
  <https://developer.android.com/reference/android/content/pm/PackageInstaller>
- Android developer verification FAQ:
  <https://developer.android.com/developer-verification/guides/faq>

---

## 23. App icon

The app icon is not a build option. It is part of the product's identity, like
its name, its bundle id and its version: one mark, fixed in the repository and
changed here, in code — dromon.yaml has no key for it.

### Why fixed rather than chosen

An app icon is what a user identifies on their launcher. A build that could
pick a different one is a build that can ship the wrong brand, and nothing
downstream would catch it — the artifact installs and runs perfectly with the
wrong face. Fixing it removes a decision that has exactly one right answer at
any moment, and the answer belongs in version control beside the name and the
version it goes out with.

### The master

```
apps/enigma/
├── app-icon.png          # normalised master: square, 1024×1024, what `tauri icon` consumes
└── app-icon-source.png   # the original as authored — never overwritten
```

`app-icon.png` is what `npx tauri icon` consumes. Enigma27's mark is the letter
**E** on a rounded tile, drawn as plain geometry (no font) by
`scripts/letter_icon.py`, which writes both files and the in-app marks:

```bash
python3 scripts/letter_icon.py apps/enigma E <tile colour> <ink colour> enigma27
```

Everything generated from the master is **committed**: the desktop
`.png`/`.ico`/`.icns` set under `apps/enigma/src-tauri/icons/`, and the Android
launcher mipmaps under `apps/enigma/src-tauri/gen/android/app/src/main/res/`.
A build uses those committed files as they are; it does not regenerate them.

#### Master image requirements

- **Square** — Tauri would distort anything else into every output size.
- **At least 512×512**; **1024×1024 recommended**, below which the largest
  generated sizes are upscaled from a smaller original.
- **PNG with alpha**, or **SVG**.
- **Keep the mark inside the middle ~66%.** Android's adaptive icon crops to a
  circle, squircle or rounded square depending on the launcher; anything in the
  corners is gone. Design for the circle, then check the square still looks
  deliberate.
- **Test it small.** Most of an icon's life is 32–48px in a taskbar, where fine
  detail and thin strokes disappear.

### Changing the app icon

Deliberately a manual, reviewed step.

1. Replace `apps/enigma/app-icon.png` (and `app-icon-source.png`) with the new
   master — for the letter mark, by running `scripts/letter_icon.py` as above.
2. Regenerate every size from it:

   ```bash
   cd apps/enigma
   npx tauri icon app-icon.png
   ```

   That rewrites `src-tauri/icons/` — the desktop set plus an `icons/android/`
   mipmap tree.
3. Mirror the Android mipmaps into the generated project. The Gradle project
   does **not** read `icons/android/`: `tauri android init` copies it once, at
   init time, so without this step an Android build ships the previous
   launcher icon.

   ```bash
   cp -r src-tauri/icons/android/. src-tauri/gen/android/app/src/main/res/
   ```
4. Review the diff (roughly 90 files) and commit it with the master.

The in-app marks (the unlock gate and the top bar) are separate files, cut from
the same master: `apps/enigma/src/assets/<logoDir>/app_icon.png` and
`bar_icon.png` — see [`logos.ts`](apps/enigma/src/assets/logos.ts). Replace
them in the same change so the app's face stays the same everywhere.

---

## 24. Crypto audit inventory

Written 2026-09-16; brought up to date 2026-11-23 for Enigma27 in Pharos (iroh, the
captain, file locks and key rings are gone; padding, sealed sender, cover traffic and the Beacon client added since). Nothing here was re-audited on that
date — rows were corrected to match the code, and what no longer exists was taken
out.

### Scope

Active scope:

- Enigma27: `apps/enigma` (Rust core, Vue front end, `packages/rakotis`)
- The crates it links: `crates/rotor/rotor_core`, `crates/gervasius`,
  `crates/protasius`, `crates/enigmatite`
- arti 0.43 as configured in `src-tauri/src/mesh.rs`

Out of scope here:

- Beacon and the `pharos-*` crates (the friend protocol): root
  [SECURITY.md](../../SECURITY.md), Part 2
- Morion and its file sealing (another repository)

### Algorithm Inventory

| Area | Current algorithm or construction | Where used | Source of truth / notes |
| --- | --- | --- | --- |
| MLS group encryption | `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` via OpenMLS | Room chat payloads, presence (with onions), membership changes, file offers | Declared in `apps/enigma/src-tauri/build_config.yaml`; asserted by `build.rs` against `crates/rotor/rotor_core/src/lib.rs`. Pure-ciphertext wire format and ratchet-tree extension. |
| MLS credentials | OpenMLS `BasicCredential` with a self-asserted identity (the profile name) | MLS member identities and rosters | `crates/rotor/rotor_core/src/lib.rs`. Not a PKI or verified identity binding. |
| Device key | Ed25519 (`ed25519-dalek`), 32-byte seed in the vault | Invitation redemption signature; personal invitations are sealed to its X25519 twin | `apps/enigma/src-tauri/src/device.rs` |
| At-rest envelope | Passphrase -> Argon2id -> UKEK wraps random 32-byte DEK -> XChaCha20-Poly1305 for values | Profile vault: MLS state, history, settings, rooms, invite records, device key, arti's state | `crates/gervasius/src/*`, `crates/protasius/src/lib.rs`. Vault headers store version, KDF params, salt, and wrapped DEK. |
| Password KDF | Argon2id v1.3, 32-byte output | New Enigma vaults | Configured in `build_config.yaml` as 64 MiB, t=3, p=4; validated by `build.rs`; implemented in `crates/gervasius`. |
| AEAD for local data | XChaCha20-Poly1305 with 24-byte random nonce and AAD (`protasius:v1:` ‖ key) | Every sealed value; the in-memory PIN passphrase box | `crates/gervasius`, `crates/protasius`, `apps/enigma/src-tauri/src/vault.rs`. |
| Public-key sealing | Ephemeral-static X25519 -> HKDF-SHA256 -> XChaCha20-Poly1305 | Personal invite ticket body sealed to the recipient's device id | `crates/gervasius/src/seal.rs`, `apps/enigma/src-tauri/src/invite_ticket.rs`. Ed25519 device keys are converted to X25519; small-order/off-curve inputs are rejected. |
| Invite redemption | Ed25519 signature over a random challenge plus BLAKE3 keyed proof with the 32-byte capability | Redemption over the inviter's onion, before the MLS add | `apps/enigma/src-tauri/src/invite_redeem.rs`, `invites.rs`. The capability does not cross the wire. |
| File download | One-time 32-byte secret, committed as BLAKE3(secret) over MLS; BLAKE3 of the whole file | Downloads over the sender's onion | `apps/enigma/src-tauri/src/files.rs`. Bytes are protected by Tor's onion encryption, not by MLS. |
| Transport | arti onion services, one per member per room; full vanguards | Room links, redemptions, downloads | `apps/enigma/src-tauri/src/mesh.rs`. No direct connections. Links carry JSON frames; only MLS protects content. |
| Padding and cover | Trailing-space padding to 512 B / 2 KiB / 8 KiB / n × 32 KiB; a padded `{"type":"cover"}` per link per quiet 30 s slot (90 s Android) | Every mesh frame | `mesh.rs` (`padded_len`, `spawn_cover`) |
| Beacon mailbox id/token | MLS exporter (current epoch) + week number; Beacon stores hashes | Room mailboxes on Beacon | `lib.rs` `mls_mailbox`, `beacon.rs`, `src/beaconMailbox.ts` |
| Invitation drop | XChaCha20-Poly1305 under keys from the capability; mailboxes from capability + invite id | Redemption via Beacon while the inviter is offline | `invite_drop.rs` |
| Friend check code | 12 digits from the two device ids | Pairing in Friends | `src/stores/friends.ts` |
| Room slug / onion nickname | BLAKE3 of the room name | Room ids and the keystore nickname | `mesh.rs`. Deterministic, not a secret. |

Key dependency versions in the Enigma Rust tree (check with the commands below):

- `openmls` 0.7.4 and `openmls_rust_crypto` 0.4.4
- `arti-client` 0.43 (features `onion-service-client`, `onion-service-service`, `vanguards`)
- `argon2` 0.5
- `chacha20poly1305` 0.10
- `ed25519-dalek` 3
- `blake3` 1

### Secret And Data Locations

| Secret or sensitive data | Storage | Protection |
| --- | --- | --- |
| Profile DEK | In memory only after unlock; wrapped in `vault.json` at rest | Argon2id-derived UKEK wraps DEK through gervasius |
| MLS state | Protasius, namespace `mls` | Sealed; exported state is zeroized on Rust paths that handle it |
| Chat history, settings, saved rooms (with members' onions) | Protasius kv (`chat:log`, `p2p:settings`, `p2p:rooms`) | Values sealed with per-key AAD; keys remain plaintext for scans |
| Device key | Protasius, `keys/device_ed25519` | Sealed |
| arti's state (onion keys, guards, vanguards) | `profiles/<p>/tor/state` while running; `keys/tor_keystore` when stopped | Sealed at rest; plaintext on disk while the app runs, and after a crash until the next clean stop |
| Invite capabilities and records | Protasius internal invite namespace | Sealed at rest; redemption sends only a challenge-bound proof |
| PIN unlock passphrase copy | Process memory only | Passphrase sealed under PIN-derived gervasius vault; dropped after 5 wrong PINs or restart |
| Panic code | A second slot in `vault.json` | Panic unlock returns like a normal unlock and wipes every profile |

### Existing Cybersecurity Measures

- Build-time crypto declarations are validated in `apps/enigma/src-tauri/build.rs`.
  Unknown YAML fields fail the build, sane KDF ranges are checked, and algorithm
  strings are const-asserted against the crypto crates.
- Room content is E2EE through MLS; nothing is sent or shown in plaintext; key
  packages from the mesh are refused (invitation-only admission).
- Always Tor, with full vanguards for every hosted onion; no direct connection
  and no outbound HTTP from the Rust core.
- Local profile data is encrypted at rest through protasius/gervasius, arti's
  state included. No password recovery path.
- The vault can idle-lock. Locking stops the mesh (sealing arti's state) and drops
  in-memory MLS sessions before the DEK.
- PIN unlock is convenience-only and memory-only. Nothing PIN-derived is persisted.
- The panic code's unlock result is indistinguishable from a normal unlock.
- Personal invitations hide the capability and the inviter's onion from a passive QR
  observer by sealing the body to the recipient. General invitations are bearer
  credentials by design.
- Invite redemption is challenge-bound and identity-bound: a captured proof does not
  replay against a new challenge or a different device id.
- A file download needs the secret only the accepting member holds, works once, and
  is checked by BLAKE3 before it is kept.
- Tauri capabilities are narrow at the manifest level: core, opener, dialog,
  notification and deep-link defaults; no filesystem plugin permission.

### Audit Gaps And Required Work

P0 before an external encryption audit:

- Authenticate or drop `mls_reset_request`: today any connection to a member's
  onion can make that member start a new group of one (§9 item 4).
- Add a real Tauri Content Security Policy. `tauri.conf.json` has `"csp": null`.
- Enforce passphrase minimum and policy in Rust, not only in UI.
- Run a fresh dependency audit for Rust and npm.

P1 hardening (padding, sealed sender, cover traffic and Beacon mailboxes are done:
root [todo.md](../../todo.md) Stages 7–8):

- Restrict who can link to a member onion (today anyone who knows it can; §9 item 7).
- Member/key verification UX: bind the MLS credential to the device key; safety
  numbers or SAS.
- MLS rekey/post-compromise cadence.
- Review all logging for passphrases, invite capabilities, onions and key material.

P2 documentation and test depth:

- Fuzz/property tests for frame parsers, invite-ticket decoding and the download
  handshake.
- Review zeroization boundaries; webview/TypeScript plaintext cannot get the same
  memory guarantees.

### Verification Commands

```bash
rg -n "MLS_128_DHKEMX25519|xchacha20-poly1305|argon2id|blake3|VanguardMode|csp" \
  apps/enigma crates

cargo tree -p enigma -i openmls
cargo tree -p enigma -i arti-client -e features
cargo tree -p enigma -i chacha20poly1305
cargo tree -p enigma | grep -c iroh     # 0: no iroh in Enigma27

npm query .workspace --json
npm audit
```

---

## Roadmap

Open work, in rough priority order. Enigma27's own list is [todo.md](todo.md); the
Beacon and metadata work is root [todo.md](../../todo.md) Stages 7–8 (done except a
real-Tor test run).

- **An authenticated reset**, or none (§9 item 4).
- **Who may link:** member onions accept anyone who knows them (§9 item 7).
- **Key verification** in rooms (bind the MLS credential to the device key) and an
  MLS rekey cadence.
- **The MLS identity is the profile name**: two people who both use the profile
  "default" collide in a room.
- **Accepted limitations:** a full mesh is for small rooms; without a Beacon, joiners
  need the inviter online.
- **Housekeeping:** the centralization roadmap in
  [§15](#15-config--sources-of-truth).
