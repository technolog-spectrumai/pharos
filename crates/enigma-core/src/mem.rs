//! In-memory outsides (port of `fakes.ts` and `MemMailbox`): an MLS store, a kv, a mailbox,
//! a transport hub several engines share, and a clock tests move by hand. For tests and demos;
//! MLS itself is the real rotor.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::mailbox::MAILBOX_PAGE;
use crate::traits::{Clock, Kv, Mailbox, OpenedRoom, Transport};

/// An MLS session store in memory.
#[derive(Clone, Default)]
pub struct MemStore(Arc<Mutex<HashMap<String, Vec<u8>>>>);

impl enigmatite::mls::Store for MemStore {
    fn get(&self, room: &str, identity: &str) -> Option<Vec<u8>> {
        self.0.lock().ok()?.get(&format!("{room}\0{identity}")).cloned()
    }
    fn put(&self, room: &str, identity: &str, state: &[u8]) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(format!("{room}\0{identity}"), state.to_vec());
        }
    }
    fn delete(&self, room: &str, identity: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(&format!("{room}\0{identity}"));
        }
    }
}

/// A kv in memory (cloning shares it: "the same disk after a restart").
#[derive(Clone, Default)]
pub struct MemKv(Arc<Mutex<HashMap<String, String>>>);

impl Kv for MemKv {
    fn get(&self, ns: &str, key: &str) -> Option<String> {
        self.0.lock().ok()?.get(&format!("{ns}\0{key}")).cloned()
    }
    fn put(&self, ns: &str, key: &str, value: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.insert(format!("{ns}\0{key}"), value.to_string());
        }
    }
    fn delete(&self, ns: &str, key: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(&format!("{ns}\0{key}"));
        }
    }
}

/// A Beacon's mailbox in memory, ids from 1.
#[derive(Clone, Default)]
pub struct MemMailbox {
    /// The bodies posted.
    pub bodies: Arc<Mutex<Vec<String>>>,
    /// The server does not answer.
    pub down: Arc<Mutex<bool>>,
}

impl MemMailbox {
    /// Takes the server down or up.
    pub fn set_down(&self, down: bool) {
        *self.down.lock().unwrap() = down;
    }
    /// How many bodies it holds.
    #[must_use]
    pub fn len(&self) -> usize {
        self.bodies.lock().unwrap().len()
    }
    /// Whether it holds none.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Mailbox for MemMailbox {
    fn post(&self, body: &Value) -> Result<(), String> {
        if *self.down.lock().unwrap() {
            return Err("the server does not answer".into());
        }
        self.bodies.lock().unwrap().push(body.to_string());
        Ok(())
    }
    fn fetch(&self, after: u64, _room: &str) -> Result<Vec<(u64, String)>, String> {
        if *self.down.lock().unwrap() {
            return Err("the server does not answer".into());
        }
        Ok(self
            .bodies
            .lock()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, b)| (i as u64 + 1, b.clone()))
            .filter(|(id, _)| *id > after)
            .take(MAILBOX_PAGE)
            .collect())
    }
}

/// A clock tests move by hand (cloning shares it).
#[derive(Clone)]
pub struct ManualClock(Arc<AtomicU64>);

impl ManualClock {
    /// Starting at `ms`.
    #[must_use]
    pub fn new(ms: u64) -> Self {
        Self(Arc::new(AtomicU64::new(ms)))
    }
    /// Moves it on.
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// A room's slug from its name (the real one is the mesh's).
#[must_use]
pub fn fake_slug(name: &str) -> String {
    format!("topic-{name}")
}

#[derive(Default)]
struct HubInner {
    rooms: HashMap<String, HashSet<String>>,
    offline: HashSet<String>,
    queue: VecDeque<(String, String, String)>,
    log: Vec<(String, String, String)>,
    peers: Vec<(String, String, Vec<String>)>,
    forgotten: Vec<(String, String)>,
    fail_next: Option<String>,
}

/// An in-memory mesh: frames sent by one device are queued for every other device in the room
/// that is online. Tests drain the queue into engines with [`Hub::pop`].
#[derive(Clone, Default)]
pub struct Hub(Arc<Mutex<HubInner>>);

impl Hub {
    /// The transport as device `who` sees it.
    #[must_use]
    pub fn transport(&self, who: &str) -> HubTransport {
        HubTransport { hub: self.clone(), who: who.to_string() }
    }
    /// The next queued delivery: (to, room, payload).
    #[must_use]
    pub fn pop(&self) -> Option<(String, String, String)> {
        self.0.lock().unwrap().queue.pop_front()
    }
    /// Takes a device off the mesh, or back.
    pub fn set_online(&self, who: &str, on: bool) {
        let mut h = self.0.lock().unwrap();
        if on {
            h.offline.remove(who);
        } else {
            h.offline.insert(who.to_string());
        }
    }
    /// Every frame sent: (from, room, payload).
    #[must_use]
    pub fn log(&self) -> Vec<(String, String, String)> {
        self.0.lock().unwrap().log.clone()
    }
    /// Frames `who` sent of a type.
    #[must_use]
    pub fn sent(&self, who: &str, ty: &str) -> Vec<Value> {
        self.log()
            .into_iter()
            .filter(|(f, _, _)| f == who)
            .filter_map(|(_, _, p)| serde_json::from_str::<Value>(&p).ok())
            .filter(|v| v["type"] == ty)
            .collect()
    }
    /// Every `set_peers` call: (who, room, peers).
    #[must_use]
    pub fn peers_calls(&self) -> Vec<(String, String, Vec<String>)> {
        self.0.lock().unwrap().peers.clone()
    }
    /// Every `forget_onion` call: (who, name).
    #[must_use]
    pub fn forgotten(&self) -> Vec<(String, String)> {
        self.0.lock().unwrap().forgotten.clone()
    }
    /// The next create/join fails with this reason.
    pub fn fail_next(&self, why: &str) {
        self.0.lock().unwrap().fail_next = Some(why.to_string());
    }
    /// Drops queued deliveries.
    pub fn clear_queue(&self) {
        self.0.lock().unwrap().queue.clear();
    }
    /// Whether `who` is in the room's mesh.
    #[must_use]
    pub fn is_in(&self, who: &str, room: &str) -> bool {
        self.0.lock().unwrap().rooms.get(who).is_some_and(|r| r.contains(room))
    }
}

/// One device's view of the [`Hub`].
pub struct HubTransport {
    hub: Hub,
    who: String,
}

impl HubTransport {
    fn join(&self, name: &str) -> Result<OpenedRoom, String> {
        let mut h = self.hub.0.lock().unwrap();
        if let Some(why) = h.fail_next.take() {
            return Err(why);
        }
        let room = fake_slug(name);
        h.rooms.entry(self.who.clone()).or_default().insert(room.clone());
        Ok(OpenedRoom { room, name: name.to_string(), onion: format!("{}.onion", self.who) })
    }
}

impl Transport for HubTransport {
    fn create_room(&self, name: &str) -> Result<OpenedRoom, String> {
        self.join(name)
    }
    fn join_room(&self, name: &str, _peers: &[String]) -> Result<OpenedRoom, String> {
        self.join(name)
    }
    fn set_peers(&self, room: &str, peers: &[String]) {
        self.hub.0.lock().unwrap().peers.push((self.who.clone(), room.to_string(), peers.to_vec()));
    }
    fn leave_room(&self, room: &str) {
        if let Some(r) = self.hub.0.lock().unwrap().rooms.get_mut(&self.who) {
            r.remove(room);
        }
    }
    fn forget_onion(&self, name: &str) {
        self.hub.0.lock().unwrap().forgotten.push((self.who.clone(), name.to_string()));
    }
    fn send(&self, room: &str, payload: &str) {
        let mut h = self.hub.0.lock().unwrap();
        h.log.push((self.who.clone(), room.to_string(), payload.to_string()));
        if h.offline.contains(&self.who) {
            return;
        }
        let to: Vec<String> = h
            .rooms
            .iter()
            .filter(|(w, r)| **w != self.who && r.contains(room) && !h.offline.contains(*w))
            .map(|(w, _)| w.clone())
            .collect();
        for w in to {
            h.queue.push_back((w, room.to_string(), payload.to_string()));
        }
    }
}
