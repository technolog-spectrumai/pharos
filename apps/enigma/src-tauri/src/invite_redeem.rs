//! Redeeming an invitation: the exchange that turns a QR into MLS membership.
//!
//! ## Why redemption is a conversation, not a decode
//!
//! The QR names a capability and an address; every
//! question that matters is answered by the **inviter, live, at redemption**:
//! has this expired (by *their* clock), was it withdrawn, is it addressed to you,
//! has somebody already spent it. None of those can be decided by the holder, so
//! the holder does not get to decide them.
//!
//! The direct cost is that **the inviter must be online**. There is no
//! store-and-forward in Enigma27. An invitation is a rendezvous, not a message left for someone.
//!
//! ## The exchange
//!
//! ```text
//! inviter  → redeemer : challenge (32 random bytes)
//! redeemer → inviter  : invite_id, node_id,
//!                       sig   = Ed25519(identity_sk, challenge)
//!                       proof = blake3::keyed_hash(capability,
//!                                   invite_id ‖ challenge ‖ node_id)
//!                       key_package (MLS)
//! inviter             : verify sig → reserve (atomically, in invites.rs)
//!                       → admit (MLS add_member, answered by the frontend)
//! inviter  → redeemer : welcome ‖ room name ‖ members' onions — or a refusal code
//! ```
//!
//! **The capability never crosses the wire.** What travels is a MAC over a fresh
//! challenge *and* the redeemer's own identity, so a proof captured from one
//! redemption cannot be replayed by the same holder (new challenge) or reused by
//! a different one (different node_id).
//!
//! ## Why the redeemer signs
//!
//! **Tor authenticates the server, not the client**: an onion connection
//! carries no client identity at all. Without a signature, "recipient binding"
//! would reduce to the redeemer *claiming* to be the recipient. So the redeemer
//! signs the challenge with its device key, and the inviter verifies it against
//! the device id being claimed.
//!
//! ## Where the MLS work happens
//!
//! Rust performs every *check* and takes the lease, then parks on a oneshot and
//! asks the frontend to do the group operation. MLS orchestration lives in
//! `useChatChannel` for every other flow in this app and there is no reason for
//! this one to be the exception: the commit produced by an add has to be
//! broadcast to the existing members, and the frontend is what owns that seam.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use chacha20poly1305::aead::rand_core::{OsRng, RngCore};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

use crate::invite_ticket::INVITE_ID_LEN;
use crate::invites::{self, RedeemError};

pub(crate) const REDEEM_VERSION: u8 = 1;
const CHALLENGE_LEN: usize = 32;

// ── wire frames (length-prefixed JSON, the mesh's framing) ───────────────────

#[derive(Serialize, Deserialize)]
struct ChallengeFrame {
    v: u8,
    /// Hex. Fresh per connection — this is what stops a proof being replayed.
    challenge: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct RequestFrame {
    pub(crate) v: u8,
    /// Hex of the ticket's invite_id.
    pub(crate) invite_id: String,
    /// The redeemer's device id, proven by `sig`.
    pub(crate) node_id: String,
    /// Hex Ed25519 signature over the raw challenge bytes.
    pub(crate) sig: String,
    /// Hex MAC proving possession of the capability.
    pub(crate) proof: String,
    /// Base64 MLS KeyPackage.
    pub(crate) key_package: String,
    /// Display name for the room roster. Self-asserted, like every other
    /// `sender_name` in this app (technology.md §9.5).
    pub(crate) name: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct ReplyFrame {
    pub(crate) v: u8,
    pub(crate) ok: bool,
    /// One of the `INVITE_*` codes from `invites::RedeemError` when `!ok`.
    pub(crate) code: String,
    /// Base64 MLS Welcome.
    pub(crate) welcome: String,
    /// The room to join. Handed over ONLY here, never in the QR.
    pub(crate) room_name: String,
    /// The members' onions for the room, the inviter's included.
    pub(crate) peers: Vec<String>,
}

impl ReplyFrame {
    pub(crate) fn refused(code: &str) -> Self {
        Self {
            v: REDEEM_VERSION,
            ok: false,
            code: code.to_string(),
            welcome: String::new(),
            room_name: String::new(),
            peers: Vec::new(),
        }
    }
}

/// What the frontend hands back once it has run the MLS add.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmitAnswer {
    pub ok: bool,
    #[serde(default)]
    pub welcome: String,
    #[serde(default)]
    pub room_name: String,
    #[serde(default)]
    pub peers: Vec<String>,
    /// Populated when the frontend could not complete the add.
    #[serde(default)]
    pub error: String,
}

/// What a successful redemption yields to the joining side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemGrant {
    pub welcome: String,
    pub room_name: String,
    pub peers: Vec<String>,
}

/// In-flight admissions awaiting the frontend's answer, keyed by request id.
/// Managed state, shared by the protocol handlers and `invite_admit`.
#[derive(Default, Clone)]
pub struct RedeemState(pub Arc<Mutex<HashMap<String, oneshot::Sender<AdmitAnswer>>>>);

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

fn fixed<const N: usize>(s: &str) -> Option<[u8; N]> {
    let v = unhex(s)?;
    if v.len() != N {
        return None;
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&v);
    Some(out)
}

// ── the security core (pure; no transport, no vault) ────────────────────────

/// Does `sig` prove that whoever sent it holds the key behind `node_id`?
pub fn verify_identity(node_id: &str, challenge: &[u8], sig_hex: &str) -> bool {
    match fixed::<64>(sig_hex) {
        Some(sig) => crate::device::verify(node_id, challenge, &sig),
        None => false,
    }
}

// ── server side ─────────────────────────────────────────────────────────────

/// Run the inviter's half of the exchange over an already-open stream pair.
async fn serve_exchange<W, R>(
    app: &AppHandle,
    pending: &RedeemState,
    write: &mut W,
    read: &mut R,
) -> Result<()>
where
    W: FrameSink,
    R: FrameSource,
{
    let mut challenge = [0u8; CHALLENGE_LEN];
    OsRng.fill_bytes(&mut challenge);
    write
        .send(&ChallengeFrame { v: REDEEM_VERSION, challenge: hex(&challenge) })
        .await?;

    let req: RequestFrame = read.recv().await?;
    if req.v != REDEEM_VERSION {
        write.send(&ReplyFrame::refused("INVITE_VERSION")).await?;
        return Ok(());
    }

    let reply = decide(app, pending, &challenge, req).await;
    write.send(&reply).await?;
    Ok(())
}

/// Every check, in the order that gives the most useful refusal, then the lease,
/// then the admission.
pub(crate) async fn decide(
    app: &AppHandle,
    pending: &RedeemState,
    challenge: &[u8; CHALLENGE_LEN],
    req: RequestFrame,
) -> ReplyFrame {
    // 1. Is the redeemer who they say they are? Everything downstream —
    //    recipient binding, the proof, the audit trail — is meaningless if not.
    if !verify_identity(&req.node_id, challenge, &req.sig) {
        return ReplyFrame::refused("INVITE_BAD_IDENTITY");
    }

    let (Some(invite_id), Some(proof)) =
        (fixed::<INVITE_ID_LEN>(&req.invite_id), fixed::<32>(&req.proof))
    else {
        return ReplyFrame::refused(RedeemError::BadCapability.code());
    };

    // 2. State, expiry, recipient binding and the capability proof — checked and
    //    leased in one critical section so two redeemers cannot both pass.
    let record = match invites::reserve(app, &req.invite_id, &req.node_id, &invite_id, challenge, &proof)
    {
        Ok(rec) => rec,
        Err(e) => return ReplyFrame::refused(e.code()),
    };

    // 2b. The key package must be the redeemer's own: its MLS credential is the
    //     device id that signed the challenge.
    if crate::key_package_identity(app, &record.room_slug, &req.key_package).as_deref() != Some(req.node_id.as_str()) {
        let _ = invites::release(app, &req.invite_id);
        return ReplyFrame::refused("INVITE_BAD_IDENTITY");
    }

    // 3. Admission itself, performed by the frontend (see the module note).
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel::<AdmitAnswer>();
    pending.0.lock().await.insert(request_id.clone(), tx);
    let _ = app.emit(
        "invite://admit",
        serde_json::json!({
            "requestId": request_id,
            "inviteId": req.invite_id,
            "roomSlug": record.room_slug,
            "roomName": record.room_name,
            "keyPackage": req.key_package,
            "redeemer": req.node_id,
            "redeemerName": req.name,
        }),
    );

    // Bounded by the same user-set connect timeout every other deadline in this
    // app reads (technology.md §15) — never a literal.
    let window = Duration::from_secs(crate::net_settings::connect_timeout_secs(app));
    let answer = tokio::time::timeout(window, rx).await;
    pending.0.lock().await.remove(&request_id);

    match answer {
        Ok(Ok(a)) if a.ok => {
            // Spend it only now: the redeemer is a member, so the invitation has
            // done its job.
            let _ = invites::commit(app, &req.invite_id, &req.node_id);
            ReplyFrame {
                v: REDEEM_VERSION,
                ok: true,
                code: String::new(),
                welcome: a.welcome,
                room_name: a.room_name,
                peers: a.peers,
            }
        }
        other => {
            // A failed or abandoned admission must not burn the invitation —
            // hand the lease back so the holder can simply try again.
            let _ = invites::release(app, &req.invite_id);
            // The frontend's reason stays on the INVITER's side. The redeemer
            // gets a bare code: why an admission failed can name a room, a
            // member or an MLS state, and none of that is owed to someone who
            // has just been refused.
            match other {
                Ok(Ok(a)) if !a.error.is_empty() => {
                    eprintln!("[redeem] admission refused by the frontend: {}", a.error)
                }
                Ok(Ok(_)) => eprintln!("[redeem] admission declined"),
                Ok(Err(_)) => eprintln!("[redeem] admission dropped before answering"),
                Err(_) => eprintln!("[redeem] admission timed out"),
            }
            ReplyFrame::refused("INVITE_ADMIT_FAILED")
        }
    }
}

/// Resolve a parked admission. Called by the `invite_admit` command once the
/// frontend has run `add_member` and broadcast the resulting commit.
pub async fn answer_admit(pending: &RedeemState, request_id: &str, answer: AdmitAnswer) -> bool {
    match pending.0.lock().await.remove(request_id) {
        Some(tx) => tx.send(answer).is_ok(),
        None => false,
    }
}

// ── framing ─────────────────────────────────────────────────────────────────

pub trait FrameSink {
    fn send<T: Serialize + Sync>(
        &mut self,
        val: &T,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
}

pub trait FrameSource {
    fn recv<T: DeserializeOwned>(&mut self) -> impl std::future::Future<Output = Result<T>> + Send;
}

/// The mesh's length-prefixed JSON frames.
pub struct TorSink<'a, W>(pub &'a mut W);
pub struct TorSource<'a, R>(pub &'a mut R);

impl<W> FrameSink for TorSink<'_, W>
where
    W: tokio::io::AsyncWrite + Unpin + Send,
{
    async fn send<T: Serialize + Sync>(&mut self, val: &T) -> Result<()> {
        crate::mesh::write_frame(self.0, &serde_json::to_string(val)?).await
    }
}

impl<R> FrameSource for TorSource<'_, R>
where
    R: tokio::io::AsyncRead + Unpin + Send,
{
    async fn recv<T: DeserializeOwned>(&mut self) -> Result<T> {
        let text = crate::mesh::read_frame(self.0).await?;
        Ok(serde_json::from_str(&text)?)
    }
}

/// Serve one redemption over an accepted onion stream (the mesh's accept loop
/// routes `Hello { kind: "redeem" }` here).
pub async fn serve_tor<W, R>(app: &AppHandle, pending: &RedeemState, write: &mut W, read: &mut R) -> Result<()>
where
    W: tokio::io::AsyncWrite + Unpin + Send,
    R: tokio::io::AsyncRead + Unpin + Send,
{
    serve_exchange(app, pending, &mut TorSink(write), &mut TorSource(read)).await
}

// ── client side ─────────────────────────────────────────────────────────────

/// The redeemer's half: answer the challenge, then read the verdict.
async fn run_redeem<W, R>(
    write: &mut W,
    read: &mut R,
    invite_id: &[u8; INVITE_ID_LEN],
    capability: &[u8; 32],
    secret: &ed25519_dalek::SigningKey,
    key_package_b64: String,
    name: String,
) -> Result<RedeemGrant>
where
    W: FrameSink,
    R: FrameSource,
{
    let challenge_frame: ChallengeFrame = read.recv().await?;
    if challenge_frame.v != REDEEM_VERSION {
        return Err(anyhow!("INVITE_VERSION"));
    }
    let challenge = unhex(&challenge_frame.challenge).ok_or_else(|| anyhow!("bad challenge"))?;
    if challenge.len() != CHALLENGE_LEN {
        return Err(anyhow!("bad challenge"));
    }

    let node_id = crate::device::id_of(secret);
    let mut chal = [0u8; CHALLENGE_LEN];
    chal.copy_from_slice(&challenge);
    let proof = invites::expected_proof(capability, invite_id, &chal, &node_id);

    write
        .send(&RequestFrame {
            v: REDEEM_VERSION,
            invite_id: hex(invite_id),
            node_id,
            sig: hex(&crate::device::sign(secret, &challenge)),
            proof: hex(&proof),
            key_package: key_package_b64,
            name,
        })
        .await?;

    let reply: ReplyFrame = read.recv().await?;
    if !reply.ok {
        // The inviter's refusal codes are passed through untouched so the UI can
        // say "already used" rather than "failed".
        return Err(anyhow!(
            "{}",
            if reply.code.is_empty() { "INVITE_REFUSED".to_string() } else { reply.code }
        ));
    }
    Ok(RedeemGrant {
        welcome: reply.welcome,
        room_name: reply.room_name,
        peers: reply.peers,
    })
}

/// Redeem over an already-connected onion stream (`mesh::dial_kind` dials and
/// hands the halves over, so the Tor plumbing stays in one module).
pub async fn redeem_over_tor<W, R>(
    app: &AppHandle,
    write: &mut W,
    read: &mut R,
    invite_id: &[u8; INVITE_ID_LEN],
    capability: &[u8; 32],
    key_package_b64: String,
    name: String,
) -> Result<RedeemGrant>
where
    W: tokio::io::AsyncWrite + Unpin + Send,
    R: tokio::io::AsyncRead + Unpin + Send,
{
    let secret = crate::device::load_or_create(app)?;
    run_redeem(
        &mut TorSink(write),
        &mut TorSource(read),
        invite_id,
        capability,
        &secret,
        key_package_b64,
        name,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn sig(k: &SigningKey, msg: &[u8]) -> String {
        hex(&crate::device::sign(k, msg))
    }

    fn id(k: &SigningKey) -> String {
        crate::device::id_of(k)
    }

    // ── identity proof ───────────────────────────────────────────────────────

    #[test]
    fn a_signature_proves_the_claimed_node_id() {
        let sk = key(1);
        let challenge = [0x42u8; CHALLENGE_LEN];
        let s = sig(&sk, &challenge);
        assert!(verify_identity(&id(&sk), &challenge, &s));
    }

    #[test]
    fn a_signature_does_not_transfer_to_another_identity() {
        // Claiming to be Bob while holding Carol's key: the whole point of the
        // signature, since Tor would not catch it.
        let carol = key(2);
        let bob = key(3);
        let challenge = [0x42u8; CHALLENGE_LEN];
        let s = sig(&carol, &challenge);
        assert!(!verify_identity(&id(&bob), &challenge, &s));
    }

    #[test]
    fn a_signature_over_a_different_challenge_does_not_replay() {
        let sk = key(1);
        let s = sig(&sk, &[0x01u8; CHALLENGE_LEN]);
        assert!(!verify_identity(&id(&sk), &[0x02u8; CHALLENGE_LEN], &s));
    }

    #[test]
    fn malformed_identity_material_is_refused_rather_than_trusted() {
        let sk = key(1);
        let challenge = [0x42u8; CHALLENGE_LEN];
        let good = sig(&sk, &challenge);
        let id = id(&sk);

        assert!(!verify_identity("not-a-node-id", &challenge, &good));
        assert!(!verify_identity(&id, &challenge, "zz"));
        assert!(!verify_identity(&id, &challenge, ""));
        // Right length, wrong bytes.
        assert!(!verify_identity(&id, &challenge, &"ab".repeat(64)));
        // Odd-length hex must not panic.
        assert!(!verify_identity(&id, &challenge, "abc"));
    }

    // ── hex helpers ──────────────────────────────────────────────────────────

    #[test]
    fn hex_round_trips_and_rejects_junk() {
        let bytes = [0u8, 1, 15, 16, 254, 255];
        assert_eq!(hex(&bytes), "00010f10feff");
        assert_eq!(unhex(&hex(&bytes)).unwrap(), bytes);
        assert!(unhex("xyz").is_none());
        assert!(unhex("abc").is_none(), "odd length");
        assert_eq!(fixed::<2>("0102").unwrap(), [1, 2]);
        assert!(fixed::<3>("0102").is_none(), "wrong length");
    }

    // ── refusals ─────────────────────────────────────────────────────────────

    #[test]
    fn a_refusal_carries_a_code_and_no_room_information() {
        // A refused redemption must not leak what it was refusing access to.
        for code in ["INVITE_EXPIRED", "INVITE_USED", "INVITE_WRONG_RECIPIENT"] {
            let r = ReplyFrame::refused(code);
            assert!(!r.ok);
            assert_eq!(r.code, code);
            assert!(r.room_name.is_empty());
            assert!(r.welcome.is_empty());
            assert!(r.peers.is_empty());
        }
    }

    #[test]
    fn every_store_refusal_survives_the_wire_as_its_own_code() {
        // The UI distinguishes these, so they must not collapse into one another
        // on the way out.
        let codes: Vec<String> = [
            RedeemError::Unknown,
            RedeemError::Expired,
            RedeemError::Revoked,
            RedeemError::AlreadyUsed,
            RedeemError::Busy,
            RedeemError::WrongRecipient,
            RedeemError::BadCapability,
        ]
        .iter()
        .map(|e| ReplyFrame::refused(e.code()).code)
        .collect();
        let unique: std::collections::HashSet<&String> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len());
    }
}
