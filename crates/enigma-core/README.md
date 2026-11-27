# enigma-core

Enigma's room engine in Rust: the port of rakotis' `useChatChannel.ts` (and `mailbox.ts`),
stage 3 of `b2.md`. Tauri-free and UI-free, so the console app (`enigma-tui`) and the Tauri
app run the same engine. MLS runs here through `enigmatite::mls::Sessions` (rotor), so the
keys stay on the device. The MLS identity is the device id (64-hex Ed25519 public key).

## Shape

A synchronous state machine, one current room at a time (like the TS channel):

- the app **feeds it**: `handle_frame(room, payload)` (frames from the transport),
  `handle_status(room, status, peer, linked)` (link state), `tick()` (time: call it every
  ~250 ms);
- the app **calls actions**: `create_room`, `open_room`, `join_by_invite`, `send_text`, ...;
- the app **drains events**: `drain_events() -> Vec<Event>`, and reads state (`messages()`,
  `roster()`, `mls_status()`, ...).

Timers (the 5 s lone-room wait, the admission deadline, a reset's new group, the 1 s peers
debounce, the Poisson mailbox catch-up, the 30 s reset dedupe) are deadlines checked in
`tick()` against the injected `Clock`, so tests are deterministic.

## Outside (traits, `src/traits.rs`)

| Trait | Mirrors | Methods |
|---|---|---|
| `Transport` | `ChatTransport.ts` | `create_room(name)`, `join_room(name, peers)`, `set_peers(room, peers)`, `cancel_join()`, `leave_room(room)`, `forget_onion(name)`, `send(room, payload)`, `last_status(room)` |
| `Mailbox` | `ChatMailbox` (`mailbox.ts`) | `post(body)`, `fetch(after, room)`, `every_ms()` |
| `Signer` | `resetAuth` + `deviceId()` | `device_id()`, `sign(msg)`, `verify(device_id, msg, sig)`; `Ed25519Signer` implements it |
| `Kv` | `KvBackend` (`localDb.ts`) | `get/put/delete(ns, key)`: saved rooms (`p2p:rooms`), admitted flag (`chat:admitted`), timeline log (`chat:log`), mailbox place (`chat:mailbox`) |
| `Clock` | `Date.now()` / timers | `now_ms()`; `SystemClock` |
| `enigmatite::mls::Store` | the `mls_*` commands' store | where rotor sessions are saved |

Transport calls are synchronous; the Tauri side (stage 5) hands them to its async mesh.

`src/mem.rs` holds the in-memory outsides (port of `fakes.ts`): `MemStore`, `MemKv`,
`MemMailbox`, `ManualClock`, and `Hub` (an in-memory mesh several engines share).

## API (`Engine`, `src/engine.rs`)

```rust
let mut e = Engine::new(Deps { transport, signer, kv, store, mailbox, clock }, Config::default());
e.set_user_name("Alice");
let slug = e.create_room("Room")?;          // a group of one at once
e.send_text("hi");
e.handle_frame(&slug, payload);             // from the transport
e.tick();
for ev in e.drain_events() { /* UI */ }
```

| Method | What |
|---|---|
| `new(deps, cfg)` | loads the saved rooms; identity = `signer.device_id()` |
| `set_user_name(name)`, `set_avatar(data_url)` | profile; the avatar is re-announced |
| `create_room(name) -> Option<slug>` | host a room, enter it, group of one |
| `open_room(slug)` | reopen a saved room: kept MLS session comes back ready if it was admitted, else a fresh key package and the 5 s wait |
| `cancel_join()` | abort an in-flight join |
| `invite_key_package(scratch_room) -> b64` | redeemer: key package under a scratch room |
| `admit_invited(room, kp_b64) -> Option<Grant>` | inviter: add member, broadcast commit, return `{welcome, room_name, peers}` (our onion first) |
| `join_by_invite(&grant, scratch_room) -> bool` | redeemer: adopt scratch session, join from Welcome, link to peers |
| `send_text`, `send_image(data_url)`, `send_voice(data_url)` | sealed messages (refused before `Ready`) |
| `send_sync(kind, payload)` | control families (`file_offer`, `file_accept`, `sync_*`, ...) |
| `force_reset(broadcast)` | signed `mls_reset_request`, history cleared, fresh group |
| `leave()` | sealed `leave`, view reset |
| `delete_room(slug)` | `room_closed` (host) or `leave`, then wipe MLS/log/entry/onion |
| `catch_up_mailbox()` | read the Beacon mailbox now (also on Connected and on Poisson ticks) |
| `handle_frame(room, payload)`, `handle_status(room, status, peer, linked)`, `tick()` | input |
| `clear_local(notice)`, `post_system_notice(text)`, `clear_unread()` | local |
| `messages()`, `roster()`, `members()`, `rooms()`, `mls_status()`, `mls_error()`, `link_status()`, `current_room()`, `device_id()`, `my_onion()`, `unread()`, `error()` | state |

## Events (`Event`, `src/types.rs`)

| Event | When |
|---|---|
| `MessageAdded(Message)` | a human row (text, image, voice, map card) or the "not ready" placeholder |
| `Notice(Notice)` | a system row: `key` (`chat.sys.*`), English `text`, `params`, `error` |
| `TimelineReset` | the timeline was replaced (room change, reset, restore): re-read `messages()` |
| `RosterChanged(Vec<Participant>)` | roster rows: id, name (`Member xxxxxx` for an unnamed 64-hex id), avatar, linked, is_self |
| `MlsStatusChanged(MlsStatus)` | idle / initializing / key_exchange / ready / error |
| `LinkStatusChanged(LinkStatus)` | connecting / connected / waiting / disconnected / error |
| `RoomsChanged` | the saved rooms changed |
| `RoomChanged(Option<slug>)` | the current room changed |
| `RoomClosed(slug)` | the host deleted the room; wiped here |
| `Sync { kind, payload, sender }` | `sync_` / `file_` / `meeting_` / `vox_` / `dlink_` / `plink_` families |
| `Error(String)` | an action failed |

## Wire (unchanged from the TS)

Outer frames: `{"type":"mls_app","ciphertext"}` only for content (sealed sender), plus
`mls_commit`, `mls_welcome`, `mls_key_package` (sent on a fresh start; **refused** when it
comes from the mesh), `mls_reset_request` (`device_id, reset_id, ts, sig`; `sig` = device key
over `enigma27-reset\0room\0reset_id\0ts`, obeyed only from a current member within 5 min,
once per `reset_id`), `cover` (ignored). With a mailbox every frame also carries `ts`.
Inner JSON: `{type, msg_id, from:{id,name}, ...}` with `text`, `presence` (device_id, name,
avatar, onion, beacon, reply), `leave`, `room_closed`, `image_message`, `voice_message`,
`map_*`, and the sync families.

## TS -> Rust

| TS (`useChatChannel.ts` / `mailbox.ts`) | Rust |
|---|---|
| `useChatChannel(options)` | `Engine::new(deps, cfg)` |
| `createRoom` | `Engine::create_room` |
| `openP2pRoom` | `Engine::open_room` |
| `cancelJoin` | `Engine::cancel_join` |
| `admitInvited` | `Engine::admit_invited` |
| `joinByInvite` | `Engine::join_by_invite` (+ `invite_key_package` for the scratch kp) |
| `leaveParticipant` | `Engine::leave` |
| `deleteRoom` | `Engine::delete_room` |
| `handleRoomClosed` | `handle_inner` -> `handle_room_closed` |
| `sendMessage` / `sendImage` / `sendAudio` | `send_text` / `send_image` / `send_voice` |
| `sendSync` / `onSync` | `send_sync` / `Event::Sync` |
| `sendEncryptedMedia` | `send_inner` (private) |
| `forceResetMls` | `Engine::force_reset` |
| `resetIsGenuine` | `reset_is_genuine` (private) |
| `requestFreshMlsInvite` | `request_fresh_invite` (private) |
| `startMls` / creator timer / `armAdmissionTimeout` | `start_mls`, `creator_fire`, `tick` |
| `chatTransport.onMessage` -> `handleMessage` | `Engine::handle_frame` -> `handle_message` / `handle_inner` |
| `chatTransport.onStatus` | `Engine::handle_status` |
| `refreshP2pRoster` | `refresh_roster` (private) -> `roster()` |
| `schedulePeers` | `schedule_peers` + `tick` -> `flush_peers` |
| `announcePresence` | `announce_presence` (private) |
| `handlePeerLeave` | `handle_peer_leave` (private) |
| `learnBeacon` / `roomBeacon` | `learn_beacon` / `room_beacon` (private) |
| `catchUpMailbox` / `startMailbox` | `Engine::catch_up_mailbox` / `schedule_mailbox` + `tick` |
| `restoreTimeline` / `pushMessage` | `restore_timeline` / `push_message` (log in `Kv` `chat:log`) |
| `clearLocalChatState` | `Engine::clear_local` |
| `postSystemNotice` / `clearUnread` | `post_system_notice` / `clear_unread` |
| `deviceId` | `Engine::device_id` |
| `loadP2pRooms` / `rememberP2pRoom` / `forgetP2pRoom` | `load_rooms` / `remember_room` / `forget_room`; `rooms()` |
| `mailbox.frameId` / `envelope` / `note` / `catchUp` | `mailbox::frame_id` / `envelope` / `note` / `catch_up` |
| `MemMailbox`, `MemHub`, `memKv` (`fakes.ts`) | `mem::MemMailbox`, `mem::Hub`, `mem::MemKv` |
| `cryptoService.*` | `enigmatite::mls::Sessions` directly |

## Not ported

- Teutates-only options: `openAdmission` (certified roster, `admissionCheck`,
  `keyPackageExtra`, `mayFound`, kp retry), `rosterNotices`/`enforceRoster`/`removed`,
  `threads` (#tags, @mentions), `inlineFiles` (`sendFile`), `keepSession` (no effect already).
- Headless channels (devlink) and the admin split for gossip key packages: device linking is
  parked in limbo; a normal room refuses mesh key packages outright.
- Linked-device leaves (`userPartOf` grouping, `removeLeaf`, `mergeHistory`): limbo too.
- Image downscaling and blob reading: the UI's job (the engine takes data URLs).
- `syncRuntimeIdentity` / `applyRuntimeProfile`: the identity is the `Signer`'s; an app
  switching profiles builds a new `Engine`.
