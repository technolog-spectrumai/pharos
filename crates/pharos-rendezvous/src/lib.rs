//! D2: everything two friends need to find each other is derived from the
//! secret they set up when they paired, so nothing has to be published.
//!
//! - Each friend hosts a **rendezvous onion** that changes every week
//!   ([`WEEK_SECS`]); its key is HKDF(secret, "onion" ‖ host ‖ week). The
//!   other friend derives the same key's public half and dials it. An observer
//!   who sees one week's onion cannot link it to the next.
//! - With Proteus (M3), each friend has a **mailbox** there whose id and
//!   access token come from the same secret, so either friend can find it and
//!   Proteus learns only a random-looking id.
//! - The **directory** record (D5) a friend leaves on Proteus is sealed with
//!   a key from the secret and filed under a weekly id.
//!
//! All derivations are HKDF-SHA256 with the salt [`SALT`] and a distinct info
//! string, so no two outputs are related. The test vectors at the bottom pin
//! them; another implementation must produce the same bytes.

use hkdf::Hkdf;
use sha2::{Digest, Sha256, Sha512};
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const SALT: &[u8] = b"pharos/rendezvous/v1";
pub const WEEK_SECS: u64 = 7 * 24 * 3600;

/// A device fingerprint: the first 16 bytes of SHA-256 over its public key.
pub type Fingerprint = [u8; 16];

pub fn fingerprint(device_public_key: &[u8; 32]) -> Fingerprint {
    let h = Sha256::digest(device_public_key);
    h[..16].try_into().unwrap()
}

/// The secret a friendship is built on (from the MLS group's exporter at pairing).
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct FriendshipSecret([u8; 32]);

impl FriendshipSecret {
    pub fn from_bytes(b: [u8; 32]) -> Self {
        FriendshipSecret(b)
    }
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    fn derive<const N: usize>(&self, parts: &[&[u8]]) -> [u8; N] {
        let hk = Hkdf::<Sha256>::new(Some(SALT), &self.0);
        let info: Vec<u8> = parts.concat();
        let mut out = [0u8; N];
        hk.expand(&info, &mut out).expect("N is a valid HKDF length");
        out
    }

    /// The onion `host` runs for `week`.
    pub fn rendezvous(&self, host: &Fingerprint, week: u64) -> RendezvousKey {
        let seed: [u8; 32] = self.derive(&[b"onion", host, &week.to_be_bytes()]);
        RendezvousKey::from_seed(seed, week)
    }

    /// What `me` dials to reach `friend` at `now`: this week's onion, then last
    /// week's (a friend whose clock is behind, or who has not restarted since
    /// Monday), then next week's (a friend whose clock is ahead).
    pub fn dial_candidates(&self, friend: &Fingerprint, now_secs: u64) -> Vec<String> {
        let w = week_of(now_secs);
        let mut out = vec![self.rendezvous(friend, w).onion_address()];
        if w > 0 {
            out.push(self.rendezvous(friend, w - 1).onion_address());
        }
        out.push(self.rendezvous(friend, w + 1).onion_address());
        out
    }

    /// The id of `owner`'s mailbox on Proteus (stable for the friendship's life).
    pub fn mailbox_id(&self, owner: &Fingerprint) -> [u8; 32] {
        self.derive(&[b"mailbox-id", owner])
    }

    /// The token that lets either friend put into and take from `owner`'s mailbox.
    /// Proteus stores only its hash.
    pub fn mailbox_token(&self, owner: &Fingerprint) -> [u8; 32] {
        self.derive(&[b"mailbox-token", owner])
    }

    /// Where `owner` files its directory record for `week`.
    pub fn directory_id(&self, owner: &Fingerprint, week: u64) -> [u8; 32] {
        self.derive(&[b"directory-id", owner, &week.to_be_bytes()])
    }

    /// The key `owner`'s directory record is sealed with (XChaCha20-Poly1305).
    pub fn directory_key(&self, owner: &Fingerprint) -> [u8; 32] {
        self.derive(&[b"directory-key", owner])
    }

    /// The write token for `owner`'s directory record; only `owner` uses it.
    pub fn directory_token(&self, owner: &Fingerprint) -> [u8; 32] {
        self.derive(&[b"directory-token", owner])
    }
}

pub fn week_of(unix_secs: u64) -> u64 {
    unix_secs / WEEK_SECS
}

/// A rendezvous onion's key: the ed25519 seed and the Tor-expanded secret.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct RendezvousKey {
    seed: [u8; 32],
    #[zeroize(skip)]
    pub week: u64,
}

impl RendezvousKey {
    fn from_seed(seed: [u8; 32], week: u64) -> Self {
        RendezvousKey { seed, week }
    }

    pub fn public_key(&self) -> [u8; 32] {
        ed25519_dalek::SigningKey::from_bytes(&self.seed).verifying_key().to_bytes()
    }

    /// The 64-byte expanded secret (clamped scalar ‖ nonce prefix) Tor's
    /// keystore takes for an onion identity key.
    pub fn expanded_secret(&self) -> [u8; 64] {
        let h = Sha512::digest(self.seed);
        let mut out: [u8; 64] = h.into();
        out[0] &= 248;
        out[31] &= 63;
        out[31] |= 64;
        out
    }

    pub fn onion_address(&self) -> String {
        onion_address(&self.public_key())
    }
}

/// A Tor v3 onion address: base32(pubkey ‖ checksum[..2] ‖ 0x03) + ".onion".
pub fn onion_address(public_key: &[u8; 32]) -> String {
    use sha3::Sha3_256;
    let mut h = Sha3_256::new();
    h.update(b".onion checksum");
    h.update(public_key);
    h.update([3u8]);
    let sum = h.finalize();
    let mut raw = Vec::with_capacity(35);
    raw.extend_from_slice(public_key);
    raw.extend_from_slice(&sum[..2]);
    raw.push(3);
    format!("{}.onion", data_encoding::BASE32_NOPAD.encode(&raw).to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret() -> FriendshipSecret {
        FriendshipSecret::from_bytes([0x42; 32])
    }
    const ALICE: Fingerprint = [0xa1; 16];
    const BOB: Fingerprint = [0xb0; 16];

    #[test]
    fn onion_address_matches_tors_format() {
        // 56 base32 characters; version byte 3 makes the last one 'd'.
        let a = onion_address(&[0u8; 32]);
        assert_eq!(a.len(), 56 + 6);
        assert!(a.starts_with("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(a.ends_with("d.onion"), "{a}");
        // pharos-tor checks the same address against arti's own HsId.
    }

    #[test]
    fn each_friend_each_week_gets_its_own_onion() {
        let s = secret();
        let a0 = s.rendezvous(&ALICE, 100).onion_address();
        assert_eq!(a0, s.rendezvous(&ALICE, 100).onion_address(), "deterministic");
        assert_ne!(a0, s.rendezvous(&ALICE, 101).onion_address());
        assert_ne!(a0, s.rendezvous(&BOB, 100).onion_address());
        let other = FriendshipSecret::from_bytes([0x43; 32]);
        assert_ne!(a0, other.rendezvous(&ALICE, 100).onion_address());
    }

    #[test]
    fn dial_candidates_cover_clock_skew() {
        let s = secret();
        let now = 100 * WEEK_SECS + 10;
        let c = s.dial_candidates(&BOB, now);
        assert_eq!(c[0], s.rendezvous(&BOB, 100).onion_address());
        assert_eq!(c[1], s.rendezvous(&BOB, 99).onion_address());
        assert_eq!(c[2], s.rendezvous(&BOB, 101).onion_address());
        assert_eq!(s.dial_candidates(&BOB, 5).len(), 2);
    }

    #[test]
    fn expanded_secret_is_a_clamped_scalar_for_the_same_public_key() {
        let k = secret().rendezvous(&ALICE, 7);
        let x = k.expanded_secret();
        assert_eq!(x[0] & 7, 0);
        assert_eq!(x[31] & 0xc0, 0x40);
        // The clamped scalar times the base point is the public key.
        let mut scalar = [0u8; 32];
        scalar.copy_from_slice(&x[..32]);
        let pk = curve(&scalar);
        assert_eq!(pk, k.public_key());
    }

    fn curve(scalar: &[u8; 32]) -> [u8; 32] {
        // ed25519_dalek exposes the expanded form through hazmat.
        let esk = ed25519_dalek::hazmat::ExpandedSecretKey::from_bytes(&{
            let mut b = [0u8; 64];
            b[..32].copy_from_slice(scalar);
            b
        });
        ed25519_dalek::VerifyingKey::from(&esk).to_bytes()
    }

    #[test]
    fn all_outputs_are_distinct() {
        let s = secret();
        let outs = [
            s.mailbox_id(&ALICE), s.mailbox_token(&ALICE), s.mailbox_id(&BOB),
            s.directory_id(&ALICE, 1), s.directory_id(&ALICE, 2),
            s.directory_key(&ALICE), s.directory_token(&ALICE),
        ];
        for i in 0..outs.len() {
            for j in i + 1..outs.len() {
                assert_ne!(outs[i], outs[j], "{i} vs {j}");
            }
        }
    }

    /// Pinned values: change only with a new SALT (a new protocol version).
    #[test]
    fn test_vectors() {
        let s = secret();
        let v = [
            hex::encode(s.mailbox_id(&ALICE)),
            hex::encode(s.mailbox_token(&ALICE)),
            hex::encode(s.directory_id(&ALICE, 2900)),
            hex::encode(s.directory_key(&ALICE)),
            s.rendezvous(&ALICE, 2900).onion_address(),
            hex::encode(fingerprint(&[1u8; 32])),
        ];
        let expected: [&str; 6] = VECTORS;
        for (got, want) in v.iter().zip(expected) {
            assert_eq!(got, want);
        }
    }

    const VECTORS: [&str; 6] = [
        "b781ea71fa680c632b2e44bd7064df68708bc2f4eabf83b6c25714c014336510",
        "03d4e24caffad22558459ce05fe0c1b39aed3c622871ac59a542c6e34b44b6bb",
        "291191eca9e6be24495ae3d233d940a9084cbe0b1492eb61ac88352a56eb9d02",
        "42cdb423561d9d0500dd4c195af3f2a7773627e0ac8320b5e8452e366840b887",
        "kpggurkfahwconbkrkmtfri7eimi7m3l4vci2eko6vxlw6ibarpbzsqd.onion",
        "72cd6e8422c407fb6d098690f1130b7d",
    ];
}
