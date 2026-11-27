//! The Beacon manager, without any UI: starts and stops a Beacon (through
//! `beacon::runner`), reads its relay statistics, edits the allowed phones and the
//! config. The Slint layer (`lib.rs`) only turns a [`Snapshot`] into properties.
//!
//! What it shows is counts and ids only: a Beacon never sees names or content.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use beacon::config::Config;
use beacon::runner::{self, Check, Listen, Phase, Running};
use beacon_node::relay::{EventKind, Relay};

/// How many log lines are kept.
const LOG_CAP: usize = 300;

/// Unix seconds.
#[must_use]
pub fn now_secs() -> u64 {
    beacon_node::relay::now_secs()
}

/// A device id or route id, shortened for a screen: `ab12cd34…`.
#[must_use]
pub fn short(id: &str) -> String {
    if id.len() <= 12 {
        id.to_string()
    } else {
        format!("{}…", &id[..8])
    }
}

/// An onion, shortened: `abcdefgh…xyz.onion`.
#[must_use]
pub fn short_onion(o: &str) -> String {
    let base = o.trim_end_matches(".onion");
    if base.len() <= 16 {
        return o.to_string();
    }
    format!("{}…{}.onion", &base[..8], &base[base.len() - 4..])
}

/// "just now", "5 min ago", "3 h ago", "2 days ago", "never".
#[must_use]
pub fn ago(t: u64, now: u64) -> String {
    if t == 0 {
        return "never".into();
    }
    let d = now.saturating_sub(t);
    match d {
        0..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", d / 60),
        3600..=86_399 => format!("{} h ago", d / 3600),
        _ => format!("{} days ago", d / 86_400),
    }
}

/// "1 h 05 min", "3 min", "12 s".
#[must_use]
pub fn duration(secs: u64) -> String {
    match secs {
        0..=59 => format!("{secs} s"),
        60..=3599 => format!("{} min", secs / 60),
        3600..=86_399 => format!("{} h {:02} min", secs / 3600, secs % 3600 / 60),
        _ => format!("{} days {} h", secs / 86_400, secs % 86_400 / 3600),
    }
}

/// "12 KB", "3.4 MB".
#[must_use]
pub fn bytes(n: usize) -> String {
    match n {
        0..=1023 => format!("{n} B"),
        1024..=1_048_575 => format!("{} KB", n / 1024),
        _ => format!("{:.1} MB", n as f64 / 1_048_576.0),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientRow {
    pub device: String,
    pub online: bool,
    pub last_seen: u64,
    pub rooms: usize,
    pub queued_frames: usize,
    pub queued_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomRow {
    pub room: String,
    pub members: usize,
    pub online: usize,
    pub linked: Vec<String>,
    pub wanted: usize,
    pub queued_frames: usize,
    pub queued_bytes: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogKind {
    Info,
    Good,
    Bad,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogLine {
    pub at: u64,
    pub kind: LogKind,
    pub text: String,
}

/// The settings the Settings screen edits (all saved to config.yaml).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_clients: usize,
    pub max_queue_frames: usize,
    pub max_queue_mb: usize,
    pub queue_ttl_days: u64,
    pub message_ttl_days: u64,
    pub release_delay_secs: u64,
}

/// Everything a screen shows.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub phase: Phase,
    pub onion: Option<String>,
    /// `pharos-beacon:…`, when the address is known.
    pub code: Option<String>,
    pub uptime: Option<u64>,
    pub tor: String,
    pub clients: Vec<ClientRow>,
    pub rooms: Vec<RoomRow>,
    pub allowed: Vec<String>,
    pub restricted: bool,
    pub restart_needed: bool,
    pub log: Vec<LogLine>,
    pub name: String,
    pub data_dir: String,
    pub page: bool,
    pub limits: Limits,
    pub check: Check,
    pub demo: bool,
}

impl Snapshot {
    #[must_use]
    pub fn clients_online(&self) -> usize {
        self.clients.iter().filter(|c| c.online).count()
    }
    #[must_use]
    pub fn links(&self) -> usize {
        self.rooms.iter().map(|r| r.linked.len()).sum()
    }
}

/// Where the model gets its Beacon from.
#[derive(Clone)]
pub enum Mode {
    /// A real Beacon, on Tor (or loopback, or in-process for tests).
    Real(Listen),
    /// Fake clients and rooms (screenshots); nothing is served.
    Demo,
}

/// The Beacon manager.
pub struct Model {
    config_path: PathBuf,
    cfg: Config,
    mode: Mode,
    rt: Option<tokio::runtime::Runtime>,
    handle: tokio::runtime::Handle,
    running: Option<Running>,
    /// The restricted-discovery setting the running Beacon started with.
    started_restricted: Option<bool>,
    log: Vec<LogLine>,
    notes_seen: usize,
    relay_seen: Option<(usize, u64)>,
    check: Check,
    demo_started: Option<u64>,
}

impl Model {
    /// A manager for the Beacon configured at `config_path` (made with defaults if
    /// missing). It owns a small tokio runtime.
    pub fn open(config_path: &Path, mode: Mode) -> Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()?;
        let h = rt.handle().clone();
        let mut m = Self::with_handle(config_path, mode, h)?;
        m.rt = Some(rt);
        Ok(m)
    }

    /// The same on an existing runtime.
    pub fn with_handle(config_path: &Path, mode: Mode, handle: tokio::runtime::Handle) -> Result<Self> {
        let cfg = if config_path.exists() {
            Config::load(config_path)?
        } else {
            let mut c = Config::default();
            if let Some(d) = config_path.parent() {
                c.data_dir = d.join("data");
                c.master_key = d.join("master.key");
            }
            c
        };
        let check = runner::check(&cfg);
        let mut m = Model {
            config_path: config_path.to_path_buf(),
            cfg,
            mode,
            rt: None,
            handle,
            running: None,
            started_restricted: None,
            log: vec![],
            notes_seen: 0,
            relay_seen: None,
            check,
            demo_started: None,
        };
        if m.is_demo() {
            m.demo_seed();
        }
        Ok(m)
    }

    /// The runtime the Beacon runs on (enigma27-combo dials its relay from here).
    #[must_use]
    pub fn handle(&self) -> tokio::runtime::Handle {
        self.handle.clone()
    }

    #[must_use]
    pub fn is_demo(&self) -> bool {
        matches!(self.mode, Mode::Demo)
    }

    #[must_use]
    pub fn config(&self) -> &Config {
        &self.cfg
    }

    #[must_use]
    pub fn config_path(&self) -> &Path {
        &self.config_path
    }

    fn push(&mut self, kind: LogKind, text: impl Into<String>) {
        self.push_at(now_secs(), kind, text);
    }

    fn push_at(&mut self, at: u64, kind: LogKind, text: impl Into<String>) {
        self.log.push(LogLine { at, kind, text: text.into() });
        if self.log.len() > LOG_CAP {
            self.log.remove(0);
        }
    }

    /// Is a Beacon running (or starting)?
    #[must_use]
    pub fn is_on(&self) -> bool {
        if self.is_demo() {
            return self.demo_started.is_some();
        }
        self.running.as_ref().is_some_and(|r| !r.is_finished())
    }

    /// Starts the Beacon. Makes the data folder and master key first if they are
    /// missing (as `beacon init`).
    pub fn start(&mut self) -> Result<()> {
        if self.is_on() {
            return Ok(());
        }
        if self.is_demo() {
            self.demo_started = Some(now_secs());
            self.push(LogKind::Good, "Beacon started");
            return Ok(());
        }
        let Mode::Real(listen) = self.mode.clone() else { unreachable!() };
        if runner::init(&self.cfg).context("making the data folder and master key")? {
            self.push(LogKind::Info, format!("made a master key at {} — back it up apart from the data", self.cfg.master_key.display()));
        }
        self.check = runner::check(&self.cfg);
        if !self.check.key_ok() {
            let m = self.check.master_key.clone();
            self.push(LogKind::Bad, format!("not started: master key {m}"));
            bail!("master key: {m}");
        }
        self.push(LogKind::Info, "starting");
        self.started_restricted = Some(self.cfg.restricted_discovery);
        self.running = Some(runner::start(self.cfg.clone(), listen, &self.handle, false));
        self.notes_seen = 0;
        self.relay_seen = None;
        Ok(())
    }

    /// Stops it (it reaches "off" within a moment).
    pub fn stop(&mut self) {
        if self.is_demo() {
            if self.demo_started.take().is_some() {
                self.push(LogKind::Info, "Beacon stopped");
            }
            return;
        }
        self.poll();
        if let Some(r) = self.running.as_mut() {
            r.stop();
            self.push(LogKind::Info, "stop requested");
        }
    }

    /// Start if off, stop if on.
    pub fn toggle(&mut self) -> Result<()> {
        if self.is_on() {
            self.stop();
            Ok(())
        } else {
            self.start()
        }
    }

    /// The relay of the running Beacon.
    #[must_use]
    pub fn relay(&self) -> Option<Arc<Relay>> {
        self.running.as_ref().and_then(Running::relay)
    }

    /// Pulls new notes and relay events into the log.
    pub fn poll(&mut self) {
        let Some((st, relay)) = self.running.as_ref().map(|r| (r.status(), r.relay())) else { return };
        let new: Vec<(u64, String)> = st.notes.iter().skip(self.notes_seen).cloned().collect();
        self.notes_seen = st.notes.len();
        for (at, n) in new {
            let kind = if n.starts_with("error") || n.starts_with("WARNING") { LogKind::Bad } else { LogKind::Info };
            self.push_at(at, kind, n);
        }
        if let Some(rel) = relay {
            let id = Arc::as_ptr(&rel) as usize;
            let since = match self.relay_seen {
                Some((i, s)) if i == id => s,
                _ => 0,
            };
            let evs = rel.events_since(since);
            if let Some(last) = evs.last() {
                self.relay_seen = Some((id, last.seq));
            } else if self.relay_seen.is_none_or(|(i, _)| i != id) {
                self.relay_seen = Some((id, since));
            }
            for e in evs {
                let (kind, text) = match e.kind {
                    EventKind::ClientAttached { device } => (LogKind::Good, format!("phone {} attached", short(&device))),
                    EventKind::ClientDetached { device } => (LogKind::Info, format!("phone {} left", short(&device))),
                    EventKind::ClientRefused { why } => (LogKind::Bad, format!("refused a phone: {why}")),
                    EventKind::LinkUp { room, peer } => (LogKind::Good, format!("link up to {} (room {})", short_onion(&peer), short(&room))),
                    EventKind::LinkDown { room, peer } => (LogKind::Bad, format!("link down to {} (room {})", short_onion(&peer), short(&room))),
                    EventKind::BeaconRefused { peer, why } => (LogKind::Bad, format!("refused Beacon {}: {why}", short_onion(&peer))),
                };
                self.push_at(e.at, kind, text);
            }
        }
    }

    /// Everything the screens show, now.
    pub fn snapshot(&mut self) -> Snapshot {
        if self.is_demo() {
            return self.demo_snapshot();
        }
        self.poll();
        let now = now_secs();
        let (phase, onion, uptime, tor) = match self.running.as_ref() {
            Some(r) => {
                let s = r.status();
                (s.phase, s.onion, s.online_since.map(|t| now.saturating_sub(t)), s.tor)
            }
            None => (Phase::Off, None, None, "not running".into()),
        };
        let onion = onion.or_else(|| runner::served_onion(&self.cfg));
        let code = onion.as_deref().and_then(|o| beacon::page::Page::build(o, &self.cfg.name).ok()).map(|p| p.code);
        let stats = self.relay().map(|r| r.stats()).unwrap_or_default();
        let clients = stats
            .clients
            .into_iter()
            .map(|c| ClientRow { device: c.device, online: c.online, last_seen: c.last_seen, rooms: c.rooms, queued_frames: c.queued_frames, queued_bytes: c.queued_bytes })
            .collect();
        let rooms = stats
            .rooms
            .into_iter()
            .map(|r| RoomRow { room: r.room, members: r.members, online: r.online, linked: r.linked, wanted: r.wanted, queued_frames: r.queued_frames, queued_bytes: r.queued_bytes })
            .collect();
        let on = self.is_on();
        self.base_snapshot(phase, onion, code, uptime, tor, clients, rooms, on)
    }

    #[allow(clippy::too_many_arguments)]
    fn base_snapshot(&self, phase: Phase, onion: Option<String>, code: Option<String>, uptime: Option<u64>, tor: String, clients: Vec<ClientRow>, rooms: Vec<RoomRow>, on: bool) -> Snapshot {
        Snapshot {
            phase,
            onion,
            code,
            uptime,
            tor,
            clients,
            rooms,
            allowed: self.allowed(),
            restricted: self.cfg.restricted_discovery,
            restart_needed: on && self.started_restricted.is_some_and(|r| r != self.cfg.restricted_discovery),
            log: self.log.clone(),
            name: self.cfg.name.clone(),
            data_dir: self.cfg.data_dir.display().to_string(),
            page: self.cfg.page,
            limits: self.limits(),
            check: self.check.clone(),
            demo: self.is_demo(),
        }
    }

    /// The phones allowed to find it (restricted discovery).
    #[must_use]
    pub fn allowed(&self) -> Vec<String> {
        beacon::clients::list(&self.cfg.clients_dir()).unwrap_or_default()
    }

    /// `beacon allow NAME KEY`.
    pub fn allow(&mut self, name: &str, key: &str) -> Result<()> {
        beacon::clients::allow(&self.cfg.clients_dir(), name.trim(), key)?;
        self.push(LogKind::Info, format!("allowed phone {}", name.trim()));
        Ok(())
    }

    /// `beacon deny NAME`.
    pub fn deny(&mut self, name: &str) -> Result<()> {
        beacon::clients::deny(&self.cfg.clients_dir(), name)?;
        self.push(LogKind::Info, format!("took {name} off the list (it may still reach Beacon for a while)"));
        Ok(())
    }

    fn save(&mut self) -> Result<()> {
        if let Some(d) = self.config_path.parent() {
            std::fs::create_dir_all(d)?;
        }
        self.cfg.save(&self.config_path)
    }

    /// "Only my phones". Takes effect the next time the Beacon starts.
    pub fn set_restricted(&mut self, on: bool) -> Result<()> {
        if self.cfg.restricted_discovery == on {
            return Ok(());
        }
        self.cfg.restricted_discovery = on;
        self.save()?;
        let when = if self.is_on() { " (restart the Beacon for it to take effect)" } else { "" };
        self.push(LogKind::Info, format!("only my phones {}{when}", if on { "on" } else { "off" }));
        Ok(())
    }

    #[must_use]
    pub fn limits(&self) -> Limits {
        Limits {
            max_clients: self.cfg.relay.max_clients,
            max_queue_frames: self.cfg.relay.max_queue_frames,
            max_queue_mb: self.cfg.relay.max_queue_bytes / (1024 * 1024),
            queue_ttl_days: self.cfg.relay.queue_ttl_days,
            message_ttl_days: self.cfg.limits.message_ttl_days,
            release_delay_secs: self.cfg.limits.release_delay_secs,
        }
    }

    /// Saves the limits (in force from the next start).
    pub fn set_limits(&mut self, l: &Limits) -> Result<()> {
        if l.max_clients == 0 || l.max_queue_frames == 0 || l.max_queue_mb == 0 || l.queue_ttl_days == 0 || l.message_ttl_days == 0 {
            bail!("limits must be above zero");
        }
        if l.release_delay_secs > 3600 {
            bail!("the release delay is at most an hour");
        }
        self.cfg.relay.max_clients = l.max_clients;
        self.cfg.relay.max_queue_frames = l.max_queue_frames;
        self.cfg.relay.max_queue_bytes = l.max_queue_mb * 1024 * 1024;
        self.cfg.relay.queue_ttl_days = l.queue_ttl_days;
        self.cfg.limits.message_ttl_days = l.message_ttl_days;
        self.cfg.limits.release_delay_secs = l.release_delay_secs;
        self.save()?;
        self.push(LogKind::Info, "limits saved (in force from the next start)");
        Ok(())
    }

    /// Its name (on its page and in its code).
    pub fn set_name(&mut self, name: &str) -> Result<()> {
        let n = name.trim();
        if n.is_empty() || n.chars().count() > 64 {
            bail!("a name is 1 to 64 characters");
        }
        self.cfg.name = n.to_string();
        self.save()?;
        self.push(LogKind::Info, format!("name set to {n}"));
        Ok(())
    }

    pub fn set_page(&mut self, on: bool) -> Result<()> {
        self.cfg.page = on;
        self.save()?;
        self.push(LogKind::Info, format!("page {}", if on { "on" } else { "off" }));
        Ok(())
    }

    /// `beacon check` again.
    pub fn recheck(&mut self) -> Check {
        self.check = runner::check(&self.cfg);
        self.check.clone()
    }

    /// `beacon backup OUT`.
    pub fn backup(&mut self, out: &Path) -> Result<()> {
        if self.is_demo() {
            bail!("no database in demo mode");
        }
        runner::open_store(&self.cfg)?.backup(out)?;
        self.push(LogKind::Good, format!("backed up to {}; back up the master key separately", out.display()));
        Ok(())
    }

    // Demo ─────────────────────────────────────────────────────────────────

    fn demo_seed(&mut self) {
        let t = now_secs();
        self.demo_started = Some(t - 3 * 3600 - 17 * 60);
        let lines = [
            (3 * 3600 + 18 * 60, LogKind::Info, "starting".to_string()),
            (3 * 3600 + 17 * 60 + 40, LogKind::Info, "disk: the data folder is on an encrypted disk (/dev/mapper/crypt, mounted at /)".into()),
            (3 * 3600 + 17 * 60, LogKind::Good, format!("serving on {}", short_onion(&demo_onion()))),
            (3 * 3600 + 16 * 60, LogKind::Good, "phone 5f1c09ab… attached".into()),
            (3 * 3600 + 15 * 60, LogKind::Good, "link up to lkq2x7cd…3nqd.onion (room 9be41c07…)".into()),
            (2 * 3600, LogKind::Bad, "refused a phone: bad signature".into()),
            (47 * 60, LogKind::Info, "phone c27d4410… left".into()),
            (12 * 60, LogKind::Bad, "link down to v3mj2kq9…a7ad.onion (room 41aa6b02…)".into()),
            (11 * 60, LogKind::Good, "link up to v3mj2kq9…a7ad.onion (room 41aa6b02…)".into()),
            (4 * 60, LogKind::Bad, "refused Beacon zz9q4a1b…k2fq.onion: not listed".into()),
            (60, LogKind::Good, "phone 0e8a52d1… attached".into()),
        ];
        for (ago, k, s) in lines {
            self.push_at(t - ago, k, s);
        }
    }

    fn demo_snapshot(&self) -> Snapshot {
        let now = now_secs();
        let on = self.demo_started.is_some();
        let dev = |s: &str| format!("{s}{}", "0".repeat(64 - s.len()));
        let clients = if on {
            vec![
                ClientRow { device: dev("5f1c09ab77e2"), online: true, last_seen: now, rooms: 3, queued_frames: 0, queued_bytes: 0 },
                ClientRow { device: dev("0e8a52d19c40"), online: true, last_seen: now, rooms: 2, queued_frames: 0, queued_bytes: 0 },
                ClientRow { device: dev("c27d44103b9f"), online: false, last_seen: now - 47 * 60, rooms: 2, queued_frames: 14, queued_bytes: 61_440 },
                ClientRow { device: dev("a913fe6d2011"), online: false, last_seen: now - 2 * 86_400, rooms: 1, queued_frames: 132, queued_bytes: 2_621_440 },
            ]
        } else {
            vec![]
        };
        let rooms = if on {
            vec![
                RoomRow { room: dev("9be41c07d2"), members: 3, online: 2, linked: vec!["lkq2x7cd".into(), "v3mj2kq9".into()], wanted: 2, queued_frames: 14, queued_bytes: 61_440 },
                RoomRow { room: dev("41aa6b0233"), members: 2, online: 1, linked: vec!["v3mj2kq9".into()], wanted: 1, queued_frames: 0, queued_bytes: 0 },
                RoomRow { room: dev("e07f9a5c18"), members: 2, online: 1, linked: vec![], wanted: 1, queued_frames: 132, queued_bytes: 2_621_440 },
            ]
        } else {
            vec![]
        };
        let onion = demo_onion();
        let code = beacon::page::Page::build(&onion, &self.cfg.name).ok().map(|p| p.code);
        let phase = if on { Phase::Online } else { Phase::Off };
        let tor = if on { "connected · full vanguards" } else { "not running" }.to_string();
        let mut s = self.base_snapshot(phase, Some(onion), code, self.demo_started.map(|t| now - t), tor, clients, rooms, on);
        if s.allowed.is_empty() {
            s.allowed = vec!["anna-phone".into(), "home-tablet".into(), "piotr-phone".into()];
        }
        s.check = Check {
            master_key: "ok".into(),
            disk: beacon::diskcrypt::Verdict::Encrypted { mount: "/".into(), device: "/dev/mapper/crypt".into() },
            key_off_encrypted_disk: false,
        };
        s.data_dir = "/var/lib/beacon".into();
        s
    }
}

/// A valid-looking v3 onion for the demo (made from a fixed key).
#[must_use]
pub fn demo_onion() -> String {
    let mut k = [7u8; 64];
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;
    pharos_tor::onion_of(k).unwrap_or_else(|_| "pharosdemobeaconpharosdemobeaconpharosdemobeaconpharosd.onion".into())
}

impl Drop for Model {
    fn drop(&mut self) {
        if let Some(mut r) = self.running.take() {
            r.stop();
        }
        if let Some(rt) = self.rt.take() {
            rt.shutdown_timeout(std::time::Duration::from_secs(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        assert_eq!(short(&"ab".repeat(32)), "abababab…");
        assert_eq!(ago(0, 10), "never");
        assert_eq!(ago(100, 130), "just now");
        assert_eq!(ago(100, 100 + 300), "5 min ago");
        assert_eq!(duration(3 * 3600 + 5 * 60), "3 h 05 min");
        assert_eq!(bytes(2048), "2 KB");
        assert!(demo_onion().ends_with(".onion"));
    }
}
