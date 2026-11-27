//! Stage b2: what the relay keeps for client devices (beacon-node's [`QueueStore`]),
//! in its own SQLite file (`relay.sqlite`) beside the mailbox store, which stays
//! untouched. As there, every key is a keyed hash and every value is sealed with the
//! master key under a label naming its table: the file alone shows how many rows and
//! how large, not which devices, rooms or Beacons.

use crate::masterkey::MasterKey;
use anyhow::Result;
use beacon_node::queue::{Membership, QueueLimits, QueueStore};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

pub struct SqliteQueue {
    db: Mutex<Connection>,
    key: MasterKey,
    limits: QueueLimits,
}

impl SqliteQueue {
    pub fn open(path: &Path, key: MasterKey, limits: QueueLimits) -> Result<Self> {
        Self::init(Connection::open(path)?, key, limits)
    }

    pub fn in_memory(key: MasterKey, limits: QueueLimits) -> Result<Self> {
        Self::init(Connection::open_in_memory()?, key, limits)
    }

    fn init(db: Connection, key: MasterKey, limits: QueueLimits) -> Result<Self> {
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS rq (
               pair BLOB NOT NULL, seq INTEGER NOT NULL, blob BLOB NOT NULL, size INTEGER NOT NULL,
               expires INTEGER NOT NULL, PRIMARY KEY (pair, seq));
             CREATE TABLE IF NOT EXISTS rseq (pair BLOB PRIMARY KEY, next INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS rmember (pair BLOB PRIMARY KEY, blob BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS rheld (
               id INTEGER PRIMARY KEY AUTOINCREMENT, dev BLOB NOT NULL, blob BLOB NOT NULL, expires INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS rroute (id BLOB PRIMARY KEY, blob BLOB NOT NULL, expires INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS rpin (onion BLOB PRIMARY KEY, node BLOB NOT NULL);
             CREATE INDEX IF NOT EXISTS rq_expires ON rq(expires);",
        )?;
        Ok(Self { db: Mutex::new(db), key, limits })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn pair(&self, device: &str, room: &str) -> [u8; 32] {
        self.key.hash("relay-pair", format!("{device}\0{room}").as_bytes())
    }

    fn try_push(&self, device: &str, room: &str, frame: &str, now: u64) -> Result<u64> {
        let pair = self.pair(device, room);
        let mut db = self.db();
        let tx = db.transaction()?;
        let next: u64 = tx.query_row("SELECT next FROM rseq WHERE pair=?1", [&pair[..]], |r| r.get::<_, i64>(0)).optional()?.map_or(1, |n| n as u64);
        tx.execute("INSERT OR REPLACE INTO rseq (pair, next) VALUES (?1, ?2)", params![&pair[..], (next + 1) as i64])?;
        let sealed = self.key.seal(&format!("relay-frame/{}/{next}", hex(&pair)), frame.as_bytes());
        tx.execute(
            "INSERT INTO rq (pair, seq, blob, size, expires) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![&pair[..], next as i64, sealed, frame.len() as i64, (now + self.limits.ttl_secs) as i64],
        )?;
        // Oldest first beyond the caps.
        loop {
            let (n, bytes): (i64, i64) = tx.query_row("SELECT COUNT(*), COALESCE(SUM(size),0) FROM rq WHERE pair=?1", [&pair[..]], |r| Ok((r.get(0)?, r.get(1)?)))?;
            if n <= 1 || (n as usize <= self.limits.max_frames && bytes as usize <= self.limits.max_bytes) {
                break;
            }
            tx.execute("DELETE FROM rq WHERE pair=?1 AND seq=(SELECT MIN(seq) FROM rq WHERE pair=?1)", [&pair[..]])?;
        }
        tx.commit()?;
        Ok(next)
    }

    fn try_pending(&self, device: &str, room: &str, now: u64) -> Result<Vec<(u64, String)>> {
        let pair = self.pair(device, room);
        let db = self.db();
        let mut st = db.prepare("SELECT seq, blob FROM rq WHERE pair=?1 AND expires>?2 ORDER BY seq")?;
        let rows = st.query_map(params![&pair[..], now as i64], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, Vec<u8>>(1)?)))?;
        let mut out = vec![];
        for row in rows {
            let (seq, blob) = row?;
            let plain = self.key.open(&format!("relay-frame/{}/{seq}", hex(&pair)), &blob)?;
            out.push((seq, String::from_utf8(plain)?));
        }
        Ok(out)
    }

    fn try_members(&self) -> Result<Vec<Membership>> {
        let db = self.db();
        let mut st = db.prepare("SELECT pair, blob FROM rmember")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, Vec<u8>>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
        let mut out = vec![];
        for row in rows {
            let (pair, blob) = row?;
            let plain = self.key.open(&format!("relay-member/{}", hex(&pair)), &blob)?;
            out.push(serde_json::from_slice(&plain)?);
        }
        Ok(out)
    }
}

fn hex(b: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(b)
}

fn log<T: Default>(what: &str, r: Result<T>) -> T {
    r.unwrap_or_else(|e| {
        eprintln!("beacon: relay store {what}: {e:#}");
        T::default()
    })
}

impl QueueStore for SqliteQueue {
    fn push(&self, device: &str, room: &str, frame: &str, now: u64) -> u64 {
        log("push", self.try_push(device, room, frame, now))
    }
    fn pending(&self, device: &str, room: &str, now: u64) -> Vec<(u64, String)> {
        log("pending", self.try_pending(device, room, now))
    }
    fn ack(&self, device: &str, room: &str, upto: u64) {
        let pair = self.pair(device, room);
        log("ack", self.db().execute("DELETE FROM rq WHERE pair=?1 AND seq<=?2", params![&pair[..], upto as i64]).map(|_| ()).map_err(Into::into));
    }
    fn set_member(&self, device: &str, room: &str, peers: &[String]) {
        let pair = self.pair(device, room);
        let m: Membership = (device.to_string(), room.to_string(), peers.to_vec());
        let sealed = self.key.seal(&format!("relay-member/{}", hex(&pair)), &serde_json::to_vec(&m).unwrap_or_default());
        log("member", self.db().execute("INSERT OR REPLACE INTO rmember (pair, blob) VALUES (?1, ?2)", params![&pair[..], sealed]).map(|_| ()).map_err(Into::into));
    }
    fn remove_member(&self, device: &str, room: &str) {
        let pair = self.pair(device, room);
        let db = self.db();
        for t in ["rmember", "rq", "rseq"] {
            log("leave", db.execute(&format!("DELETE FROM {t} WHERE pair=?1"), [&pair[..]]).map(|_| ()).map_err(Into::into));
        }
    }
    fn members(&self) -> Vec<Membership> {
        log("members", self.try_members())
    }
    fn hold(&self, device: &str, msg: &str, now: u64) {
        let dev = self.key.hash("relay-dev", device.as_bytes());
        let sealed = self.key.seal(&format!("relay-held/{}", hex(&dev)), msg.as_bytes());
        let db = self.db();
        let n: i64 = db.query_row("SELECT COUNT(*) FROM rheld WHERE dev=?1", [&dev[..]], |r| r.get(0)).unwrap_or(0);
        if n < 256 {
            log("hold", db.execute("INSERT INTO rheld (dev, blob, expires) VALUES (?1, ?2, ?3)", params![&dev[..], sealed, (now + self.limits.redeem_ttl_secs) as i64]).map(|_| ()).map_err(Into::into));
        }
    }
    fn take_held(&self, device: &str, now: u64) -> Vec<String> {
        let dev = self.key.hash("relay-dev", device.as_bytes());
        let label = format!("relay-held/{}", hex(&dev));
        let r: Result<Vec<String>> = (|| {
            let db = self.db();
            let mut st = db.prepare("SELECT blob FROM rheld WHERE dev=?1 AND expires>?2 ORDER BY id")?;
            let blobs: Vec<Vec<u8>> = st.query_map(params![&dev[..], now as i64], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            db.execute("DELETE FROM rheld WHERE dev=?1", [&dev[..]])?;
            blobs.iter().map(|b| Ok(String::from_utf8(self.key.open(&label, b)?)?)).collect()
        })();
        log("held", r)
    }
    fn set_route(&self, id: &str, redeemer: &str, inviter: &str, now: u64) {
        let h = self.key.hash("relay-route", id.as_bytes());
        let sealed = self.key.seal(&format!("relay-route/{}", hex(&h)), format!("{redeemer}\0{inviter}").as_bytes());
        log("route", self.db().execute("INSERT OR REPLACE INTO rroute (id, blob, expires) VALUES (?1, ?2, ?3)", params![&h[..], sealed, (now + self.limits.redeem_ttl_secs) as i64]).map(|_| ()).map_err(Into::into));
    }
    fn route(&self, id: &str, now: u64) -> Option<(String, String)> {
        let h = self.key.hash("relay-route", id.as_bytes());
        let blob: Option<Vec<u8>> = self.db().query_row("SELECT blob FROM rroute WHERE id=?1 AND expires>?2", params![&h[..], now as i64], |r| r.get(0)).optional().ok().flatten();
        let plain = String::from_utf8(self.key.open(&format!("relay-route/{}", hex(&h)), &blob?).ok()?).ok()?;
        let (a, b) = plain.split_once('\0')?;
        Some((a.to_string(), b.to_string()))
    }
    fn pin(&self, onion: &str, node: &str) -> bool {
        let h = self.key.hash("relay-pin", onion.as_bytes());
        let want = self.key.hash("relay-pin-node", node.as_bytes());
        let db = self.db();
        match db.query_row("SELECT node FROM rpin WHERE onion=?1", [&h[..]], |r| r.get::<_, Vec<u8>>(0)).optional() {
            Ok(Some(n)) => n == want,
            Ok(None) => db.execute("INSERT INTO rpin (onion, node) VALUES (?1, ?2)", params![&h[..], &want[..]]).is_ok(),
            Err(_) => false,
        }
    }
    fn sweep(&self, now: u64) {
        let db = self.db();
        for t in ["rq", "rheld", "rroute"] {
            log("sweep", db.execute(&format!("DELETE FROM {t} WHERE expires<=?1"), [now as i64]).map(|_| ()).map_err(Into::into));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_members_held_and_routes_survive_and_stay_sealed() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("relay.sqlite");
        let lim = QueueLimits { max_frames: 3, ..QueueLimits::default() };
        {
            let q = SqliteQueue::open(&p, MasterKey::from_bytes(&[1; 32]), lim.clone()).unwrap();
            for i in 0..5 {
                assert_eq!(q.push("dev", "room", &format!("secret-frame-{i}"), 100), i + 1);
            }
            q.set_member("dev", "room", &["b.onion".into()]);
            q.hold("inviter", "held-msg", 100);
            q.set_route("abcd", "redeemer", "inviter", 100);
            assert!(q.pin("b.onion", "k") && !q.pin("b.onion", "k2"));
        }
        let raw = std::fs::read(&p).unwrap();
        let wal = std::fs::read(d.path().join("relay.sqlite-wal")).unwrap_or_default();
        for needle in [b"secret-frame".as_slice(), b"b.onion", b"held-msg", b"redeemer"] {
            assert!(!raw.windows(needle.len()).any(|w| w == needle) && !wal.windows(needle.len()).any(|w| w == needle));
        }
        let q = SqliteQueue::open(&p, MasterKey::from_bytes(&[1; 32]), lim).unwrap();
        assert_eq!(q.pending("dev", "room", 100).iter().map(|x| x.0).collect::<Vec<_>>(), vec![3, 4, 5]);
        q.ack("dev", "room", 4);
        assert_eq!(q.pending("dev", "room", 100), vec![(5, "secret-frame-4".to_string())]);
        assert_eq!(q.members(), vec![("dev".to_string(), "room".to_string(), vec!["b.onion".to_string()])]);
        assert_eq!(q.take_held("inviter", 100), vec!["held-msg".to_string()]);
        assert!(q.take_held("inviter", 100).is_empty());
        assert_eq!(q.route("abcd", 100), Some(("redeemer".into(), "inviter".into())));
        q.sweep(100 + 15 * 86_400);
        assert!(q.pending("dev", "room", 0).is_empty() && q.route("abcd", 0).is_none());
        q.remove_member("dev", "room");
        assert!(q.members().is_empty());
    }
}
