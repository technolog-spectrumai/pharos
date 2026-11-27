//! `enigma-app`: everything of the Enigma app that is not drawing.
//!
//! - [`core`]: the app state ([`core::Core`]) and its actions (rooms, send, join, friends,
//!   Beacon), on `enigma-core`'s [`enigma_core::Engine`];
//! - [`backend`]: Tor / Beacon / transport behind a trait ([`backend::DemoBackend`] now,
//!   [`backend::RealBackend`] wired in stage 2);
//! - [`codes`]: Friends and invitation codes, check code, QR;
//! - [`avatar`]: letter avatars (same palette as `avatarIcon.ts`);
//! - [`i18n`]: English and Polish texts.
//!
//! The front ends (`apps/enigma-slint`, `apps/enigma-tui`) only map input to these actions
//! and state to pixels or cells.

pub mod avatar;
pub mod backend;
pub mod codes;
pub mod core;
pub mod i18n;
