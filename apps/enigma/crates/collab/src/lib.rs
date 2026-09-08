//! A two-peer session: pair by ticket, then exchange bytes.
//!
//! Built for collaborative drawing, but it knows nothing about drawings. A
//! frame carries opaque bytes; what converges them is the caller's business
//! (for Sketch, `sketchCrdt.ts`). That is deliberate — the same transport
//! should serve a spreadsheet without learning what a cell is.
//!
//! ## Shape of the thing
//!
//! One side `host()`s and gets a [`TicketV1`] to show as a QR. The other
//! `join()`s with it. Both then send and receive [`Frame`]s over an
//! iroh-gossip topic, which is QUIC — encrypted end to end between the two
//! endpoints, *including through a relay*, which forwards packets it cannot
//! open.
//!
//! ## What is deliberately NOT here
//!
//! **MLS.** With exactly two peers on a topic there is no forwarder, so iroh's
//! transport encryption is the whole story and an application-layer layer would
//! buy only post-compromise security. It becomes *necessary* at three or more,
//! where gossip's multi-hop delivery means a peer decrypts and re-broadcasts —
//! and that is when it lands, together with the group-formation election that
//! N peers also require. The seam is [`Session::send`] and the receive stream.
//!
//! **A tauri dependency.** This exports plain functions; each app writes its own
//! `#[tauri::command]` shims and decides what reaches its IPC surface — the
//! rule `crates/padova` established and the reason a command exists for one app
//! and not another.
//!
//! ## Two layers, and only one needs the network
//!
//! [`ticket`] and [`frame`] are pure data: the QR format, its bounds, the wire
//! frames, and the gap detector. They compile and test with **no iroh at all**,
//! which is why the `net` feature is off by default — an app that does not
//! collaborate links none of it, exactly as an app that does not seal files
//! never links the keyring.

pub mod frame;
pub mod ticket;

pub use frame::{Frame, SeqTracker, PROTO_V};
pub use ticket::{short_auth_string, TicketV1, TICKET_TTL_MS};

#[cfg(feature = "net")]
pub mod session;
#[cfg(feature = "net")]
pub use session::{Config, Event, Session};
