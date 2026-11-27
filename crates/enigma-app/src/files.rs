//! File transfer inside a room (the Files tab): offer → accept → chunks → done, every
//! step a sync message sealed by the room's MLS group and carried by the Beacons like
//! any other frame (the Tauri app dialled the sender's onion instead; b2 has no direct
//! links). A Beacon sees only sealed frames of the usual padded sizes.
//!
//! Sync kinds (payload JSON): `file_offer {offerId, name, size, chunks, sha256}`,
//! `file_accept {offerId}`, `file_decline {offerId}`, `file_cancel {offerId}`,
//! `file_chunk {offerId, i, data}` (base64), `file_done {offerId}`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Default chunk size (KiB) and largest file (MiB), as the Tauri settings' defaults.
pub const DEFAULT_CHUNK_KB: u64 = 256;
/// Default largest file (MiB).
pub const DEFAULT_MAX_MB: u64 = 25;
/// Chunks sent per tick (~250 ms), so a transfer does not starve the chat.
pub const CHUNKS_PER_TICK: usize = 4;

/// Where a transfer is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileState {
    /// Offered, waiting for an answer.
    Offered,
    /// Moving.
    Sending,
    /// Arriving.
    Receiving,
    /// Done (for the receiver: saved here).
    Done(Option<PathBuf>),
    /// Declined by the other side or by me.
    Declined,
    /// Cancelled by the sender.
    Cancelled,
    /// Failed (checksum, write).
    Failed(String),
}

/// One row of the Files tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRow {
    /// Offer id.
    pub id: String,
    /// File name.
    pub name: String,
    /// Bytes.
    pub size: u64,
    /// 0..=100.
    pub percent: u8,
    /// State.
    pub state: FileState,
    /// I offered it.
    pub mine: bool,
    /// Who offered it.
    pub from: String,
}

struct Out {
    name: String,
    data: Vec<u8>,
    chunk: usize,
    next: usize,
    state: FileState,
}

struct In {
    name: String,
    size: u64,
    sha256: String,
    from: String,
    got: Vec<Option<Vec<u8>>>,
    state: FileState,
}

/// The transfers of this device.
#[derive(Default)]
pub struct Files {
    out: HashMap<String, Out>,
    inc: HashMap<String, In>,
    order: Vec<String>,
    /// Where received files go.
    pub dir: PathBuf,
}

fn chunks_of(size: usize, chunk: usize) -> usize {
    size.div_ceil(chunk.max(1)).max(1)
}

fn safe_file_name(n: &str) -> String {
    let base = Path::new(n).file_name().and_then(|s| s.to_str()).unwrap_or("file");
    let s: String = base.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    if s.trim_matches('.').is_empty() {
        "file".into()
    } else {
        s
    }
}

impl Files {
    /// Received files go to `dir`.
    #[must_use]
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, ..Self::default() }
    }

    /// Offer a file: (offer id, the `file_offer` payload).
    ///
    /// # Errors
    /// Unreadable, or over `max_bytes`.
    pub fn offer(&mut self, path: &Path, chunk_bytes: usize, max_bytes: u64) -> Result<(String, Value), String> {
        let data = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if data.len() as u64 > max_bytes {
            return Err(format!("the file is larger than {} MB", max_bytes / (1024 * 1024)));
        }
        let name = safe_file_name(&path.to_string_lossy());
        let id = hex::encode(&Sha256::digest(format!("{name}{}{:?}", data.len(), std::time::SystemTime::now()).as_bytes())[..12]);
        let sha = hex::encode(Sha256::digest(&data));
        let n = chunks_of(data.len(), chunk_bytes);
        let p = json!({ "offerId": id, "name": name, "size": data.len(), "chunks": n, "sha256": sha });
        self.out.insert(id.clone(), Out { name, data, chunk: chunk_bytes.max(1), next: 0, state: FileState::Offered });
        self.order.push(id.clone());
        Ok((id, p))
    }

    /// Accept an incoming offer: the `file_accept` payload.
    pub fn accept(&mut self, id: &str) -> Option<Value> {
        let i = self.inc.get_mut(id).filter(|i| i.state == FileState::Offered)?;
        i.state = FileState::Receiving;
        Some(json!({ "offerId": id }))
    }

    /// Decline an incoming offer, or cancel my own: (kind, payload).
    pub fn decline(&mut self, id: &str) -> Option<(&'static str, Value)> {
        if let Some(o) = self.out.get_mut(id) {
            o.state = FileState::Cancelled;
            return Some(("file_cancel", json!({ "offerId": id })));
        }
        let i = self.inc.get_mut(id)?;
        i.state = FileState::Declined;
        Some(("file_decline", json!({ "offerId": id })))
    }

    /// A sync message from the room. Returns a status line to show, if any.
    pub fn on_sync(&mut self, kind: &str, p: &Value, sender: &str) -> Option<String> {
        let id = p["offerId"].as_str()?.to_string();
        match kind {
            "file_offer" => {
                if self.inc.contains_key(&id) || self.out.contains_key(&id) {
                    return None;
                }
                let size = p["size"].as_u64()?;
                let n = usize::try_from(p["chunks"].as_u64()?).ok().filter(|n| *n > 0 && *n <= 1_000_000)?;
                let name = safe_file_name(p["name"].as_str().unwrap_or("file"));
                let msg = format!("{sender} offers \u{201c}{name}\u{201d} ({} KB): see Files.", size.div_ceil(1024));
                self.inc.insert(id.clone(), In { name, size, sha256: p["sha256"].as_str().unwrap_or("").into(), from: sender.into(), got: vec![None; n], state: FileState::Offered });
                self.order.push(id);
                Some(msg)
            }
            "file_accept" => {
                let o = self.out.get_mut(&id)?;
                if o.state == FileState::Offered {
                    o.state = FileState::Sending;
                    return Some(format!("{sender} accepted \u{201c}{}\u{201d}.", o.name));
                }
                None
            }
            "file_decline" => {
                let o = self.out.get(&id)?;
                Some(format!("{sender} declined \u{201c}{}\u{201d}.", o.name))
            }
            "file_cancel" => {
                let i = self.inc.get_mut(&id)?;
                i.state = FileState::Cancelled;
                None
            }
            "file_chunk" => {
                let i = self.inc.get_mut(&id).filter(|i| i.state == FileState::Receiving)?;
                let k = usize::try_from(p["i"].as_u64()?).ok()?;
                let data = B64.decode(p["data"].as_str()?).ok()?;
                if k < i.got.len() {
                    i.got[k] = Some(data);
                }
                if i.got.iter().all(Option::is_some) {
                    return Some(self.finish(&id));
                }
                None
            }
            _ => None,
        }
    }

    fn finish(&mut self, id: &str) -> String {
        let dir = self.dir.clone();
        let Some(i) = self.inc.get_mut(id) else { return String::new() };
        let data: Vec<u8> = i.got.iter().flatten().flatten().copied().collect();
        if !i.sha256.is_empty() && hex::encode(Sha256::digest(&data)) != i.sha256 {
            i.state = FileState::Failed("checksum mismatch".into());
            return format!("\u{201c}{}\u{201d} arrived damaged.", i.name);
        }
        let _ = std::fs::create_dir_all(&dir);
        let mut path = dir.join(&i.name);
        let mut n = 1;
        while path.exists() {
            path = dir.join(format!("{n}-{}", i.name));
            n += 1;
        }
        match std::fs::write(&path, &data) {
            Ok(()) => {
                i.state = FileState::Done(Some(path.clone()));
                i.got.clear();
                format!("Saved \u{201c}{}\u{201d} to {}.", i.name, path.display())
            }
            Err(e) => {
                i.state = FileState::Failed(e.to_string());
                format!("Could not save \u{201c}{}\u{201d}: {e}", i.name)
            }
        }
    }

    /// The next chunks to send (call every tick): (kind, payload).
    pub fn pump(&mut self) -> Vec<(&'static str, Value)> {
        let mut v = vec![];
        for (id, o) in &mut self.out {
            while o.state == FileState::Sending && v.len() < CHUNKS_PER_TICK {
                let start = o.next * o.chunk;
                let end = (start + o.chunk).min(o.data.len());
                v.push(("file_chunk", json!({ "offerId": id, "i": o.next, "data": B64.encode(&o.data[start..end]) })));
                o.next += 1;
                if o.next >= chunks_of(o.data.len(), o.chunk) {
                    o.state = FileState::Done(None);
                    v.push(("file_done", json!({ "offerId": id })));
                }
            }
        }
        v
    }

    /// Every transfer, oldest first.
    #[must_use]
    pub fn rows(&self) -> Vec<FileRow> {
        self.order
            .iter()
            .filter_map(|id| {
                if let Some(o) = self.out.get(id) {
                    let n = chunks_of(o.data.len(), o.chunk);
                    let pct = if matches!(o.state, FileState::Done(_)) { 100 } else { (o.next * 100 / n) as u8 };
                    return Some(FileRow { id: id.clone(), name: o.name.clone(), size: o.data.len() as u64, percent: pct, state: o.state.clone(), mine: true, from: String::new() });
                }
                let i = self.inc.get(id)?;
                let got = i.got.iter().filter(|c| c.is_some()).count();
                let pct = if matches!(i.state, FileState::Done(_)) { 100 } else { (got * 100 / i.got.len().max(1)) as u8 };
                Some(FileRow { id: id.clone(), name: i.name.clone(), size: i.size, percent: pct, state: i.state.clone(), mine: false, from: i.from.clone() })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offer_accept_chunks_and_save_with_checksum() {
        let dir = std::env::temp_dir().join(format!("enigma-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("notes.txt");
        let body: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &body).unwrap();
        let mut a = Files::new(dir.join("a"));
        let mut b = Files::new(dir.join("b"));
        assert!(a.offer(&src, 1024, 100).is_err(), "too large");
        let (id, offer) = a.offer(&src, 1024, 1 << 20).unwrap();
        assert!(b.on_sync("file_offer", &offer, "Ann").unwrap().contains("notes.txt"));
        assert_eq!(b.rows()[0].state, FileState::Offered);
        assert!(a.pump().is_empty(), "nothing before an accept");
        let acc = b.accept(&id).unwrap();
        assert!(a.on_sync("file_accept", &acc, "Bob").is_some());
        let mut saved = None;
        for _ in 0..10 {
            for (k, p) in a.pump() {
                if let Some(s) = b.on_sync(k, &p, "Ann") {
                    saved = Some(s);
                }
            }
        }
        assert!(saved.unwrap().starts_with("Saved"));
        let FileState::Done(Some(p)) = &b.rows()[0].state else { panic!("{:?}", b.rows()) };
        assert_eq!(std::fs::read(p).unwrap(), body);
        assert_eq!(a.rows()[0].percent, 100);
        // A declined one, and a hostile name.
        let (id2, mut offer2) = a.offer(&src, 4096, 1 << 20).unwrap();
        offer2["name"] = json!("../../etc/passwd");
        b.on_sync("file_offer", &offer2, "Ann");
        assert_eq!(b.rows()[1].name, "passwd");
        let (k, p) = b.decline(&id2).unwrap();
        assert_eq!(k, "file_decline");
        assert!(a.on_sync(k, &p, "Bob").unwrap().contains("declined"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
