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

**In:** P2P MLS chat with QR/ticket pairing and persistent rooms · Tor
transport · P2P file transfer · per-file local locking + the notes and SVG editors ·
the encrypted-at-rest vault (passphrase gate, panic code, idle auto-lock,
airplane mode) · profile + settings + i18n.

**Out:** the DHT, Contacts, voice calls, calendar, maps, Enigma Cloud,
multi-device linking.

**Who it's for:** the user who wants one thing to work and to be able to explain
what the app does in a sentence. Also the smallest binary and the smallest
audit surface — the natural default for a high-risk user.

### Enigma Plus — "chat, and talk"

Light plus exactly one thing: **1:1 voice calls** (the **Vox** tab — `vox`,
riding the room's MLS group).

**Out:** everything Light is out, minus calls. No DHT, no Contacts, no device
linking, no calendar/maps/Cloud.

**Who it's for:** the user who wants voice without acquiring a directory, a
contact list, or a second device to keep in sync. Reachability is Light's:
QR/ticket first, then reconnect to the saved NodeId via n0 discovery — so a call
starts from a ticket or from someone already in a room with you. There is
deliberately no "call a nickname", because there is no nickname directory.

### Enigma Pro — "the collaboration suite"

Everything. Plus, extended with the discovery layer, the shared-workspace
features and the optional self-hosted server client.

**Adds:** **DHT discovery** (ticketless join-by-room-code, the nickname
directory, presence) · **Contacts** (built on that: presence, nickname search,
direct room invites with Accept/Decline) · **multi-device linking** (the user's
own devices converge over pure P2P — no third party) · **Peer sync** (scoped,
revocable person-to-person links — see [peer.md](peer.md)) · **Calendar**
(meetings + scheduling polls) · **Maps** (offline region packages) ·
**Enigma Cloud** (client for the user's *own* self-hosted server).

**Who it's for:** teams and organisations running Enigma as their working
surface, and the only edition where `cloud.allow_connections` defaults to true —
the one edition whose users have deliberately stood up their own infrastructure.
It is also the only edition that touches a public network the user does not
control (the Mainline DHT), which is the other reason discovery lives here.

---

## 2. Feature matrix

| Feature | Light | Plus | Pro | Gate |
|---|:--:|:--:|:--:|---|
| P2P MLS chat, QR/ticket pairing, room persistence | ✅ | ✅ | ✅ | — (always) |
| Tor onion transport | ✅ | ✅ | ✅ | — |
| Hosted relays + pkarr discovery | ✅ | ✅ | ✅ | `p2p.allow_hosted_relays` |
| P2P file transfer | ✅ | ✅ | ✅ | — |
| Local locked files + notes and SVG editors | ✅ | ✅ | ✅ | — |
| Vault, panic code, idle lock, airplane mode | ✅ | ✅ | ✅ | — |
| **Vox** (1:1 voice calls) | ❌ | ✅ | ✅ | `calls.enabled` |
| **DHT discovery** (room codes, nick directory, presence) | ❌ | ❌ | ✅ | `dht.enabled` |
| **Contacts** (presence, nick search, invites) | ❌ | ❌ | ✅ | `contacts.enabled` |
| Multi-device linking | ❌ | ❌ | ✅ | `devices.allow_linking` |
| **Calendar** (meetings + polls) | ❌ | ❌ | ✅ | `calendar.enabled` |
| **Maps** | ❌ | ❌ | ✅ | `maps.enabled` |
| **Key ring** (one passphrase, many locked files) | ❌ | ❌ | ✅ | `keyring.enabled` |
| **Peer sync** (scoped person-to-person links) | ❌ | ❌ | ✅ | `peers.enabled` |
| **Enigma Cloud** | ❌ | ❌ | ✅ | `cloud.allow_connections` |

The Kanban board, Sketch board and Mind map were Pro features until 2026-07-27,
when they were **parked** (no maintenance capacity) — code, tests and docs kept
under `limbo/frontend/{kanban,sketch,mind}/` with restore checklists. Their
build-config sections and flags are gone with them; restoring a feature re-adds
its section, so the matrix would gain its row back.

Two separate gates, easy to confuse:

- **`p2p.allow_hosted_relays`** is `true` in every edition and stays that way.
  It buys the n0 relay fallback and pkarr/DNS discovery — which is what makes
  NAT-to-NAT pairing work and lets a saved NodeId still be resolved after a
  restart. Turning it off would break plain chat reconnection in *every*
  edition, so it is not the lever for shipping a smaller product.
- **`dht.enabled`** (Pro only) is the lever. It gates the Mainline DHT alone:
  ticketless join-by-room-code, the nickname directory, and presence. Light and
  Plus therefore pair by QR/ticket and reconnect by saved NodeId, which is the
  ordinary path anyway — what they lose is the short room code and the ability
  to find someone by name.

Even in Pro the DHT stays **opt-in per profile** (`features.dht_discovery:
false`): the build gate only decides whether the toggle can be offered, and
nothing is published to a public network until the user asks for it.

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

The generated `enigma_lib::build_config` module is unchanged in shape; the
feature sections join the existing ones as `build_config::{calls, contacts,
calendar, dht}::ENABLED`.

---

## 5. How each gate behaves

Each flag follows the established `maps` precedent — nothing novel, three
layers each:

| Layer | `calls.enabled: false` | `contacts.enabled: false` | `calendar.enabled: false` |
|---|---|---|---|
| Rust | the `enigma/vox/0` ALPN is not registered on the p2p router (an inbound call is refused at ALPN negotiation) and every `vox_*` command returns `CALLS_DISABLED` | the invite ALPN is not registered — a direct room invite from a Pro peer is refused at negotiation | — (meetings ride the chat channel's sync seam; no dedicated Rust surface) |
| Store | `useVoxCall` never instantiated (`chatStore.vox === null`) | `useRoomInvites` never instantiated | `useMeetings` never instantiated; no reminder tick |
| UI | no Vox tab, `/vox` redirects to `/chat`, no ring indicator, no call button in Contacts | no Contacts tab, `/contacts` redirects, no invite badge | no Calendar tab, `/calendar` redirects, no meeting badge |

`dht.enabled: false` is shaped a little differently, because the DHT is a
capability rather than a tab:

| Layer | `dht.enabled: false` |
|---|---|
| Rust | `p2p_dht::discovery_enabled` and `nick_publish_enabled` return false **before** reading the user's setting, which is the single choke point for the `DhtHandle`, `DhtAddressLookup`, the rendezvous publisher/resolver, the nick publisher and room-code minting. On top of that `dht_presence` / `dht_publish_nick` / `dht_find_nick` / `dht_apply` fail fast with `DHT_DISABLED`, so a stray call cannot even bind the endpoint. `dht_status` and `dht_room_code` stay silent instead — each already has a total "nothing here" value in its own return type. |
| Frontend | `getDhtDiscovery` / `getDhtNickPublish` / `getDhtStatus` in rakotis apply the same gate ahead of the same kv read, so every consumer goes inert at once — including `useRoomInvites`, which then prefers a Pro peer's **ticket** over the room code it also sends. |
| UI | no Settings→Connections DHT card, no nickname claim / find-people / presence surfaces in Contacts, no call-by-nickname in Vox, no room-code field in create or room-info. Hidden, not disabled: every off-state string points at the Settings card, which is exactly what this build lacks. |

Because the composables are the things that register sync handlers on the chat
channel, a flag-off build does not merely hide a surface — it never subscribes
to those message types at all. An incoming call offer or meeting invite from a
higher-edition peer is simply an unhandled sync type and is dropped.

Cross-edition rooms therefore degrade quietly rather than erroring: a Pro user
can schedule a meeting in a room containing Light users; those users see
nothing. That is the intended behaviour, but it is also the sharpest edge in
this design — see §6.

One place where quiet degradation was **not** enough: a room joined by code
stores that code as its credential, and `p2p:rooms` replicates over the
device-link rail. Reopening such a room in a DHT-less build would hit
`join_room_by_code` and strand it — and chat auto-reopens the most recent room
at boot, so it would present as a red banner on first launch. `realtime_join_room`
therefore recovers the room name from the code (the topic is `blake3(name)`,
which the code carries) and reconnects by persisted NodeIds instead.

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
5. **CI matrix.** CI builds the default config only, and `run_dev.sh` defaults
   to `pro` — both DHT-on, cloud-on, everything-on. Nothing in routine use
   exercises a flag-*off* build, so an edition-only regression would ship
   unnoticed; `tests/component/dhtGate.test.ts` is the only standing guard.
   CI should build all three (a config that fails validation is a build failure,
   so this catches config rot immediately).
6. **A `const` makes code dead, not absent.** §1 promises a feature "is not in
   that binary", and for tabs/composables that holds. It does not yet hold for
   the DHT: `dht.enabled: false` makes every path unreachable, but iroh's
   `address-lookup-pkarr-dht` feature and the `mainline` crate are still linked
   into a Light binary. Honest wording today is "unreachable"; making it true
   needs a `#[cfg(feature)]` split in `Cargo.toml`, which is the same gap
   `maps.rs` and `vox.rs` have.
7. **Per-edition caps are deliberately not used.** If a future tier wants, say,
   a bigger file-size default for Pro, note that `settings.*` clamps are safe to
   vary per edition but `network.max_frame_bytes` is **not** (§3).
