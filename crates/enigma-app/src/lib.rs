//! `enigma-app`: everything of the Enigma app that is not drawing.
//!
//! - [`core`]: the app state ([`core::Core`]) and its actions (rooms, send, join, friends,
//!   Beacon), on `enigma-core`'s [`enigma_core::Engine`];
//! - [`backend`]: Tor / Beacon / transport behind a trait ([`backend::DemoBackend`], and
//!   [`real::RealBackend`]: the client link over Tor to the user's Beacon; the client never hosts one);
//! - [`vault`]: the profile vault (protasius), PIN, panic code, profiles, idle lock;
//! - [`session`]: the lock gate around a [`core::Core`] (create / unlock / lock);
//! - [`codes`]: Friends and invitation codes, check code, QR;
//! - [`media`]: pictures to send, data URLs, QR codes read from image files;
//! - [`files`]: file transfer inside a room (sealed sync messages through the Beacons);
//! - [`avatar`]: letter avatars (same palette as `avatarIcon.ts`);
//! - [`i18n`]: English and Polish texts.
//!
//! The front ends (`apps/enigma-slint`, `apps/enigma-tui`) only map input to these actions
//! and state to pixels or cells.

pub mod actions;
pub mod avatar;
pub mod backend;
pub mod codes;
pub mod core;
pub mod files;
pub mod i18n;
pub mod media;
pub mod real;
pub mod session;
pub mod vault;
