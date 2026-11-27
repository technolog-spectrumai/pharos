//! What a Beacon keeps for its clients (stage b2): per (device, room) a queue of
//! frames for when the device is offline, the rooms each device is in (with the
//! Beacons it listed), held invitation messages, and redemption routes.
//!
//! [`QueueStore`] is the interface; [`MemQueue`] keeps it in memory (tests, the
//! in-process Beacon). The `beacon` binary keeps it in SQLite, sealed with its
//! master key (`beacon/src/relay_store.rs`).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// Bounds on one (device, room) queue and on how long things are kept.
#[derive(Clone, Debug)]
pub struct QueueLimits {
    /// Frames per (device, room); the oldest go first beyond this.
    pub max_frames: usize,
    /// Bytes per (device, room).
    pub max_bytes: usize,
    /// How long a frame is kept (seconds).
    pub ttl_secs: u64,
    /// How long a held invitation message or route is kept (seconds).
    pub redeem_ttl_secs: u64,
}

impl Default for QueueLimits {
    fn default() -> Self {
        Self { max_frames: 2000, max_bytes: 32 * 1024 * 1024, ttl_secs: 14 * 86_400, redeem_ttl_secs: 86_400 }
    }
}

/// A room membership: device, route id, the Beacons it listed.
pub type Membership = (String, String, Vec<String>);

/// Where a Beacon keeps client state. Errors are the backend's; the relay logs them.
pub trait QueueStore: Send + Sync + 'static {
    /// Append a frame for `device` in `room`; returns its seq (increasing per pair).
    fn push(&self, device: &str, room: &str, frame: &str, now: u64) -> u64;
    /// Every kept frame of the pair, in order.
    fn pending(&self, device: &str, room: &str, now: u64) -> Vec<(u64, String)>;
    /// Drop frames up to `upto`.
    fn ack(&self, device: &str, room: &str, upto: u64);
    /// Record (or update) a membership.
    fn set_member(&self, device: &str, room: &str, peers: &[String]);
    /// Forget a membership and its queue.
    fn remove_member(&self, device: &str, room: &str);
    /// Every membership.
    fn members(&self) -> Vec<Membership>;
    /// Hold a message for a device that is offline.
    fn hold(&self, device: &str, msg: &str, now: u64);
    /// Take every message held for a device.
    fn take_held(&self, device: &str, now: u64) -> Vec<String>;
    /// Remember a redemption: who asked (`redeemer`), for whom (`inviter`).
    fn set_route(&self, id: &str, redeemer: &str, inviter: &str, now: u64);
    /// A redemption's (redeemer, inviter).
    fn route(&self, id: &str, now: u64) -> Option<(String, String)>;
    /// The node key first seen for a Beacon onion (pinned on first use).
    fn pin(&self, onion: &str, node: &str) -> bool;
    /// Drop what expired.
    fn sweep(&self, now: u64);
}

#[derive(Default)]
struct Q {
    next: u64,
    frames: VecDeque<(u64, String, u64)>,
    bytes: usize,
}

#[derive(Default)]
struct MemInner {
    queues: HashMap<(String, String), Q>,
    members: HashMap<(String, String), Vec<String>>,
    held: HashMap<String, Vec<(String, u64)>>,
    routes: HashMap<String, (String, String, u64)>,
    pins: HashMap<String, String>,
}

/// [`QueueStore`] in memory.
#[derive(Default)]
pub struct MemQueue {
    limits: QueueLimits,
    inner: Mutex<MemInner>,
}

impl MemQueue {
    /// With these limits.
    #[must_use]
    pub fn new(limits: QueueLimits) -> Self {
        Self { limits, inner: Mutex::default() }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, MemInner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl QueueStore for MemQueue {
    fn push(&self, device: &str, room: &str, frame: &str, now: u64) -> u64 {
        let mut g = self.lock();
        let q = g.queues.entry((device.into(), room.into())).or_default();
        q.next += 1;
        let seq = q.next;
        q.bytes += frame.len();
        q.frames.push_back((seq, frame.to_string(), now + self.limits.ttl_secs));
        while q.frames.len() > self.limits.max_frames || (q.bytes > self.limits.max_bytes && q.frames.len() > 1) {
            if let Some((_, f, _)) = q.frames.pop_front() {
                q.bytes -= f.len();
            }
        }
        seq
    }
    fn pending(&self, device: &str, room: &str, now: u64) -> Vec<(u64, String)> {
        let g = self.lock();
        g.queues
            .get(&(device.into(), room.into()))
            .map(|q| q.frames.iter().filter(|f| f.2 > now).map(|(s, f, _)| (*s, f.clone())).collect())
            .unwrap_or_default()
    }
    fn ack(&self, device: &str, room: &str, upto: u64) {
        let mut g = self.lock();
        if let Some(q) = g.queues.get_mut(&(device.into(), room.into())) {
            while q.frames.front().is_some_and(|f| f.0 <= upto) {
                if let Some((_, f, _)) = q.frames.pop_front() {
                    q.bytes -= f.len();
                }
            }
        }
    }
    fn set_member(&self, device: &str, room: &str, peers: &[String]) {
        self.lock().members.insert((device.into(), room.into()), peers.to_vec());
    }
    fn remove_member(&self, device: &str, room: &str) {
        let mut g = self.lock();
        g.members.remove(&(device.into(), room.into()));
        g.queues.remove(&(device.into(), room.into()));
    }
    fn members(&self) -> Vec<Membership> {
        self.lock().members.iter().map(|((d, r), p)| (d.clone(), r.clone(), p.clone())).collect()
    }
    fn hold(&self, device: &str, msg: &str, now: u64) {
        let exp = now + self.limits.redeem_ttl_secs;
        let mut g = self.lock();
        let v = g.held.entry(device.into()).or_default();
        if v.len() < 256 {
            v.push((msg.into(), exp));
        }
    }
    fn take_held(&self, device: &str, now: u64) -> Vec<String> {
        self.lock().held.remove(device).unwrap_or_default().into_iter().filter(|m| m.1 > now).map(|m| m.0).collect()
    }
    fn set_route(&self, id: &str, redeemer: &str, inviter: &str, now: u64) {
        let exp = now + self.limits.redeem_ttl_secs;
        let mut g = self.lock();
        if g.routes.len() < 100_000 {
            g.routes.insert(id.into(), (redeemer.into(), inviter.into(), exp));
        }
    }
    fn route(&self, id: &str, now: u64) -> Option<(String, String)> {
        self.lock().routes.get(id).filter(|r| r.2 > now).map(|r| (r.0.clone(), r.1.clone()))
    }
    fn pin(&self, onion: &str, node: &str) -> bool {
        let mut g = self.lock();
        g.pins.entry(onion.into()).or_insert_with(|| node.into()) == node
    }
    fn sweep(&self, now: u64) {
        let mut g = self.lock();
        for q in g.queues.values_mut() {
            while q.frames.front().is_some_and(|f| f.2 <= now) {
                if let Some((_, f, _)) = q.frames.pop_front() {
                    q.bytes -= f.len();
                }
            }
        }
        g.held.retain(|_, v| {
            v.retain(|m| m.1 > now);
            !v.is_empty()
        });
        g.routes.retain(|_, r| r.2 > now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_queue_numbers_caps_acks_and_expires() {
        let q = MemQueue::new(QueueLimits { max_frames: 3, max_bytes: 1000, ttl_secs: 10, redeem_ttl_secs: 10 });
        for i in 0..5 {
            q.push("d", "r", &format!("f{i}"), 100);
        }
        let p = q.pending("d", "r", 100);
        assert_eq!(p.iter().map(|x| x.0).collect::<Vec<_>>(), vec![3, 4, 5]);
        q.ack("d", "r", 4);
        assert_eq!(q.pending("d", "r", 100), vec![(5, "f4".to_string())]);
        assert_eq!(q.push("d", "r", "x", 100), 6, "seq keeps growing after acks");
        assert!(q.pending("d", "r", 111).is_empty());
        assert!(q.pin("o", "k1") && q.pin("o", "k1") && !q.pin("o", "k2"));
    }
}
