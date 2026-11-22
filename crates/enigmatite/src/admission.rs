//! Admission by a certified roster (Teutates' rule, an option of rakotis' engine): a key
//! package carries a proof signed by the newcomer's device key; a member checks the key belongs
//! to someone the roster certifies, and that the MLS identity is that key's.

use ed25519_dalek::{Signer as _, Verifier as _};
use serde_json::{json, Value};

/// What a device's key signs in a key package's proof (domain separation; the tag predates the
/// move, so proofs made by older Teutates builds still check).
const KP_TAG: &[u8] = b"teutates-chat/key-package/1";

/// A device's MLS identity: `<user>#dev-<8 base32 of its device key>`, the leaf form rakotis
/// groups by user (`userPartOf`), so every device of a member reads as that member.
#[must_use]
pub fn identity(user: &str, device_key: &[u8; 32]) -> String {
    let mut s = data_encoding::BASE32_NOPAD.encode(device_key);
    s.make_ascii_lowercase();
    format!("{user}#dev-{}", &s[..8])
}

/// The member a leaf identity belongs to (rakotis `userPartOf`).
#[must_use]
pub fn user_of(id: &str) -> &str {
    match id.rsplit_once("#dev-") {
        Some((user, dev)) if dev.len() == 8 && dev.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)) => user,
        _ => id,
    }
}

/// The proof a key package carries: the device key that signs it (hex) and its signature.
#[must_use]
pub fn kp_proof(seed: &[u8; 32], kp: &[u8]) -> Value {
    let key = ed25519_dalek::SigningKey::from_bytes(seed);
    let sig = key.sign(&[KP_TAG, blake3::hash(kp).as_bytes()].concat());
    json!({ "key": hex::encode(key.verifying_key().to_bytes()), "sig": hex::encode(sig.to_bytes()) })
}

/// The device key a key package's proof shows (hex), when its signature holds.
#[must_use]
pub fn check_kp_proof(proof: &Value, kp: &[u8]) -> Option<String> {
    let key_hex = proof["key"].as_str()?;
    let key: [u8; 32] = hex::decode(key_hex).ok()?.try_into().ok()?;
    let sig: [u8; 64] = hex::decode(proof["sig"].as_str()?).ok()?.try_into().ok()?;
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&key).ok()?;
    vk.verify(&[KP_TAG, blake3::hash(kp).as_bytes()].concat(), &ed25519_dalek::Signature::from_bytes(&sig)).ok()?;
    Some(key_hex.to_string())
}

/// Whether a key-package frame (`{"device_id","key_package","teutates":proof}`) comes from a
/// device of `user` whose key is one of `keys` (hex): the proof holds and the identity is the
/// key's.
#[must_use]
pub fn admits(frame: &Value, keys: &[String]) -> bool {
    let Some(from) = frame["device_id"].as_str() else { return false };
    let Some(kp) = frame["key_package"].as_str().or(frame["package"].as_str()).and_then(|s| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.decode(s).ok()
    }) else {
        return false;
    };
    let Some(key) = check_kp_proof(&frame["teutates"], &kp) else { return false };
    let Ok(raw) = hex::decode(&key) else { return false };
    let Ok(raw) = <[u8; 32]>::try_from(raw.as_slice()) else { return false };
    keys.contains(&key) && identity(user_of(from), &raw) == from
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn identities_group_by_member() {
        let id = identity("did:heliodor:abc", &[7; 32]);
        assert!(id.starts_with("did:heliodor:abc#dev-"));
        assert_eq!(user_of(&id), "did:heliodor:abc");
        assert_eq!(user_of("bob"), "bob");
    }

    #[test]
    fn a_proof_holds_for_its_key_package_and_device_only() {
        let p = kp_proof(&[3; 32], b"kp");
        assert!(check_kp_proof(&p, b"kp").is_some());
        assert!(check_kp_proof(&p, b"other").is_none());
        let pk = ed25519_dalek::SigningKey::from_bytes(&[3; 32]).verifying_key().to_bytes();
        let me = identity("did:x", &pk);
        let kb = base64::engine::general_purpose::STANDARD.encode(b"kp");
        let f = json!({ "device_id": me, "key_package": kb, "teutates": p });
        assert!(admits(&f, &[hex::encode(pk)]));
        assert!(!admits(&f, &["00".repeat(32)]));
        let other = json!({ "device_id": identity("did:y", &pk), "key_package": kb, "teutates": f["teutates"] });
        assert!(admits(&other, &[hex::encode(pk)]), "the key decides; the roster maps keys to members");
        let forged = json!({ "device_id": identity("did:x", &[9; 32]), "key_package": kb, "teutates": f["teutates"] });
        assert!(!admits(&forged, &[hex::encode(pk)]));
    }
}
