# Enigma — captain election for the Tor onion host

Companion to [tor.md](tor.md). Plan for electing the onion **captain** (host +
relay) automatically instead of hardcoding it to the room creator, with failover,
plus a ★ badge on the captain in the participant list.

## Context

The Tor onion transport ([p2p_tor.rs](apps/enigma/src-tauri/src/p2p_tor.rs)) uses a
**star**: the room *creator* launches one onion service and relays MLS ciphertext;
joiners dial the creator's `.onion`. That makes the creator a **fixed, manual
"captain" and a single point of failure** — if the creator goes offline, the whole
room is down (see the star-limitation note in tor.md, and `todo.md` §2).

Goal: **elect the captain automatically** (lowest identity among members) and **fail
over** when the captain leaves or crashes, so hosting isn't tied to whoever created
the room. Also: when the local user is the captain, show a ★ on their profile row.

The hard constraint: **Tor has no discovery.** If the relay dies, every star
connection drops and there is no way to "look up" a replacement — you can only dial
a `.onion` you already know. So recovery is possible *only* if other members were
**already hosting** onions **and the group already knew their addresses**. This
forces the core design below.

### Decisions (confirmed)

1. **Captain = lowest MLS identity** among members whose onion is currently known
   and reachable. Reuse the existing deterministic leader rule (`members().sort()[0]`
   from the leave path, [useChatChannel.ts:224](packages/rakotis/src/useChatChannel.ts#L224)),
   **not** the join-path `ourId < theirId` (which races in 3+ groups). The user's
   "lowest NodeId" maps to the MLS identity — the stable per-member id we have when
   iroh is off (iroh NodeIds don't exist over Tor).
2. **Every member pre-hosts its own onion** for the room and shares its `.onion`
   over the encrypted **presence** message. Forced by Tor's lack of discovery.
3. **Full failover incl. crash.** On the captain leaving *or* becoming unreachable
   (its transport connection dropping past a retry budget), members auto re-elect
   the next-lowest reachable member and re-dial its already-published onion. The
   current admin also evicts a crashed captain from the MLS group (reuse
   `handlePeerLeave` / `removeMember`) so the roster + star converge.
4. **★ badge: participant rows, Tor rooms only** (including the user's own row when
   they host). No star on iroh rooms.

## Design overview — "everyone hosts, one relay, re-pointable dial"

Each member of a Tor room simultaneously:
- **Hosts its own onion** and runs an accept/relay loop **always** (so any member
  can be dialed the instant it becomes captain — no ~30s descriptor-publish delay
  at failover). Non-captains simply receive no inbound dials.
- **Maintains one outbound dial to the current captain** — unless it *is* the
  captain (then it only hosts + relays its inbound peers).

Changing captain = every non-captain **re-points its single outbound dial** to the
new captain's onion. The captain relays among its inbound peers exactly as today.
The onion directory (MLS-id → `.onion`) is built from encrypted presence messages,
so every member can compute the same election locally.

This keeps the steady-state message flow byte-for-byte identical to the current
star (captain relays; a joiner's frame reaches the captain + all other joiners,
never echoing to itself). Only the *wiring* becomes dynamic.

---

## A. Transport changes — [p2p_tor.rs](apps/enigma/src-tauri/src/p2p_tor.rs)

### A.1 Unified per-room state (replaces the `Host`/`Joiner` enum)

```rust
struct MemberRoom {
    name: String,
    my_onion: String,                                  // my always-published onion
    _service: Arc<RunningOnionService>,                // drop = stop serving
    peers: Arc<Mutex<Vec<PeerConn>>>,                  // inbound relay set (used when I'm captain)
    accept_task: JoinHandle<()>,                       // ALWAYS running (create + join)
    outbound: Arc<Mutex<Option<Outbound>>>,            // dial to captain; None ⇒ I am captain
}
struct Outbound {
    captain_onion: String,
    write: Arc<Mutex<Option<WriteHalf<DataStream>>>>,  // None while (re)connecting
    task: JoinHandle<()>,                              // connection manager: dial+handshake+read+retry
}
```
`Node.rooms` becomes `HashMap<String, MemberRoom>`. `PeerConn` unchanged (still
keyed on per-connection `seq`).

### A.2 Two extracted helpers (reused by create + join)

- `host_onion(app,state,room,name) -> (my_onion, service, peers, accept_task)` — lifts
  the service-launch + accept loop out of today's `create_room`.
- `dial_and_handshake(client,onion,name,my_id) -> (ReadHalf, WriteHalf)` — lifts the
  `Hello`→`Ready` dial out of today's `join_room`; reused on every reconnect.

### A.3 `create_room` / `join_room` — both host, both return `my_onion`

```rust
pub async fn create_room(..) -> Result<(String /*room*/, String /*ticket*/, String /*my_onion*/)>;
pub async fn join_room(..)   -> Result<(String /*room*/, String /*name*/,  String /*my_onion*/)>;
```
- `create_room`: `host_onion`, install `MemberRoom{ outbound: None }` (creator is the
  sole member ⇒ trivially captain).
- `join_room`: **`host_onion` AND** dial the ticket onion (initial captain) via the
  connection manager (A.5); install `MemberRoom` with that `Outbound`.
- Both surface `my_onion` so the frontend can announce it in presence.

### A.4 New `set_captain` — the reconciliation entry point

```rust
pub async fn set_captain(app,state, room:&str, captain_onion:String) -> Result<()>;
```
Snapshot under the lock, dial outside it (Tor is slow — mirrors existing lock
discipline). Cases:
- `captain_onion == my_onion` → I'm captain: abort + clear any outbound (host-only).
- unchanged target → no-op (prevents redial blips on stable elections).
- new/changed → abort old outbound task, spawn a fresh connection manager for the
  new onion.

Idempotent; safe to call on every roster refresh (the frontend only calls it when
the elected captain actually changes).

### A.5 Connection manager (replaces `spawn_joiner_reader`) — retry + death signal

Owns dial → handshake → read-loop → reconnect for one outbound. Publishes the live
write-half into the shared `write` slot; on stream drop, retries with exponential
backoff (`MAX_CAPTAIN_RETRIES = 3`, base 2s → 4s → 8s, cap ~15s, reset on any
healthy connect). Only after the budget is exhausted does it emit the **death
signal** (so a slow Tor dial doesn't instantly declare the captain dead). Because
`set_captain` aborts this task on captain change, an in-flight redial for a
superseded captain is cancelled cleanly.

### A.6 `broadcast`

"Outbound if present, else fan out to inbound peers." Snapshot targets under the
lock, write after dropping it. If the outbound write-slot is `None` (mid-reconnect),
drop the frame best-effort (same semantics as today). At steady state only the
captain has inbound peers and every non-captain has exactly one outbound ⇒ relay
behaviour is the old star. `spawn_peer_reader` (relay fan-out) unchanged.

### A.7 Death-signal event (backward compatible)

Add an **optional** `reason` to the status event; keep `emit_status` as a wrapper
passing `reason=None` so all other call sites and old listeners are untouched:

```
realtime://status { room, state:"disconnected", peers:0, peer_id:<dead onion>, reason:"captain_unreachable" }
```

### A.8 Lifecycle touch-ups

`leave_room` / `shutdown`: abort `accept_task` **and** the outbound task. `node_info`:
return the first room's `my_onion`. `join_room_by_node`: adjust for the new 3-tuple.

---

## B. Command layer — [realtime.rs](apps/enigma/src-tauri/src/realtime.rs) + [lib.rs](apps/enigma/src-tauri/src/lib.rs)

- `CreatedRoom` / `JoinedRoom`: add `onion: String` (iroh branch passes `""`).
- Wire the new 3-tuples from `p2p_tor::create_room` / `join_room`.
- New command `realtime_tor_set_captain(app,config,tor, room, captain_onion)` →
  `p2p_tor::set_captain` (offline-gated). Register it in `generate_handler!` in
  `lib.rs` (`TorP2pState` is already managed).

---

## C. Bridge — [chatTransport.ts](packages/rakotis/src/chatTransport.ts)

- `CreatedRoom` / `JoinedRoom`: add `onion: string`.
- `StatusHandler`: append an optional `reason?` 4th arg (backward compatible);
  forward `e.payload.reason` from the `realtime://status` listener.
- Add `setCaptain(room, captainOnion): void` to the interface + gateway
  (`invoke("realtime_tor_set_captain", …)`) + the browser stub (no-op).

---

## D. Frontend orchestration — [useChatChannel.ts](packages/rakotis/src/useChatChannel.ts)

### D.1 New reactive state
```ts
const myOnion = ref("");                     // my onion for the current room
const currentRoomIsTor = ref(false);         // gate: only Tor rooms get captain logic
const currentCaptainOnion = ref<string|null>(null); // last onion pushed to setCaptain (change detector)
const deadCaptains = new Set<string>();      // MLS ids currently believed dead
```
Extend `presenceById` values to `{ name, avatar, onion }`. Extend `P2pRoomEntry`
with `tor?: boolean` and `onion?: string`.

### D.2 Source my onion & transport flag at every room-open path
`createRoom` / `joinByTicket` / `openP2pRoom` now receive `onion` — set
`myOnion.value` and `currentRoomIsTor.value = isTorTicket(...)`. `enterP2pRoom`
resets `currentCaptainOnion=null` and clears `deadCaptains` alongside `presenceById`.
(`currentRoomIsTor` is the answer to "the room object doesn't record transport" — a
dedicated ref set on open, backed by the persisted `tor` flag on reopen.)

### D.3 Presence carries the onion
`announcePresence`: add `onion: myOnion.value`. Handler: store the onion in
`presenceById`, and `deadCaptains.delete(id)` (a fresh presence ⇒ that member is
alive again — revival).

### D.4 Election helper + wiring in `refreshP2pRoster`
```ts
function electCaptain(memberIds, onionById, dead) {
  const eligible = memberIds
    .filter(id => !dead.has(id))
    .filter(id => !!onionById.get(id))   // onion known ⇒ reachable candidate
    .slice().sort();                     // lowest MLS identity (same rule as handlePeerLeave)
  const captainId = eligible[0] ?? null;
  return { captainId, captainOnion: captainId ? onionById.get(captainId) : null };
}
```
In `refreshP2pRoster` (the single roster builder), gated on `currentRoomIsTor`:
build `onionById` from `presenceById` (+ self = `myOnion`), elect, set
`p.isCaptain = p.id === captainId` on every participant (incl. the self row), and
**when the captain onion changes**, call `chatTransport.setCaptain(slug, captainOnion)`.
Debounce this trigger (~1.5–2s trailing) so a burst of joins/presences collapses to
one handoff.

### D.5 Failover on the death event
In the `onStatus` handler, branch on `reason === "captain_unreachable"` →
`handleCaptainDeath(deadOnion)`:
```ts
async function handleCaptainDeath(deadOnion) {
  // map onion → MLS id via presenceById (we only ever dial the current captain)
  deadCaptains.add(deadId);
  currentCaptainOnion.value = null;   // force re-point
  await refreshP2pRoster();           // re-elect next-lowest reachable + setCaptain
  await handlePeerLeave(deadId);      // REUSE :218-231 — drops presence + (if we're admin) removeMember
}
```
`handlePeerLeave` already implements "the admin evicts the departed member" via the
same `sort()[0]` rule + `removeMember`. Re-point first (fast, restores the star),
then MLS eviction. `electCaptain` filters `deadCaptains`, so the dead id is skipped
even before the removal commit propagates.

### D.6 Bootstrap / handoff behaviour
- Creator alone ⇒ captain = self ⇒ `setCaptain(myOnion)` drops the (absent)
  outbound — no-op.
- First joiner already dials the creator (initial captain). Once MLS + presence
  settle, if `creatorId < joinerId` the election equals the incumbent ⇒ guarded
  no-op. If `joinerId < creatorId`, captaincy hands off: the joiner drops its
  outbound (becomes host-only), the creator redials the joiner — one deliberate
  reconnect (a brief Tor dial), collapsed by the debounce.

---

## E. Star ★ badge (Tor rooms only)

- [types.ts](packages/rakotis/src/services/types.ts): add `isCaptain?: boolean` to
  `Participant` (already re-exported from rakotis).
- `refreshP2pRoster`: sets `isCaptain` (D.4), gated on `currentRoomIsTor` so iroh
  rooms never get a star; the self row is covered by the same assignment.
- [ParticipantRow.vue](apps/enigma/src/components/chat/ParticipantRow.vue): beside the
  existing "On" badge —
  `<OyaBadge v-if="participant.isCaptain" icon="star" tone="warn" title="Captain (onion host)">Host</OyaBadge>`.
- [main.ts](apps/enigma/src/main.ts): register `faStar` (currently absent) in the
  Font Awesome import + `library.add(...)`, or the icon renders nothing.

---

## Edge cases & risks

- **Handoff churn** when a lower-id member joins → one Tor reconnect. Mitigated by the
  ~1.5–2s debounce; accepted as correct under Decision 1.
- **Onion not yet announced** (lowest id has no known onion) → `electCaptain` skips it;
  a higher id serves until its presence (with onion) lands, then hands off. Accepted.
- **Split-brain during death detection** → members exhaust the retry budget at slightly
  different times; a message in that window may reach only a subset (MLS doesn't
  auto-retransmit). Keep `MAX_CAPTAIN_RETRIES` modest so convergence is quick; the
  existing group-mismatch recovery + manual reset are the backstop. Accepted for chat.
- **Dead-captain removal racing a live captain** (long blip > budget) → the evicted
  captain sees a self-removing commit, detects "group id differs", and self-heals via
  the existing fresh-invite path. Guards: generous backoff before declaring death;
  only the single lowest survivor issues the removal; a fresh presence clears
  `deadCaptains`. Accepted.
- **Cascading deaths** → each failed new captain emits `captain_unreachable`, growing
  `deadCaptains`; election walks to the next-lowest. Converges. Accepted.
- **"Everyone hosts" cost + in-group onion disclosure** — every member runs an onion
  service (extra descriptors, slightly slower joins) and shares its stable, dialable
  `.onion` with all group members over encrypted presence (an in-group
  deanonymization vector). Explicitly accepted per Decision 2; onions are per-room +
  per-profile, limiting cross-room correlation.
- **Off-screen rooms** — like the current roster/leave handling, election/failover is
  scoped to `currentRoom`; a death in a background Tor room re-elects when it's next
  opened. Documented limitation.

---

## Files to modify

| File | Change |
|---|---|
| `apps/enigma/src-tauri/src/p2p_tor.rs` | unified `MemberRoom` state; `host_onion`/`dial_and_handshake`; `create_room`/`join_room` return `my_onion`; `set_captain`; connection manager w/ retry + death signal; `broadcast`; `emit_status_reason`; lifecycle touch-ups |
| `apps/enigma/src-tauri/src/realtime.rs` | `+onion` on DTOs; create/join wiring; `realtime_tor_set_captain` |
| `apps/enigma/src-tauri/src/lib.rs` | register the new command |
| `packages/rakotis/src/chatTransport.ts` | `+onion` DTOs; `reason` on status; `setCaptain` bridge |
| `packages/rakotis/src/useChatChannel.ts` | onion refs; presence onion; `electCaptain`; `refreshP2pRoster` wiring; `handleCaptainDeath`; room-open capture; debounce; `P2pRoomEntry` fields |
| `packages/rakotis/src/services/types.ts` | `isCaptain?` on `Participant` |
| `apps/enigma/src/components/chat/ParticipantRow.vue` | ★ badge |
| `apps/enigma/src/main.ts` | register `faStar` |

**Unchanged:** MLS (`mls_*`/`RotorSession`), the QR components, iroh transport, the
`realtime://message` shape, and the "use Tor" switch.

## Build order

1. **Rust transport core** (`p2p_tor.rs`): state + helper extraction, then
   create/join/broadcast/connection-manager/set_captain, then event + lifecycle.
   Keep the existing ticket/framing unit tests green.
2. **Rust command layer** (`realtime.rs` + `lib.rs`): DTO fields, wiring, new command;
   `cargo test`.
3. **Bridge** (`chatTransport.ts`): DTO onion, reason, `setCaptain`.
4. **Types + badge** (`types.ts`, `ParticipantRow.vue`, `main.ts`): additive; verify
   `faStar` renders.
5. **Orchestration** (`useChatChannel.ts`): refs, presence, election, failover,
   debounce; `vue-tsc` + `vitest` (jsdom uses the stub `setCaptain` no-op).

## Verification (3 dev instances over Tor)

Flip "use Tor" on in all three profiles (each is a distinct onion).
1. **A creates** a room → A's own row shows ★ (sole member), status `connected`, MLS active.
2. **B and C join** → all three rosters converge to 3, exactly one ★ on the
   lowest-MLS-id member (same on every screen), and a message from B is relayed to A + C.
3. **Hard-kill the captain** (the ★ instance, to exercise crash failover) → after the
   retry budget one survivor emits `captain_unreachable`; the ★ moves to the
   next-lowest reachable member; survivors re-dial its already-published onion; the
   roster drops to 2 as the admin's `removeMember` propagates.
4. **Confirm** a message between the two survivors flows (star reconstituted).
5. **Revival** — relaunch the killed instance → it re-joins MLS, re-announces its
   onion, is dropped from `deadCaptains`; if lowest, captaincy hands back and ★ returns.
6. **iroh regression** — with Tor off, create/join a room: no ★ ever, no `setCaptain`
   invoked (gated by `currentRoomIsTor`).
