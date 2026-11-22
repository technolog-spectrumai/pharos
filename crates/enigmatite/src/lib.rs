//! Enigma's room engine, the Rust half (technology.md §"Shared room engine").
//!
//! The protocol itself — key package → commit + Welcome → sealed messages, presence, the
//! captain, moderation — runs in TypeScript, in rakotis' `useChatChannel`. What it asks of the
//! native side is the same in every app, so it lives here once:
//!
//! * [`mls`] — one rotor MLS session per (room, identity), saved in the app's store after every
//!   step (the `mls_*` commands of Enigma and Teutates);
//! * [`events`] — the `realtime://message` / `realtime://status` events rakotis' chat transport
//!   listens to, and the loop that turns a Ferrozine room's events into them;
//! * [`gateway`] — an iroh-gossip endpoint with rooms by name, for an app that needs nothing
//!   else on it (Teutates; Enigma keeps its own endpoint for Tor, the DHT, invitations, calls);
//! * [`admission`] — a key package's proof by a device key, and device identities grouped by
//!   member (`<user>#dev-<8 base32>`), for rooms that admit by a certified roster.

pub mod admission;
pub mod events;
pub mod gateway;
pub mod mls;
