//! `config.yaml`. Every field has a default, so an empty file is a valid config.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Database, arti's state and cache.
    pub data_dir: PathBuf,
    /// The at-rest key (3.7). Beside the config by default, not in the data folder.
    pub master_key: PathBuf,
    /// What its page and its code call it (1 to 64 characters).
    pub name: String,
    /// Serve the page with the code for Enigma at `/` on the onion (3.8).
    pub page: bool,
    /// Restricted discovery (Tor client authorisation, 8.A3): only phones whose
    /// key was added with `beacon allow` can find the onion. Off by default.
    /// It keeps strangers and floods away; mailbox tokens still guard each
    /// mailbox. Phones without a key simply stay on the mesh.
    pub restricted_discovery: bool,
    pub limits: Limits,
    /// Stage b2: serve client links and the Beacon mesh on the same onion.
    pub relay: RelayLimits,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct RelayLimits {
    /// Serve client links and mesh with other Beacons (on by default).
    pub enabled: bool,
    /// Devices attached at once.
    pub max_clients: usize,
    /// Frames kept per (device, room) while the device is away.
    pub max_queue_frames: usize,
    /// Bytes kept per (device, room).
    pub max_queue_bytes: usize,
    /// A kept frame is dropped after this many days.
    pub queue_ttl_days: u64,
}

impl Default for RelayLimits {
    fn default() -> Self {
        RelayLimits { enabled: true, max_clients: 1024, max_queue_frames: 2000, max_queue_bytes: 32 * 1024 * 1024, queue_ttl_days: 14 }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    /// Largest sealed message accepted into a mailbox, bytes.
    pub max_message_bytes: usize,
    /// Messages kept per mailbox; a full mailbox refuses more until fetched.
    pub max_messages_per_mailbox: u32,
    /// Bytes kept per mailbox, across its messages (images make some large).
    pub max_mailbox_bytes: usize,
    pub max_mailboxes: u32,
    /// A message nobody fetched is dropped after this many days.
    pub message_ttl_days: u64,
    /// A new message is handed out after a random 0..=this many seconds (8.D3).
    pub release_delay_secs: u64,
    pub max_record_bytes: usize,
    pub record_ttl_days: u64,
    pub max_pairing_bytes: usize,
    pub pairing_ttl_days: u64,
    /// Requests per minute per mailbox / record / pairing token.
    pub requests_per_minute: u32,
    /// Requests handled at once, across everyone.
    pub max_concurrent: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            // A sealed image (192 KiB, padded, MLS) fits; a text is far smaller.
            max_message_bytes: 256 * 1024,
            max_messages_per_mailbox: 2000,
            max_mailbox_bytes: 32 * 1024 * 1024,
            max_mailboxes: 10_000,
            message_ttl_days: 14,
            release_delay_secs: 10,
            max_record_bytes: 2048,
            record_ttl_days: 15,
            max_pairing_bytes: 48 * 1024,
            pairing_ttl_days: 7,
            requests_per_minute: 60,
            max_concurrent: 32,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            data_dir: PathBuf::from("/var/lib/beacon"),
            master_key: PathBuf::from("/etc/beacon/master.key"),
            name: "Beacon".into(),
            page: true,
            restricted_discovery: false,
            limits: Limits::default(),
            relay: RelayLimits::default(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))?;
        if text.trim().is_empty() {
            return Ok(Config::default());
        }
        serde_norway::from_str(&text).map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_partial_configs_take_defaults_and_typos_are_refused() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("c.yaml");
        std::fs::write(&p, "").unwrap();
        let c = Config::load(&p).unwrap();
        assert_eq!(c.limits.max_messages_per_mailbox, 2000);
        assert!(!c.restricted_discovery, "only my phones is off by default");
        assert_eq!(c.limits.release_delay_secs, 10);
        assert_eq!((c.name.as_str(), c.page), ("Beacon", true));
        std::fs::write(&p, "data_dir: /srv/p\nlimits:\n  message_ttl_days: 3\n").unwrap();
        let c = Config::load(&p).unwrap();
        assert_eq!(c.data_dir, PathBuf::from("/srv/p"));
        assert_eq!(c.limits.message_ttl_days, 3);
        assert_eq!(c.limits.max_record_bytes, 2048);
        std::fs::write(&p, "data_dri: /x\n").unwrap();
        assert!(Config::load(&p).is_err());
    }
}

impl Config {
    /// Writes the config as YAML (every field, so the file shows what is in force).
    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        let text = serde_norway::to_string(self)?;
        let tmp = path.with_extension("yaml.tmp");
        std::fs::write(&tmp, format!("# Beacon config (written by pharos-lighthouse; `beacon` reads it too)\n{text}"))?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Where the allowed phones' keys live, one `<name>.auth` each.
    pub fn clients_dir(&self) -> PathBuf {
        self.data_dir.join("clients")
    }
}
