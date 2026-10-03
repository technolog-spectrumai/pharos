# Enigma26 product line — Basic / Standard / Professional

One codebase, three shipped products. Every edition is the same binary source
built with a different **compile-time build config**; there is no runtime
licence check, no server-side entitlement, and no dormant code path waiting for
an unlock. A feature that is not in an edition is **not in that binary**: its
tab is absent, its route redirects, its composable is never instantiated, and
its Rust commands fail fast with a `*_DISABLED` error.

That property is the whole point. Enigma26's pitch is a serverless, auditable,
end-to-end-encrypted client — an edition that merely *hides* features would
mean every user still ships the attack surface of every feature. Gating at
build time keeps each edition's surface honest.

**Related docs:** [build.md](build.md) (how to build each edition) ·
[technology.md](technology.md) (§14–§15: where each config value canonically
lives) · [README.md](README.md) (orientation).

---

## 1. The three editions

*(Until 2026-08-18 the line was Light / Plus / Pro; those editions were
replaced wholesale by the presets below — different names AND different
compositions, e.g. contacts and calendar moved into the entry edition. The
editions no longer carry separate bundle identifiers either: all three now
declare `com.spectrumaipl.enigma26` and replace one another (§3, §6.1). An app
installed from the older `com.spectrumaipl.enigma` id is untouched by a new
build and has to be migrated by hand — see
[build.md](build.md#one-fixed-app-identity).)*

### Enigma26 Basic — "the private organiser"

The offline-first core: everything that works without any third-party
infrastructure, plus the personal-organisation surface.

**In:** P2P MLS chat with QR/ticket pairing and persistent rooms · Tor
transport · P2P file transfer · per-file local locking + the notes and SVG
editors · the encrypted-at-rest vault (passphrase gate, panic code, idle
auto-lock, airplane mode) · **Contacts** · **Calendar** (meetings + polls) ·
**PIN unlock** · profile + settings + i18n.

**Out:** hosted relays and pkarr discovery, the DHT, the key ring, voice calls,
maps.

**The honest consequence of "no relays":** pairing works anywhere (the
QR/ticket carries addresses), but *reconnecting to a saved NodeId across
different networks does not* — with `p2p.allow_hosted_relays: false` the iroh
endpoint registers no lookup service at all, so rooms reconnect on the same
LAN or over Tor. That is the point of this edition: zero third-party
infrastructure, and the trade is stated rather than hidden.

**Who it's for:** the user who wants a private organiser and messenger with
the smallest possible audit surface, and who either shares a network with
their peers or runs Tor.

### Enigma26 Standard — "the connected messenger"

Basic plus the connectivity layer.

**Adds:** **hosted relays + pkarr discovery** (NAT-to-NAT pairing, reconnect
to a saved NodeId from anywhere) · **the Mainline DHT** (ticketless
join-by-room-code, the nickname directory, presence — still opt-in per
profile) · **Key ring** (one passphrase, many locked files) · **Vox** (1:1
voice calls).

**Who it's for:** the ordinary case — people on different networks who want
calls and reliable reconnection, accepting n0's relay/DNS infrastructure and
the (opt-in) public DHT in exchange.

### Enigma26 Professional — "the collaboration suite"

Standard plus **Maps** (offline region packages, P2P region sharing, the
shared location layer).

**Who it's for:** teams running Enigma26 as their working surface. Nothing here
touches any infrastructure Standard does not already touch — since Enigma26
Cloud was deleted (2026-08, technology.md §16) no edition speaks to an
application server, so Professional's threat model is Standard's plus a
larger local surface.

---

## 2. Feature matrix

| Feature | Basic | Standard | Professional | Gate |
|---|:--:|:--:|:--:|---|
| P2P MLS chat, QR/ticket pairing, room persistence | ✅ | ✅ | ✅ | — (always) |
| Tor onion transport | ✅ | ✅ | ✅ | — |
| P2P file transfer | ✅ | ✅ | ✅ | — |
| Local locked files + notes and SVG editors | ✅ | ✅ | ✅ | — |
| Vault, panic code, idle lock, airplane mode | ✅ | ✅ | ✅ | — |
| **Contacts** (saved peers, direct room invites) | ✅ | ✅ | ✅ | `contacts.enabled` |
| **Calendar** (meetings + polls) | ✅ | ✅ | ✅ | `calendar.enabled` |
| **PIN unlock** (keypad re-unlock after idle lock) | ✅ | ✅ | ✅ | `lock.pin_unlock` |
| Hosted relays + pkarr discovery | ❌ | ✅ | ✅ | `p2p.allow_hosted_relays` |
| **DHT discovery** (room codes, nick directory, presence) | ❌ | ✅ | ✅ | `dht.enabled` |
| **Key ring** (one passphrase, many locked files) | ❌ | ✅ | ✅ | `keyring.enabled` |
| **Vox** (1:1 voice calls) | ❌ | ✅ | ✅ | `calls.enabled` |
| **Maps** | ❌ | ❌ | ✅ | `maps.enabled` |

The Kanban board, Sketch board and Mind map were features of the top edition until 2026-07-27,
when they were **parked** (no maintenance capacity) — code, tests and docs kept
under `limbo/frontend/{kanban,sketch,mind}/` with restore checklists. Their
build-config sections and flags are gone with them; restoring a feature re-adds
its section, so the matrix would gain its row back.

**Multi-device linking** (gate `devices.allow_linking`, a row in all three
editions) and **peer sync** (gate `peers.enabled`, a Standard-and-up row) were
**parked on 2026-08-18** the same way: frontend under
`limbo/frontend/{devices,peers}/`, Rust under `limbo/rust/{devices,peers}/`,
plans at [limbo/frontend/devices/sync.md](limbo/frontend/devices/sync.md),
[limbo/frontend/devices/fsync.md](limbo/frontend/devices/fsync.md) and
[limbo/frontend/peers/peer.md](limbo/frontend/peers/peer.md). Peer sync went for
a reason beyond capacity: a grant persisted a 32-byte pairwise link key per
contact, so every contact added standing key material to the vault, and the
feature cost more to maintain than it returned. Both gates and the
`devlink_pair_window_secs` / `devlink_resync_secs` / `peer_resync_secs` settings
are gone from every build config — a restore re-adds them, and with them the
matrix rows. Device linking is being reimplemented from scratch, so treat the
parked code as a record rather than a design to return to.

**Enigma Cloud** — the client for the user's own self-hosted faros server — was a
top-edition row here (gate `cloud.allow_connections`) until 2026-08, when it was
**deleted**, not parked: no `limbo/` copy, no flag, no YAML to restore
(technology.md §16). It is the one feature this matrix has lost outright rather
than gated away, and the reason no edition now contains any code that speaks to
an application server. Its commercial slot in [price.md](price.md) needs the same
treatment — see that document's §9.

Two separate gates, easy to confuse:

- **`p2p.allow_hosted_relays`** (Standard and up) buys the n0 relay fallback
  and pkarr/DNS discovery — NAT-to-NAT pairing, and resolving a saved NodeId
  after a restart from a different network. Basic turns it off deliberately:
  zero third-party infrastructure, at the stated cost of off-LAN reconnection
  (§1).
- **`dht.enabled`** (Standard and up, and it requires relays — build.rs
  rejects the combination without them) gates the Mainline DHT alone:
  ticketless join-by-room-code, the nickname directory, and presence.

Even in Professional the DHT stays **opt-in per profile** (`features.dht_discovery:
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
  must agree on it, and a Basic user must be able to sit in a room with a
  Professional
  user. Never diverge this per edition.
- **Settings clamps.** Same defaults and bounds for every user-tunable setting,
  including ones whose feature is off in that edition (`map_storage_limit_mb`
  is still a required, validated field in the Basic config — it is simply
  never read).
- **App identity.** All three declare `name: Enigma26`,
  `identifier: com.spectrumaipl.enigma26`, and the same version (0.1.6 today),
  because Android installs by Gradle `applicationId` and `build.rs` rejects any
  drift between the build config and `tauri.conf.json`. Editions replace the
  same app instead of installing side by side. The version is bumped with the
  code, never chosen per build — it is carried identically by `tauri.conf.json`,
  `Cargo.toml`, the three `package.json` files, `build_config.yaml` and every
  YAML in `configs/`; `build.yaml` has no key for it. The app **icon** is
  fixed the same way and for the same reason: one mark, committed with the
  code — see [icons.md](icons.md).

---

## 4. Selecting an edition at build time

`src-tauri/build.rs` resolves its YAML from the `ENIGMA_EDITION` environment
variable:

```
ENIGMA_EDITION unset  →  src-tauri/build_config.yaml               (unchanged default)
ENIGMA_EDITION=basic         →  src-tauri/configs/build_config.basic.yaml
ENIGMA_EDITION=standard      →  src-tauri/configs/build_config.standard.yaml
ENIGMA_EDITION=professional  →  src-tauri/configs/build_config.professional.yaml
ENIGMA_EDITION=custom        →  src-tauri/configs/build_config.custom.yaml
```

`custom` is not a fourth product: it is a local feature set of your own
(gitignored, absent from a fresh checkout), for experiments. Nothing checks
that its gates match one of the three editions, so it is not something to ship
under a product name.

A build names its edition in [build.yaml](build.yaml) — `apps.enigma.edition:
basic` — and `./build.sh` sets the variable from it. Dev runs and bare cargo
take it from the environment:

```bash
./build.sh enigma                                # release bundle, edition from build.yaml
ENIGMA_EDITION=professional ./run_dev.sh         # dev run, Professional
ENIGMA_EDITION=standard ( cd apps/enigma/src-tauri && cargo build )
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
| Rust | the `enigma/vox/0` ALPN is not registered on the p2p router (an inbound call is refused at ALPN negotiation) and every `vox_*` command returns `CALLS_DISABLED` | the invite ALPN is not registered — a direct room invite from a contacts-capable peer is refused at negotiation | — (meetings ride the chat channel's sync seam; no dedicated Rust surface) |
| Store | `useVoxCall` never instantiated (`chatStore.vox === null`) | `useRoomInvites` never instantiated | `useMeetings` never instantiated; no reminder tick |
| UI | no Vox tab, `/vox` redirects to `/chat`, no ring indicator, no call button in Contacts | no Contacts tab, `/contacts` redirects, no invite badge | no Calendar tab, `/calendar` redirects, no meeting badge |

`dht.enabled: false` is shaped a little differently, because the DHT is a
capability rather than a tab:

| Layer | `dht.enabled: false` |
|---|---|
| Rust | `p2p_dht::discovery_enabled` and `nick_publish_enabled` return false **before** reading the user's setting, which is the single choke point for the `DhtHandle`, `DhtAddressLookup`, the rendezvous publisher/resolver, the nick publisher and room-code minting. On top of that `dht_presence` / `dht_publish_nick` / `dht_find_nick` / `dht_apply` fail fast with `DHT_DISABLED`, so a stray call cannot even bind the endpoint. `dht_status` and `dht_room_code` stay silent instead — each already has a total "nothing here" value in its own return type. |
| Frontend | `getDhtDiscovery` / `getDhtNickPublish` / `getDhtStatus` in rakotis apply the same gate ahead of the same kv read, so every consumer goes inert at once — including `useRoomInvites`, which then prefers a DHT-capable peer's **ticket** over the room code it also sends. |
| UI | no Settings→Connections DHT card, no nickname claim / find-people / presence surfaces in Contacts, no call-by-nickname in Vox, no room-code field in create or room-info. Hidden, not disabled: every off-state string points at the Settings card, which is exactly what this build lacks. |

Because the composables are the things that register sync handlers on the chat
channel, a flag-off build does not merely hide a surface — it never subscribes
to those message types at all. An incoming call offer or meeting invite from a
higher-edition peer is simply an unhandled sync type and is dropped.

Cross-edition rooms therefore degrade quietly rather than erroring: a
Professional user can share a map region into a room containing Basic users;
those users see
nothing. That is the intended behaviour, but it is also the sharpest edge in
this design — see §6.

One place where quiet degradation was **not** enough: a room joined by code
stores that code as its credential, so the room outlives the build that joined
it — move the profile to a DHT-less edition (§6.3) and the saved room comes
with it. Reopening it would hit `join_room_by_code` and strand it, and chat
auto-reopens the most recent room at boot, so it would present as a red banner
on first launch. `realtime_join_room` therefore recovers the room name from the
code (the topic is `blake3(name)`, which the code carries) and reconnects by
persisted NodeIds instead.

---

## 6. Known gaps / follow-ups

1. **One installable app identity.** All three editions intentionally build as
   `Enigma26` with bundle id / Android package id `com.spectrumaipl.enigma26`.
   Editions replace the same app and share the same app-data root; side-by-side
   Basic/Standard/Professional installs are not a supported product shape.
2. **No cross-edition capability signalling.** A Professional peer cannot tell
   that a room member is on Basic, so it cannot warn "3 members won't see this
   meeting". A capability byte in the MLS-carried presence/join payload would
   fix it; today the degradation is silent.
3. **Upgrade path.** Moving a profile from Basic to Professional is "install the other
   build and point it at the same profile" — the vault format is
   edition-independent, so this works, but it is untested and undocumented.
4. **No tier UI.** Nothing in the app tells the user which edition they are
   running beyond which tabs exist. A line in Settings → About reading the
   already-available build config would be cheap.
5. **CI matrix.** CI builds the default config only, and `run_dev.sh` /
   `run2.sh` default to `ENIGMA_EDITION=professional` — both DHT-on,
   everything-on. Nothing in routine use
   exercises a flag-*off* build, so an edition-only regression would ship
   unnoticed; `tests/component/dhtGate.test.ts` is the only standing guard.
   CI should build all three (a config that fails validation is a build failure,
   so this catches config rot immediately).
6. **A `const` makes code dead, not absent.** §1 promises a feature "is not in
   that binary", and for tabs/composables that holds. It does not yet hold for
   the DHT: `dht.enabled: false` makes every path unreachable, but iroh's
   `address-lookup-pkarr-dht` feature and the `mainline` crate are still linked
   into a Basic binary. Honest wording today is "unreachable"; making it true
   needs a `#[cfg(feature)]` split in `Cargo.toml`, which is the same gap
   `maps.rs` and `vox.rs` have.
7. **Per-edition caps are deliberately not used.** If a future tier wants, say,
   a bigger file-size default for Professional, note that `settings.*` clamps are safe to
   vary per edition but `network.max_frame_bytes` is **not** (§3).
