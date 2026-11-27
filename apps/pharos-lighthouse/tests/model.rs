//! The model on a real Beacon run in-process (no Tor): start/stop, statistics of
//! attached clients and rooms, the allowed list, limits saved to config.yaml.

use std::sync::Arc;
use std::time::{Duration, Instant};

use beacon::config::Config;
use beacon::runner::{Listen, Phase};
use beacon_node::link::{LinkCfg, NoDialer};
use pharos_lighthouse::model::{Limits, Mode, Model};
use enigma_client::{Client, ClientConfig};
use enigma_core::Transport;

fn onion() -> String {
    pharos_lighthouse::model::demo_onion()
}
const KEY: &str = "descriptor:x25519:ZDUVQQ7IKBP6SO6X5HW6IT2BXHS4W5QQJ6E6HD3HNP3R2KRDKXGA";

fn until(what: &str, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(Instant::now() < end, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn model(dir: &std::path::Path, rt: &tokio::runtime::Runtime) -> Model {
    let listen = Listen::Memory { onion: onion(), dialer: Arc::new(NoDialer) };
    Model::with_handle(&dir.join("config.yaml"), Mode::Real(listen), rt.handle().clone()).unwrap()
}

#[test]
fn start_attach_stats_stop() {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let d = tempfile::tempdir().unwrap();
    let mut m = model(d.path(), &rt);
    assert_eq!(m.snapshot().phase, Phase::Off);
    m.start().unwrap();
    assert!(d.path().join("master.key").exists(), "start makes the master key");
    until("online", || m.snapshot().phase == Phase::Online);
    let relay = m.relay().expect("relay runs");

    let mut cc = ClientConfig::new(&onion());
    cc.link = LinkCfg { max_frame: 1 << 24, write_timeout: Duration::from_secs(5), cover_every: 0 };
    cc.redial = |_| Duration::from_millis(100);
    let a = Client::start(cc.clone(), &[1; 32], enigma_client::in_process(&relay), rt.handle());
    let b = Client::start(cc, &[2; 32], enigma_client::in_process(&relay), rt.handle());
    a.transport().join_room("Room", &[]).unwrap();
    b.transport().join_room("Room", &[]).unwrap();
    until("two clients in one room", || {
        let s = m.snapshot();
        s.clients_online() == 2 && s.rooms.len() == 1 && s.rooms[0].online == 2
    });
    let s = m.snapshot();
    assert!(s.clients.iter().all(|c| c.rooms == 1 && c.online));
    assert!(s.clients.iter().any(|c| c.device == a.device_id()));
    assert!(s.code.as_deref().is_some_and(|c| c.starts_with("pharos-beacon:")));
    assert!(s.uptime.is_some());

    b.stop();
    until("b offline, still known", || {
        let s = m.snapshot();
        s.clients.len() == 2 && s.clients_online() == 1 && s.clients.iter().any(|c| !c.online && c.last_seen > 0)
    });
    let s = m.snapshot();
    assert!(s.log.iter().any(|l| l.text.contains("attached")), "{:?}", s.log);
    assert!(s.log.iter().any(|l| l.text.contains("left")));

    m.stop();
    until("off", || m.snapshot().phase == Phase::Off);
    assert!(m.relay().is_none());
    a.stop();
    // And again.
    m.start().unwrap();
    until("online again", || m.snapshot().phase == Phase::Online);
    m.stop();
    until("off again", || !m.is_on());
}

#[test]
fn allow_deny_edit_the_clients_folder() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let d = tempfile::tempdir().unwrap();
    let mut m = model(d.path(), &rt);
    m.allow("anna-phone", KEY).unwrap();
    let dir = m.config().clients_dir();
    assert_eq!(std::fs::read_to_string(dir.join("anna-phone.auth")).unwrap().trim(), KEY);
    assert_eq!(beacon::clients::list(&dir).unwrap(), vec!["anna-phone"]);
    assert_eq!(m.snapshot().allowed, vec!["anna-phone"]);
    assert!(m.allow("bad name", KEY).is_err());
    assert!(m.allow("x", "nope").is_err());
    m.deny("anna-phone").unwrap();
    assert!(m.snapshot().allowed.is_empty());
    assert!(m.deny("anna-phone").is_err());
}

#[test]
fn settings_are_saved_to_config() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let d = tempfile::tempdir().unwrap();
    let mut m = model(d.path(), &rt);
    let l = Limits { max_clients: 12, max_queue_frames: 300, max_queue_mb: 4, queue_ttl_days: 3, message_ttl_days: 5, release_delay_secs: 30 };
    m.set_limits(&l).unwrap();
    m.set_name("Kitchen Pi").unwrap();
    m.set_restricted(true).unwrap();
    m.set_page(false).unwrap();
    let c = Config::load(&d.path().join("config.yaml")).unwrap();
    assert_eq!((c.relay.max_clients, c.relay.max_queue_frames, c.relay.max_queue_bytes, c.relay.queue_ttl_days), (12, 300, 4 << 20, 3));
    assert_eq!((c.limits.message_ttl_days, c.limits.release_delay_secs), (5, 30));
    assert_eq!(c.name, "Kitchen Pi");
    assert!(c.restricted_discovery && !c.page);
    assert_eq!(c.data_dir, d.path().join("data"));
    // A fresh model reads them back.
    assert_eq!(model(d.path(), &rt).limits(), l);
    assert!(m.set_limits(&Limits { max_clients: 0, ..l }).is_err());
    assert!(m.set_name("").is_err());
}

#[test]
fn backup_writes_a_copy() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let d = tempfile::tempdir().unwrap();
    let mut m = model(d.path(), &rt);
    beacon::runner::init(m.config()).unwrap();
    let out = d.path().join("copy.sqlite");
    m.backup(&out).unwrap();
    assert!(out.metadata().unwrap().len() > 0);
}
