// The Lighthouse window glue. Shared source: pharos-lighthouse includes it in its lib
// (`mod glue`), enigma27-combo includes it too, so it runs on either crate's generated
// Slint types. The includer brings into scope: `AppWindow` (a window with set-dark /
// set-system-theme and the LighthouseView), the `Lh` global, `LhClient`, `LhRoom`, `LhLog`,
// and `model`, `qr_image`, `load_theme`, `save_theme` from pharos_lighthouse.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use beacon::runner::Phase;
use slint::{ComponentHandle, ModelRc, SharedString, VecModel};

use self::model::{Model, Snapshot};

/// The Lighthouse global of a window.
pub fn lh(ui: &AppWindow) -> Lh<'_> {
    ui.global::<Lh>()
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
    lh(&ui).set_demo(snap.demo);
    lh(&ui).set_on(matches!(snap.phase, Phase::StartingTor | Phase::PublishingOnion | Phase::Online));
    lh(&ui).set_phase(s(snap.phase.label()));
    lh(&ui).set_phase_kind(kind);
    lh(&ui).set_error(s(err));
    lh(&ui).set_onion(s(snap.onion.clone().unwrap_or_default()));
    let code = snap.code.clone().unwrap_or_default();
    if lh(&ui).get_code().as_str() != code {
        if let Some(img) = qr_image(&code, 8) {
            lh(&ui).set_qr(img);
        }
        lh(&ui).set_code(s(code));
    }
    lh(&ui).set_uptime(s(snap.uptime.map(model::duration).unwrap_or_default()));
    lh(&ui).set_tor(s(snap.tor.clone()));
    lh(&ui).set_clients_online(snap.clients_online() as i32);
    lh(&ui).set_clients_total(snap.clients.len() as i32);
    lh(&ui).set_rooms_total(snap.rooms.len() as i32);
    lh(&ui).set_links_total(snap.links() as i32);

    let clients: Vec<LhClient> = snap
        .clients
        .iter()
        .map(|c| LhClient {
            id: s(model::short(&c.device)),
            online: c.online,
            seen: s(if c.online { "now".into() } else { model::ago(c.last_seen, now) }),
            rooms: c.rooms as i32,
            queued: s(if c.queued_frames == 0 { "—".into() } else { format!("{} frames · {}", c.queued_frames, model::bytes(c.queued_bytes)) }),
        })
        .collect();
    lh(&ui).set_clients(ModelRc::new(VecModel::from(clients)));
    lh(&ui).set_restricted(snap.restricted);
    lh(&ui).set_restart_needed(snap.restart_needed);
    let allowed: Vec<SharedString> = snap.allowed.iter().map(|a| s(a.as_str())).collect();
    lh(&ui).set_allowed(ModelRc::new(VecModel::from(allowed)));

    let rooms: Vec<LhRoom> = snap
        .rooms
        .iter()
        .map(|r| LhRoom {
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
    lh(&ui).set_rooms(ModelRc::new(VecModel::from(rooms)));

    lh(&ui).set_data_dir(s(snap.data_dir.clone()));
    lh(&ui).set_key_status(s(snap.check.master_key.clone()));
    lh(&ui).set_key_ok(snap.check.key_ok());
    let mut disk = snap.check.disk.describe();
    if snap.check.key_off_encrypted_disk {
        disk.push_str(". Note: the master key is not on the encrypted disk.");
    }
    lh(&ui).set_disk_status(s(disk));
    lh(&ui).set_disk_ok(snap.check.disk.is_encrypted());
    lh(&ui).set_page_on(snap.page);

    let log: Vec<LhLog> = snap
        .log
        .iter()
        .rev()
        .map(|l| LhLog { time: s(model::ago(l.at, now)), text: s(l.text.as_str()), kind: l.kind as i32 })
        .collect();
    lh(&ui).set_log(ModelRc::new(VecModel::from(log)));
}

/// Fills the editable fields (name, limits, backup path) from the model.
pub fn load_fields(ui: &AppWindow, m: &Model) {
    let c = m.config();
    let l = m.limits();
    lh(&ui).set_name(s(c.name.as_str()));
    lh(&ui).set_max_clients(s(l.max_clients.to_string()));
    lh(&ui).set_queue_frames(s(l.max_queue_frames.to_string()));
    lh(&ui).set_queue_mb(s(l.max_queue_mb.to_string()));
    lh(&ui).set_queue_days(s(l.queue_ttl_days.to_string()));
    lh(&ui).set_message_days(s(l.message_ttl_days.to_string()));
    lh(&ui).set_release_delay(s(l.release_delay_secs.to_string()));
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
    lh(&ui).set_backup_path(s(home.join("beacon-backup.sqlite").display().to_string()));
}

fn parse_limits(ui: &AppWindow) -> anyhow::Result<model::Limits> {
    fn num<T: std::str::FromStr>(v: SharedString, what: &str) -> anyhow::Result<T> {
        v.trim().parse().map_err(|_| anyhow::anyhow!("{what}: not a number"))
    }
    Ok(model::Limits {
        max_clients: num(lh(&ui).get_max_clients(), "phones attached at once")?,
        max_queue_frames: num(lh(&ui).get_queue_frames(), "queue frames")?,
        max_queue_mb: num(lh(&ui).get_queue_mb(), "queue size")?,
        queue_ttl_days: num(lh(&ui).get_queue_days(), "keep queued frames")?,
        message_ttl_days: num(lh(&ui).get_message_days(), "keep mailbox messages")?,
        release_delay_secs: num(lh(&ui).get_release_delay(), "release delay")?,
    })
}

/// The window on a model, with its callbacks wired.
pub fn build(m: Model) -> Result<(AppWindow, Rc<RefCell<Model>>), slint::PlatformError> {
    let ui = AppWindow::new()?;
    let m = attach(&ui, m);
    Ok((ui, m))
}

/// Wires the Lighthouse view (the `Lh` global) of a window to a model.
pub fn attach(ui: &AppWindow, m: Model) -> Rc<RefCell<Model>> {
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
    lh(&ui).on_toggle(wire(Box::new(|ui, m| {
        if let Err(e) = m.toggle() {
            lh(&ui).set_toast(s(format!("{e:#}")));
        }
    })));
    {
        let w = ui.as_weak();
        lh(&ui).on_copied(move |what| {
            if let Some(ui) = w.upgrade() {
                lh(&ui).set_toast(s(format!("{what} copied")));
            }
        });
    }
    lh(&ui).on_allow(wire(Box::new(|ui, m| {
        let (n, k) = (lh(&ui).get_allow_name(), lh(&ui).get_allow_key());
        match m.allow(&n, &k) {
            Ok(()) => {
                lh(&ui).set_allow_error(false);
                lh(&ui).set_allow_message(s(format!("{} is allowed{}", n.trim(), if m.config().restricted_discovery { "; it can find the Beacon within minutes" } else { " (Only my phones is off: everyone can find the Beacon)" })));
                lh(&ui).set_allow_name(s(""));
                lh(&ui).set_allow_key(s(""));
            }
            Err(e) => {
                lh(&ui).set_allow_error(true);
                lh(&ui).set_allow_message(s(format!("{e:#}")));
            }
        }
    })));
    {
        let (w, mm) = (ui.as_weak(), m.clone());
        lh(&ui).on_deny(move |name| {
            let Some(ui) = w.upgrade() else { return };
            let r = mm.borrow_mut().deny(&name);
            lh(&ui).set_allow_error(r.is_err());
            lh(&ui).set_allow_message(s(match r {
                Ok(()) => format!("{name} is off the list (it may still reach the Beacon for a while)"),
                Err(e) => format!("{e:#}"),
            }));
            let snap = mm.borrow_mut().snapshot();
            refresh(&ui, &snap);
        });
    }
    {
        let (w, mm) = (ui.as_weak(), m.clone());
        lh(&ui).on_set_restricted(move |on| {
            let Some(ui) = w.upgrade() else { return };
            if let Err(e) = mm.borrow_mut().set_restricted(on) {
                lh(&ui).set_allow_error(true);
                lh(&ui).set_allow_message(s(format!("{e:#}")));
            }
            let snap = mm.borrow_mut().snapshot();
            refresh(&ui, &snap);
        });
    }
    {
        let (w, mm) = (ui.as_weak(), m.clone());
        lh(&ui).on_set_page(move |on| {
            let Some(ui) = w.upgrade() else { return };
            let r = mm.borrow_mut().set_page(on);
            settings_result(&ui, r.map(|()| "saved (in force from the next start)".into()));
            let snap = mm.borrow_mut().snapshot();
            refresh(&ui, &snap);
        });
    }
    {
        let w = ui.as_weak();
        lh(&ui).on_set_theme(move |choice| {
            let Some(ui) = w.upgrade() else { return };
            apply_theme(&ui, choice);
            if let Err(e) = save_theme(choice) {
                settings_result(&ui, Err(e));
            }
        });
    }
    lh(&ui).set_theme_choice(load_theme());
    apply_theme(&ui, lh(&ui).get_theme_choice());
    lh(&ui).on_save_settings(wire(Box::new(|ui, m| {
        let r = (|| {
            m.set_name(&lh(&ui).get_name())?;
            m.set_limits(&parse_limits(ui)?)?;
            anyhow::Ok(format!("saved to {}", m.config_path().display()))
        })();
        settings_result(ui, r);
    })));
    lh(&ui).on_backup(wire(Box::new(|ui, m| {
        let p = PathBuf::from(lh(&ui).get_backup_path().trim());
        let r = m.backup(&p).map(|()| format!("backed up to {}; back up the master key separately", p.display()));
        settings_result(ui, r);
    })));
    lh(&ui).on_recheck(wire(Box::new(|ui, m| {
        let c = m.recheck();
        settings_result(ui, Ok(format!("master key: {}", c.master_key)));
    })));
    m
}

fn settings_result(ui: &AppWindow, r: anyhow::Result<String>) {
    match r {
        Ok(t) => {
            lh(&ui).set_settings_error(false);
            lh(&ui).set_settings_message(s(t));
        }
        Err(e) => {
            lh(&ui).set_settings_error(true);
            lh(&ui).set_settings_message(s(format!("{e:#}")));
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
    let _timer = ticker(&ui, &m);
    ui.run()?;
    m.borrow_mut().stop();
    Ok(())
}

/// A refresh every second (keep the timer alive).
pub fn ticker(ui: &AppWindow, m: &Rc<RefCell<Model>>) -> slint::Timer {
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
    timer
}
pub fn apply_theme(ui: &AppWindow, choice: i32) {
    match choice {
        1 => ui.invoke_set_dark(false),
        2 => ui.invoke_set_dark(true),
        _ => ui.invoke_set_system_theme(),
    }
}

