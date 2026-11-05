//! 3.5: one SQLite file. Every id and token is stored as a keyed hash and every
//! value sealed with the master key (3.7): the file alone gives away how many
//! rows there are and how big they are, nothing else.
//!
//! WAL journal with `synchronous=FULL`: a power cut (a Pi's usual way of
//! stopping) loses at most the request in flight, never the file.

use crate::config::Limits;
use crate::masterkey::MasterKey;
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

const DAY: u64 = 86_400;

pub struct Store {
    db: Mutex<Connection>,
    key: MasterKey,
    limits: Limits,
}

/// Why a request was refused, mapped to an HTTP status by the API.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Wrong token for an existing mailbox / record.
    Forbidden,
    NotFound,
    /// Mailbox full, or the server's mailbox count reached.
    Full,
    TooLarge,
    /// A pairing token already used.
    Conflict,
}

pub type Outcome<T> = std::result::Result<T, Refusal>;

pub struct Fetched {
    pub seq: i64,
    pub blob: Vec<u8>,
}

fn hexs(b: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(b)
}

impl Store {
    pub fn open(path: &Path, key: MasterKey, limits: Limits) -> Result<Self> {
        let db = Connection::open(path)?;
        Self::init(db, key, limits)
    }

    pub fn in_memory(key: MasterKey, limits: Limits) -> Result<Self> {
        Self::init(Connection::open_in_memory()?, key, limits)
    }

    fn init(db: Connection, key: MasterKey, limits: Limits) -> Result<Self> {
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS mailbox (
               id BLOB PRIMARY KEY, token BLOB NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1);
             CREATE TABLE IF NOT EXISTS message (
               mailbox BLOB NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
               seq INTEGER NOT NULL, blob BLOB NOT NULL, expires INTEGER NOT NULL,
               PRIMARY KEY (mailbox, seq));
             CREATE TABLE IF NOT EXISTS record (
               id BLOB PRIMARY KEY, token BLOB NOT NULL, blob BLOB NOT NULL, expires INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS pairing (
               token BLOB PRIMARY KEY, blob BLOB NOT NULL, expires INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS message_expires ON message(expires);",
        )?;
        Ok(Store { db: Mutex::new(db), key, limits })
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Check (or, on first use, set) the mailbox's token. Returns the hashed id.
    fn mailbox_auth(&self, db: &Connection, id: &[u8], token: &[u8], create: bool) -> Result<Outcome<[u8; 32]>> {
        let hid = self.key.hash("mailbox", id);
        let htok = self.key.hash("mailbox-token", token);
        let found: Option<Vec<u8>> =
            db.query_row("SELECT token FROM mailbox WHERE id=?1", [&hid[..]], |r| r.get(0)).optional()?;
        match found {
            Some(t) if t == htok => Ok(Ok(hid)),
            Some(_) => Ok(Err(Refusal::Forbidden)),
            None if !create => Ok(Err(Refusal::NotFound)),
            None => {
                let n: u32 = db.query_row("SELECT COUNT(*) FROM mailbox", [], |r| r.get(0))?;
                if n >= self.limits.max_mailboxes {
                    return Ok(Err(Refusal::Full));
                }
                db.execute("INSERT INTO mailbox (id, token) VALUES (?1, ?2)", params![&hid[..], &htok[..]])?;
                Ok(Ok(hid))
            }
        }
    }

    /// M3: leave a sealed message in a mailbox. The first put creates it (its
    /// id and token are derived from the friendship secret, so only friends know them).
    pub fn put_message(&self, id: &[u8], token: &[u8], blob: &[u8], now: u64) -> Result<Outcome<i64>> {
        if blob.len() > self.limits.max_message_bytes {
            return Ok(Err(Refusal::TooLarge));
        }
        let mut db = self.db();
        let tx = db.transaction()?;
        let hid = match self.mailbox_auth(&tx, id, token, true)? {
            Ok(h) => h,
            Err(r) => return Ok(Err(r)),
        };
        let count: u32 = tx.query_row("SELECT COUNT(*) FROM message WHERE mailbox=?1", [&hid[..]], |r| r.get(0))?;
        if count >= self.limits.max_messages_per_mailbox {
            return Ok(Err(Refusal::Full));
        }
        let seq: i64 = tx.query_row("SELECT next_seq FROM mailbox WHERE id=?1", [&hid[..]], |r| r.get(0))?;
        let sealed = self.key.seal(&format!("message/{}/{seq}", hexs(&hid)), blob);
        let expires = now + self.limits.message_ttl_days * DAY;
        tx.execute(
            "INSERT INTO message (mailbox, seq, blob, expires) VALUES (?1, ?2, ?3, ?4)",
            params![&hid[..], seq, sealed, expires as i64],
        )?;
        tx.execute("UPDATE mailbox SET next_seq=next_seq+1 WHERE id=?1", [&hid[..]])?;
        tx.commit()?;
        Ok(Ok(seq))
    }

    /// Up to `max` messages after `after`, oldest first.
    pub fn fetch(&self, id: &[u8], token: &[u8], after: i64, max: u32) -> Result<Outcome<Vec<Fetched>>> {
        let db = self.db();
        let hid = match self.mailbox_auth(&db, id, token, false)? {
            Ok(h) => h,
            Err(Refusal::NotFound) => return Ok(Ok(vec![])),
            Err(r) => return Ok(Err(r)),
        };
        let mut st = db.prepare("SELECT seq, blob FROM message WHERE mailbox=?1 AND seq>?2 ORDER BY seq LIMIT ?3")?;
        let rows = st.query_map(params![&hid[..], after, max], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
        let mut out = vec![];
        for row in rows {
            let (seq, sealed) = row?;
            let blob = self.key.open(&format!("message/{}/{seq}", hexs(&hid)), &sealed)?;
            out.push(Fetched { seq, blob });
        }
        Ok(Ok(out))
    }

    /// Drop every message up to and including `upto` (the recipient has them).
    pub fn ack(&self, id: &[u8], token: &[u8], upto: i64) -> Result<Outcome<usize>> {
        let db = self.db();
        let hid = match self.mailbox_auth(&db, id, token, false)? {
            Ok(h) => h,
            Err(r) => return Ok(Err(r)),
        };
        Ok(Ok(db.execute("DELETE FROM message WHERE mailbox=?1 AND seq<=?2", params![&hid[..], upto])?))
    }

    /// D5: file (or replace) a sealed directory record. The first writer's token owns it.
    pub fn put_record(&self, id: &[u8], token: &[u8], blob: &[u8], now: u64) -> Result<Outcome<()>> {
        if blob.len() > self.limits.max_record_bytes {
            return Ok(Err(Refusal::TooLarge));
        }
        let hid = self.key.hash("record", id);
        let htok = self.key.hash("record-token", token);
        let db = self.db();
        let found: Option<Vec<u8>> =
            db.query_row("SELECT token FROM record WHERE id=?1", [&hid[..]], |r| r.get(0)).optional()?;
        if matches!(found, Some(ref t) if t[..] != htok[..]) {
            return Ok(Err(Refusal::Forbidden));
        }
        let sealed = self.key.seal(&format!("record/{}", hexs(&hid)), blob);
        let expires = now + self.limits.record_ttl_days * DAY;
        db.execute(
            "INSERT INTO record (id, token, blob, expires) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET blob=excluded.blob, expires=excluded.expires",
            params![&hid[..], &htok[..], sealed, expires as i64],
        )?;
        Ok(Ok(()))
    }

    pub fn get_record(&self, id: &[u8], now: u64) -> Result<Outcome<Vec<u8>>> {
        let hid = self.key.hash("record", id);
        let db = self.db();
        let row: Option<(Vec<u8>, i64)> = db
            .query_row("SELECT blob, expires FROM record WHERE id=?1", [&hid[..]], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        match row {
            Some((sealed, exp)) if exp as u64 > now => Ok(Ok(self.key.open(&format!("record/{}", hexs(&hid)), &sealed)?)),
            _ => Ok(Err(Refusal::NotFound)),
        }
    }

    /// D1 with Proteus: a pairing reply left under the card's one-time token.
    pub fn put_pairing(&self, token: &[u8], blob: &[u8], now: u64) -> Result<Outcome<()>> {
        if blob.len() > self.limits.max_pairing_bytes {
            return Ok(Err(Refusal::TooLarge));
        }
        let ht = self.key.hash("pairing", token);
        let sealed = self.key.seal(&format!("pairing/{}", hexs(&ht)), blob);
        let expires = now + self.limits.pairing_ttl_days * DAY;
        let n = self.db().execute(
            "INSERT OR IGNORE INTO pairing (token, blob, expires) VALUES (?1, ?2, ?3)",
            params![&ht[..], sealed, expires as i64],
        )?;
        Ok(if n == 1 { Ok(()) } else { Err(Refusal::Conflict) })
    }

    /// Take the reply: it is returned once, then gone.
    pub fn take_pairing(&self, token: &[u8], now: u64) -> Result<Outcome<Vec<u8>>> {
        let ht = self.key.hash("pairing", token);
        let db = self.db();
        let row: Option<(Vec<u8>, i64)> = db
            .query_row("SELECT blob, expires FROM pairing WHERE token=?1", [&ht[..]], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let Some((sealed, exp)) = row else { return Ok(Err(Refusal::NotFound)) };
        db.execute("DELETE FROM pairing WHERE token=?1", [&ht[..]])?;
        if exp as u64 <= now {
            return Ok(Err(Refusal::NotFound));
        }
        Ok(Ok(self.key.open(&format!("pairing/{}", hexs(&ht)), &sealed)?))
    }

    /// Drop what has expired, and mailboxes left empty and unused. Returns rows removed.
    pub fn sweep(&self, now: u64) -> Result<usize> {
        let db = self.db();
        let n = now as i64;
        let mut removed = db.execute("DELETE FROM message WHERE expires<=?1", [n])?;
        removed += db.execute("DELETE FROM record WHERE expires<=?1", [n])?;
        removed += db.execute("DELETE FROM pairing WHERE expires<=?1", [n])?;
        Ok(removed)
    }

    /// `VACUUM INTO`: a consistent copy while serving. The copy is sealed the same
    /// way; keep the master key's backup apart from it.
    pub fn backup(&self, to: &Path) -> Result<()> {
        if to.exists() {
            return Err(anyhow!("{} exists", to.display()));
        }
        self.db().execute("VACUUM INTO ?1", [to.to_string_lossy()])?;
        Ok(())
    }

    /// Rows per table, for `proteus status`.
    pub fn counts(&self) -> Result<[(String, i64); 4]> {
        let db = self.db();
        let c = |t: &str| -> Result<(String, i64)> {
            Ok((t.to_string(), db.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))?))
        };
        Ok([c("mailbox")?, c("message")?, c("record")?, c("pairing")?])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        let limits = Limits { max_messages_per_mailbox: 3, max_mailboxes: 2, ..Limits::default() };
        Store::in_memory(MasterKey::from_bytes(&[7; 32]), limits).unwrap()
    }

    #[test]
    fn mailbox_put_fetch_ack() {
        let s = store();
        assert_eq!(s.put_message(b"box", b"tok", b"m1", 0).unwrap(), Ok(1));
        assert_eq!(s.put_message(b"box", b"tok", b"m2", 0).unwrap(), Ok(2));
        let got = s.fetch(b"box", b"tok", 0, 10).unwrap().unwrap();
        assert_eq!(got.iter().map(|f| f.blob.clone()).collect::<Vec<_>>(), vec![b"m1".to_vec(), b"m2".to_vec()]);
        assert_eq!(s.fetch(b"box", b"tok", 1, 10).unwrap().unwrap().len(), 1);
        assert_eq!(s.ack(b"box", b"tok", 1).unwrap(), Ok(1));
        assert_eq!(s.fetch(b"box", b"tok", 0, 10).unwrap().unwrap()[0].seq, 2);
        // Sequence numbers keep going after an ack.
        assert_eq!(s.put_message(b"box", b"tok", b"m3", 0).unwrap(), Ok(3));
    }

    #[test]
    fn wrong_tokens_quotas_and_sizes_are_refused() {
        let s = store();
        s.put_message(b"box", b"tok", b"m", 0).unwrap().unwrap();
        assert_eq!(s.put_message(b"box", b"bad", b"m", 0).unwrap(), Err(Refusal::Forbidden));
        assert!(matches!(s.fetch(b"box", b"bad", 0, 10).unwrap(), Err(Refusal::Forbidden)));
        assert_eq!(s.ack(b"box", b"bad", 99).unwrap(), Err(Refusal::Forbidden));
        s.put_message(b"box", b"tok", b"m", 0).unwrap().unwrap();
        s.put_message(b"box", b"tok", b"m", 0).unwrap().unwrap();
        assert_eq!(s.put_message(b"box", b"tok", b"m", 0).unwrap(), Err(Refusal::Full));
        s.put_message(b"box2", b"t", b"m", 0).unwrap().unwrap();
        assert_eq!(s.put_message(b"box3", b"t", b"m", 0).unwrap(), Err(Refusal::Full), "max_mailboxes");
        let big = vec![0; s.limits().max_message_bytes + 1];
        assert_eq!(s.put_message(b"box2", b"t", &big, 0).unwrap(), Err(Refusal::TooLarge));
        assert!(s.fetch(b"nobox", b"t", 0, 10).unwrap().unwrap().is_empty());
    }

    #[test]
    fn records_are_owned_by_their_first_token_and_expire() {
        let s = store();
        s.put_record(b"r", b"owner", b"v1", 0).unwrap().unwrap();
        s.put_record(b"r", b"owner", b"v2", 0).unwrap().unwrap();
        assert_eq!(s.put_record(b"r", b"other", b"evil", 0).unwrap(), Err(Refusal::Forbidden));
        assert_eq!(s.get_record(b"r", 10).unwrap(), Ok(b"v2".to_vec()));
        let later = s.limits().record_ttl_days * DAY + 1;
        assert_eq!(s.get_record(b"r", later).unwrap(), Err(Refusal::NotFound));
        assert_eq!(s.sweep(later).unwrap(), 1);
    }

    #[test]
    fn a_pairing_reply_is_taken_once() {
        let s = store();
        s.put_pairing(b"pt", b"reply", 0).unwrap().unwrap();
        assert_eq!(s.put_pairing(b"pt", b"again", 0).unwrap(), Err(Refusal::Conflict));
        assert_eq!(s.take_pairing(b"pt", 1).unwrap(), Ok(b"reply".to_vec()));
        assert_eq!(s.take_pairing(b"pt", 1).unwrap(), Err(Refusal::NotFound));
    }

    #[test]
    fn the_file_holds_no_ids_tokens_or_contents_and_needs_the_key() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("p.sqlite");
        {
            let s = Store::open(&path, MasterKey::from_bytes(&[7; 32]), Limits::default()).unwrap();
            s.put_message(b"MAILBOX-ID-XYZ", b"TOKEN-ABC", b"HELLO-PLAINTEXT", 0).unwrap().unwrap();
            s.put_record(b"RECORD-ID", b"TOKEN-ABC", b"RECORD-PLAINTEXT", 0).unwrap().unwrap();
            s.backup(&d.path().join("b.sqlite")).unwrap();
        }
        for f in ["p.sqlite", "p.sqlite-wal", "b.sqlite"] {
            let Ok(raw) = std::fs::read(d.path().join(f)) else { continue };
            for needle in [&b"MAILBOX-ID-XYZ"[..], b"TOKEN-ABC", b"HELLO-PLAINTEXT", b"RECORD-PLAINTEXT", b"RECORD-ID"] {
                assert!(!raw.windows(needle.len()).any(|w| w == needle), "{f} leaks {}", String::from_utf8_lossy(needle));
            }
        }
        // The backup opens with the same key, not with another.
        let b = Store::open(&d.path().join("b.sqlite"), MasterKey::from_bytes(&[7; 32]), Limits::default()).unwrap();
        assert_eq!(b.fetch(b"MAILBOX-ID-XYZ", b"TOKEN-ABC", 0, 9).unwrap().unwrap()[0].blob, b"HELLO-PLAINTEXT");
        let wrong = Store::open(&d.path().join("b.sqlite"), MasterKey::from_bytes(&[8; 32]), Limits::default()).unwrap();
        assert!(matches!(wrong.fetch(b"MAILBOX-ID-XYZ", b"TOKEN-ABC", 0, 9).unwrap(), Ok(v) if v.is_empty()),
            "another key does not even find the mailbox");
    }

    #[test]
    fn a_sealed_value_moved_to_another_row_does_not_open() {
        let s = store();
        s.put_message(b"box", b"tok", b"one", 0).unwrap().unwrap();
        s.put_message(b"box", b"tok", b"two", 0).unwrap().unwrap();
        s.db().execute_batch("UPDATE message SET blob=(SELECT blob FROM message WHERE seq=1) WHERE seq=2").unwrap();
        assert!(s.fetch(b"box", b"tok", 1, 9).is_err());
    }
}
