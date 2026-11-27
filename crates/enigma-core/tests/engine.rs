//! Multi-device scenarios on the real MLS (rotor via enigmatite) with in-memory outsides:
//! ports of rakotis' chatChannelMls / chatChannelRooms / inviteOnly / joinStartsMls /
//! sharedOptions tests that apply to Enigma27.

use std::sync::Arc;

use base64::Engine as _;
use enigma_core::mem::{fake_slug, Hub, ManualClock, MemKv, MemMailbox, MemStore};
use enigma_core::traits::reset_message;
use enigma_core::{Config, Deps, Ed25519Signer, Engine, Event, LinkStatus, MessageKind, MlsStatus, Signer};
use serde_json::{json, Value};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const T0: u64 = 1_772_366_400_000;

struct Dev {
    name: String,
    seed: u8,
    kv: MemKv,
    store: MemStore,
    eng: Engine,
}

struct Net {
    hub: Hub,
    clock: ManualClock,
    mb: Option<MemMailbox>,
    cfg: Config,
    devs: Vec<Dev>,
}

impl Net {
    fn new() -> Self {
        Self { hub: Hub::default(), clock: ManualClock::new(T0), mb: None, cfg: Config::default(), devs: vec![] }
    }
    fn with_mailbox() -> Self {
        let mut n = Self::new();
        n.mb = Some(MemMailbox::default());
        n
    }
    fn engine(&self, name: &str, seed: u8, kv: &MemKv, store: &MemStore) -> Engine {
        let mut e = Engine::new(
            Deps {
                transport: Box::new(self.hub.transport(name)),
                signer: Box::new(Ed25519Signer::from_seed(&[seed; 32])),
                kv: Box::new(kv.clone()),
                store: Arc::new(store.clone()),
                mailbox: self.mb.clone().map(|m| Box::new(m) as _),
                clock: Box::new(self.clock.clone()),
            },
            self.cfg.clone(),
        );
        let mut n = name.to_string();
        n[..1].make_ascii_uppercase();
        e.set_user_name(&n);
        e
    }
    fn add(&mut self, name: &str, seed: u8) -> usize {
        let (kv, store) = (MemKv::default(), MemStore::default());
        let eng = self.engine(name, seed, &kv, &store);
        self.devs.push(Dev { name: name.into(), seed, kv, store, eng });
        self.devs.len() - 1
    }
    /// The app closes and opens again: same disk, fresh memory.
    fn restart(&mut self, i: usize) {
        let d = &self.devs[i];
        let eng = self.engine(&d.name.clone(), d.seed, &d.kv.clone(), &d.store.clone());
        self.devs[i].eng = eng;
    }
    fn e(&mut self, i: usize) -> &mut Engine {
        &mut self.devs[i].eng
    }
    fn id(&self, i: usize) -> String {
        Ed25519Signer::from_seed(&[self.devs[i].seed; 32]).device_id()
    }
    fn pump(&mut self) {
        let mut n = 0;
        while let Some((to, room, p)) = self.hub.pop() {
            if let Some(d) = self.devs.iter_mut().find(|d| d.name == to) {
                d.eng.handle_frame(&room, &p);
            }
            n += 1;
            assert!(n < 10_000, "frame storm");
        }
    }
    fn advance(&mut self, ms: u64) {
        let mut left = ms;
        while left > 0 {
            let step = left.min(250);
            self.clock.advance(step);
            left -= step;
            for d in &mut self.devs {
                d.eng.tick();
            }
            self.pump();
        }
    }
    /// `host` admits `guest` by invitation; both settle.
    fn invite(&mut self, host: usize, guest: usize) -> bool {
        let room = self.devs[host].eng.current_room().unwrap().to_string();
        let kp = self.e(guest).invite_key_package("scratch").unwrap();
        let Some(grant) = self.e(host).admit_invited(&room, &kp) else { return false };
        self.pump();
        let ok = self.e(guest).join_by_invite(&grant, "scratch");
        self.pump();
        self.advance(1500);
        ok
    }
    fn texts(&self, i: usize) -> Vec<String> {
        self.devs[i].eng.messages().iter().filter(|m| m.kind == MessageKind::Text).map(|m| m.content.clone()).collect()
    }
    fn notices(&self, i: usize) -> Vec<String> {
        self.devs[i].eng.messages().iter().filter_map(|m| m.notice.as_ref().map(|n| n.key.clone())).collect()
    }
}

const ROOM: &str = "Room One";

fn room() -> String {
    fake_slug(ROOM)
}

/// alice creates, bob is invited.
fn pair() -> (Net, usize, usize) {
    let mut n = Net::new();
    let a = n.add("alice", 1);
    let b = n.add("bob", 2);
    n.e(a).create_room(ROOM).unwrap();
    assert!(n.invite(a, b));
    (n, a, b)
}

fn trio() -> (Net, usize, usize, usize) {
    let (mut n, a, b) = pair();
    let c = n.add("carol", 3);
    assert!(n.invite(a, c));
    (n, a, b, c)
}

// ── starting the session ─────────────────────────────────────────────────────

#[test]
fn a_created_room_is_a_group_of_one_at_once_and_saved_as_ours() {
    let mut n = Net::new();
    let a = n.add("alice", 1);
    let slug = n.e(a).create_room(ROOM).unwrap();
    assert_eq!(slug, room());
    assert_eq!(n.e(a).mls_status(), MlsStatus::Ready);
    let entry = n.e(a).rooms()[0].clone();
    assert!(entry.host);
    assert_eq!(entry.onion.as_deref(), Some("alice.onion"));
    assert!(n.notices(a).contains(&"chat.sys.created".into()));
    assert!(n.notices(a).contains(&"chat.sys.encrypted".into()));
    assert!(!n.notices(a).contains(&"chat.sys.settingUp".into()));
    // The key package carries what a peer would need (and the mesh refuses it).
    let kp = &n.hub.sent("alice", "mls_key_package")[0];
    assert_eq!(kp["device_id"], json!(n.id(a)));
    assert_eq!(kp["user"], json!("Alice"));
    assert_eq!(kp["key_package"], kp["package"]);
    assert_eq!(n.e(a).members(), vec![n.id(a)]);
}

#[test]
fn a_failed_create_returns_none_with_the_reason() {
    let mut n = Net::new();
    let a = n.add("alice", 1);
    n.hub.fail_next("no tor");
    assert!(n.e(a).create_room(ROOM).is_none());
    assert_eq!(n.e(a).error(), Some("no tor"));
    assert!(n.e(a).current_room().is_none());
}

#[test]
fn a_room_this_device_was_let_into_comes_straight_back_with_no_key_package() {
    let (mut n, _a, b) = pair();
    n.restart(b);
    let before = n.hub.sent("bob", "mls_key_package").len();
    n.e(b).open_room(&room());
    assert_eq!(n.e(b).mls_status(), MlsStatus::Ready);
    assert_eq!(n.hub.sent("bob", "mls_key_package").len(), before);
}

#[test]
fn a_restored_session_never_let_in_starts_a_fresh_handshake_and_waits_5s() {
    let mut n = Net::new();
    let a = n.add("alice", 1);
    n.e(a).create_room(ROOM).unwrap();
    n.devs[a].kv.delete_admitted();
    n.restart(a);
    n.e(a).open_room(&room());
    assert_eq!(n.e(a).mls_status(), MlsStatus::KeyExchange);
    assert!(n.notices(a).contains(&"chat.sys.settingUp".into()));
    n.advance(4750);
    assert_eq!(n.e(a).mls_status(), MlsStatus::KeyExchange);
    n.advance(250);
    assert_eq!(n.e(a).mls_status(), MlsStatus::Ready);
}

trait KvExt {
    fn delete_admitted(&self);
}
impl KvExt for MemKv {
    fn delete_admitted(&self) {
        use enigma_core::Kv;
        self.delete("chat:admitted", &room());
    }
}

#[test]
fn reopening_an_open_room_does_nothing_and_an_unknown_one_is_an_error() {
    let (mut n, a, _b) = pair();
    let sent = n.hub.log().len();
    n.e(a).open_room(&room());
    assert_eq!(n.hub.log().len(), sent);
    n.e(a).open_room("nope");
    assert!(n.e(a).error().is_some());
}

#[test]
fn a_joiner_nobody_admits_gets_no_lock_and_is_told_after_the_deadline() {
    let (mut n, a, b) = pair();
    let c = n.add("carol", 3);
    // carol has a saved entry for the room but was never let in.
    n.e(c).create_room("elsewhere");
    let mut kvroom = n.devs[c].eng.rooms()[0].clone();
    kvroom.room = room();
    kvroom.name = ROOM.into();
    {
        use enigma_core::Kv;
        n.devs[c].kv.put("p2p:rooms", "default", &serde_json::to_string(&vec![kvroom]).unwrap());
    }
    n.restart(c);
    n.e(c).open_room(&room());
    assert_eq!(n.e(c).mls_status(), MlsStatus::KeyExchange);
    n.pump();
    // The others talk; carol sees traffic she cannot read.
    n.e(a).send_text("hi bob");
    n.pump();
    assert!(n.devs[c].eng.messages().iter().any(|m| m.kind == MessageKind::Placeholder));
    let sent_before = n.hub.log().iter().filter(|(f, _, _)| f == "carol").count();
    n.advance(6000);
    assert_eq!(n.e(c).mls_status(), MlsStatus::KeyExchange, "no lone group over a room others talk in");
    n.advance(60_000);
    assert!(n.notices(c).contains(&"chat.sys.notAdmitted".into()));
    assert_eq!(n.hub.log().iter().filter(|(f, _, _)| f == "carol").count(), sent_before, "nothing sent to anyone");
    assert_eq!(n.texts(b), vec!["hi bob"]);
}

#[test]
fn a_room_left_while_negotiating_declares_no_lone_group() {
    let mut n = Net::new();
    let a = n.add("alice", 1);
    n.e(a).create_room(ROOM).unwrap();
    n.devs[a].kv.delete_admitted();
    n.restart(a);
    n.e(a).open_room(&room());
    n.e(a).leave();
    n.advance(6000);
    assert_eq!(n.e(a).mls_status(), MlsStatus::Idle);
    assert!(!n.notices(a).contains(&"chat.sys.encrypted".into()));
}

// ── invitations ──────────────────────────────────────────────────────────────

#[test]
fn an_invitee_joins_and_they_talk_both_ways_with_names_from_presence() {
    let (mut n, a, b) = pair();
    assert_eq!(n.e(b).mls_status(), MlsStatus::Ready);
    n.e(a).send_text("hello bob");
    n.pump();
    n.e(b).send_text("hi alice");
    n.pump();
    assert_eq!(n.texts(a), vec!["hello bob", "hi alice"]);
    assert_eq!(n.texts(b), vec!["hello bob", "hi alice"]);
    let msg = n.devs[b].eng.messages().iter().find(|m| m.content == "hello bob").unwrap().clone();
    assert_eq!(msg.user, "Alice");
    assert_eq!(msg.device_id, Some(n.id(a)));
    assert!(!msg.is_self);
    let mut names: Vec<String> = n.e(a).roster().iter().map(|p| p.name.clone()).collect();
    names.sort();
    assert_eq!(names, vec!["Alice", "Bob"]);
    // Sealed sender: nothing on the wire says who wrote it.
    for (_, _, p) in n.hub.log() {
        let v: Value = serde_json::from_str(&p).unwrap();
        if v["type"] == "mls_app" {
            assert_eq!(v.as_object().unwrap().len(), 2);
            assert!(!p.contains("hello bob"));
        }
    }
}

#[test]
fn the_grant_names_our_onion_first_and_the_joiner_links_to_the_members_debounced() {
    let (mut n, a, b) = pair();
    let c = n.add("carol", 3);
    let kp = n.e(c).invite_key_package("scratch").unwrap();
    let g = n.e(a).admit_invited(&room(), &kp).unwrap();
    assert_eq!(g.room_name, ROOM);
    assert_eq!(g.peers, vec!["alice.onion".to_string(), "bob.onion".to_string()]);
    n.pump();
    assert!(n.e(c).join_by_invite(&g, "scratch"));
    n.advance(1500);
    let calls: Vec<_> = n.hub.peers_calls().into_iter().filter(|(w, _, _)| w == "carol").collect();
    assert!(!calls.is_empty());
    let last = &calls.last().unwrap().2;
    assert!(last.contains(&"alice.onion".to_string()) && last.contains(&"bob.onion".to_string()));
    assert!(!last.contains(&"carol.onion".to_string()));
    // bob processed the commit: all three read each other.
    n.e(b).send_text("three");
    n.pump();
    assert_eq!(n.texts(c), vec!["three"]);
    assert_eq!(n.texts(a), vec!["three"]);
    assert_eq!(n.e(a).members().len(), 3);
}

#[test]
fn admit_refuses_a_room_not_open_or_not_ready_or_a_bad_key_package() {
    let (mut n, a, _b) = pair();
    let c = n.add("carol", 3);
    let kp = n.e(c).invite_key_package("scratch").unwrap();
    assert!(n.e(a).admit_invited("other-room", &kp).is_none());
    assert!(n.e(a).admit_invited(&room(), "bm90IGEga3A=").is_none());
    assert_eq!(n.e(a).members().len(), 2);
    n.e(a).leave();
    assert!(n.e(a).admit_invited(&room(), &kp).is_none());
}

#[test]
fn join_by_invite_fails_without_the_scratch_session_or_with_a_bad_welcome() {
    let (mut n, a, _b) = pair();
    let c = n.add("carol", 3);
    let kp = n.e(c).invite_key_package("scratch").unwrap();
    let g = n.e(a).admit_invited(&room(), &kp).unwrap();
    assert!(!n.e(c).join_by_invite(&g, "no-such-scratch"));
    assert_eq!(n.e(c).mls_status(), MlsStatus::Error);
    let d = n.add("dave", 4);
    n.e(d).invite_key_package("scratch").unwrap();
    let mut bad = g.clone();
    bad.welcome = B64.encode(b"junk");
    assert!(!n.e(d).join_by_invite(&bad, "scratch"));
    assert_eq!(n.e(d).mls_status(), MlsStatus::Error);
    n.hub.fail_next("cannot join");
    let x = n.add("xavier", 5);
    assert!(!n.e(x).join_by_invite(&g, "scratch"));
    assert_eq!(n.e(x).error(), Some("cannot join"));
}

#[test]
fn a_key_package_off_the_mesh_is_refused_and_not_answered() {
    let (mut n, a, _b) = pair();
    let s = n.add("stranger", 9);
    let kp = n.e(s).invite_key_package("x").unwrap();
    let before = n.hub.log().len();
    let frame = json!({ "type": "mls_key_package", "key_package": kp, "package": kp, "device_id": n.id(s), "user": "S" });
    n.e(a).handle_frame(&room(), &frame.to_string());
    assert_eq!(n.hub.log().len(), before);
    assert_eq!(n.e(a).members().len(), 2);
}

// ── roster ───────────────────────────────────────────────────────────────────

#[test]
fn an_unnamed_member_reads_member_and_six_hex_until_its_presence_comes() {
    let (mut n, a, _b) = pair();
    let c = n.add("carol", 3);
    let kp = n.e(c).invite_key_package("scratch").unwrap();
    n.e(a).admit_invited(&room(), &kp).unwrap();
    let cid = n.id(c);
    let row = n.e(a).roster().iter().find(|p| p.id == cid).unwrap().clone();
    assert_eq!(row.name, format!("Member {}", &cid[..6]));
}

#[test]
fn linked_members_are_marked_and_connected_is_said_once() {
    let (mut n, a, b) = pair();
    let bid = n.id(b);
    n.e(a).handle_status(&room(), LinkStatus::Connected, Some("bob.onion"), &["bob.onion".into()]);
    n.e(a).handle_status(&room(), LinkStatus::Connected, Some("bob.onion"), &["bob.onion".into()]);
    assert!(n.e(a).roster().iter().find(|p| p.id == bid).unwrap().linked);
    assert_eq!(n.notices(a).iter().filter(|k| *k == "chat.sys.connected").count(), 1);
    n.e(a).handle_status(&room(), LinkStatus::Waiting, None, &[]);
    assert!(!n.e(a).roster().iter().find(|p| p.id == bid).unwrap().linked);
    n.e(a).handle_status(&room(), LinkStatus::Error, None, &[]);
    assert!(n.notices(a).contains(&"chat.sys.connectionError".into()));
    // Status for a room not on screen is ignored, but its peer is remembered.
    n.e(a).handle_status("other", LinkStatus::Connected, Some("zed.onion"), &[]);
    assert_eq!(n.e(a).link_status(), LinkStatus::Error);
}

#[test]
fn the_rooms_beacon_rides_presence_and_the_first_one_heard_is_kept() {
    let mut n = Net::new();
    let beacon = format!("{}.onion", "b".repeat(56));
    n.cfg.beacon_for_new_room = Some(beacon.clone());
    let a = n.add("alice", 1);
    n.cfg.beacon_for_new_room = None;
    let b = n.add("bob", 2);
    n.e(a).create_room(ROOM).unwrap();
    assert!(n.invite(a, b));
    assert_eq!(n.e(b).rooms()[0].beacon.as_deref(), Some(beacon.as_str()));
}

// ── commits, resets ──────────────────────────────────────────────────────────

#[test]
fn a_commit_that_will_not_apply_puts_the_session_in_error_with_the_reason() {
    let (mut n, a, _b) = pair();
    let f = json!({ "type": "mls_commit", "commit": B64.encode(b"garbage") });
    n.e(a).handle_frame(&room(), &f.to_string());
    assert_eq!(n.e(a).mls_status(), MlsStatus::Error);
    assert!(n.e(a).mls_error().is_some());
    assert!(n.notices(a).contains(&"chat.sys.commitFailed".into()));
}

#[test]
fn a_welcome_that_will_not_open_is_an_error_and_one_is_ignored_once_ready() {
    let (mut n, a, _b) = pair();
    let w = json!({ "type": "mls_welcome", "welcome": B64.encode(b"junk") }).to_string();
    n.e(a).handle_frame(&room(), &w);
    assert_eq!(n.e(a).mls_status(), MlsStatus::Ready);
    n.devs[a].kv.delete_admitted();
    n.restart(a);
    n.e(a).open_room(&room());
    assert_eq!(n.e(a).mls_status(), MlsStatus::KeyExchange);
    n.e(a).handle_frame(&room(), &w);
    assert_eq!(n.e(a).mls_status(), MlsStatus::Error);
    assert!(n.notices(a).contains(&"chat.sys.joinGroupFailed".into()));
}

fn reset_frame(n: &Net, signer_seed: u8, device: &str, ts: u64, reset_id: &str) -> String {
    let sig = Ed25519Signer::from_seed(&[signer_seed; 32]).sign(&reset_message(&room(), reset_id, ts));
    let _ = n;
    json!({ "type": "mls_reset_request", "device_id": device, "reset_id": reset_id, "ts": ts, "sig": sig }).to_string()
}

#[test]
fn a_reset_is_obeyed_only_signed_by_a_current_member_and_fresh_once_per_id() {
    let (mut n, a, b) = pair();
    n.e(a).send_text("history");
    n.pump();
    let bid = n.id(b);
    let now = n.clock_now();
    // Forged (signed by someone else), stale, a non-member: refused.
    for f in [
        reset_frame(&n, 7, &bid, now, "r1"),
        reset_frame(&n, 2, &bid, now - 6 * 60_000, "r2"),
        reset_frame(&n, 9, &Ed25519Signer::from_seed(&[9; 32]).device_id(), now, "r3"),
        json!({ "type": "mls_reset_request", "device_id": bid, "reset_id": "r4", "ts": now }).to_string(),
    ] {
        n.e(a).handle_frame(&room(), &f);
        assert_eq!(n.texts(a), vec!["history"]);
    }
    // Genuine: history cleared, fresh group, no second broadcast.
    let resets = n.hub.sent("alice", "mls_reset_request").len();
    let f5 = reset_frame(&n, 2, &bid, now, "r5");
    n.e(a).handle_frame(&room(), &f5);
    assert!(n.texts(a).is_empty());
    assert_eq!(n.notices(a)[0], "chat.sys.sessionReset");
    assert_eq!(n.e(a).mls_status(), MlsStatus::KeyExchange);
    assert_eq!(n.hub.sent("alice", "mls_reset_request").len(), resets);
    n.advance(5000);
    assert_eq!(n.e(a).mls_status(), MlsStatus::Ready);
    assert!(n.notices(a).contains(&"chat.sys.newGroup".into()));
    assert_eq!(n.e(a).members(), vec![n.id(a)]);
}

#[test]
fn force_reset_broadcasts_a_signed_request_and_peers_obey_it_once() {
    let (mut n, a, b) = pair();
    n.e(b).force_reset(true);
    let req = n.hub.sent("bob", "mls_reset_request")[0].clone();
    let sig = req["sig"].as_str().unwrap();
    assert!(enigma_core::traits::verify_ed25519(&n.id(b), &reset_message(&room(), req["reset_id"].as_str().unwrap(), req["ts"].as_u64().unwrap()), sig));
    n.pump();
    assert!(n.notices(a).contains(&"chat.sys.sessionReset".into()));
    // The same request again: ignored (dedupe by reset id).
    n.advance(5000);
    let count = n.notices(a).iter().filter(|k| *k == "chat.sys.sessionReset").count();
    n.e(a).handle_frame(&room(), &req.to_string());
    assert_eq!(n.notices(a).iter().filter(|k| *k == "chat.sys.sessionReset").count(), count);
    // Our own request echoed back is ignored.
    n.e(b).handle_frame(&room(), &req.to_string());
    assert_eq!(n.notices(b).iter().filter(|k| *k == "chat.sys.sessionReset").count(), 1);
}

impl Net {
    fn clock_now(&self) -> u64 {
        use enigma_core::Clock;
        self.clock.now_ms()
    }
}

// ── leaving, deleting ────────────────────────────────────────────────────────

#[test]
fn a_leaver_is_removed_by_the_smallest_remaining_identity() {
    let (mut n, a, b, c) = trio();
    let ids = [n.id(a), n.id(b), n.id(c)];
    let (ca, cb) = (n.hub.sent("alice", "mls_commit").len(), n.hub.sent("bob", "mls_commit").len());
    n.e(c).leave();
    assert!(n.e(c).current_room().is_none());
    assert_eq!(n.e(c).mls_status(), MlsStatus::Idle);
    n.pump();
    let remover = if ids[0] < ids[1] { "alice" } else { "bob" };
    let other = if remover == "alice" { "bob" } else { "alice" };
    let since = |who: &str| n.hub.sent(who, "mls_commit").len() - if who == "alice" { ca } else { cb };
    assert_eq!(since(remover), 1);
    assert_eq!(since(other), 0, "only the smallest identity removes");
    assert_eq!(n.e(a).members().len(), 2);
    assert_eq!(n.e(b).members().len(), 2);
    n.e(a).send_text("after");
    n.pump();
    assert_eq!(n.texts(b), vec!["after"]);
    assert!(!n.e(a).rooms()[0].peers.contains(&"carol.onion".to_string()));
}

#[test]
fn deleting_a_room_we_host_closes_it_for_everyone() {
    let (mut n, a, b) = pair();
    n.e(b).send_text("x");
    n.pump();
    n.e(a).delete_room(&room());
    assert!(n.e(a).rooms().is_empty());
    assert_eq!(n.notices(a), vec!["chat.sys.roomDeleted"]);
    n.pump();
    let ev = n.e(b).drain_events();
    assert!(ev.contains(&Event::RoomClosed(room())));
    assert!(n.e(b).rooms().is_empty());
    assert!(n.e(b).current_room().is_none());
    assert_eq!(n.notices(b), vec!["chat.sys.roomDeletedByHost"]);
    assert!(n.hub.forgotten().iter().any(|(w, name)| w == "bob" && name == ROOM));
    // Reopened later: nothing kept.
    n.restart(b);
    assert!(n.e(b).rooms().is_empty());
}

#[test]
fn deleting_a_room_we_only_joined_sends_a_leave() {
    let (mut n, a, b) = pair();
    n.e(b).delete_room(&room());
    n.pump();
    assert_eq!(n.e(a).members(), vec![n.id(a)]);
    assert_eq!(n.e(a).rooms().len(), 1);
}

#[test]
fn deleting_a_room_not_open_only_stops_its_links_and_forgets_its_onion() {
    let (mut n, a, _b) = pair();
    n.e(a).create_room("Second").unwrap();
    n.e(a).delete_room(&room());
    assert_eq!(n.e(a).current_room(), Some(fake_slug("Second").as_str()));
    assert_eq!(n.e(a).rooms().len(), 1);
    assert!(!n.hub.is_in("alice", &room()));
}

// ── frames ───────────────────────────────────────────────────────────────────

#[test]
fn clear_frames_and_cover_are_ignored_and_nothing_is_sent_before_encryption() {
    let (mut n, a, _b) = pair();
    for f in [json!({"type":"cover","pad":"xxxx"}), json!({"type":"text","text":"in the clear"}), json!({"type":"chat_message","content":"x"})] {
        n.e(a).handle_frame(&room(), &f.to_string());
    }
    n.e(a).handle_frame(&room(), "not json");
    assert!(n.texts(a).is_empty());
    let mut m = Net::new();
    let x = m.add("x", 5);
    m.e(x).create_room(ROOM).unwrap();
    m.devs[x].kv.delete_admitted();
    m.restart(x);
    m.e(x).open_room(&room());
    let before = m.hub.log().len();
    m.e(x).send_text("too early");
    assert_eq!(m.hub.log().len(), before);
    assert!(m.notices(x).contains(&"chat.sys.notReady".into()));
}

#[test]
fn images_voice_and_file_signalling_reach_the_others() {
    let (mut n, a, b) = pair();
    n.e(a).send_image("data:image/jpeg;base64,AAA");
    n.e(a).send_voice("data:audio/webm;base64,BBB");
    n.e(a).send_sync("file_offer", json!({ "offerId": "o1", "name": "x.pdf" })).unwrap();
    n.e(b).drain_events();
    n.pump();
    let msgs = n.devs[b].eng.messages().to_vec();
    assert!(msgs.iter().any(|m| m.kind == MessageKind::Image && m.image_data.as_deref() == Some("data:image/jpeg;base64,AAA")));
    assert!(msgs.iter().any(|m| m.kind == MessageKind::Voice));
    let ev = n.e(b).drain_events();
    assert!(ev.iter().any(|e| matches!(e, Event::Sync { kind, payload, sender } if kind == "file_offer" && payload["offerId"] == "o1" && sender == "Alice")));
    assert!(!msgs.iter().any(|m| m.content.contains("file_offer")));
}

#[test]
fn the_timeline_survives_a_restart_without_duplicates() {
    let (mut n, a, b) = pair();
    n.e(a).send_text("one");
    n.pump();
    n.restart(b);
    n.e(b).open_room(&room());
    assert_eq!(n.texts(b), vec!["one"]);
    n.e(a).send_text("two");
    n.pump();
    assert_eq!(n.texts(b), vec!["one", "two"]);
}

// ── the Beacon mailbox ───────────────────────────────────────────────────────

fn mailbox_pair() -> (Net, usize, usize) {
    let mut n = Net::with_mailbox();
    let a = n.add("alice", 1);
    let b = n.add("bob", 2);
    n.e(a).create_room(ROOM).unwrap();
    assert!(n.invite(a, b));
    n.advance(130_000); // both caught up once: their places are set
    (n, a, b)
}

#[test]
fn a_member_away_reads_what_came_meanwhile_after_a_restart_with_its_group_kept() {
    let (mut n, a, b) = mailbox_pair();
    n.hub.set_online("bob", false);
    n.e(a).send_text("while you were away");
    n.pump();
    assert!(n.texts(b).is_empty());
    n.restart(b);
    n.hub.set_online("bob", true);
    n.e(b).open_room(&room());
    assert_eq!(n.e(b).mls_status(), MlsStatus::Ready);
    assert_eq!(n.texts(b), vec!["while you were away"]);
    assert!(n.devs[b].eng.messages().iter().any(|m| m.via_mailbox));
}

#[test]
fn the_mesh_copy_and_the_beacon_copy_of_a_frame_are_read_once() {
    let (mut n, a, b) = mailbox_pair();
    n.e(a).send_text("once");
    n.pump();
    n.e(b).catch_up_mailbox();
    n.e(a).catch_up_mailbox(); // its own frame was noted when sent
    assert_eq!(n.texts(b), vec!["once"]);
    assert_eq!(n.texts(a), vec!["once"]);
    assert_eq!(n.e(b).mls_status(), MlsStatus::Ready);
}

#[test]
fn with_the_server_down_the_room_talks_over_the_mesh_and_the_queue_drains_later() {
    let (mut n, a, b) = mailbox_pair();
    let mb = n.mb.clone().unwrap();
    mb.set_down(true);
    let held = mb.len();
    n.e(a).send_text("mesh only");
    n.pump();
    assert_eq!(n.texts(b), vec!["mesh only"]);
    assert_eq!(mb.len(), held);
    mb.set_down(false);
    n.advance(130_000); // Poisson catch-ups: at least one within 4x30 s
    assert!(mb.len() > held);
    assert_eq!(n.texts(b), vec!["mesh only"]);
}

#[test]
fn an_old_presence_from_the_mailbox_says_nothing_about_now() {
    let (mut n, a, b) = mailbox_pair();
    n.hub.set_online("bob", false);
    n.e(a).set_avatar("data:image/png;base64,NEW");
    n.pump();
    n.advance(1000);
    n.clock.advance(10 * 60_000);
    n.restart(b);
    n.hub.set_online("bob", true);
    n.e(b).open_room(&room());
    let aid = n.id(a);
    let row = n.e(b).roster().iter().find(|p| p.id == aid).unwrap().clone();
    assert_eq!(row.avatar, "", "a ten-minute-old presence is not applied");
}

#[test]
fn no_mailbox_means_nothing_is_posted_and_frames_carry_no_ts() {
    let (mut n, a, _b) = pair();
    n.e(a).send_text("x");
    for (_, _, p) in n.hub.log() {
        assert!(serde_json::from_str::<Value>(&p).unwrap().get("ts").is_none());
    }
}
