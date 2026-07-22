# Enigma product line — Light / Plus / Pro

One codebase, three shipped products. Every edition is the same binary source
built with a different **compile-time build config**; there is no runtime
licence check, no server-side entitlement, and no dormant code path waiting for
an unlock. A feature that is not in an edition is **not in that binary**: its
tab is absent, its route redirects, its composable is never instantiated, and
its Rust commands fail fast with a `*_DISABLED` error.

That property is the whole point. Enigma's pitch is a serverless, auditable,
end-to-end-encrypted client — an edition that merely *hides* features would
mean every user still ships the attack surface of every feature. Gating at
build time keeps each edition's surface honest.

**Related docs:** [build.md](build.md) (how to build each edition) ·
[technology.md](technology.md) (§14–§15: where each config value canonically
lives) · [README.md](README.md) (orientation).

---

## 1. The three editions

### Enigma Light — "just the encrypted chat"

The minimum viable secure messenger. Everything needed to pair with someone and
talk to them safely, and nothing else.

**In:** P2P MLS chat with QR pairing and persistent rooms · Tor transport ·
DHT room codes · P2P file transfer · per-file local locking + the notes editor ·
the encrypted-at-rest vault (passphrase gate, panic code, idle auto-lock,
airplane mode) · profile + settings + i18n.

**Out:** Contacts, voice calls, calendar, board, sketch, maps, Enigma Cloud,
multi-device linking.

**Who it's for:** the user who wants one thing to work and to be able to explain
what the app does in a sentence. Also the smallest binary and the smallest
audit surface — the natural default for a high-risk user.

### Enigma Plus — "chat with people, not just rooms"

Light plus the two features that turn a room-based messenger into something you
use with a *contact list*.

**Adds:** **Contacts** (DHT presence, the nickname directory, direct room
invites with Accept/Decline) · **1:1 voice calls** (`vox`, riding the room's MLS
group) · **multi-device linking** (the user's own devices converge over pure
P2P — no third party).

**Out:** calendar, board, sketch, maps, Enigma Cloud.

**Who it's for:** the everyday user. Device linking lands here rather than in
Light because "my phone and my laptop" is a Plus-shaped expectation, and because
it is the first feature that makes the profile exist in more than one place.

### Enigma Pro — "the collaboration suite"

Everything. Plus, extended with the shared-workspace features and the optional
self-hosted server client.

**Adds:** **Peer sync** (scoped, revocable person-to-person links — see
[peer.md](peer.md)) · **Calendar** (meetings + scheduling polls) · **Kanban board** ·
**Sketch board** · **Maps** (offline region packages) · **Enigma Cloud** (client
for the user's *own* self-hosted server).

**Who it's for:** teams and organisations running Enigma as their working
surface, and the only edition where `cloud.allow_connections` defaults to true —
the one edition whose users have deliberately stood up their own infrastructure.

---

## 2. Feature matrix

| Feature | Light | Plus | Pro | Gate |
|---|:--:|:--:|:--:|---|
| P2P MLS chat, QR pairing, room persistence | ✅ | ✅ | ✅ | — (always) |
| Tor onion transport | ✅ | ✅ | ✅ | — |
| Hosted relays + DHT room codes | ✅ | ✅ | ✅ | `p2p.allow_hosted_relays` |
| P2P file transfer | ✅ | ✅ | ✅ | — |
| Local locked files + notes editor | ✅ | ✅ | ✅ | — |
| Vault, panic code, idle lock, airplane mode | ✅ | ✅ | ✅ | — |
| **Contacts** (presence, nick directory, invites) | ❌ | ✅ | ✅ | `contacts.enabled` |
| **Voice calls** | ❌ | ✅ | ✅ | `calls.enabled` |
| Multi-device linking | ❌ | ✅ | ✅ | `devices.allow_linking` |
| **Calendar** (meetings + polls) | ❌ | ❌ | ✅ | `calendar.enabled` |
| **Kanban board** | ❌ | ❌ | ✅ | `kanban.enabled` |
| **Sketch board** | ❌ | ❌ | ✅ | `sketch.enabled` |
| **Maps** | ❌ | ❌ | ✅ | `maps.enabled` |
| **Peer sync** (scoped person-to-person links) | ❌ | ❌ | ✅ | `peers.enabled` |
| **Enigma Cloud** | ❌ | ❌ | ✅ | `cloud.allow_connections` |

DHT nuance: the DHT toggle covers three things — ticketless room joins by short
room code (chat-level, in every edition), plus peer presence and the nickname
directory (surfaced only inside Contacts, so effectively Plus and up). The
toggle itself stays opt-in (`features.dht_discovery: false`) in all three
editions; nothing is published to the Mainline DHT unless the user asks.

---

## 3. Invariants — what does NOT vary by edition

Editions differ **only in feature gates**. Everything else is byte-identical
across the three configs, deliberately:

- **Crypto.** Same MLS ciphersuite, same at-rest AEAD, same Argon2id costs. One
  security story to audit, not three. (These are compile-time asserted against
  the vendored `rotor_core`/`gervasius` anyway — they cannot drift silently.)
- **Network / wire.** Same `max_frame_bytes`, `onion_port`, chunk size, Tor
  timeouts. `max_frame_bytes` is **wire-interop sensitive**: peers in one room
  must agree on it, and a Light user must be able to sit in a room with a Pro
  user. Never diverge this per edition.
- **Settings clamps.** Same defaults and bounds for every user-tunable setting,
  including ones whose feature is off in that edition (`map_storage_limit_mb`
  is still a required, validated field in the Light config — it is simply
  never read).
- **App identity.** All three declare `name: Enigma`, the same identifier and
  the same version, because `build.rs` asserts equality against
  `tauri.conf.json`. Shipping three separately-installable products with
  distinct names and bundle ids is a follow-up (§6).

---

## 4. Selecting an edition at build time

`src-tauri/build.rs` resolves its YAML from the `ENIGMA_EDITION` environment
variable:

```
ENIGMA_EDITION unset  →  src-tauri/build_config.yaml               (unchanged default)
ENIGMA_EDITION=light  →  src-tauri/configs/build_config.light.yaml
ENIGMA_EDITION=plus   →  src-tauri/configs/build_config.plus.yaml
ENIGMA_EDITION=pro    →  src-tauri/configs/build_config.pro.yaml
```

```bash
ENIGMA_EDITION=light ./build_desktop.sh          # release bundle, Light
ENIGMA_EDITION=pro   ./run_dev.sh                # dev run, Pro
ENIGMA_EDITION=plus  ( cd apps/enigma/src-tauri && cargo build )
```

An unset variable keeps today's behaviour exactly — the repo default build is
still `build_config.yaml`, which stays the "everything on, main-branch" config
and is what CI and existing scripts build. `build.rs` emits
`cargo:rerun-if-env-changed=ENIGMA_EDITION` and watches the whole `configs/`
directory, so switching editions re-runs codegen rather than silently reusing a
cached binary. An unknown edition name fails the build with the list of valid
ones — never a silent fallback to the default config.

The generated `enigma_lib::build_config` module is unchanged in shape; the three
new sections join the existing ones as `build_config::{calls, contacts,
calendar}::ENABLED`.

---

## 5. How each new gate behaves

The three new flags follow the established `kanban`/`sketch`/`maps` precedent
exactly — nothing novel, three layers each:

| Layer | `calls.enabled: false` | `contacts.enabled: false` | `calendar.enabled: false` |
|---|---|---|---|
| Rust | the `enigma/vox/0` ALPN is not registered on the p2p router (an inbound call is refused at ALPN negotiation) and every `vox_*` command returns `CALLS_DISABLED` | the invite ALPN is not registered — a direct room invite from a Plus/Pro peer is refused at negotiation | — (meetings ride the chat channel's sync seam; no dedicated Rust surface) |
| Store | `useVoxCall` never instantiated (`chatStore.vox === null`) | `useRoomInvites` never instantiated | `useMeetings` never instantiated; no reminder tick |
| UI | no Calls tab, `/calls` redirects to `/chat`, no ring indicator, no call button in Contacts | no Contacts tab, `/contacts` redirects, no invite badge | no Calendar tab, `/calendar` redirects, no meeting badge |

Because the composables are the things that register sync handlers on the chat
channel, a flag-off build does not merely hide a surface — it never subscribes
to those message types at all. An incoming call offer or meeting invite from a
higher-edition peer is simply an unhandled sync type and is dropped.

Cross-edition rooms therefore degrade quietly rather than erroring: a Pro user
can schedule a meeting in a room containing Light users; those users see
nothing. That is the intended behaviour, but it is also the sharpest edge in
this design — see §6.

---

## 6. Known gaps / follow-ups

1. **Distinct installable products.** All three editions currently build as
   "Enigma" with bundle id `com.spectrumaipl.enigma`, because `build.rs`
   asserts `app.{name,identifier,version}` against `tauri.conf.json`. Shipping
   Light/Plus/Pro side by side needs per-edition `tauri.conf.json` variants (or
   a generated one) so they get distinct names, ids, and install paths.
2. **No cross-edition capability signalling.** A Pro peer cannot tell that a
   room member is on Light, so it cannot warn "3 members won't see this
   meeting". A capability byte in the MLS-carried presence/join payload would
   fix it; today the degradation is silent. Peer sync makes this sharper: a sync
   request to a Light or Plus peer is refused at ALPN negotiation and the
   requester cannot explain why (peer.md §6).
3. **Upgrade path.** Moving a profile from Light to Pro is "install the other
   build and point it at the same profile" — the vault format is
   edition-independent, so this works, but it is untested and undocumented.
4. **No tier UI.** Nothing in the app tells the user which edition they are
   running beyond which tabs exist. A line in Settings → About reading the
   already-available build config would be cheap.
5. **CI matrix.** CI builds the default config only. It should build all three
   (a config that fails validation is a build failure, so this catches config
   rot immediately).
6. **Per-edition caps are deliberately not used.** If a future tier wants, say,
   a bigger file-size default for Pro, note that `settings.*` clamps are safe to
   vary per edition but `network.max_frame_bytes` is **not** (§3).
