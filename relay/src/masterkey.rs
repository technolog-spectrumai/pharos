//! 3.7, as in Zirkelite: one master key seals everything Relay stores.
//!
//! `master.key` holds 32 random bytes (hex). It must be mode 0600 — a key
//! that group or others can read is refused. Two sub-keys come from it with
//! BLAKE3's key derivation: one seals values (XChaCha20-Poly1305 with a label
//! naming the table and row, so a value moved to another row does not open),
//! one hashes ids and tokens (keyed BLAKE3), so the database holds neither.

use anyhow::{anyhow, bail, Context, Result};
use pharos_seal::{open_labelled, seal_labelled};
use rand_core::{OsRng, RngCore};
use std::path::Path;
use zeroize::Zeroizing;

pub struct MasterKey {
    seal: Zeroizing<[u8; 32]>,
    hash: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(…)")
    }
}

impl MasterKey {
    pub fn from_bytes(master: &[u8; 32]) -> Self {
        MasterKey {
            // These labels keep the server's former name (Proteus): they derive
            // the keys existing data is sealed with, so they never change.
            seal: Zeroizing::new(blake3::derive_key("proteus 2026 at-rest seal v1", master)),
            hash: Zeroizing::new(blake3::derive_key("proteus 2026 id and token hash v1", master)),
        }
    }

    /// Write a new key; refuses to overwrite one.
    pub fn create(path: &Path) -> Result<()> {
        if path.exists() {
            bail!("{} already exists; refusing to overwrite a master key", path.display());
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut k = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(&mut *k);
        let text = Zeroizing::new(data_encoding::HEXLOWER.encode(&*k) + "\n");
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        opts.open(path)?.write_all(text.as_bytes())?;
        Ok(())
    }

    pub fn load(path: &Path) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).with_context(|| format!("{}", path.display()))?.permissions().mode();
            if mode & 0o077 != 0 {
                bail!(
                    "{} is readable by group or others (mode {:o}); run: chmod 600 {}",
                    path.display(),
                    mode & 0o777,
                    path.display()
                );
            }
        }
        let text = Zeroizing::new(std::fs::read_to_string(path)?);
        let bytes = Zeroizing::new(
            data_encoding::HEXLOWER_PERMISSIVE
                .decode(text.trim().as_bytes())
                .map_err(|_| anyhow!("{} is not a hex key", path.display()))?,
        );
        let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| anyhow!("{} must hold 32 bytes", path.display()))?;
        Ok(Self::from_bytes(&arr))
    }

    pub fn seal(&self, label: &str, plaintext: &[u8]) -> Vec<u8> {
        seal_labelled(&self.seal, label.as_bytes(), plaintext)
    }

    pub fn open(&self, label: &str, sealed: &[u8]) -> Result<Vec<u8>> {
        open_labelled(&self.seal, label.as_bytes(), sealed).map_err(|_| anyhow!("a stored value under {label} did not open"))
    }

    /// The keyed hash a client id or token is stored under.
    pub fn hash(&self, kind: &str, value: &[u8]) -> [u8; 32] {
        let mut h = blake3::Hasher::new_keyed(&self.hash);
        h.update(kind.as_bytes());
        h.update(&[0]);
        h.update(value);
        *h.finalize().as_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_load_and_refuse_loose_permissions() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("k/master.key");
        MasterKey::create(&p).unwrap();
        assert!(MasterKey::create(&p).is_err(), "never overwrites");
        let k = MasterKey::load(&p).unwrap();
        let s = k.seal("message/1", b"x");
        assert_eq!(MasterKey::load(&p).unwrap().open("message/1", &s).unwrap(), b"x");
        assert!(k.open("message/2", &s).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o640)).unwrap();
            assert!(MasterKey::load(&p).unwrap_err().to_string().contains("chmod 600"));
        }
    }

    #[test]
    fn hashes_depend_on_the_key_and_the_kind() {
        let a = MasterKey::from_bytes(&[1; 32]);
        let b = MasterKey::from_bytes(&[2; 32]);
        assert_ne!(a.hash("mailbox", b"id"), b.hash("mailbox", b"id"));
        assert_ne!(a.hash("mailbox", b"id"), a.hash("record", b"id"));
        assert_eq!(a.hash("mailbox", b"id"), a.hash("mailbox", b"id"));
    }
}
