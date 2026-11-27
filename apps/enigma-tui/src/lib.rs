//! `enigma-tui`: Enigma in the console, on `enigma-core` (stage 4 of b2.md).
//!
//! - [`app`]: state and event handling (no terminal I/O);
//! - [`gate`]: the lock gate (create / unlock, masked);
//! - [`ui`]: rendering only;
//! - [`backend`] (from `enigma-app`): Tor / Beacon / transport behind a trait ([`backend::DemoBackend`],
//!   and the real one: vault + client link to Your Beacon over Tor);
//! - [`codes`] (from `enigma-app`): Friends and invitation codes, QR;
//! - [`screens`]: off-terminal rendering (text, HTML) for tests and screenshots.

pub mod app;
pub mod gate;
pub mod screens;
pub mod ui;

/// The backend and the codes live in `enigma-app` (shared with `enigma27`).
pub use enigma_app::{backend, codes};
