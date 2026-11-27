//! More of [`Core`]'s actions: settings (theme, tabs, file sizes, offline, connection
//! timeout, notifications), pictures, voice notes, files, invitations (peek, personal,
//! TTL), room banners and info, deep links. UI-agnostic like the rest of `Core`.

use std::path::{Path, PathBuf};

use enigma_core::{MessageKind, MlsStatus};

use crate::codes::{self, Invitation};
use crate::core::Core;
use crate::files::{DEFAULT_CHUNK_KB, DEFAULT_MAX_MB};
use crate::media;

/// Where received files go: `$ENIGMA_DOWNLOADS`, else `~/Downloads/Enigma27`.
#[must_use]
pub fn downloads_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("ENIGMA_DOWNLOADS") {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map_or_else(|| PathBuf::from("."), PathBuf::from);
    home.join("Downloads").join("Enigma27")
}

/// The theme choice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Theme {
    /// Follow the system.
    System,
    /// Light.
    Light,
    /// Dark.
    Dark,
}

impl Theme {
    /// "system" / "light" / "dark".
    #[must_use]
    pub fn code(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
    /// From a code (anything else: system).
    #[must_use]
    pub fn from_code(s: &str) -> Self {
        match s {
            "light" => Self::Light,
            "dark" => Self::Dark,
            _ => Self::System,
        }
    }
}

/// The bottom tabs that can be hidden (Tauri `tabs.ts`).
pub const TABS: [&str; 3] = ["chat", "files", "friends"];

/// What a pasted code is, before redeeming it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Peek {
    /// Room name.
    pub room: String,
    /// The inviter's Beacon.
    pub beacon: String,
    /// The inviter's device (short).
    pub inviter: String,
    /// The friend it names, when the inviter is a friend.
    pub inviter_name: Option<String>,
    /// Expiry (unix s), 0 = none.
    pub expires: u64,
    /// Personal: for this device (`Some(true)`), for another one (`Some(false)`), or general.
    pub for_me: Option<bool>,
    /// One line to show.
    pub summary: String,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// "in 2 h", "in 5 min", "expired".
#[must_use]
pub fn expiry_text(expires: u64, now: u64) -> String {
    if expires == 0 {
        return "no expiry".into();
    }
    if now >= expires {
        return "expired".into();
    }
    let left = expires - now;
    if left >= 86_400 {
        format!("expires in {} d", left / 86_400)
    } else if left >= 3_600 {
        format!("expires in {} h", left / 3_600)
    } else {
        format!("expires in {} min", left.div_ceil(60))
    }
}

impl Core {
    /// A setting (vault, else memory).
    #[must_use]
    pub fn setting(&self, k: &str) -> Option<String> {
        match self.backend.vault() {
            Some(v) => v.setting(k),
            None => self.mem_settings.get(k).cloned(),
        }
    }

    /// Set one.
    pub fn set_setting(&mut self, k: &str, v: &str) {
        match self.backend.vault() {
            Some(vault) => vault.set_setting(k, v),
            None => {
                self.mem_settings.insert(k.into(), v.into());
            }
        }
    }

    fn flag(&self, k: &str, default: bool) -> bool {
        self.setting(k).map_or(default, |v| v == "1")
    }

    /// Theme choice.
    #[must_use]
    pub fn theme(&self) -> Theme {
        Theme::from_code(&self.setting("theme").unwrap_or_default())
    }
    /// Set it.
    pub fn set_theme(&mut self, t: Theme) {
        self.set_setting("theme", t.code());
    }

    /// Whether a tab ("chat", "files", "friends") is shown. Chat is always shown.
    #[must_use]
    pub fn tab_visible(&self, tab: &str) -> bool {
        tab == "chat" || self.flag(&format!("tab_{tab}"), true)
    }
    /// Show / hide a tab (Chat cannot be hidden).
    pub fn set_tab_visible(&mut self, tab: &str, on: bool) {
        if tab != "chat" && TABS.contains(&tab) {
            self.set_setting(&format!("tab_{tab}"), if on { "1" } else { "0" });
        }
    }

    /// Largest file to send (MiB, 1..=100).
    #[must_use]
    pub fn max_file_mb(&self) -> u64 {
        self.setting("max_file_mb").and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_MAX_MB).clamp(1, 100)
    }
    /// Set it.
    pub fn set_max_file_mb(&mut self, mb: u64) {
        self.set_setting("max_file_mb", &mb.clamp(1, 100).to_string());
    }
    /// File chunk (KiB, 16..=1024).
    #[must_use]
    pub fn chunk_kb(&self) -> u64 {
        self.setting("chunk_kb").and_then(|s| s.parse().ok()).unwrap_or(DEFAULT_CHUNK_KB).clamp(16, 1024)
    }
    /// Set it.
    pub fn set_chunk_kb(&mut self, kb: u64) {
        self.set_setting("chunk_kb", &kb.clamp(16, 1024).to_string());
    }

    /// Notifications for new messages while away (default on).
    #[must_use]
    pub fn notifications_on(&self) -> bool {
        self.flag("notifications", true)
    }
    /// Set it.
    pub fn set_notifications(&mut self, on: bool) {
        self.set_setting("notifications", if on { "1" } else { "0" });
    }
    /// The notifications since the last call.
    pub fn take_notifications(&mut self) -> Vec<(String, String)> {
        std::mem::take(&mut self.notes)
    }

    /// Offline mode.
    #[must_use]
    pub fn offline(&self) -> bool {
        self.backend.offline()
    }
    /// Go offline / online.
    pub fn set_offline(&mut self, on: bool) {
        self.backend.set_offline(on);
        self.status = if on { "Offline: Tor and the Beacon link are stopped.".into() } else { "Online: connecting to Your Beacon\u{2026}".into() };
    }
    /// Connection timeout (s).
    #[must_use]
    pub fn connect_timeout(&self) -> u64 {
        self.backend.connect_timeout()
    }
    /// Set it.
    pub fn set_connect_timeout(&mut self, secs: u64) {
        self.backend.set_connect_timeout(secs);
    }
    /// This device's discovery key for Your Beacon ("only my phones"), once Tor is up.
    pub fn discovery_key(&mut self) -> Option<String> {
        self.backend.discovery_key()
    }

    // ── media ──────────────────────────────────────────────────────────────

    fn ready_or_status(&mut self) -> bool {
        if self.engine.mls_status() != MlsStatus::Ready {
            self.status = self.tr("chat.notReady");
            return false;
        }
        true
    }

    /// Send a picture from a file (scaled down, re-encoded).
    pub fn send_image_file(&mut self, path: &Path) -> bool {
        if !self.ready_or_status() {
            return false;
        }
        match media::image_data_url(path) {
            Ok(url) => {
                self.engine.send_image(&url);
                self.after_send();
                true
            }
            Err(e) => {
                self.status = e;
                false
            }
        }
    }

    /// Send a voice note (WAV bytes).
    pub fn send_voice_wav(&mut self, wav: &[u8]) -> bool {
        if !self.ready_or_status() || wav.is_empty() {
            return false;
        }
        use base64::Engine as _;
        let url = format!("data:audio/wav;base64,{}", base64::engine::general_purpose::STANDARD.encode(wav));
        self.engine.send_voice(&url);
        self.after_send();
        true
    }

    fn after_send(&mut self) {
        self.backend.poll(&mut self.engine);
        self.drain(self.viewing);
    }

    /// A voice message's WAV bytes (row `i` of the timeline).
    #[must_use]
    pub fn voice_wav(&self, i: usize) -> Option<Vec<u8>> {
        let m = self.messages().get(i).filter(|m| m.kind == MessageKind::Voice)?;
        media::decode_data_url(m.audio_data.as_deref()?).map(|(_, b)| b)
    }

    /// Offer a file to the room.
    pub fn offer_file(&mut self, path: &Path) -> bool {
        if !self.ready_or_status() {
            return false;
        }
        let (chunk, max) = (self.chunk_kb() as usize * 1024, self.max_file_mb() * 1024 * 1024);
        match self.files.offer(path, chunk, max) {
            Ok((_, p)) => match self.engine.send_sync("file_offer", p) {
                Ok(()) => {
                    self.status = "File offered: it goes once someone accepts.".into();
                    self.after_send();
                    true
                }
                Err(e) => {
                    self.status = e;
                    false
                }
            },
            Err(e) => {
                self.status = e;
                false
            }
        }
    }

    /// Accept an offered file.
    pub fn accept_file(&mut self, id: &str) {
        if let Some(p) = self.files.accept(id) {
            if let Err(e) = self.engine.send_sync("file_accept", p) {
                self.status = e;
            }
            self.after_send();
        }
    }

    /// Decline an offered file, or cancel mine.
    pub fn decline_file(&mut self, id: &str) {
        if let Some((k, p)) = self.files.decline(id) {
            let _ = self.engine.send_sync(k, p);
            self.after_send();
        }
    }

    /// A QR code read from an image file, put where it belongs: an invitation joins, a
    /// friend code adds the friend, a Beacon code becomes Your Beacon. Returns the text.
    pub fn scan_file(&mut self, path: &Path) -> Option<String> {
        match media::scan_qr_file(path) {
            Ok(text) => Some(text),
            Err(e) => {
                self.status = e;
                None
            }
        }
    }

    // ── invitations ────────────────────────────────────────────────────────

    /// What an invitation code is, before redeeming.
    pub fn peek(&mut self, code: &str) -> Option<Peek> {
        let Some(inv) = codes::decode_invitation(code) else {
            self.status = self.tr("join.notACode");
            return None;
        };
        Some(self.peek_inv(&inv))
    }

    fn peek_inv(&self, inv: &Invitation) -> Peek {
        let inviter_name = self.friends.iter().find(|f| f.id == inv.device).map(|f| f.name.clone());
        let for_me = if inv.for_device.is_empty() { None } else { Some(inv.for_device == self.engine.device_id()) };
        let who = inviter_name.clone().unwrap_or_else(|| if inv.device.len() >= 8 { format!("device {}", &inv.device[..8]) } else { "someone".into() });
        let kind = match for_me {
            None => "general invitation",
            Some(true) => "personal invitation for you",
            Some(false) => "personal invitation for someone else",
        };
        let summary = format!("\u{201c}{}\u{201d} from {who}: {kind}, {}", inv.name, expiry_text(inv.expires, now_secs()));
        Peek { room: inv.name.clone(), beacon: inv.onion.clone(), inviter: inv.device.chars().take(8).collect(), inviter_name, expires: inv.expires, for_me, summary }
    }

    // ── rooms ──────────────────────────────────────────────────────────────

    /// The banner over the timeline: waiting to be let in, or alone in the room.
    #[must_use]
    pub fn banner(&self) -> Option<String> {
        self.engine.current_room()?;
        match self.engine.mls_status() {
            MlsStatus::KeyExchange | MlsStatus::Initializing if !self.is_host() => Some(self.tr("banner.waiting")),
            MlsStatus::Ready if self.engine.roster().iter().all(|p| p.is_self) => Some(self.tr("banner.alone")),
            _ => None,
        }
    }

    /// Room info lines: (label, value).
    #[must_use]
    pub fn room_info(&self) -> Vec<(String, String)> {
        let Some(cur) = self.engine.current_room() else { return vec![] };
        let Some(r) = self.engine.rooms().iter().find(|r| r.room == cur) else { return vec![] };
        vec![
            ("Name".into(), r.name.clone()),
            ("Role".into(), self.tr(if r.host { "info.host" } else { "info.member" })),
            ("Encryption".into(), self.crypto_label()),
            ("Members".into(), self.engine.roster().len().to_string()),
            ("Linked now".into(), self.linked_count().to_string()),
            ("Beacons of this room".into(), (r.peers.len() + 1).to_string()),
            ("Your Beacon".into(), r.onion.clone().unwrap_or_default()),
            ("Room id".into(), r.room.clone()),
        ]
    }

    /// Open an `enigma://room/<name>[/<tag>][?to=&quote=]` link: the room opens if this
    /// device has it; returns the draft to offer (`#tag @to quote`). An invitation code
    /// passed as a link (`enigma://join/<code>`) is peeked instead (the UI asks first).
    pub fn open_link(&mut self, url: &str) -> Option<String> {
        let rest = url.trim().strip_prefix("enigma://")?;
        if let Some(code) = rest.strip_prefix("join/") {
            let code = percent_decode(code);
            let p = self.peek(&code)?;
            self.status = p.summary;
            return Some(String::new());
        }
        let rest = rest.strip_prefix("room/")?;
        let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
        let mut parts = path.trim_end_matches('/').splitn(2, '/');
        let room = percent_decode(parts.next()?);
        if room.is_empty() {
            return None;
        }
        let tag = parts.next().map(percent_decode).filter(|t| !t.is_empty());
        let (mut to, mut quote) = (None, None);
        for kv in query.split('&').filter(|s| !s.is_empty()) {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            let v = percent_decode(&v.replace('+', " "));
            match k {
                "to" => to = Some(v),
                "quote" => quote = Some(v),
                _ => {}
            }
        }
        match self.engine.rooms().iter().position(|r| r.name == room || r.room == room) {
            Some(i) => self.open_room(i),
            None => self.status = format!("No room \u{201c}{room}\u{201d} on this device."),
        }
        Some([tag.map(|t| format!("#{t}")), to.map(|t| format!("@{t}")), quote].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" "))
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::DemoBackend;

    fn demo() -> Core {
        Core::new(Box::new(DemoBackend::new()), "Me")
    }

    #[test]
    fn settings_theme_tabs_sizes_and_notifications() {
        let mut c = demo();
        assert_eq!(c.theme(), Theme::System);
        c.set_theme(Theme::Dark);
        assert_eq!(c.theme(), Theme::Dark);
        assert!(c.tab_visible("files"));
        c.set_tab_visible("files", false);
        c.set_tab_visible("chat", false);
        assert!(!c.tab_visible("files") && c.tab_visible("chat"));
        c.set_max_file_mb(500);
        assert_eq!(c.max_file_mb(), 100);
        c.set_chunk_kb(1);
        assert_eq!(c.chunk_kb(), 16);
        assert!(c.notifications_on());
        c.tick(false);
        assert!(c.send("ping"));
        c.tick(false);
        let n = c.take_notifications();
        assert!(n.iter().any(|(t, b)| t.starts_with("Ann") && b.starts_with("Got it")), "{n:?}");
        c.set_notifications(false);
        assert!(c.send("again"));
        c.tick(false);
        assert!(c.take_notifications().is_empty());
    }

    #[test]
    fn pictures_voice_and_files_in_the_demo_room() {
        let dir = std::env::temp_dir().join(format!("enigma-actions-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("p.png");
        image::RgbImage::from_pixel(64, 48, image::Rgb([200, 30, 30])).save(&png).unwrap();
        let mut c = demo();
        assert!(c.send_image_file(&png), "{}", c.status);
        assert!(c.messages().iter().any(|m| m.kind == MessageKind::Image && m.is_self));
        assert!(!c.send_image_file(&dir.join("nope.png")));
        assert!(c.send_voice_wav(b"RIFF....WAVE"));
        let i = c.messages().iter().rposition(|m| m.kind == MessageKind::Voice).unwrap();
        assert_eq!(c.voice_wav(i).unwrap(), b"RIFF....WAVE");
        assert!(c.offer_file(&png), "{}", c.status);
        assert_eq!(c.files.rows().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn peek_banner_info_and_links() {
        let mut c = demo();
        let me = c.engine.device_id().to_string();
        let ann = c.friends[0].id.clone();
        let inv = Invitation { name: "Den".into(), room: "r".into(), onion: "x.onion".into(), device: ann, id: "1".into(), expires: now_secs() + 7200, for_device: me };
        let p = c.peek(&codes::encode_invitation(&inv)).unwrap();
        assert_eq!(p.inviter_name.as_deref(), Some("Ann"));
        assert_eq!(p.for_me, Some(true));
        assert!(p.summary.contains("personal invitation for you") && p.summary.contains("expires in 2 h"), "{}", p.summary);
        assert!(c.peek("nope").is_none());
        assert_eq!(expiry_text(10, 20), "expired");
        assert!(c.banner().is_none(), "Ann is in the room");
        assert!(c.create_room("Solo"));
        assert_eq!(c.banner().as_deref(), Some(c.tr("banner.alone").as_str()));
        assert!(c.room_info().iter().any(|(k, v)| k == "Name" && v == "Solo"));
        assert_eq!(c.open_link("enigma://room/Lighthouse/news?to=Ann&quote=hi+there").as_deref(), Some("#news @Ann hi there"));
        assert_eq!(c.room_name().as_deref(), Some("Lighthouse"));
        assert_eq!(c.open_link("enigma://room/Nowhere").as_deref(), Some(""));
        assert!(c.status.contains("Nowhere"));
        assert!(c.open_link("https://example.com").is_none());
        assert_eq!(percent_decode("a%20b%2"), "a b%2");
    }
}
