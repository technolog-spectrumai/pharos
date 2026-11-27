//! `enigma27`: Enigma's main app in Slint, for desktop and Android (stage 5 of b2.md).
//!
//! The UI is in `ui/*.slint`; this file is the glue: it owns a [`Host`] (the lock
//! [`Session`] around an [`enigma_app::core::Core`] on the real backend, or a demo `Core`),
//! turns its state into Slint models ([`refresh`]) and Slint callbacks into actions
//! ([`wire`]). Nothing here knows about rooms or crypto beyond what `Core` exposes, so the
//! console app (`enigma-tui`) and this app behave the same. The client never runs a
//! Beacon (b2.md: client and Beacon are separate apps); it attaches to Your Beacon.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use enigma_app::backend::DemoBackend;
use enigma_app::codes;
use enigma_app::core::Core;
use enigma_app::i18n::Lang;
use enigma_app::session::Session;
use enigma_app::vault::default_base;
use slint::{Color, Image, Rgb8Pixel, Rgba8Pixel, SharedPixelBuffer};

pub mod audio;
pub mod headless;

slint::include_modules!();

/// The window glue (also compiled into enigma27-combo, on its own Slint types: see
/// `glue.rs`).
mod glue {
    use super::{audio, data_url_image, hhmm, now_ms, qr_image, rgb, Host, Shared};
    use super::{AppWindow, FileItem, FriendItem, InfoItem, InviteItem, MessageItem, Page, PersonItem, RoomItem, Texts};
    include!("glue.rs");
}
pub use glue::*;

/// What the window drives: the real app behind its lock gate, or the demo world.
pub struct Host {
    /// The real app (vault, client link to Your Beacon over Tor).
    pub session: Option<Session>,
    /// The demo app (no vault, no lock).
    pub demo: Option<Core>,
    /// A voice note being recorded.
    pub recording: Option<audio::Recording>,
    /// Decoded pictures by message id (decoding a data URL every refresh would be slow).
    pub images: HashMap<String, Image>,
    /// Last language seen (the gate has no core).
    pub lang: Lang,
}

impl Host {
    /// The demo world.
    #[must_use]
    pub fn demo(name: &str) -> Self {
        Self::with(None, Some(Core::new(Box::new(DemoBackend::new()), name)))
    }
    /// The real app on a session.
    #[must_use]
    pub fn real(s: Session) -> Self {
        Self::with(Some(s), None)
    }
    fn with(session: Option<Session>, demo: Option<Core>) -> Self {
        Self { session, demo, recording: None, images: HashMap::new(), lang: Lang::En }
    }
    /// The app, when unlocked.
    #[must_use]
    pub fn core(&self) -> Option<&Core> {
        self.demo.as_ref().or_else(|| self.session.as_ref().and_then(Session::core))
    }
    /// The app, when unlocked.
    pub fn core_mut(&mut self) -> Option<&mut Core> {
        match (&mut self.demo, &mut self.session) {
            (Some(c), _) => Some(c),
            (None, Some(s)) => s.core_mut(),
            _ => None,
        }
    }
    /// Locked (the gate shows).
    #[must_use]
    pub fn locked(&self) -> bool {
        self.core().is_none()
    }
    /// User activity (the idle lock restarts).
    pub fn touch(&mut self) {
        if let Some(s) = &mut self.session {
            s.touch(now_ms());
        }
    }
}

/// The shared host, as the callbacks hold it.
pub type Shared = Rc<RefCell<Host>>;

/// Milliseconds since the epoch.
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// 0xRRGGBB to a Slint colour.
#[must_use]
pub fn rgb(c: u32) -> Color {
    Color::from_rgb_u8((c >> 16) as u8, (c >> 8) as u8, c as u8)
}

/// A QR code as an image, `scale` pixels per module, dark on white.
#[must_use]
pub fn qr_image(text: &str, scale: u32) -> Image {
    let Some((side, m)) = codes::qr_modules(text) else { return Image::default() };
    let px = side as u32 * scale;
    let mut buf = SharedPixelBuffer::<Rgb8Pixel>::new(px, px);
    let data = buf.make_mut_slice();
    for y in 0..px {
        for x in 0..px {
            let dark = m[(y / scale) as usize * side + (x / scale) as usize];
            let v = if dark { 0x10 } else { 0xff };
            data[(y * px + x) as usize] = Rgb8Pixel { r: v, g: v, b: v };
        }
    }
    Image::from_rgb8(buf)
}

/// A data URL's picture as a Slint image.
#[must_use]
pub fn data_url_image(url: &str) -> Option<Image> {
    let (w, h, px) = enigma_app::media::data_url_rgba(url)?;
    let buf = SharedPixelBuffer::<Rgba8Pixel>::clone_from_slice(&px, w, h);
    Some(Image::from_rgba8(buf))
}

/// "HH:MM" (UTC) for a timestamp in ms.
#[must_use]
pub fn hhmm(ts_ms: u64) -> String {
    let m = ts_ms / 60_000;
    format!("{:02}:{:02}", (m / 60) % 24, m % 60)
}

/// The data dir on Android (the app's internal storage).
#[cfg(target_os = "android")]
fn android_base(app: &slint::android::AndroidApp) -> std::path::PathBuf {
    app.internal_data_path().unwrap_or_else(|| std::path::PathBuf::from("/data/local/tmp/enigma27"))
}

/// Android entry point (the cdylib): a client of Your Beacon, like the desktop.
#[cfg(target_os = "android")]
#[no_mangle]
fn android_main(app: slint::android::AndroidApp) {
    let base = android_base(&app);
    slint::android::init(app).expect("slint android init");
    let host = real_host(&base).unwrap_or_else(|_| Host::demo("Me"));
    run(host, None).expect("run");
}

/// Where profiles live on this desktop (the Tauri app's data dir, so its profile opens).
#[must_use]
pub fn data_dir() -> std::path::PathBuf {
    default_base()
}
