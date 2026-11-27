//! Enigma's room engine, Tauri-free and UI-free: the Rust port of rakotis'
//! `useChatChannel.ts` (with `mailbox.ts`). The engine is a synchronous state
//! machine: the app feeds it frames ([`Engine::handle_frame`]), link status
//! ([`Engine::handle_status`]) and time ([`Engine::tick`]), calls its actions, and
//! drains [`Event`]s for the UI. MLS runs here, through `enigmatite::mls::Sessions`
//! (rotor), so the keys stay on the device.
//!
//! See README.md for the API, the events and the TS -> Rust mapping.

pub mod engine;
pub mod mailbox;
pub mod mem;
pub mod traits;
pub mod types;

pub use engine::{Config, Deps, Engine};
pub use traits::{Clock, Ed25519Signer, Kv, Mailbox, OpenedRoom, Signer, SystemClock, Transport};
pub use types::*;
