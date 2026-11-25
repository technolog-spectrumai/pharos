//! The phones allowed to find Beacon when `restricted_discovery` is on (8.A3):
//! one `<name>.auth` file each in `<data>/clients`, holding the phone's discovery
//! key (`descriptor:x25519:<base32>`). arti watches the folder, so `allow` and
//! `deny` take effect without a restart (after the descriptor is republished).

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

const PREFIX: &str = "descriptor:x25519:";

fn check_name(name: &str) -> Result<()> {
    let ok = !name.is_empty() && name.len() <= 32 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !ok {
        bail!("a name is 1–32 letters, digits, - or _");
    }
    Ok(())
}

fn check_key(key: &str) -> Result<()> {
    let b32 = key.strip_prefix(PREFIX).context("a phone's key starts with descriptor:x25519:")?;
    // 32 bytes of X25519 in unpadded base32.
    if b32.len() != 52 || !b32.bytes().all(|b| b.is_ascii_alphabetic() || (b'2'..=b'7').contains(&b)) {
        bail!("that key is not 52 base32 characters");
    }
    Ok(())
}

/// The folder, made private (arti refuses one others can write to).
pub fn prepare(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn file(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.auth"))
}

pub fn allow(dir: &Path, name: &str, key: &str) -> Result<()> {
    check_name(name)?;
    let key = key.trim();
    check_key(key)?;
    prepare(dir)?;
    std::fs::write(file(dir, name), format!("{key}\n")).context("writing the key")?;
    Ok(())
}

pub fn deny(dir: &Path, name: &str) -> Result<()> {
    check_name(name)?;
    std::fs::remove_file(file(dir, name)).with_context(|| format!("{name} is not on the list"))
}

pub fn list(dir: &Path) -> Result<Vec<String>> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Ok(vec![]) };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok()?.file_name().into_string().ok()?.strip_suffix(".auth").map(str::to_string))
        .collect();
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "descriptor:x25519:ZDUVQQ7IKBP6SO6X5HW6IT2BXHS4W5QQJ6E6HD3HNP3R2KRDKXGA";

    #[test]
    fn allow_list_deny() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("clients");
        allow(&dir, "anna-phone", KEY).unwrap();
        assert_eq!(list(&dir).unwrap(), vec!["anna-phone"]);
        assert_eq!(std::fs::read_to_string(dir.join("anna-phone.auth")).unwrap().trim(), KEY);
        deny(&dir, "anna-phone").unwrap();
        assert!(list(&dir).unwrap().is_empty());
        assert!(deny(&dir, "anna-phone").is_err());
    }

    #[test]
    fn refuses_bad_names_and_keys() {
        let d = tempfile::tempdir().unwrap();
        assert!(allow(d.path(), "../x", KEY).is_err());
        assert!(allow(d.path(), "a", "x25519:abc").is_err());
        assert!(allow(d.path(), "a", "descriptor:x25519:short").is_err());
    }
}
