//! Locking a file in place, self-contained.
//!
//! Every sealed file carries everything needed to open it except the password:
//!
//! ```text
//! ZINNLOCK(8) || VERSION(1) || header_len(u32 LE) || VaultHeader(JSON) || nonce(24) || ct+tag
//! ```
//!
//! `VaultHeader` is gervasius's — a random 16-byte salt, the Argon2id costs it
//! was made with, and a DEK wrapped under the password-derived key. It sits in
//! the CLEAR because it reveals nothing without the password, and putting it
//! here is what makes a sealed file portable: carry the file to another machine
//! and the password alone opens it.
//!
//! This replaces a design where the salt was a PARAMETER, fetched from the
//! caller's strongbox row on the platform (`GET /vault/api/strongbox/`). That
//! bought cross-device key agreement, and it died with the cloud: the endpoint
//! is parked in `limbo/cloud/`, so the commands became uncallable — no salt, no
//! key. The alternatives were a device-local salt (one file whose loss orphans
//! every sealed document, needing backup UI and a place to keep it) or this.
//! Enigma reached the same conclusion for the same reason; see its
//! `local_lock.rs`, which this frame deliberately mirrors.
//!
//! Two tiers, not one: the password wraps a random DEK rather than encrypting
//! the bytes directly. It costs nothing here and it is what would let a
//! password change re-wrap the key instead of re-encrypting the file.
//!
//! A sealed file announces itself in its first nine bytes, so it can be shown
//! as sealed without asking for anything — that half lives in substrate. The
//! password is a parameter and is never stored; a wrong one fails on the
//! wrapped DEK's tag before a single byte is written, so the file on disk is
//! left exactly as it was.
//!
//! These functions take a PATH and use `std::fs` directly, so no plugin scope
//! gates them — they will seal anything they are handed. The caller decides
//! the boundary: Morion resolves every path against its workspace first.
//!
//! ## Editing without decrypting the disk
//!
//! A [`SealSession`] is the third way in. `open_sealed` verifies the password,
//! decrypts the file INTO MEMORY and keeps the file's own key; `write` seals a
//! new body under that same key and header and writes it atomically, so the
//! file on disk is ciphertext before, during and after an edit. Nothing
//! unencrypted is ever written, and the password is not kept — only the DEK,
//! which zeroizes when the session is dropped. That is enigma's
//! `local_note_read`/`local_note_write` pair, with the passphrase held once in
//! Rust instead of being handed back to the page on every save.
//!
//! ## Two frames, one reader
//!
//! Enigma writes `ENIGLOCK` with its own AAD; this crate writes `ZINNLOCK`.
//! The layout and the cryptography are identical, so a reader that picks the
//! spec by the magic opens either. New files are always written as ZINNLOCK.

use gervasius::{create_vault_with_params, open, seal, Dek, KdfParams, VaultHeader};
use serde::Serialize;
use substrate::{atomic_write, is_legacy, name_of, read_capped, FrameSpec};

use crate::Locker;

/// What a file's ciphertext is bound to. A CONSTANT, never the file name, so a
/// sealed file survives being renamed or moved. It no longer matches the
/// platform's `sealed.VAULT_AAD`, and should not: this frame is zinnia's own.
/// Zinnia's frame — magic, version and AAD in one place, shared with enigma's
/// by shape but never by value: both apps have sealed files on disk already.
const SPEC: FrameSpec = FrameSpec::ZINNIA;
const AAD: &[u8] = SPEC.aad;

/// What a caller is told about a file it just sealed or opened: its name and
/// its plaintext size. Nothing about the key.
#[derive(Debug, Serialize)]
pub struct LockedInfo {
    name: String,
    size: u64,
}

/// Split a frame into its spec, its header and its sealed body.
/// The layout lives in `substrate::FrameSpec` — one implementation for both
/// apps, each with its own magic and AAD. The magic says which one wrote the
/// file, and with it which AAD opens the body. All this adds is decoding the
/// header JSON, which is padova's business rather than the frame's.
fn parse_frame(bytes: &[u8]) -> Result<(FrameSpec, VaultHeader, &[u8]), String> {
    let spec = FrameSpec::detect(bytes)
        .ok_or_else(|| "not_locked: that file is not encrypted".to_string())?;
    let (header_bytes, body) = spec.split(bytes)?;
    let header: VaultHeader = serde_json::from_slice(header_bytes)
        .map_err(|_| "crypto: that encrypted file is damaged".to_string())?;
    Ok((spec, header, body))
}

/// A file opened for editing: its key, held in Rust for as long as the file is
/// open, so saves re-seal without the password and the page never holds
/// either. Dropping it zeroizes the key.
pub struct SealSession {
    /// The frame the file was found in — and will be written back in, so an
    /// enigma-locked file stays an enigma-locked file.
    spec: FrameSpec,
    header: VaultHeader,
    dek: Dek,
    /// The file this session edits, as the caller spelled it: the one it was
    /// opened from, then whichever file a Save As last wrote. Writing back
    /// THERE requires the file still to be this vault; writing anywhere else
    /// is Save As, after which the session follows the new file.
    origin: String,
}

impl std::fmt::Debug for SealSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The key is deliberately not printable.
        f.debug_struct("SealSession").field("magic", &self.spec.magic).finish()
    }
}

impl SealSession {
    /// Re-seal `plain` under this session's key and write it to `path`
    /// atomically — the same header, a fresh nonce.
    ///
    /// Writing back to the file this session edits (the one it was opened
    /// from, or the last Save As target) fails closed if that file no longer
    /// carries this session's header: a file re-keyed by something else in
    /// the meantime, or decrypted in place, must not be overwritten under a
    /// key it no longer has.
    ///
    /// Any other path is Save As. It is written with this session's header,
    /// so the same password opens the copy — over an existing file too,
    /// because the user chose that target in a save dialog that asked — and
    /// from then on the session edits the copy, with the same check.
    pub fn write(&mut self, path: &str, plain: &[u8]) -> Result<LockedInfo, String> {
        if path == self.origin && std::path::Path::new(path).exists() {
            let current = read_capped(path)?;
            match parse_frame(&current) {
                Ok((_, header, _)) if same_header(&header, &self.header) => {}
                _ => return Err("changed_on_disk: that file changed on disk; open it again".into()),
            }
        }
        let body = seal(&self.dek, self.spec.aad, plain).map_err(|e| format!("crypto: {e:?}"))?;
        let header_json = serde_json::to_vec(&self.header).map_err(|e| format!("crypto: {e}"))?;
        atomic_write(path, &self.spec.frame(&header_json, &body))?;
        self.origin = path.to_string();
        Ok(LockedInfo { name: name_of(path), size: plain.len() as u64 })
    }

    /// The file this session writes back to: the one it was opened from, or
    /// the last Save As target.
    pub fn origin(&self) -> &str {
        &self.origin
    }
}

/// Whether two headers are the same vault: same salt, same wrapped key. The
/// wrapped DEK is what a re-key changes, so it is the comparison that matters.
fn same_header(a: &VaultHeader, b: &VaultHeader) -> bool {
    a.salt == b.salt && a.wrapped_dek == b.wrapped_dek && a.kdf == b.kdf
}

impl Locker {
    /// The password to use: the one passed in, or the remembered one.
    ///
    /// `None` means "use what is remembered", and the answer never leaves Rust —
    /// that is the point of asking here rather than letting the frontend fetch
    /// it and pass it back down.
    fn password_for(&self, given: Option<String>) -> Result<String, String> {
        match given {
            Some(p) if !p.is_empty() => Ok(p),
            _ => self
                .recall()
                .ok_or_else(|| "no_passphrase: no password was given and none is remembered".to_string()),
        }
    }

    /// Encrypt `path` in place.
    ///
    /// Argon2id at 64 MiB and three passes is most of a second of pure CPU. A
    /// shim that runs this on the UI thread stops the window repainting, so
    /// the dialog's own spinner freezes while the work it describes happens —
    /// mark the command `async`.
    ///
    /// Refuses a file that is already sealed, in any format. Double-sealing
    /// would need two passwords undone in the right order, which nobody ever
    /// means.
    pub fn lock_file(&self, path: &str, password: Option<String>) -> Result<LockedInfo, String> {
        let password = self.password_for(password)?;
        let plain = read_capped(path)?;
        if SPEC.is_current(&plain) || is_legacy(&plain) {
            return Err("already_locked: that file is already encrypted".into());
        }
        // A fresh salt and a fresh DEK for THIS file. Two files sealed under one
        // password share no key material, so opening one tells you nothing
        // about the other.
        let (header, dek) = create_vault_with_params(&password, KdfParams::default())
            .map_err(|e| format!("crypto: {e:?}"))?;
        let body = seal(&dek, AAD, &plain).map_err(|e| format!("crypto: {e:?}"))?;
        let header_json = serde_json::to_vec(&header).map_err(|e| format!("crypto: {e}"))?;

        atomic_write(path, &SPEC.frame(&header_json, &body))?;
        Ok(LockedInfo { name: name_of(path), size: plain.len() as u64 })
    }

    /// Decrypt in place.
    ///
    /// A wrong password fails when the wrapped DEK's tag does not verify —
    /// before `atomic_write` is reached, so the file on disk is provably
    /// untouched. The error says only "wrong password or corrupt file": telling
    /// those two apart would be telling an attacker which half they got right.
    pub fn unlock_file(&self, path: &str, password: Option<String>) -> Result<LockedInfo, String> {
        let password = self.password_for(password)?;
        let bytes = read_capped(path)?;
        // A file sealed by the platform, or by this app before 8/2026. Its salt
        // lived on the server's strongbox row, which is parked — so it cannot
        // be opened here at all, and saying which format it is beats "wrong
        // password".
        if !SPEC.is_current(&bytes) && is_legacy(&bytes) {
            return Err("legacy_format: that file was encrypted by the platform".into());
        }
        let (spec, header, body) = parse_frame(&bytes)?;
        let dek = gervasius::unlock(&header, &password)
            .map_err(|_| "wrong_password: wrong password or corrupt file".to_string())?;
        let plain = open(&dek, spec.aad, body)
            .map_err(|_| "wrong_password: wrong password or corrupt file".to_string())?;
        atomic_write(path, &plain)?;
        Ok(LockedInfo { name: name_of(path), size: plain.len() as u64 })
    }

    /// Change the passphrase of a sealed file: re-encrypt it, in place, under
    /// a NEW key.
    ///
    /// Not a re-wrap of the old key, although the two-tier frame would allow
    /// one: a new passphrase is most often wanted because the old one may be
    /// known to someone, and whoever knew it could have kept the key it
    /// unwrapped. So the file gets a fresh salt and a fresh DEK, exactly as if
    /// it had been encrypted for the first time — `create_vault_with_params`
    /// and `seal`, nothing new — and the plaintext exists only in memory
    /// between the open and the seal. The frame the file was in is kept, so
    /// an enigma-locked file stays one.
    ///
    /// `password` is the current passphrase (`None`: the remembered one);
    /// `new_password` must be given and must differ. A wrong current
    /// passphrase fails before anything is written. An open [`SealSession`]
    /// on the file is left with the old key and will refuse to write back
    /// (`changed_on_disk`), as for any re-key — its owner opens it again.
    pub fn rekey_file(&self, path: &str, password: Option<String>, new_password: String) -> Result<LockedInfo, String> {
        let password = self.password_for(password)?;
        if new_password.is_empty() {
            return Err("no_passphrase: a new passphrase is needed".into());
        }
        if new_password == password {
            return Err("same_passphrase: the new passphrase is the current one".into());
        }
        let bytes = read_capped(path)?;
        if !substrate::is_known_frame(&bytes) && is_legacy(&bytes) {
            return Err("legacy_format: that file was encrypted by the platform".into());
        }
        let (spec, header, body) = parse_frame(&bytes)?;
        let old = gervasius::unlock(&header, &password)
            .map_err(|_| "wrong_password: wrong password or corrupt file".to_string())?;
        let plain = open(&old, spec.aad, body)
            .map_err(|_| "wrong_password: wrong password or corrupt file".to_string())?;
        let (header, dek) = create_vault_with_params(&new_password, KdfParams::default())
            .map_err(|e| format!("crypto: {e:?}"))?;
        let body = seal(&dek, spec.aad, &plain).map_err(|e| format!("crypto: {e:?}"))?;
        let header_json = serde_json::to_vec(&header).map_err(|e| format!("crypto: {e}"))?;
        atomic_write(path, &spec.frame(&header_json, &body))?;
        Ok(LockedInfo { name: name_of(path), size: plain.len() as u64 })
    }

    /// Decrypt `path` into memory and keep its key for the edit.
    ///
    /// Nothing on disk changes. The plaintext goes to the caller; the session
    /// is what a later `write` needs, and it holds the DEK rather than the
    /// password — the password is checked here, once, and forgotten.
    pub fn open_sealed(&self, path: &str, password: Option<String>) -> Result<(SealSession, Vec<u8>), String> {
        let password = self.password_for(password)?;
        let bytes = read_capped(path)?;
        if !substrate::is_known_frame(&bytes) && is_legacy(&bytes) {
            return Err("legacy_format: that file was encrypted by the platform".into());
        }
        let (spec, header, body) = parse_frame(&bytes)?;
        let dek = gervasius::unlock(&header, &password)
            .map_err(|_| "wrong_password: wrong password or corrupt file".to_string())?;
        let plain = open(&dek, spec.aad, body)
            .map_err(|_| "wrong_password: wrong password or corrupt file".to_string())?;
        Ok((SealSession { spec, header, dek, origin: path.to_string() }, plain))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{serial, LOCKER};
    use substrate::is_sealed_file;

    fn tmp(name: &str, bytes: &[u8]) -> String {
        let path = std::env::temp_dir().join(format!("padova-lock-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// The whole point of the frame: seal, and open again with nothing but the
    /// password. No salt is passed in either direction.
    #[test]
    fn a_sealed_file_opens_with_only_the_password() {
        let path = tmp("roundtrip", b"some local bytes");
        LOCKER.lock_file(&path, Some("pw".into())).unwrap();

        let sealed = std::fs::read(&path).unwrap();
        assert!(SPEC.is_current(&sealed), "not this build's frame");
        assert!(is_sealed_file(&path), "substrate must recognise what padova wrote");
        assert_ne!(sealed, b"some local bytes", "the bytes must actually change");

        let info = LOCKER.unlock_file(&path, Some("pw".into())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"some local bytes");
        assert_eq!(info.size, "some local bytes".len() as u64);
        std::fs::remove_file(&path).ok();
    }

    /// Every seal draws its own salt and its own DEK, so two files sealed under
    /// one password share no key material and no ciphertext.
    #[test]
    fn two_files_under_one_password_share_no_key_material() {
        let a = tmp("uniq-a", b"identical");
        let b = tmp("uniq-b", b"identical");
        LOCKER.lock_file(&a, Some("pw".into())).unwrap();
        LOCKER.lock_file(&b, Some("pw".into())).unwrap();
        assert_ne!(std::fs::read(&a).unwrap(), std::fs::read(&b).unwrap());

        let (_, ha, _) = parse_frame(&std::fs::read(&a).unwrap()).unwrap();
        let (_, hb, _) = parse_frame(&std::fs::read(&b).unwrap()).unwrap();
        assert_ne!(ha.salt, hb.salt, "each file gets a fresh salt");
        assert_eq!(ha.salt.len(), 16);
        std::fs::remove_file(&a).ok();
        std::fs::remove_file(&b).ok();
    }

    /// The header travels in the file, so the file travels. A rename must not
    /// break it — which is why the AAD is a constant and never the name.
    #[test]
    fn a_sealed_file_survives_being_renamed() {
        let path = tmp("rename-from", b"portable");
        LOCKER.lock_file(&path, Some("pw".into())).unwrap();
        let moved = format!("{path}-moved");
        std::fs::rename(&path, &moved).unwrap();

        LOCKER.unlock_file(&moved, Some("pw".into())).unwrap();
        assert_eq!(std::fs::read(&moved).unwrap(), b"portable");
        std::fs::remove_file(&moved).ok();
    }

    /// Fail-closed. The wrapped DEK's tag rejects the password before
    /// `atomic_write` is reached, so the ciphertext on disk is byte-identical.
    #[test]
    fn a_wrong_password_leaves_the_file_untouched() {
        let path = tmp("wrongpw", b"precious");
        LOCKER.lock_file(&path, Some("right".into())).unwrap();
        let sealed = std::fs::read(&path).unwrap();

        let err = LOCKER.unlock_file(&path, Some("wrong".into())).unwrap_err();
        assert!(err.starts_with("wrong_password"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), sealed, "file must be untouched");
        std::fs::remove_file(&path).ok();
    }

    /// The remembered passphrase, reached the way the commands reach it —
    /// inside Rust. Nothing in this flow hands it to a caller.
    #[test]
    fn falls_back_to_the_remembered_passphrase() {
        let _serial = serial();
        let path = tmp("remembered", b"quiet");
        LOCKER.forget();
        // With nothing remembered and nothing given, it refuses rather than
        // sealing under an empty password.
        assert!(LOCKER.lock_file(&path, None).unwrap_err().starts_with("no_passphrase"));

        LOCKER.remember("hunter2").unwrap();
        LOCKER.lock_file(&path, None).unwrap();
        // …and the file it produced is an ordinary one: the same passphrase
        // opens it when typed, because the frame never knew where it came from.
        LOCKER.unlock_file(&path, Some("hunter2".into())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"quiet");

        LOCKER.forget();
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn refuses_to_seal_twice_or_open_plaintext() {
        let path = tmp("double", b"plain");
        assert!(LOCKER.unlock_file(&path, Some("x".into())).unwrap_err().starts_with("not_locked"));
        LOCKER.lock_file(&path, Some("pw".into())).unwrap();
        assert!(LOCKER.lock_file(&path, Some("pw".into())).unwrap_err().starts_with("already_locked"));
        std::fs::remove_file(&path).ok();
    }

    /// A file the platform sealed is still SEEN as sealed — the listing must
    /// never hand it to an editor as ciphertext — but it cannot be opened here,
    /// because its salt lived on a strongbox row that is parked. Saying which
    /// format it is beats reporting a wrong password.
    #[test]
    /// Only meaningful with `legacy-detect`: without it this build genuinely
    /// cannot recognise a Fernet file, which is the honest answer for one that
    /// could never open it either. The three zinnia apps opt the feature in.
    #[cfg(feature = "legacy-detect")]
    fn a_platform_sealed_file_is_seen_but_refused() {
        let fernet = tmp("legacy-fernet", b"gAAAAAxyz-not-really-a-token");
        assert!(is_sealed_file(&fernet), "must still be badged");
        let err = LOCKER.unlock_file(&fernet, Some("pw".into())).unwrap_err();
        assert!(err.starts_with("legacy_format"), "{err}");
        std::fs::remove_file(&fernet).ok();
    }

    // ── sessions: decrypt in memory, re-seal on save ─────────────────────

    /// The editing path: the disk is ciphertext before, during and after.
    #[test]
    fn a_session_edits_a_sealed_file_without_ever_writing_plaintext() {
        let path = tmp("session", b"classified");
        LOCKER.lock_file(&path, Some("pw".into())).unwrap();
        let sealed_before = std::fs::read(&path).unwrap();

        let (mut session, plain) = LOCKER.open_sealed(&path, Some("pw".into())).unwrap();
        assert_eq!(plain, b"classified");
        assert_eq!(std::fs::read(&path).unwrap(), sealed_before, "opening wrote nothing");

        session.write(&path, b"classified, edited").unwrap();
        let on_disk = std::fs::read(&path).unwrap();
        assert!(SPEC.is_current(&on_disk));
        assert!(!on_disk.windows(10).any(|w| w == b"classified"), "plaintext leaked into the frame");
        // The same password still opens it — the header travelled unchanged.
        let (_, again) = LOCKER.open_sealed(&path, Some("pw".into())).unwrap();
        assert_eq!(again, b"classified, edited");
        // …and a plain unlock recovers the edit, so nothing about the file is
        // session-specific.
        LOCKER.unlock_file(&path, Some("pw".into())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"classified, edited");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_session_fails_closed_on_a_wrong_password_or_a_damaged_file() {
        let path = tmp("session-wrong", b"secret");
        LOCKER.lock_file(&path, Some("right".into())).unwrap();
        let sealed = std::fs::read(&path).unwrap();
        let err = LOCKER.open_sealed(&path, Some("wrong".into())).unwrap_err();
        assert!(err.starts_with("wrong_password"), "{err}");

        let mut damaged = sealed.clone();
        let last = damaged.len() - 1;
        damaged[last] ^= 0x01;
        std::fs::write(&path, &damaged).unwrap();
        let err = LOCKER.open_sealed(&path, Some("right".into())).unwrap_err();
        assert!(err.starts_with("wrong_password"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), damaged, "nothing was written");

        let plain = tmp("session-plain", b"not sealed");
        let err = LOCKER.open_sealed(&plain, Some("x".into())).unwrap_err();
        assert!(err.starts_with("not_locked"), "{err}");
        std::fs::remove_file(&path).ok();
        std::fs::remove_file(&plain).ok();
    }

    /// The file was re-keyed (or decrypted) while an editor held it open. The
    /// session's key no longer belongs to that file, so the save refuses
    /// rather than clobbering the newer bytes under a stale key.
    #[test]
    fn a_session_refuses_to_write_over_a_file_that_changed_on_disk() {
        let path = tmp("session-changed", b"original");
        LOCKER.lock_file(&path, Some("one".into())).unwrap();
        let (mut session, _) = LOCKER.open_sealed(&path, Some("one".into())).unwrap();

        LOCKER.unlock_file(&path, Some("one".into())).unwrap();
        LOCKER.lock_file(&path, Some("two".into())).unwrap();
        let rekeyed = std::fs::read(&path).unwrap();
        let err = session.write(&path, b"edited").unwrap_err();
        assert!(err.starts_with("changed_on_disk"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), rekeyed);

        // Decrypted in place is a change too.
        LOCKER.unlock_file(&path, Some("two".into())).unwrap();
        let err = session.write(&path, b"edited").unwrap_err();
        assert!(err.starts_with("changed_on_disk"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), b"original");

        // A path that does not exist yet is Save As: written fresh, same key.
        let copy = format!("{path}-copy");
        session.write(&copy, b"a copy").unwrap();
        let (_, plain) = LOCKER.open_sealed(&copy, Some("one".into())).unwrap();
        assert_eq!(plain, b"a copy");
        // …and the session now edits the copy, checked like the original was:
        // re-keyed underneath, it is refused.
        LOCKER.unlock_file(&copy, Some("one".into())).unwrap();
        LOCKER.lock_file(&copy, Some("three".into())).unwrap();
        assert!(session.write(&copy, b"late").unwrap_err().starts_with("changed_on_disk"));
        LOCKER.unlock_file(&copy, Some("three".into())).unwrap();
        LOCKER.lock_file(&copy, Some("one".into())).unwrap();
        session.write(&format!("{path}-copy2"), b"x").unwrap();
        std::fs::remove_file(format!("{path}-copy2")).ok();
        // Save As over an EXISTING other file — plain or sealed under another
        // key — is the user's choice in the save dialog, and is written.
        let other = tmp("session-changed-other", b"some other file");
        session.write(&other, b"over it").unwrap();
        let (_, plain) = LOCKER.open_sealed(&other, Some("one".into())).unwrap();
        assert_eq!(plain, b"over it");
        std::fs::remove_file(&path).ok();
        std::fs::remove_file(&copy).ok();
        std::fs::remove_file(&other).ok();
    }

    /// A file enigma locked opens here with its password, and a session keeps
    /// it in enigma's frame — moving a file between the apps changes nothing.
    #[test]
    fn enigmas_frame_opens_and_stays_enigmas() {
        let spec = FrameSpec::ENIGMA;
        let (header, dek) = create_vault_with_params("pw", KdfParams::default()).unwrap();
        let body = seal(&dek, spec.aad, b"from enigma").unwrap();
        let path = tmp("enigma", &spec.frame(&serde_json::to_vec(&header).unwrap(), &body));

        let (mut session, plain) = LOCKER.open_sealed(&path, Some("pw".into())).unwrap();
        assert_eq!(plain, b"from enigma");
        session.write(&path, b"edited here").unwrap();
        let on_disk = std::fs::read(&path).unwrap();
        assert!(spec.is_current(&on_disk), "still ENIGLOCK");
        assert!(!SPEC.is_current(&on_disk));
        LOCKER.unlock_file(&path, Some("pw".into())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"edited here");
        std::fs::remove_file(&path).ok();
    }

    /// A new passphrase is a new key: the old passphrase stops opening the
    /// file, the new one opens the same bytes, and the frame keeps its kind.
    #[test]
    fn a_rekey_changes_the_passphrase_and_the_key_but_not_the_contents() {
        let path = tmp("rekey", b"the same words");
        LOCKER.lock_file(&path, Some("old".into())).unwrap();
        let before = std::fs::read(&path).unwrap();
        let (before_header, _) = parse_frame(&before).map(|(_, h, b)| (h, b.to_vec())).unwrap();

        let info = LOCKER.rekey_file(&path, Some("old".into()), "new".into()).unwrap();
        assert_eq!(info.size, 14);
        let after = std::fs::read(&path).unwrap();
        let (_, after_header, _) = parse_frame(&after).unwrap();
        assert!(!same_header(&before_header, &after_header), "a fresh vault, not the old one");
        assert_ne!(before_header.salt, after_header.salt);
        assert!(LOCKER.open_sealed(&path, Some("old".into())).unwrap_err().starts_with("wrong_password"));
        let (_, plain) = LOCKER.open_sealed(&path, Some("new".into())).unwrap();
        assert_eq!(plain, b"the same words");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn a_rekey_refuses_a_wrong_or_repeated_passphrase_and_leaves_the_file_alone() {
        let path = tmp("rekey-refused", b"keep me");
        LOCKER.lock_file(&path, Some("old".into())).unwrap();
        let sealed = std::fs::read(&path).unwrap();
        let wrong = LOCKER.rekey_file(&path, Some("guess".into()), "new".into()).unwrap_err();
        assert!(wrong.starts_with("wrong_password"), "{wrong}");
        let same = LOCKER.rekey_file(&path, Some("old".into()), "old".into()).unwrap_err();
        assert!(same.starts_with("same_passphrase"), "{same}");
        let empty = LOCKER.rekey_file(&path, Some("old".into()), String::new()).unwrap_err();
        assert!(empty.starts_with("no_passphrase"), "{empty}");
        assert_eq!(std::fs::read(&path).unwrap(), sealed, "untouched by every refusal");

        let plain = tmp("rekey-plain", b"not sealed");
        assert!(LOCKER.rekey_file(&plain, Some("old".into()), "new".into()).unwrap_err().starts_with("not_locked"));
        assert_eq!(std::fs::read(&plain).unwrap(), b"not sealed");
        std::fs::remove_file(&path).ok();
        std::fs::remove_file(&plain).ok();
    }

    #[test]
    fn a_rekey_keeps_enigmas_frame_and_strands_an_open_session() {
        let spec = FrameSpec::ENIGMA;
        let (header, dek) = create_vault_with_params("pw", KdfParams::default()).unwrap();
        let body = seal(&dek, spec.aad, b"from enigma").unwrap();
        let path = tmp("rekey-enigma", &spec.frame(&serde_json::to_vec(&header).unwrap(), &body));
        let (mut session, _) = LOCKER.open_sealed(&path, Some("pw".into())).unwrap();
        assert_eq!(session.origin(), path);

        LOCKER.rekey_file(&path, Some("pw".into()), "pw2".into()).unwrap();
        assert!(spec.is_current(&std::fs::read(&path).unwrap()), "still ENIGLOCK");
        // The session's key no longer opens the file: it must not write it.
        assert!(session.write(&path, b"stale").unwrap_err().starts_with("changed_on_disk"));
        let (_, plain) = LOCKER.open_sealed(&path, Some("pw2".into())).unwrap();
        assert_eq!(plain, b"from enigma");
        std::fs::remove_file(&path).ok();
    }

    /// Four bytes of length off a disk that may be truncated or hostile. An
    /// unchecked slice would panic the command instead of refusing the file.
    #[test]
    fn a_damaged_frame_is_refused_rather_than_panicking() {
        let path = tmp("truncated", b"x");
        LOCKER.lock_file(&path, Some("pw".into())).unwrap();
        let mut sealed = std::fs::read(&path).unwrap();
        sealed.truncate(substrate::PREFIX_LEN + 4);
        std::fs::write(&path, &sealed).unwrap();

        let err = LOCKER.unlock_file(&path, Some("pw".into())).unwrap_err();
        assert!(err.starts_with("crypto"), "{err}");
        std::fs::remove_file(&path).ok();
    }
}
