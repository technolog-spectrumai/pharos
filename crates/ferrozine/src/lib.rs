//! # Ferrozine
//!
//! Peer-to-peer transport for Belisario's apps, over iroh (QUIC, with
//! hole-punching and optional relays), with every application byte sealed by
//! rotor's MLS before it reaches the network.
//!
//! | Module | What it carries | How rotor seals it |
//! |---|---|---|
//! | [`room`] | many-to-many messages (chat) over iroh-gossip | the room's MLS group, owned and persisted by the app, lent per message |
//! | [`file`](mod@file) | one file, host to one downloader, streamed in chunks | a pairwise MLS channel made in-band for the transfer and dropped after it |
//! | [`pair`] | the pairwise channel itself, for any one-to-one stream (calls too) | one two-member group per connection |
//!
//! Underneath: [`endpoint`] binds an iroh endpoint (relays or none; stable or
//! ephemeral identity), [`addr`] turns addresses into text and back, [`frame`]
//! reads and writes bounded length-prefixed frames.
//!
//! ## Where ferrozine stops
//!
//! - **No storage.** Stable endpoint secrets and room MLS state are the app's
//!   to persist (Vesper keeps them in its encrypted vault). Ferrozine takes the
//!   bytes and borrows the session.
//! - **No UI events.** Progress and arrivals come back as plain values
//!   ([`file::TransferEvent`], [`room::RoomEvent`]); each app maps them to its
//!   own events. There is no `tauri` dependency.
//! - **No policy.** Airplane mode, Tor-only profiles and settings are the
//!   app's. Ferrozine binds when asked, and reads per-transfer settings
//!   through a callback.
//!
//! See `docs/design.md` for the reasoning, and `docs/security.md` for what
//! each layer protects against.

pub mod addr;
pub mod endpoint;
pub mod error;
pub mod file;
pub mod frame;
pub mod pair;
pub mod room;

pub use error::{Error, Result};
pub use iroh;
pub use iroh_gossip;
pub use rotor_core;
