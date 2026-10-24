# Ferrozine

Peer-to-peer transport for Belisario's apps: iroh (QUIC, hole-punching,
optional relays) underneath, rotor's MLS sealing every application byte on top.

| Module | Carries | Sealed by |
|---|---|---|
| `room` | many-to-many messages over iroh-gossip | the room's MLS group — owned and persisted by the app, lent per message |
| `file` | one file, host → one downloader, streamed in chunks | a pairwise MLS channel made in-band and dropped after the transfer |
| `pair` | the pairwise channel itself, for any one-to-one stream (calls too) | a two-member MLS group per connection |
| `endpoint`, `addr`, `frame` | binding (relays or none, stable or ephemeral id), addresses as text, bounded frames | — |

It has no `tauri` dependency and stores nothing: apps persist endpoint
secrets and room groups themselves, map ferrozine's plain events onto their
own, and apply their own network policy (airplane mode, Tor-only profiles).

Users: **Enigma** (chat rooms, chat file transfers, calls) and **Pumex**
(file transfer, to be split out of Enigma).

## Use

```rust,ignore
use ferrozine::{endpoint::{EndpointConfig, Node, Relays}, file::{self, FileHost, HostSettings, Limits}};

// Host
let node = Node::bind(EndpointConfig::ephemeral(Relays::Hosted)).await?;
let host = FileHost::new(Limits::ENIGMA, || HostSettings { chunk_size: 256 * 1024, integrity: true }, observer);
let _router = iroh::protocol::Router::builder(node.endpoint.clone()).accept(b"pumex/file/1", host.clone()).spawn();
let offer = host.offer("/path/to/file")?;           // send offer.offer_id + node.addr_text() to the peer
host.authorize(&offer.offer_id, &commitment);       // the commitment the peer sent back

// Downloader
let prepared = file::prepare(&offer_id)?;            // send prepared.commitment() to the host
file::download(&endpoint, addr, b"pumex/file/1", prepared, dest, true, Limits::ENIGMA, observer).await?;
```

Offer ids, addresses and commitments must travel over a channel that is
already authenticated — in Enigma, the room's own MLS group.

## Tests

```bash
cargo test -p ferrozine     # from the repo root
```

`tests/file.rs` runs the protocol over in-memory streams, with a tampering
proxy in the middle (flipped bytes, dropped, reordered and truncated chunks,
a missing trailer, wrong and missing authorization). `tests/network.rs` runs
a file transfer and a sealed room between two real iroh endpoints on loopback.

See [`docs/design.md`](docs/design.md) and [`docs/security.md`](docs/security.md).
