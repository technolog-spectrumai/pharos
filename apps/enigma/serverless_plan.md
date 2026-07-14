# Enigma serverless P2P rework — plan & record

This document records the rework that turned Enigma from a server-backed comms
suite into a **single serverless P2P chat**. It is the in-repo copy of the
approved implementation plan, kept as the reference for what changed and why,
and for the follow-up work that was deliberately deferred.

## Goal

- **P2P chat only.** No app server of any kind: no relay WebSocket, no REST
  data gateway, no login, no server-side directory.
- **Rendezvous by QR code.** Two people meet by one sharing a QR code that
  carries the room's iroh *ticket* (topic + name + the creator's
  `EndpointAddr`). Scanning (camera or image file) or pasting the ticket joins
  the room.
- **Pair once, auto-refresh.** After the one-time QR pairing, reconnects don't
  need a new QR: every peer's stable NodeId is persisted per room and
  re-resolved through iroh's built-in n0 discovery when addresses change.
  (Later addition: the opt-in DHT discovery toggle — `dht.md` — adds ticketless
  *first* joins by room code and a Contacts tab, over the Mainline DHT.)
- **Tor onion transport (now implemented).** An opt-in "use Tor" switch routes
  rendezvous + chat over peer-hosted onion services (star topology); the QR then
  carries a `.onion`. Full breakdown in [tor.md](tor.md).
- **Remove Aurora and Enigma+** (the sibling apps) entirely.
- **Park voice calls + file transfer** in `limbo/` (unlinked, restorable).
  File transfer was restored in 2026-07 (Files tab alongside Chat/Settings,
  offline/Tor-gated, max-size guard in Settings); Vox remains parked.

## Decisions

1. **iroh's n0 relays + discovery stay on** (`presets::N0`,
   `RelayMode::Default`). "No server" means *our* server; iroh's public
   infrastructure handles NAT traversal and NodeId→address resolution. This is
   what makes both QR pairing and ticketless reconnects work everywhere.
2. **Tor onion transport implemented (opt-in, exclusive).** `tor.rs` remains the
   outbound Arti client; the net-new hidden-service *hosting* lives in
   `p2p_tor.rs`. A per-profile "use Tor" switch selects it exclusively (iroh off
   when on); the room creator hosts one onion service and relays (star topology).
   Full record in [tor.md](tor.md).
3. **Voice (Vox) + file transfer moved to `limbo/`**, not deleted — see
   `limbo/README.md` for the restore path. File transfer has since been
   restored (2026-07); Vox is still parked.
4. **Reconnect model:** the Rust gossip layer reports each neighbor's NodeId in
   the `realtime://status` event (`peer_id`); the frontend persists it into the
   room entry (`p2p:rooms` kv). Reopening a room rejoins by ticket **seeded
   with the saved peer NodeIds**, so stale ticket addresses don't strand us.

## What was removed

| Layer | Removed |
|---|---|
| Apps | `apps/aurora/`, `apps/enigma_plus/`, `AURORA_*.png` |
| Rust | `data.rs` (REST gateway), `aster.rs` (server directory), `onion_e2e.rs` (server e2e harness), the WebSocket half of `realtime.rs`, server/auth fields + commands in `lib.rs` (`server_url`, `auth_token`, `server_data`, `server_is_onion`, `allow_self_signed_tls`) |
| Cargo deps | `reqwest`, `tokio-tungstenite`, `futures-util`, `chacha20poly1305`, `rustfft`, `n0-future` |
| rakotis | `services/ws.ts`, `services/apiBase.ts`, `chatCommands.ts`, `pinCrypto.ts`, the whole `kind === "relay"` branch of `useChatChannel.ts`, server getters in `appStorage.ts` |
| enigma UI | `EnigmaLoginView.vue`, `services/api.ts`, the relay/Forum + Vox + Files tabs, the server-address / Tor-server / self-signed / server-data settings, the server-URL QR scanner |
| Tests/CI | relay & login & aster tests, `live.spec.ts`, `scripts/e2e_runner.py` (Docker backend runner), aurora/enigma_plus CI matrix entries |

## What was kept / promoted

- `p2p_iroh.rs` — the only transport. Room = gossip topic = `blake3(name)`;
  ticket = postcard+base32 (`Ticket { topic, name, peers }`); this string **is**
  the QR payload.
- All `mls_*` commands + `RotorSession` (crypto unchanged — MLS runs entirely
  over the gossip topic; no server was ever involved in key exchange).
- `load_or_create_secret` (stable NodeId) — relocated from `aster.rs` into
  `p2p_iroh.rs`.
- QR generate/scan (`qrcode` + `html5-qrcode`) — now the primary pairing UX in
  `ChatPanel.vue`; the NodeId is shown (text + QR) in Settings → My identity.
- `tor.rs` + arti deps — the outbound client base; now joined by `p2p_tor.rs`,
  the peer-hosted onion transport built on arti's `onion-service-service`.
- Native voice-note recording (`audio_*` commands) — voice notes go inline over
  MLS (`sendEncryptedMedia`), same as images.
- `kv.rs` (fjall), `fs_local.rs`, offline profiles, airplane-mode switch.

## Done since the rework

- **onion-p2p** — peer-hosted onion services so a QR can carry a `.onion`
  address. Shipped as `p2p_tor.rs` + the "use Tor" switch; star topology (creator
  hosts + relays). Full record in [tor.md](tor.md). Multi-peer gossip *mesh* over
  Tor remains out of scope.

## Deferred (TODOs)

- **Captain election for the onion host.** Today the room *creator* is a fixed,
  manual "captain" — the sole onion host and relay, and a single point of failure
  (if it goes offline the room is down). Next: elect the host automatically (e.g.
  lowest NodeId among members) with failover, so hosting isn't tied to whoever
  created the room. See the star-limitation note in [tor.md](tor.md).
- **Cold-start edge case:** if *every* member of a room is offline long enough
  for n0 discovery records to lapse **and** all addresses changed, reconnection
  needs a fresh QR. Accepted; a bare NodeId still resolves as long as the peer
  has been online recently.
- **Group scale:** gossip fan-out and MLS admin election (`ourId < theirId`)
  are unchanged from the original implementation — fine for small rooms.

## Build & test

```bash
./build_desktop.sh            # one-click release build (or: npm run build)
./run_dev.sh                  # dev instance (APP_PROFILE/CHAT_USER env to isolate)
npm test                      # all workspace tests
( cd apps/enigma/src-tauri && cargo test )
```

Two-instance pairing test: run two dev instances with different
`APP_PROFILE`s; create a room on A (QR appears), scan/paste on B; both should
reach “Encrypted” and exchange text + an image with no server running.
Restart B → it reopens the room and reconnects via the persisted peer NodeId.
