//! Enigma Beacon: a Slint app to run and manage a Beacon on a desktop or a
//! Raspberry Pi with a screen. The logic is in [`model`]; this file maps a
//! [`model::Snapshot`] onto the window and its callbacks onto the model.

pub mod headless;
pub mod model;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use beacon::runner::Phase;
use model::{Model, Snapshot};
use slint::{ComponentHandle, Image, ModelRc, Rgb8Pixel, SharedPixelBuffer, SharedString, VecModel};

slint::include_modules!();

/// Quiet zone around the QR code, in modules.
pub const QR_BORDER: usize = 4;

/// The code as a QR image: dark modules on white, a 4-module border, `scale` px a module.
#[must_use]
pub fn qr_image(code: &str, scale: usize) -> Option<Image> {
    let (n, mods) = beacon::page::qr_modules(code).ok()?;
    let side = (n + 2 * QR_BORDER) * scale;
    let mut buf = SharedPixelBuffer::<Rgb8Pixel>::new(side as u32, side as u32);
    let px = buf.make_mut_slice();
    px.fill(Rgb8Pixel { r: 255, g: 255, b: 255 });
    for y in 0..n {
        for x in 0..n {
            if mods[y * n + x] {
                for dy in 0..scale {
                    let row = ((y + QR_BORDER) * scale + dy) * side;
                    let col = (x + QR_BORDER) * scale;
                    px[row + col..row + col + scale].fill(Rgb8Pixel { r: 0x1b, g: 0x1f, b: 0x2a });
                }
            }
        }
    }
    Some(Image::from_rgb8(buf))
}

fn s(x: impl Into<SharedString>) -> SharedString {
    x.into()
}

/// Puts a snapshot on the window (everything but the editable fields).
pub fn refresh(ui: &AppWindow, snap: &Snapshot) {
    let now = model::now_secs();
    let (kind, err) = match &snap.phase {
        Phase::Off => (0, String::new()),
        Phase::StartingTor | Phase::PublishingOnion => (1, String::new()),
        Phase::Online => (2, String::new()),
        Phase::Error(e) => (3, e.clone()),
    };
    ui.set_demo(snap.demo);
    ui.set_on(matches!(snap.phase, Phase::StartingTor | Phase::PublishingOnion | Phase::Online));
    ui.set_phase(s(snap.phase.label()));
    ui.set_phase_kind(kind);
    ui.set_error(s(err));
    ui.set_onion(s(snap.onion.clone().unwrap_or_default()));
    let code = snap.code.clone().unwrap_or_default();
    if ui.get_code().as_str() != code {
        if let Some(img) = qr_image(&code, 8) {
            ui.set_qr(img);
        }
        ui.set_code(s(code));
    }
    ui.set_uptime(s(snap.uptime.map(model::duration).unwrap_or_default()));
    ui.set_tor(s(snap.tor.clone()));
    ui.set_clients_online(snap.clients_online() as i32);
    ui.set_clients_total(snap.clients.len() as i32);
    ui.set_rooms_total(snap.rooms.len() as i32);
    ui.set_links_total(snap.links() as i32);

    let clients: Vec<ClientItem> = snap
        .clients
        .iter()
        .map(|c| ClientItem {
            id: s(model::short(&c.device)),
            online: c.online,
            seen: s(if c.online { "now".into() } else { model::ago(c.last_seen, now) }),
            rooms: c.rooms as i32,
            queued: s(if c.queued_frames == 0 { "—".into() } else { format!("{} frames · {}", c.queued_frames, model::bytes(c.queued_bytes)) }),
        })
        .collect();
    ui.set_clients(ModelRc::new(VecModel::from(clients)));
    ui.set_restricted(snap.restricted);
    ui.set_restart_needed(snap.restart_needed);
    let allowed: Vec<SharedString> = snap.allowed.iter().map(|a| s(a.as_str())).collect();
    ui.set_allowed(ModelRc::new(VecModel::from(allowed)));

    let rooms: Vec<RoomItem> = snap
        .rooms
        .iter()
        .map(|r| RoomItem {
            id: s(model::short(&r.room)),
            online: r.online as i32,
            members: r.members as i32,
            linked: s(if r.wanted == 0 {
                "none listed".to_string()
            } else {
                format!("{} of {} up{}", r.linked.len(), r.wanted, if r.linked.is_empty() { String::new() } else { format!(" · {}", r.linked.iter().map(|o| model::short_onion(o)).collect::<Vec<_>>().join(", ")) })
            }),
            queued: s(if r.queued_frames == 0 { "—".into() } else { format!("{} frames · {}", r.queued_frames, model::bytes(r.queued_bytes)) }),
        })
        .collect();
    ui.set_rooms(ModelRc::new(VecModel::from(rooms)));

    ui.set_data_dir(s(snap.data_dir.clone()));
    ui.set_key_status(s(snap.check.master_key.clone()));
    ui.set_key_ok(snap.check.key_ok());
    let mut disk = snap.check.disk.describe();
    if snap.check.key_off_encrypted_disk {
        disk.push_str(". Note: the master key is not on the encrypted disk.");
    }
    ui.set_disk_status(s(disk));
    ui.set_disk_ok(snap.check.disk.is_encrypted());
    ui.set_page_on(snap.page);

    let log: Vec<LogItem> = snap
        .log
        .iter()
        .rev()
        .map(|l| LogItem { time: s(model::ago(l.at, now)), text: s(l.text.as_str()), kind: l.kind as i32 })
        .collect();
    ui.set_log(ModelRc::new(VecModel::from(log)));
}

/// Fills the editable fields (name, limits, backup path) from the model.
pub fn load_fields(ui: &AppWindow, m: &Model) {
    let c = m.config();
    let l = m.limits();
    ui.set_name(s(c.name.as_str()));
    ui.set_max_clients(s(l.max_clients.to_string()));
    ui.set_queue_frames(s(l.max_queue_frames.to_string()));
    ui.set_queue_mb(s(l.max_queue_mb.to_string()));
    ui.set_queue_days(s(l.queue_ttl_days.to_string()));
    ui.set_message_days(s(l.message_ttl_days.to_string()));
    ui.set_release_delay(s(l.release_delay_secs.to_string()));
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    ui.set_backup_path(s(home.join("beacon-backup.sqlite").display().to_string()));
}

fn parse_limits(ui: &AppWindow) -> anyhow::Result<model::Limits> {
    fn num<T: std::str::FromStr>(v: SharedString, what: &str) -> anyhow::Result<T> {
        v.trim().parse().map_err(|_| anyhow::anyhow!("{what}: not a number"))
    }
    Ok(model::Limits {
        max_clients: num(ui.get_max_clients(), "phones attached at once")?,
        max_queue_frames: num(ui.get_queue_frames(), "queue frames")?,
        max_queue_mb: num(ui.get_queue_mb(), "queue size")?,
        queue_ttl_days: num(ui.get_queue_days(), "keep queued frames")?,
        message_ttl_days: num(ui.get_message_days(), "keep mailbox messages")?,
        release_delay_secs: num(ui.get_release_delay(), "release delay")?,
    })
}

/// The window on a model, with its callbacks wired.
pub fn build(m: Model) -> Result<(AppWindow, Rc<RefCell<Model>>), slint::PlatformError> {
    let ui = AppWindow::new()?;
    let m = Rc::new(RefCell::new(m));
    load_fields(&ui, &m.borrow());
    refresh(&ui, &m.borrow_mut().snapshot());

    let wire = |f: Box<dyn Fn(&AppWindow, &mut Model)>| {
        let (w, m) = (ui.as_weak(), m.clone());
        move || {
            if let Some(ui) = w.upgrade() {
                f(&ui, &mut m.borrow_mut());
                let snap = m.borrow_mut().snapshot();
                refresh(&ui, &snap);
            }
        }
    };
    ui.on_toggle(wire(Box::new(|ui, m| {
        if let Err(e) = m.toggle() {
            ui.set_toast(s(format!("{e:#}")));
        }
    })));
    {
        let w = ui.as_weak();
        ui.on_copied(move |what| {
            if let Some(ui) = w.upgrade() {
                ui.set_toast(s(format!("{what} copied")));
            }
        });
    }
    ui.on_allow(wire(Box::new(|ui, m| {
        let (n, k) = (ui.get_allow_name(), ui.get_allow_key());
        match m.allow(&n, &k) {
            Ok(()) => {
                ui.set_allow_error(false);
                ui.set_allow_message(s(format!("{} is allowed{}", n.trim(), if m.config().restricted_discovery { "; it can find the Beacon within minutes" } else { " (Only my phones is off: everyone can find the Beacon)" })));
                ui.set_allow_name(s(""));
                ui.set_allow_key(s(""));
            }
            Err(e) => {
                ui.set_allow_error(true);
                ui.set_allow_message(s(format!("{e:#}")));
            }
        }
    })));
    {
        let (w, mm) = (ui.as_weak(), m.clone());
        ui.on_deny(move |name| {
            let Some(ui) = w.upgrade() else { return };
            let r = mm.borrow_mut().deny(&name);
            ui.set_allow_error(r.is_err());
            ui.set_allow_message(s(match r {
                Ok(()) => format!("{name} is off the list (it may still reach the Beacon for a while)"),
                Err(e) => format!("{e:#}"),
            }));
            let snap = mm.borrow_mut().snapshot();
            refresh(&ui, &snap);
        });
    }
    {
        let (w, mm) = (ui.as_weak(), m.clone());
        ui.on_set_restricted(move |on| {
            let Some(ui) = w.upgrade() else { return };
            if let Err(e) = mm.borrow_mut().set_restricted(on) {
                ui.set_allow_error(true);
                ui.set_allow_message(s(format!("{e:#}")));
            }
            let snap = mm.borrow_mut().snapshot();
            refresh(&ui, &snap);
        });
    }
    {
        let (w, mm) = (ui.as_weak(), m.clone());
        ui.on_set_page(move |on| {
            let Some(ui) = w.upgrade() else { return };
            let r = mm.borrow_mut().set_page(on);
            settings_result(&ui, r.map(|()| "saved (in force from the next start)".into()));
            let snap = mm.borrow_mut().snapshot();
            refresh(&ui, &snap);
        });
    }
    ui.on_save_settings(wire(Box::new(|ui, m| {
        let r = (|| {
            m.set_name(&ui.get_name())?;
            m.set_limits(&parse_limits(ui)?)?;
            anyhow::Ok(format!("saved to {}", m.config_path().display()))
        })();
        settings_result(ui, r);
    })));
    ui.on_backup(wire(Box::new(|ui, m| {
        let p = PathBuf::from(ui.get_backup_path().trim());
        let r = m.backup(&p).map(|()| format!("backed up to {}; back up the master key separately", p.display()));
        settings_result(ui, r);
    })));
    ui.on_recheck(wire(Box::new(|ui, m| {
        let c = m.recheck();
        settings_result(ui, Ok(format!("master key: {}", c.master_key)));
    })));
    Ok((ui, m))
}

fn settings_result(ui: &AppWindow, r: anyhow::Result<String>) {
    match r {
        Ok(t) => {
            ui.set_settings_error(false);
            ui.set_settings_message(s(t));
        }
        Err(e) => {
            ui.set_settings_error(true);
            ui.set_settings_message(s(format!("{e:#}")));
        }
    }
}

/// Runs the app until its window closes. A refresh every second keeps the
/// statistics current.
pub fn run(m: Model) -> Result<(), slint::PlatformError> {
    let (ui, m) = build(m)?;
    run_built(ui, m)
}

/// [`run`] on a window from [`build`].
pub fn run_built(ui: AppWindow, m: Rc<RefCell<Model>>) -> Result<(), slint::PlatformError> {
    let timer = slint::Timer::default();
    {
        let (w, m) = (ui.as_weak(), m.clone());
        timer.start(slint::TimerMode::Repeated, std::time::Duration::from_secs(1), move || {
            if let Some(ui) = w.upgrade() {
                let snap = m.borrow_mut().snapshot();
                refresh(&ui, &snap);
            }
        });
    }
    ui.run()?;
    m.borrow_mut().stop();
    Ok(())
}
