//! `config.yaml`. Every field has a default, so an empty file is a valid config.

use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
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
    pub limits: Limits,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    /// Largest sealed message accepted into a mailbox, bytes.
    pub max_message_bytes: usize,
    /// Messages kept per mailbox; a full mailbox refuses more until fetched.
    pub max_messages_per_mailbox: u32,
    pub max_mailboxes: u32,
    /// A message nobody fetched is dropped after this many days.
    pub message_ttl_days: u64,
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
            max_message_bytes: 40 * 1024,
            max_messages_per_mailbox: 500,
            max_mailboxes: 10_000,
            message_ttl_days: 14,
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
            data_dir: PathBuf::from("/var/lib/proteus"),
            master_key: PathBuf::from("/etc/proteus/master.key"),
            name: "Proteus".into(),
            page: true,
            limits: Limits::default(),
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
        assert_eq!(c.limits.max_messages_per_mailbox, 500);
        assert_eq!((c.name.as_str(), c.page), ("Proteus", true));
        std::fs::write(&p, "data_dir: /srv/p\nlimits:\n  message_ttl_days: 3\n").unwrap();
        let c = Config::load(&p).unwrap();
        assert_eq!(c.data_dir, PathBuf::from("/srv/p"));
        assert_eq!(c.limits.message_ttl_days, 3);
        assert_eq!(c.limits.max_record_bytes, 2048);
        std::fs::write(&p, "data_dri: /x\n").unwrap();
        assert!(Config::load(&p).is_err());
    }
}
