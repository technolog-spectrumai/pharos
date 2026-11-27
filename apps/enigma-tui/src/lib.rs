//! `enigma-tui`: Enigma in the console, on `enigma-core` (stage 4 of b2.md).
//!
//! - [`app`]: state and event handling (no terminal I/O);
//! - [`ui`]: rendering only;
//! - [`backend`]: Tor / Beacon / transport behind a trait ([`backend::DemoBackend`] now,
//!   the real one in stages 2 and 5);
//! - [`codes`]: Friends and invitation codes, QR;
//! - [`screens`]: off-terminal rendering (text, HTML) for tests and screenshots.

pub mod app;
pub mod backend;
pub mod codes;
pub mod screens;
pub mod ui;
