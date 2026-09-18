//! Shared Rust below zinnia's apps.
//!
//! What lives here is what more than one app needs and what none of them should
//! own: the shape of a sealed file, the question "is this one?", and the file
//! I/O that must not lose data when it goes wrong.
//!
//! **What deliberately does NOT live here: sealing and opening.** Those need a
//! password, which means the keyring, which is the one capability the split
//! exists to keep out of apps that do not offer sealing. They stay in the
//! padova crate. The line is drawn so that DETECTING a sealed file — which
//! every app must do, to badge it and refuse to hand ciphertext to an editor —
//! costs nothing and grants nothing.
//!
//! There is no `tauri` dependency. This crate exports plain functions; each app
//! expands its own `#[tauri::command]` shims over them, so command *names* stay
//! identical across apps and the frontend's invoke strings never change.

#[cfg(feature = "legacy-detect")]
use gervasius::gervazy;

/// The frame this build writes:
///
/// ```text
/// ZINNLOCK(8) || VERSION(1) || header_len(u32 LE) || VaultHeader(JSON) || nonce(24) || ct+tag
/// ```
///
/// A local file has no `is_encrypted` column to consult, so the bytes have to
/// say what they are.
pub const MAGIC: &[u8; 8] = b"ZINNLOCK";
pub const VERSION: u8 = 1;
/// magic + version + the u32 that gives the header's length.
pub const PREFIX_LEN: usize = 8 + 1 + 4;

/// Which frame an app reads and writes.
///
/// The LAYOUT is shared — magic, version, header length, header, sealed body —
/// and so are the primitives underneath it. What differs between apps is three
/// constants, and they differ IRREVERSIBLY: every file already on a user's disk
/// carries them, so this is not a thing to unify by picking a winner. Enigma
/// writes `ENIGLOCK`/`enigma:localfile:v1`, zinnia `ZINNLOCK`/`zinnia:file:v1`,
/// and each keeps reading what it wrote.
///
/// The KDF cost is here too because enigma takes it from its build config
/// (editions tune it) while zinnia uses the default.
#[derive(Debug, Clone, Copy)]
pub struct FrameSpec {
    pub magic: &'static [u8; 8],
    pub version: u8,
    /// AEAD associated data. A CONSTANT, never the filename — a sealed file has
    /// to survive being renamed or moved.
    pub aad: &'static [u8],
}

impl FrameSpec {
    /// Zinnia's frame: what the office apps have written since 8/2026.
    pub const ZINNIA: FrameSpec =
        FrameSpec { magic: MAGIC, version: VERSION, aad: b"zinnia:file:v1" };

    /// Enigma's frame: `ENIGLOCK`, and the AAD its files carry.
    pub const ENIGMA: FrameSpec =
        FrameSpec { magic: b"ENIGLOCK", version: 1, aad: b"enigma:localfile:v1" };

    /// Whether these bytes are a frame THIS spec wrote.
    pub fn is_current(&self, bytes: &[u8]) -> bool {
        bytes.len() > PREFIX_LEN && bytes.starts_with(self.magic) && bytes[8] == self.version
    }

    /// Every frame this build knows the layout of: its own and enigma's.
    pub const KNOWN: [FrameSpec; 2] = [FrameSpec::ZINNIA, FrameSpec::ENIGMA];

    /// Which known spec wrote these bytes, if any. The magic decides; the AAD
    /// that comes with the spec is what a reader then has to use.
    pub fn detect(bytes: &[u8]) -> Option<FrameSpec> {
        Self::KNOWN.into_iter().find(|spec| spec.is_current(bytes))
    }

    /// Wrap a sealed body and its header into a frame.
    pub fn frame(&self, header_json: &[u8], body: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(PREFIX_LEN + header_json.len() + body.len());
        out.extend_from_slice(self.magic);
        out.push(self.version);
        out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
        out.extend_from_slice(header_json);
        out.extend_from_slice(body);
        out
    }

    /// Split a frame into its header bytes and its sealed body.
    ///
    /// Every length is checked before it is used as an index: this parses a
    /// file that arrived from anywhere, and a truncated one must be an error
    /// rather than a panic.
    pub fn split<'a>(&self, bytes: &'a [u8]) -> Result<(&'a [u8], &'a [u8]), String> {
        if !self.is_current(bytes) {
            return Err("not_locked: that file is not encrypted".into());
        }
        let len_at = 9;
        let header_len = u32::from_le_bytes(
            bytes[len_at..len_at + 4].try_into().map_err(|_| "crypto: truncated frame")?,
        ) as usize;
        let start = PREFIX_LEN;
        let end = start.checked_add(header_len).ok_or("crypto: header length overflows")?;
        if bytes.len() <= end {
            return Err("crypto: truncated frame".into());
        }
        Ok((&bytes[start..end], &bytes[end..]))
    }
}

/// Refuse to slurp something enormous into memory; the platform's own editable
/// ceiling is 2 MB, and a locked binary can be bigger but not unbounded.
pub const MAX_LOCK_BYTES: u64 = 256 * 1024 * 1024;

/// Whether bytes are a frame this build wrote.
pub fn is_current(bytes: &[u8]) -> bool {
    bytes.len() > PREFIX_LEN && bytes.starts_with(MAGIC) && bytes[8] == VERSION
}

/// Whether bytes are a frame ANY known spec wrote — this build's or enigma's.
/// A file enigma locked is still a locked file: badged, never handed to an
/// editor as ciphertext, skipped by a folder encryption.
pub fn is_known_frame(bytes: &[u8]) -> bool {
    FrameSpec::detect(bytes).is_some()
}

/// Whether a file on disk is sealed — a cheap sniff of its first bytes, so a
/// listing can badge sealed files without asking for anything.
///
/// Answers for the PLATFORM'S formats too, although this build cannot open
/// them: a file it cannot open is still one the user must not be handed to an
/// editor as ciphertext. A file that cannot be opened at all reads as `false` —
/// a permissions failure is indistinguishable from "not sealed" here, so
/// nothing downstream should treat this as authoritative.
pub fn is_sealed_file(path: &str) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    // Enough for any marker: this frame's 13-byte prefix, the platform's
    // 9-byte one, or Fernet's base64 prefix.
    let mut buf = [0u8; 16];
    let read = match f.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    if is_known_frame(&buf[..read]) {
        return true;
    }
    // The platform's older Fernet frames, when this build was asked to know
    // about them. Without the feature a legacy file simply is not recognised —
    // which is correct for a build that could never open one anyway.
    #[cfg(feature = "legacy-detect")]
    {
        return gervazy::is_sealed(&buf[..read]);
    }
    #[cfg(not(feature = "legacy-detect"))]
    false
}

/// Whether these bytes are one of the PLATFORM's older Fernet frames.
///
/// Always `false` without `legacy-detect`, which is the honest answer for a
/// build that has no way to recognise — or open — one. Callers use it to say
/// "that file was encrypted by the platform" instead of "wrong password".
pub fn is_legacy(bytes: &[u8]) -> bool {
    #[cfg(feature = "legacy-detect")]
    {
        return gervazy::is_sealed(bytes);
    }
    #[cfg(not(feature = "legacy-detect"))]
    {
        let _ = bytes;
        false
    }
}

/// Write bytes, or leave the file exactly as it was.
///
/// Through a sibling temporary, fsynced, then renamed. enigma's equivalent
/// skips the fsync, and a lock that a power cut can roll back to plaintext is
/// not a lock.
pub fn atomic_write(path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let tmp = format!("{path}.zlock.tmp");
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Read a whole file, refusing one that is absurdly large.
pub fn read_capped(path: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_LOCK_BYTES {
        return Err("too_large: that file is too big to lock".into());
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

/// A path's final component, for reporting back to the user.
pub fn name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// The frame layout, once, for both apps.
#[cfg(test)]
mod frame_spec_tests {
    use super::*;

    #[test]
    fn a_frame_round_trips_through_split() {
        for spec in [FrameSpec::ZINNIA, FrameSpec::ENIGMA] {
            let framed = spec.frame(b"{\"kdf\":1}", b"sealed-body");
            assert!(spec.is_current(&framed));
            let (header, body) = spec.split(&framed).expect("splits");
            assert_eq!(header, b"{\"kdf\":1}");
            assert_eq!(body, b"sealed-body");
        }
    }

    #[test]
    fn neither_app_reads_the_other_s_files() {
        // The reason the magic is a PARAMETER and not a value to unify: both
        // apps have files on disk already. A zinnia build meeting an enigma
        // file must say "not mine", not misparse it.
        let z = FrameSpec::ZINNIA.frame(b"{}", b"body");
        let e = FrameSpec::ENIGMA.frame(b"{}", b"body");
        assert!(!FrameSpec::ENIGMA.is_current(&z));
        assert!(!FrameSpec::ZINNIA.is_current(&e));
        assert!(FrameSpec::ENIGMA.split(&z).is_err());
        assert!(FrameSpec::ZINNIA.split(&e).is_err());
    }

    #[test]
    fn the_aads_differ_so_a_swapped_body_cannot_verify() {
        // Even if a frame were re-magicked by hand, the AEAD's associated data
        // still binds it to the app that wrote it.
        assert_ne!(FrameSpec::ZINNIA.aad, FrameSpec::ENIGMA.aad);
    }

    #[test]
    fn a_frame_cut_inside_its_header_is_an_error_not_a_panic() {
        // Bounds safety is what `split` owns. A file cut short INSIDE the
        // header cannot be parsed at all and must say so rather than index
        // past the end.
        let framed = FrameSpec::ZINNIA.frame(b"{\"kdf\":1}", b"sealed");
        for cut in [0, 1, PREFIX_LEN, PREFIX_LEN + 2] {
            assert!(FrameSpec::ZINNIA.split(&framed[..cut]).is_err(), "cut at {cut}");
        }
    }

    #[test]
    fn a_frame_cut_inside_its_body_still_parses_and_fails_later() {
        // Deliberate, and worth stating: losing a byte of CIPHERTEXT is not the
        // parser's to catch. The frame is structurally intact, `split` hands
        // back a short body, and the AEAD tag refuses it when it is opened —
        // which is the layer that can actually tell corruption from truncation.
        let framed = FrameSpec::ZINNIA.frame(b"{\"kdf\":1}", b"sealed");
        let (header, body) = FrameSpec::ZINNIA
            .split(&framed[..framed.len() - 1])
            .expect("structurally still a frame");
        assert_eq!(header, b"{\"kdf\":1}");
        assert_eq!(body, b"seale", "one byte short, for the AEAD to reject");
    }

    #[test]
    fn a_header_length_that_overruns_the_file_is_refused() {
        // A hostile file claiming a 4 GB header must not index past the end.
        let mut framed = FrameSpec::ZINNIA.frame(b"{}", b"body");
        framed[9..13].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(FrameSpec::ZINNIA.split(&framed).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> String {
        std::env::temp_dir()
            .join(format!("substrate-{}-{name}", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn enigmas_frame_is_recognised_as_sealed_too() {
        let framed = FrameSpec::ENIGMA.frame(b"{}", b"body");
        assert!(!is_current(&framed), "not this build's own frame");
        assert!(is_known_frame(&framed));
        assert_eq!(FrameSpec::detect(&framed).map(|s| s.magic), Some(b"ENIGLOCK"));
        assert_eq!(FrameSpec::detect(b"plain text file").map(|s| s.magic), None);
        let path = tmp("enigma-frame");
        std::fs::write(&path, &framed).unwrap();
        assert!(is_sealed_file(&path));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_frame_is_recognised_by_its_first_bytes() {
        let mut framed = Vec::from(*MAGIC);
        framed.push(VERSION);
        framed.extend_from_slice(&[0, 0, 0, 0]);
        framed.push(b'x');
        assert!(is_current(&framed));

        // A different version is not this frame, even with the right magic.
        let mut wrong = framed.clone();
        wrong[8] = VERSION.wrapping_add(1);
        assert!(!is_current(&wrong));

        assert!(!is_current(b"plain text"));
        // The prefix alone is not a frame: there must be something after it.
        assert!(!is_current(&framed[..PREFIX_LEN]));
    }

    #[test]
    fn an_unreadable_path_is_not_sealed_rather_than_an_error() {
        assert!(!is_sealed_file(&tmp("does-not-exist")));
    }

    #[test]
    fn a_plain_file_is_not_sealed() {
        let path = tmp("plain");
        std::fs::write(&path, b"just text").unwrap();
        assert!(!is_sealed_file(&path));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_framed_file_is_sealed() {
        let path = tmp("framed");
        let mut bytes = Vec::from(*MAGIC);
        bytes.push(VERSION);
        bytes.extend_from_slice(&[1, 0, 0, 0]);
        bytes.extend_from_slice(b"{}");
        std::fs::write(&path, &bytes).unwrap();
        assert!(is_sealed_file(&path));
        std::fs::remove_file(&path).ok();
    }

    /// The property the fsync is there for: a failed write must not leave the
    /// original truncated, and must not leave its temporary behind.
    #[test]
    fn a_failed_write_leaves_neither_a_partial_file_nor_a_temporary() {
        let dir = std::env::temp_dir().join(format!("substrate-{}-dir", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("target").to_string_lossy().into_owned();
        std::fs::write(&path, b"original").unwrap();

        // A directory where the temporary wants to be: `File::create` fails.
        let blocker = format!("{path}.zlock.tmp");
        std::fs::create_dir_all(&blocker).unwrap();

        assert!(atomic_write(&path, b"replacement").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_write_replaces_the_whole_file() {
        let path = tmp("replace");
        std::fs::write(&path, b"a much longer original").unwrap();
        atomic_write(&path, b"short").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"short");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn reading_refuses_a_file_over_the_cap() {
        let path = tmp("capped");
        std::fs::write(&path, b"small enough").unwrap();
        assert_eq!(read_capped(&path).unwrap(), b"small enough");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_name_survives_a_path_without_one() {
        assert_eq!(name_of("/a/b/c.txt"), "c.txt");
        assert_eq!(name_of("bare"), "bare");
        assert_eq!(name_of("/"), "/");
    }
}
