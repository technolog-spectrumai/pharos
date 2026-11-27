//! Invitations through Beacon (8.C4): when the inviter's phone is offline, the
//! redemption waits at the room's Beacon instead of failing.
//!
//! ```text
//! redeemer → Beacon  : seal(request) into mailbox R      (R from the capability)
//! inviter  ← Beacon  : polls R while the invitation is open, runs the same
//!                      checks as a live redemption (`invite_redeem::decide`)
//! inviter  → Beacon  : seal(reply) into mailbox A(node)  (A from capability + redeemer)
//! redeemer ← Beacon  : polls A until the answer is there
//! ```
//!
//! Only holders of the ticket know the capability, so only they can find the
//! mailboxes or open what is in them; Beacon stores hashes of the ids and tokens
//! and sealed blobs. The live exchange's fresh challenge cannot happen without
//! both phones online, so the redeemer picks the challenge. A captured request
//! replayed later still admits only the same device (its key package and
//! signature), and an invitation is spent after one admission.

use crate::beacon;
use crate::invite_redeem::{self, hex, unhex, RedeemGrant, RedeemState, ReplyFrame, RequestFrame, REDEEM_VERSION};
use crate::invite_ticket::{InviteBody, CAPABILITY_LEN, INVITE_ID_LEN};
use crate::invites::{self, EffectiveState};
use crate::mesh::MeshState;
use chacha20poly1305::aead::rand_core::{OsRng, RngCore};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// How long a redeemer waits at Beacon for the inviter's phone.
const WAIT: Duration = Duration::from_secs(30 * 60);
const REDEEMER_POLL: Duration = Duration::from_secs(20);
const INVITER_POLL: Duration = Duration::from_secs(45);

pub fn is_onion(s: &str) -> bool {
    s.strip_suffix(".onion").is_some_and(|h| h.len() == 56 && h.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)))
}

fn material(capability: &[u8; CAPABILITY_LEN], invite_id: &[u8; INVITE_ID_LEN], extra: &str) -> Vec<u8> {
    let mut m = Vec::with_capacity(CAPABILITY_LEN + INVITE_ID_LEN + extra.len());
    m.extend_from_slice(capability);
    m.extend_from_slice(invite_id);
    m.extend_from_slice(extra.as_bytes());
    m
}

/// A mailbox's id and token for `which` ("request", or "reply" with the redeemer's id).
pub(crate) fn mailbox(capability: &[u8; CAPABILITY_LEN], invite_id: &[u8; INVITE_ID_LEN], which: &str, node: &str) -> (String, String) {
    let m = material(capability, invite_id, node);
    let id = blake3::derive_key(&format!("enigma27 invite drop {which} id"), &m);
    let token = blake3::derive_key(&format!("enigma27 invite drop {which} token"), &m);
    (hex(&id), hex(&token))
}

fn cipher(capability: &[u8; CAPABILITY_LEN], invite_id: &[u8; INVITE_ID_LEN]) -> XChaCha20Poly1305 {
    let key = blake3::derive_key("enigma27 invite drop key", &material(capability, invite_id, ""));
    XChaCha20Poly1305::new((&key).into())
}

pub(crate) fn seal(capability: &[u8; CAPABILITY_LEN], invite_id: &[u8; INVITE_ID_LEN], which: &str, plain: &[u8]) -> String {
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = cipher(capability, invite_id)
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad: which.as_bytes() })
        .expect("encryption does not fail");
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    data_encoding::BASE64.encode(&out)
}

pub(crate) fn open(capability: &[u8; CAPABILITY_LEN], invite_id: &[u8; INVITE_ID_LEN], which: &str, text: &str) -> Option<Vec<u8>> {
    let raw = data_encoding::BASE64.decode(text.trim().as_bytes()).ok()?;
    if raw.len() < 24 + 16 {
        return None;
    }
    cipher(capability, invite_id)
        .decrypt(XNonce::from_slice(&raw[..24]), Payload { msg: &raw[24..], aad: which.as_bytes() })
        .ok()
}

/// What the redeemer leaves: the live exchange's request plus the challenge it chose.
#[derive(Serialize, Deserialize)]
struct DropRequest {
    challenge: String,
    req: RequestFrame,
}

// ── redeemer ────────────────────────────────────────────────────────────────

pub async fn redeem_via_beacon(
    app: &AppHandle,
    mesh: &MeshState,
    beacon_onion: &str,
    body: &InviteBody,
    key_package: String,
    name: String,
) -> Result<RedeemGrant, String> {
    let secret = crate::device::load_or_create(app).map_err(|e| e.to_string())?;
    let node_id = crate::device::id_of(&secret);
    let mut challenge = [0u8; 32];
    OsRng.fill_bytes(&mut challenge);
    let proof = invites::expected_proof(&body.capability, &body.invite_id, &challenge, &node_id);
    let req = DropRequest {
        challenge: hex(&challenge),
        req: RequestFrame {
            v: REDEEM_VERSION,
            invite_id: hex(&body.invite_id),
            node_id: node_id.clone(),
            sig: hex(&crate::device::sign(&secret, &challenge)),
            proof: hex(&proof),
            key_package,
            name,
        },
    };
    let plain = serde_json::to_vec(&req).map_err(|e| e.to_string())?;
    let (rid, rtok) = mailbox(&body.capability, &body.invite_id, "request", "");
    beacon::post(mesh, beacon_onion, &rid, &rtok, &seal(&body.capability, &body.invite_id, "request", &plain))
        .await
        .map_err(|e| format!("INVITE_UNREACHABLE: {e}"))?;
    let _ = app.emit("invite://waiting", serde_json::json!({ "inviter": body.inviter }));

    let (aid, atok) = mailbox(&body.capability, &body.invite_id, "reply", &node_id);
    let deadline = tokio::time::Instant::now() + WAIT;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(REDEEMER_POLL).await;
        let Ok(page) = beacon::fetch(mesh, beacon_onion, &aid, &atok, 0).await else { continue };
        for m in page {
            let Some(plain) = open(&body.capability, &body.invite_id, "reply", &m.body) else { continue };
            let Ok(reply) = serde_json::from_slice::<ReplyFrame>(&plain) else { continue };
            if !reply.ok {
                return Err(if reply.code.is_empty() { "INVITE_REFUSED".into() } else { reply.code });
            }
            return Ok(RedeemGrant { welcome: reply.welcome, room_name: reply.room_name, peers: reply.peers });
        }
    }
    Err("INVITE_UNREACHABLE: the inviter's phone did not come online in time".into())
}

// ── inviter ─────────────────────────────────────────────────────────────────

/// Runs for the app's life: answers redemptions left at Beacon for our open
/// invitations. Quiet while Tor is down or the vault is locked.
pub async fn watch(app: AppHandle) {
    let mut cursors: HashMap<String, i64> = HashMap::new();
    loop {
        // A little jitter so the polls are not a clock.
        let jitter = (OsRng.next_u32() % 20) as u64;
        tokio::time::sleep(INVITER_POLL + Duration::from_secs(jitter)).await;
        let now = invites::now_ms();
        for rec in invites::list(&app) {
            let Some(beacon_onion) = rec.beacon.clone() else { continue };
            if invites::effective_state(&rec, now) != EffectiveState::Active {
                continue;
            }
            let Some(invite_id) = unhex(&rec.id).and_then(|v| <[u8; INVITE_ID_LEN]>::try_from(v).ok()) else { continue };
            let mesh = app.state::<MeshState>();
            let (rid, rtok) = mailbox(&rec.capability, &invite_id, "request", "");
            let after = *cursors.get(&rec.id).unwrap_or(&0);
            let Ok(page) = beacon::fetch(&mesh, &beacon_onion, &rid, &rtok, after).await else { continue };
            for m in page {
                cursors.insert(rec.id.clone(), m.seq.max(after));
                let Some(plain) = open(&rec.capability, &invite_id, "request", &m.body) else { continue };
                let Ok(drop) = serde_json::from_slice::<DropRequest>(&plain) else { continue };
                let Some(challenge) = unhex(&drop.challenge).and_then(|v| <[u8; 32]>::try_from(v).ok()) else { continue };
                let node = drop.req.node_id.clone();
                let reply = if drop.req.v != REDEEM_VERSION {
                    ReplyFrame::refused("INVITE_VERSION")
                } else {
                    let pending = app.state::<RedeemState>();
                    invite_redeem::decide(&app, &pending, &challenge, drop.req).await
                };
                let Ok(plain) = serde_json::to_vec(&reply) else { continue };
                let (aid, atok) = mailbox(&rec.capability, &invite_id, "reply", &node);
                let _ = beacon::post(&mesh, &beacon_onion, &aid, &atok, &seal(&rec.capability, &invite_id, "reply", &plain)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: [u8; CAPABILITY_LEN] = [5; CAPABILITY_LEN];
    const ID: [u8; INVITE_ID_LEN] = [6; INVITE_ID_LEN];

    #[test]
    fn sealed_drops_open_only_with_the_capability_and_the_right_label() {
        let s = seal(&CAP, &ID, "request", b"hello");
        assert_eq!(open(&CAP, &ID, "request", &s).unwrap(), b"hello");
        assert!(open(&CAP, &ID, "reply", &s).is_none(), "a request cannot pass for a reply");
        assert!(open(&[7; CAPABILITY_LEN], &ID, "request", &s).is_none());
    }

    #[test]
    fn mailboxes_differ_per_direction_and_per_redeemer() {
        let req = mailbox(&CAP, &ID, "request", "");
        let a = mailbox(&CAP, &ID, "reply", "alice");
        let b = mailbox(&CAP, &ID, "reply", "bob");
        assert_ne!(req.0, a.0);
        assert_ne!(a.0, b.0);
        assert_ne!(a.0, a.1);
        assert_eq!(a.0.len(), 64);
    }

    #[test]
    fn onions_are_checked() {
        assert!(is_onion(&format!("{}.onion", "a".repeat(56))));
        assert!(!is_onion("x.onion"));
    }
}
