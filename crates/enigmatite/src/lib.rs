//! Enigma's room engine, the Rust half.
//!
//! The protocol itself — key package → commit + Welcome → sealed messages, presence —
//! runs in TypeScript, in rakotis' `useChatChannel`. What it asks of the native side
//! lives here:
//!
//! * [`mls`] — one rotor MLS session per (room, identity), saved in the app's store
//!   after every step (the `mls_*` commands);
//! * [`admission`] — a key package's proof by a device key, and device identities
//!   grouped by member (`<user>#dev-<8 base32>`), for rooms that admit by a certified
//!   roster.

pub mod admission;
pub mod mls;
