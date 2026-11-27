//! Stage b2: what the relay keeps for client devices, in `relay.sqlite` beside the
//! mailbox store. The store itself is shared (`beacon_node::sqlite_queue`, also used by
//! the app's in-process Beacon); here it is keyed by the Beacon's master key.

use crate::masterkey::MasterKey;
pub use beacon_node::sqlite_queue::SqliteQueue;

impl beacon_node::sqlite_queue::QueueKey for MasterKey {
    fn seal(&self, label: &str, plaintext: &[u8]) -> Vec<u8> {
        MasterKey::seal(self, label, plaintext)
    }
    fn open(&self, label: &str, sealed: &[u8]) -> anyhow::Result<Vec<u8>> {
        MasterKey::open(self, label, sealed)
    }
    fn hash(&self, kind: &str, value: &[u8]) -> [u8; 32] {
        MasterKey::hash(self, kind, value)
    }
}
