# Ferrozine design

## Why a crate

Vesper carried three copies of the same transport plumbing — `p2p_iroh.rs`
(gossip rooms), `file_xfer.rs` (file transfer) and `vox.rs` (calls) — each
binding its own endpoint and the last two repeating the same in-band MLS
handshake. Pumex, the file-transfer app to be split out of Vesper, needs the
file half without the rest of Vesper. Ferrozine is that shared half.

## How ferrozine connects to rotor

**Ferrozine depends on `rotor_core`; rotor knows nothing of transports.**
Rotor stays a pure MLS library, which is what keeps its WASM and Python
bindings building, and keeps its review surface small.

There are two ways an app uses MLS, and ferrozine treats them differently:

| | Pairwise (files, calls) | Group (rooms) |
|---|---|---|
| Lifetime | one connection | the room's whole life |
| Who owns the `RotorSession` | ferrozine (`pair::Channel`) | the app |
| Persisted | never (in-memory storage, dropped with the connection) | by the app (Vesper: its encrypted vault) |
| Handshake | in-band, on the stream it protects | the app's own invitation and admission flow |
| Ferrozine's part | everything | seal and open each message (`Room::broadcast_sealed`, `room::open_sealed`) |

Why not one model for both:

- A **pairwise** session that outlived its connection would be key material
  on disk for no reason. Making it in-band means there is no state to store,
  migrate or clean up after a crash, and two strangers' transfers never share
  keys.
- A **group** session *must* outlive connections — members come and go, and
  the epoch has to survive restarts — and who may join is a product decision
  (Vesper's invitations). That stays with the app. Ferrozine only borrows the
  session, so it never needs to know where it is stored.

Why not a trait between them: there is one MLS implementation and every
caller uses it; a `Sealer` trait would be an indirection with one
implementation. The concrete `RotorSession` is the interface. If a second
cipher layer ever appears, `pair::Channel` and the two room functions are
the only places to change.

**Authorization links the two.** A pairwise handshake authenticates nobody
by itself — whoever completes it gets a channel. The downloader's
KeyPackage commitment (`pair::commitment`) is sent over the *group* channel,
which is authenticated, and the host refuses any other KeyPackage. So a
pairwise channel inherits its authenticity from the group: only the member
who published that commitment holds the private key to join.

## Wire compatibility

`file` speaks Vesper's `vesper/file/1` byte for byte: the same JSON control
frames, chunk framing, chain seed, MLS identities and commitment hash.
Vesper moves onto ferrozine without breaking transfers between old and new
builds. Pumex uses the same protocol under its own ALPN. `room::topic_for`
is Vesper's `blake3(name)`, so rooms keep meeting on the same topic.

## Boundaries

- No storage, no UI events, no policy: see `src/lib.rs`.
- Endpoint secrets come in as 32 bytes; the app decides whether an endpoint
  is stable (a contact handle) or ephemeral (unlinkable transfers).
- Settings that may change between transfers (chunk size, integrity) are
  read through a callback when a downloader connects, never mid-file.
