# Enigma onion-p2p — implementation plan (`TODO(onion-p2p)`)

Companion to `serverless_plan.md`. This is the executable breakdown of the
deferred **`TODO(onion-p2p)`** recorded at the top of
`apps/enigma/src-tauri/src/tor.rs` and in `serverless_plan.md` §"Deferred (TODOs)".

## Context

Enigma became a serverless P2P chat. Its only live transport is iroh-gossip
(`p2p_iroh.rs`); two people pair by sharing a QR code that carries an iroh
*ticket* (topic + name + `EndpointAddr`). Tor already ships as **plumbing only**:
`tor.rs` is an *outbound* Arti client (dial a `.onion`), compiled but unused.

The goal here is to add a **second, peer-hosted transport over Tor** so a QR can
carry a `.onion` address, and to expose it behind a **"use Tor" switch in
Settings** that governs both rendezvous (QR pairing) and chat. This gives users
network-level metadata protection (the threat model in `technology.md` currently
notes "Metadata protection (Tor): None today") without any app server — the
onion service is hosted *by a peer*, not by us.

### Confirmed design decisions

1. **Star topology (creator hosts + relays).** The room *creator* publishes one
   onion hidden service and acts as a relay; joiners *dial* the creator's
   `.onion` (they do not host). The creator re-broadcasts every received MLS
   frame to all other connected joiners. 1:1 is just the N=2 case. The creator
   only ever sees MLS **ciphertext** — relaying is pure byte fan-out, never a
   decrypt. Multi-peer gossip *mesh* over Tor stays out of scope (per the TODO).
2. **Tor-only, exclusive when on.** While the switch is on: host an onion
   service, new rooms' QR carries a `.onion`, all chat rides Tor; iroh is not
   used. (Trade-off: rooms paired earlier over iroh need a fresh QR pairing over
   Tor — they do not auto-migrate.)
3. **Transport-only scope.** Nothing is restored from `limbo/` — that directory
   holds only voice + file transfer. `limbo/rust/vox.rs` is used solely as a
   *code template* for the length-prefixed framing and the 2-party handshake.

### Why this fits without touching the frontend transport contract

Both transports emit the **same two events** with the same JSON shape, so the
frontend (`chatTransport.ts`, `useChatChannel.ts`, MLS) stays unchanged:

- `realtime://message` → `{ room, payload }` (payload = the UTF-8 JSON MLS envelope)
- `realtime://status` → `{ room, state, peers, peer_id }` where
  `state ∈ "connecting" | "connected" | "disconnected"`.

`realtime.rs` is the existing dispatch seam (today it delegates every command to
`p2p_iroh::*` after an airplane-mode gate). We add a `use_tor` flag and a Tor
backend behind the same seam.

---

## How arti is used to host the onion service

This is the net-new part. Today `tor.rs` only uses arti's **client** side
(`onion-service-client`) to *dial* onions. Hosting requires arti's **service**
side. All API below is arti **0.43** (the version already pinned in
`Cargo.toml`), verified against docs.rs 0.43.0.

### 1. Enable the hosting feature

`onion-service-service` on `arti-client` transitively pulls in everything needed
to host: `keymgr` (the persistent on-disk keystore that makes the `.onion`
*stable*), `tor-hsservice`, `tor-hscrypto`, and `tor-persist` (`state-dir`). We
also depend on a few arti sub-crates directly because `arti-client` does not
re-export all the hosting types we need to name.

```toml
# apps/enigma/src-tauri/Cargo.toml
arti-client = { version = "0.43", default-features = false, features = [
  "tokio", "rustls", "compression",
  "onion-service-client",   # existing — outbound dial (joiner side)
  "onion-service-service",  # NEW — hosting (pulls keymgr + tor-persist state-dir)
] }
tor-hsservice = "0.43"   # OnionServiceConfigBuilder, HsNickname, handle_rend_requests,
                         # StreamRequest, RunningOnionService
tor-hscrypto  = "0.43"   # HsId (the onion address)
tor-cell      = "0.43"   # relaycell::msg::Connected (accept), End (reject)
tor-proto     = "0.43"   # stream::IncomingStreamRequest (::Begin, .port())
```
Pin the sub-crates to the exact 0.43.x that `arti-client` resolves (`cargo tree`
to confirm). Keep the existing `typed-index-collections = "=3.3.0"` MSRV pin and
the Android `rusqlite { bundled }` workaround (see Risks).

### 2. Bootstrap a client with a per-profile state dir (the key to a *stable* `.onion`)

A hidden service's `.onion` is derived from its identity keypair. To keep the
same address across restarts (so an old QR still works), the keypair must
persist. arti persists it automatically in a disk keystore **when the client is
built from an on-disk state directory** — so we do NOT hand-manage keys.

```rust
use arti_client::{TorClient, config::TorClientConfigBuilder};
use tor_rtcompat::PreferredRuntime;

// per profile, alongside iroh_gossip.key / mls_*.bin
let state_dir = profile_dir(app, config).join("tor").join("state");
let cache_dir = profile_dir(app, config).join("tor").join("cache");
let cfg = TorClientConfigBuilder::from_directories(state_dir, cache_dir).build()?;
let client: TorClient<PreferredRuntime> = TorClient::create_bootstrapped(cfg).await?;
```
> Contrast with `tor.rs`, which builds from `TorClientConfig::default()` (no
> state dir) — fine for *outbound* dialing, but it would mint a **new onion every
> restart**, so hosting needs its own state-dir-backed client. `p2p_tor` owns
> this client and uses it for **both** hosting and joiner dials (one bootstrap).

### 3. Launch a hidden service and read our `.onion`

```rust
use tor_hsservice::{config::OnionServiceConfigBuilder, HsNickname, handle_rend_requests};

// Stable, per-room+profile nickname → stable keystore entry → stable onion.
// HS nicknames have a restricted charset, so derive from the room-name hash.
let nick = HsNickname::new(format!("enigma-{}", &blake3_hex(&name)[..16]))?;
let svc_cfg = OnionServiceConfigBuilder::default().nickname(nick).build()?;

let (service, rend_requests) = client.launch_onion_service(svc_cfg)?;
//  service:       Arc<RunningOnionService>   — keep alive; dropping it stops serving
//  rend_requests: impl Stream<Item = RendRequest>

// Our own address (use the explicit unredacted form — HsId's plain Display may redact):
let hsid = service.onion_address().ok_or("onion address not ready")?; // Option<HsId>
let onion = hsid.display_unredacted().to_string();                    // "xxxx….onion"
```
> **Return-shape caveat:** on 0.43 the rustdoc renders
> `launch_onion_service` as returning `Result<Option<(Arc<RunningOnionService>, impl Stream<…>)>>`
> while worked examples destructure a bare tuple. Write the `None → Err(...)` arm
> defensively so it compiles either way; match whatever the pinned compiler reports.

### 4. Accept inbound onion streams

`handle_rend_requests` turns the rendezvous stream into a stream of per-connection
`StreamRequest`s. We accept only our fixed virtual port and hand the resulting
`DataStream` to the join handshake + relay loop:

```rust
use tor_proto::stream::IncomingStreamRequest;
use tor_cell::relaycell::msg::Connected;
use futures_lite::StreamExt;

const ONION_PORT: u16 = 9999; // fixed virtual port; also carried in the ticket

let mut streams = handle_rend_requests(rend_requests); // impl Stream<Item = StreamRequest>
while let Some(req) = streams.next().await {
    match req.request() {
        IncomingStreamRequest::Begin(b) if b.port() == ONION_PORT => {
            let data_stream = req.accept(Connected::new_empty()).await?; // DataStream (AsyncRead+AsyncWrite)
            // → split, run the Hello/Ready handshake, add to the room's peer set,
            //   spawn a per-peer reader that delivers locally AND fans out to others.
        }
        _ => { req.shutdown_circuit()?; }
    }
}
```

### 5. Dial (joiner side) — reuses the existing outbound pattern

A joiner never hosts. It dials the creator's `.onion` exactly like `tor.rs`'s
`TorState::connect` does, but on the state-dir client:

```rust
let data_stream = client.connect((onion.as_str(), ONION_PORT)).await?; // DataStream
```

### 6. Latency & status

After launch the service descriptor must be published to the HSDirs before any
joiner can connect — **seconds to tens of seconds on first run** (much slower
than iroh's relay). Surface it honestly: emit `"connecting"` at launch and only
`"connected"` when the first joiner stream is accepted. Optionally drive finer
state from `RunningOnionService::status_events()` (`OnionServiceStatus`) to tell
"still bootstrapping / not yet reachable" apart from "reachable".

### 7. What the creator can and cannot see

The creator is a normal MLS chat participant **and** the relay. The relay path is
byte fan-out over the encrypted frames — it never has the MLS group secrets for
messages it forwards, so "the host only sees ciphertext" is structural, matching
iroh's "any relay hop only sees MLS ciphertext." The creator's own client
decrypts only its own delivered copy, unchanged.

---

## New module: `p2p_tor.rs`

Mirrors the `p2p_iroh.rs` public surface **exactly** so `realtime.rs` dispatches
uniformly. Managed in `lib.rs` via `.manage(p2p_tor::TorP2pState::default())`.

### State

```rust
#[derive(Default)]
pub struct TorP2pState(pub tokio::sync::Mutex<Option<Node>>);

pub struct Node {
    client: Arc<TorClient<PreferredRuntime>>,  // bootstrapped w/ per-profile state dir
    rooms: HashMap<String, RoomHandle>,        // key = room slug = blake3(name), same as iroh
}
enum RoomHandle { Host(HostRoom), Joiner(JoinerRoom) }

struct HostRoom {
    name: String,
    onion: String,
    _service: Arc<RunningOnionService>,        // keep alive; drop = stop serving
    peers: Arc<Mutex<Vec<PeerConn>>>,          // connected joiner write-halves (fan-out set)
    accept_task: JoinHandle<()>,
}
struct JoinerRoom {
    name: String,
    onion: String,                             // creator's onion = reconnect handle
    write: Arc<Mutex<WriteHalf<DataStream>>>,  // single stream to creator
    read_task: JoinHandle<()>,
}
struct PeerConn { id: String, write: Arc<Mutex<WriteHalf<DataStream>>> }
```
`DataStream` is split with `tokio::io::split`; write-halves live behind
`Arc<Mutex<…>>` for concurrent fan-out.

### Shared helpers (lift the *pattern* from `limbo/rust/vox.rs`)

- **Framing:** 4-byte LE length prefix + JSON body — `read_frame`/`write_frame`
  over generic `AsyncRead`/`AsyncWrite`. **Raise the cap from vox's 64 KB to
  16 MB** to match iroh's `max_message_size` (MLS image/voice envelopes exceed
  64 KB).
- **Handshake:** dialer sends `Hello { name, peer_id }`; host replies `Ready`.
  (Accept/decline can be added later; first cut auto-accepts.)
- **`room_for(name)`** = `TopicId::from_bytes(blake3(name)).to_string()` — the
  **same** slug iroh produces, so the transport-independent MLS session key
  (`profile:room:identity` in `lib.rs`) is identical whether a room is iroh or
  Tor.
- **`emit_message` / `emit_status`** copied verbatim from `p2p_iroh.rs` (same
  event names, same JSON).

### Public async fn surface (parallels iroh; `realtime.rs` wraps these)

```rust
pub async fn create_room(app, &TorP2pState, name: String) -> Result<(String, String)>; // (room, ticket)
pub async fn join_room(app, &TorP2pState, ticket: String, extra: Vec<String>) -> Result<(String, String)>;
pub async fn join_room_by_node(app, &TorP2pState, name: String, onions: Vec<String>) -> Result<String>; // = re-host
pub async fn leave_room(&TorP2pState, room: &str) -> Result<()>;
pub async fn broadcast(&TorP2pState, room: &str, payload: String) -> Result<()>;
pub async fn node_info(app, &TorP2pState) -> Result<String>; // host onion or ""
pub async fn shutdown(app, &TorP2pState);
```
Plus `ensure_started(app, state)` that lazily bootstraps the state-dir client
(mirrors iroh's `ensure_started`).

### Behavior

- **`create_room` (become host):** `ensure_started` → `launch_onion_service` with
  `nickname_for(name)` → wait for `onion_address()` → spawn accept loop → store
  `HostRoom` under `room_for(name)` → return
  `TorTicket { onion, port: ONION_PORT, name }.encode()`; emit `"connecting"`.
  One onion **per room** (simplest; rooms independently reachable).
- **Star relay (accept loop):** for each accepted stream — split, `read Hello`,
  `write Ready`, push a `PeerConn`, emit `"connected"` with `Some(hello.peer_id)`
  (the NeighborUp analog), then spawn a per-peer reader:
  `while let Some(frame) = read_frame(...)` → `emit_message` locally **and**
  `write_frame` to every *other* `PeerConn`. On EOF: drop the peer, emit
  `"connected"`(n>0) / `"disconnected"`(0).
- **`join_room` (dial creator):** `TorTicket::decode` → `client.connect((onion, port))`
  → split, send `Hello`, read `Ready` → store `JoinerRoom` + a reader loop that
  emits `realtime://message`. Emit `"connecting"` before dial, `"connected"`
  (peer_id = creator onion) after `Ready`. `extra` accepted for parity, unused
  (the onion is in the ticket).
- **`broadcast`:** *Host* → write to every `PeerConn`. *Joiner* → write to the
  single creator stream (the creator then delivers + fans out). Self-messages are
  pushed locally by the frontend, same as iroh.
- **`node_info`:** host room's `.onion`, else `""` (used only by the Settings
  "My identity" display).

### `peer_id` identity over Tor

Reconnect is onion-driven (below), so `peer_id` is presence/display only:
- Joiner sends a **stable per-profile random id** in `Hello` (persist 16 bytes at
  `profile_dir/tor_peer.id`, same idea as iroh's `load_or_create_secret`) so
  presence is stable across reconnects.
- Creator's `peer_id` (emitted by the joiner) = the creator's `.onion` — which is
  exactly the joiner's reconnect handle, so the frontend's `rememberPeerForRoom`
  persists something meaningful with zero frontend change.

---

## Ticket format & iroh-vs-Tor routing

postcard is not self-describing, so a Tor ticket and an iroh ticket would look
indistinguishable. Use a **1-byte magic tag** before the postcard bytes, then
base32(lowercase) — same envelope style as iroh's ticket:

```rust
#[derive(Serialize, Deserialize)]
struct TorTicket { onion: String, port: u16, name: String }

const TOR_TAG: u8 = 0x54; // 'T'
// encode: base32_nopad_lower( [TOR_TAG] ++ postcard(self) )
// decode: strip TOR_TAG, postcard::from_bytes
```

**Routing = sniff the ticket, not the switch** (most robust): on join,
`realtime.rs` base32-decodes and checks the first byte — `TOR_TAG` →
`p2p_tor::join_room`, otherwise → `p2p_iroh::join_room` (existing iroh tickets are
tagless and keep working). The `use_tor` switch only decides which transport you
**create/host** on. This prevents nonsensical pairings and makes join work
regardless of switch state. Add a small `fn ticket_is_tor(&str) -> bool` in
`realtime.rs`.

---

## The "use Tor" switch (Settings → rendezvous + chat)

One per-profile switch, following the existing **airplane-mode** toggle
end-to-end (the template is `offline`):

- **Rust state:** add `pub use_tor: bool` to `AppProfileState` in `lib.rs` (next
  to `offline`, `#[serde(default)]`), persisted in `profile_state.json` via the
  existing `load_profile_state`/`save_profile_state`. Add a `use_tor` getter
  beside `is_offline`.
- **Rust commands:** `app_get_use_tor` / `app_set_use_tor` shaped exactly like
  `app_get_offline` / `app_set_offline`; register both in `generate_handler!`.
  Toggling **tears down the other transport** so the next command re-binds on the
  chosen one:
  - on → `p2p_iroh::shutdown(app, &iroh)`
  - off → `p2p_tor::shutdown(app, &tor)`
- **Airplane mode:** extend `app_set_offline(true)` to tear down **both**
  transports.
- **`realtime.rs` dispatch:** after the existing `offline` gate, read `use_tor`.
  `create_room` / `send` / `leave_room` / `node_info` pick the backend by the
  flag; `join_room` picks by **ticket sniff**. Return types
  (`CreatedRoom` / `JoinedRoom`) are unchanged.
- **Frontend storage:** `getUseTor` / `setUseTor` (+ `LS_USE_TOR` browser
  fallback) in `packages/rakotis/src/services/appStorage.ts`, and `use_tor?` on
  its `AppProfileState` interface.
- **Settings UI:** a `role="switch"` block in
  `apps/enigma/src/views/EnigmaConfigView.vue`, copied from the offline switch
  (lines ~313-339) + an `onMounted` load; wired to `setUseTor`. New i18n keys
  (`useTor`, `useTorOnHint`, `useTorOffHint`) in `apps/enigma/src/i18n/en.ts`
  **and** `pl.ts`.
- **Rendezvous (QR):** `chat/useP2pRooms.ts` and `chat/P2pCreateRoom.vue` already
  render whatever ticket string `createRoom` returns, so an onion-bearing ticket
  flows through the existing QR generate/scan UX unchanged.

---

## Reconnect model over Tor

Onion addresses are **stable**, so reconnect = re-dial the saved onion (joiner)
or re-host under the same nickname → same keystore key → same onion (creator).
The one asymmetry vs iroh: the star has **roles**, so persistence must remember
who hosts.

- Add one optional field to `P2pRoomEntry` (`useChatChannel.ts`):
  `host?: boolean`. Set `host: true` in the create path, falsy in join.
- In `openP2pRoom(entry)`:
  - `entry.host` → call the **create** path (`chatTransport.createRoom(entry.name)`);
    re-launching the same nickname is idempotent (same onion from the keystore).
  - else → existing `chatTransport.joinRoom(entry.ticket, entry.peers)`, which
    for a Tor ticket re-dials the onion.
- The creator's `.onion` is already stored inside the ticket in each
  `P2pRoomEntry`, and the keystore persists the HS key on disk — so **no new
  transport-level persistence** is needed beyond the `host?` flag.
- `join_room_by_node` (the `name` + ids reconnect command) doesn't map to a Tor
  *joiner*; Tor reconnect goes through the ticket-based `openP2pRoom` path.
  `p2p_tor::join_room_by_node` is implemented as "re-host" so the command name
  still resolves. No command signature change.

---

## Lifecycle

- **`p2p_tor::shutdown`:** mirror iroh — take the `Node`, per room abort tasks and
  **drop `Arc<RunningOnionService>`** (stops serving + descriptor publishing) and
  drop peer streams; emit `"disconnected"` per room. Called by airplane mode and
  by switching Tor off. Next online command re-binds via `ensure_started`.
- **Stable HS key location:**
  `app_data_dir()/profiles/<profile>/tor/state/keystore/…` (from
  `TorClientConfigBuilder::from_directories`), beside the existing per-profile
  `iroh_gossip.key` and `mls_*.bin`.

---

## Files to modify / create

| File | Change |
|---|---|
| `apps/enigma/src-tauri/Cargo.toml` | add `onion-service-service` feature + `tor-hsservice`/`tor-hscrypto`/`tor-cell`/`tor-proto` = "0.43"; keep tid pin + Android bundled rusqlite |
| `apps/enigma/src-tauri/src/p2p_tor.rs` | **new** — state-dir client, onion hosting, star relay, `TorTicket`, framing/handshake, `emit_*`, full async fn surface |
| `apps/enigma/src-tauri/src/realtime.rs` | read `use_tor`; `ticket_is_tor` sniff; dispatch create/send/leave/node_info by flag, join by ticket type; same return DTOs |
| `apps/enigma/src-tauri/src/lib.rs` | `mod p2p_tor;` `.manage(TorP2pState::default())`; `use_tor` on `AppProfileState`; `app_get/set_use_tor`; extend `app_set_offline` teardown; register commands |
| `apps/enigma/src-tauri/src/tor.rs` | reference only (bootstrapped-client + outbound `connect` pattern the joiner reuses); no change required |
| `packages/rakotis/src/services/appStorage.ts` | `getUseTor`/`setUseTor` + `LS_USE_TOR`; `use_tor?` on `AppProfileState` interface |
| `apps/enigma/src/views/EnigmaConfigView.vue` | "use Tor" `role="switch"` copied from the offline switch + `onMounted` load |
| `apps/enigma/src/i18n/en.ts`, `pl.ts` | `useTor` / `useTorOnHint` / `useTorOffHint` keys |
| `packages/rakotis/src/useChatChannel.ts` | `host?: boolean` on `P2pRoomEntry`; set on create; branch `openP2pRoom` on it |

**Unchanged (contract holds):** `chatTransport.ts` event handling, all MLS
(`mls_*` / `RotorSession`), the QR generate/scan components.

---

## Risks / gotchas

- **fs-mistrust keystore permissions (most likely blocker).** The persistent
  keystore enforces strict directory permissions via `fs-mistrust`; on
  Windows/Android or a too-open app-data dir it refuses to load and the onion is
  not stable (or launch fails). Mitigation: relax via config (the storage
  permissions builder) or `ARTI_FS_DISABLE_PERMISSION_CHECKS=1`. Test on every
  target early.
- **sqlite `links="sqlite3"` collision.** `onion-service-service` adds
  `keymgr`/`tor-persist`/`tor-hsservice` but **no new sqlite** — `rusqlite` still
  comes only from `tor-dirmgr` (already handled by the Android bundled pin). No
  *new* collision, but re-verify the Android cross-link after the feature bump.
- **`typed-index-collections = "=3.3.0"` pin stays** — new arti crates still pull
  it transitively.
- **Build size/time & disk.** Hosting adds crates and lengthens the (already big
  iroh+arti) link; the existing `split-debuginfo = "unpacked"` dev profile
  mitigates linker-OOM. The giant Rust link is disk-sensitive on this machine —
  ensure free space (an ENOSPC here is not a code bug).
- **"Creator must be online" (accepted).** If the relay is offline the whole room
  is down for everyone, including 1:1; fan-out is O(N) per message on the creator.
  Document as a star-design tradeoff; surface descriptor-publish latency as
  `"connecting"` so first launch doesn't look hung.
- **`launch_onion_service` return shape** — write the `Option`/`None → Err` arm
  defensively (see hosting §3).

---

## Build order

1. **Cargo:** add the feature + sub-crates; `cargo tree` to confirm 0.43 match;
   keep tid pin + Android bundled rusqlite.
2. **`p2p_tor.rs` scaffold:** framing (16 MB cap) + `Hello`/`Ready` +
   `TorTicket` (tagged base32) + `room_for`/`nickname_for` + `emit_*` +
   `ensure_started` (state-dir client).
3. **Host side:** `create_room` + accept loop + per-peer reader/fan-out.
4. **Joiner + rest:** `join_room` (dial + handshake + reader), `broadcast`,
   `leave_room`, `node_info`, `shutdown`, `join_room_by_node` (re-host).
5. **`lib.rs`:** manage state, `use_tor` field, `app_get/set_use_tor`, extend
   airplane teardown, register commands.
6. **`realtime.rs`:** `use_tor` read, `ticket_is_tor` sniff, dispatch.
7. **Frontend:** `host?` on `P2pRoomEntry` + `openP2pRoom` branch; the Settings
   switch + i18n; no `chatTransport`/MLS changes.

## Verification (end-to-end)

Two dev instances with different `APP_PROFILE`s (`./run_dev.sh`):

1. **Stable onion:** turn "use Tor" on, create a room on A → QR shows a `.onion`
   ticket; note the address; restart A → recreating the same room yields the
   **same `.onion`** (keystore persisted).
2. **N=2 chat:** scan/paste A's onion ticket on B → both reach "Encrypted";
   exchange text + an image over Tor, no server running.
3. **N=3 relay fan-out:** join a third instance C to A's room; a message from B
   reaches C (relayed by host A) and vice-versa.
4. **Switch teardown:** flip "use Tor" off → Tor transport tears down; flip on →
   iroh tears down. Airplane mode tears down both.
5. **Rust tests:** `TorTicket` base32 round-trip + tag discrimination; framing
   read/write round-trip. `( cd apps/enigma/src-tauri && cargo test )`; `npm test`.

## Implementation notes (as built)

Deltas discovered while implementing + building against arti 0.43 and an
adversarial review of the diff:

- **arti API specifics:** `TorClient::create_bootstrapped` returns
  `Arc<TorClient>` (no extra `Arc::new`). `HsId` has **no plain `Display`** (it's
  redaction-safe) — the full `.onion` comes from `safelog::DisplayRedacted::display_unredacted()`,
  so `safelog = "0.8"` is a direct dep and `p2p_tor.rs` imports the trait.
  `launch_onion_service` returns `Result<Option<(Arc<RunningOnionService>, impl
  Stream<Item = RendRequest>)>>` — the `None → Err` arm is handled. The rend-request
  stream is `Box::pin`ned before `.next()`.
- **Ticket tagging is two-sided (review fix).** iroh tickets were tagless, so ~1/256
  (whose topic starts with `0x54`) would be misrouted to Tor and become unjoinable.
  Both tickets are now tagged: iroh `0x49`, Tor `0x54` (`p2p_iroh::IROH_TAG` /
  `p2p_tor::TOR_TAG`). iroh `decode` still accepts older untagged tickets.
- **Send routes by room ownership, not the switch (review fix).** Joining is by
  ticket sniff, so a room can be on the transport the switch does *not* select.
  `realtime_send` dispatches via `p2p_tor::has_room(room)` (else iroh), so a
  ticket-sniffed join can always send. `leave` calls both backends; create/
  join-by-node/node_info stay on the switch.
- **Relay identity is a per-connection `seq`**, not the (persisted, reusable)
  `peer_id` — a same-device redial can't alias a live stream in fan-out/removal.
- **Bounded writes/handshake:** fan-out writes use a 20 s timeout and the join
  handshake read a 30 s timeout, so one stalled onion circuit can't wedge the host
  or hang a join.

Verified locally: `cargo check` clean (no warnings), `cargo test` 21 pass (6 new
`p2p_tor` tests), `vitest` 70 pass (new `appStorage`/`torTicket` tests), `vue-tsc`
clean. The remaining end-to-end check (two live instances pairing over real Tor)
is the manual step in "Verification" above.

## References (arti 0.43)

- `arti-client` features (`onion-service-service` ⇒ keymgr/tor-persist/tor-hsservice): https://docs.rs/crate/arti-client/0.43.0/features
- `TorClient` (launch/create): https://docs.rs/arti-client/0.43.0/arti_client/struct.TorClient.html
- `TorClientConfigBuilder::from_directories`: https://docs.rs/arti-client/0.43.0/arti_client/config/struct.TorClientConfigBuilder.html
- `tor_hsservice` (`handle_rend_requests`, `RunningOnionService`, `HsNickname`, `OnionServiceConfig`): https://docs.rs/tor-hsservice/0.43.0/tor_hsservice/
- `RunningOnionService::onion_address`: https://docs.rs/tor-hsservice/0.43.0/tor_hsservice/struct.RunningOnionService.html
- `StreamRequest` (`request`, `accept(Connected)`, `reject`, `shutdown_circuit`): https://docs.rs/tor-hsservice/0.43.0/tor_hsservice/struct.StreamRequest.html
- `HsId` (`display_unredacted`): https://docs.rs/tor-hscrypto/0.43.0/tor_hscrypto/pk/struct.HsId.html
- Official arti example (`IncomingStreamRequest::Begin`, `begin.port()`, `Connected::new_empty()`): https://tpo.pages.torproject.net/core/doc/rust/src/axum_hello_world/main.rs.html
- Hosting example (`OnionServiceConfigBuilder`, launch tuple): https://github.com/jgraef/arti-axum
- P2P-chat-over-Tor (per-profile state dir for a stable onion): https://dev.to/mdenda/building-a-p2p-chat-over-tor-with-rusts-arti-client-39nf
