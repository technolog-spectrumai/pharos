//! The issuer's record of every invitation it has minted: what it was for, when
//! it dies, and whether it has been spent.
//!
//! ## Why the issuer keeps state at all
//!
//! A room ticket is stateless — that is exactly its problem. It cannot expire,
//! cannot be revoked, and cannot be spent once, because nothing anywhere knows it
//! exists. An invitation is the opposite: the QR is a *reference* to a record that
//! lives in the inviter's vault, and every question that matters is answered here,
//! by the inviter, at redemption time.
//!
//! In particular **expiry is decided by the inviter's clock**, never the
//! redeemer's. The `expires_at` inside a ticket drives a countdown and nothing
//! else; a bearer can edit their own copy, and for a General invitation it is not
//! even authenticated. Only this record is authoritative.
//!
//! ## Where it lives
//!
//! `vault::get/put` under ns `invites` — the protasius **internal** tag. The
//! `kv_*` commands the webview can call use a different AAD tag and a different
//! record space, so JS can neither read invite state nor forge it. Same boundary
//! the Privacy MANA ledger uses (technology.md §17).
//!
//! ## The capability is stored, not just its hash
//!
//! Worth stating plainly, because the cautious-looking alternative is broken.
//! Redemption proves possession with `blake3::keyed_hash(capability, …)` bound to
//! a fresh challenge and the redeemer's identity — so a proof observed once
//! cannot be replayed by anyone else. **Verifying that MAC requires the key**, so
//! an issuer holding only a hash could not check it, and the protocol would have
//! to fall back to the redeemer transmitting the raw capability instead. That
//! trade is strictly worse: it drops the challenge binding to protect a secret
//! that the vault already protects, alongside the MLS state, the chat log and the
//! iroh identity key. So the capability is kept here, and the vault stays the one
//! boundary that matters.
//!
//! ## One-use is a lease, not a burn
//!
//! `Active → InFlight → Consumed`, with the middle step carrying a short lease.
//! Two redeemers racing the same code: exactly one takes the lease, the other is
//! told it is busy. If the MLS round then fails — a dropped connection, a
//! malformed key package — the lease simply expires and the invitation goes back
//! to `Active` rather than being destroyed by someone else's bad network. Atomic
//! against double-spend, and forgiving of ordinary failure.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::invite_ticket::{InviteKind, CAPABILITY_LEN, INVITE_ID_LEN};
use crate::vault;

const NS: &str = "invites";
const KEY: &str = "records";

/// How long a redemption may hold an invitation before others may try again.
/// Long enough for a Tor round trip plus an MLS commit; short enough that a
/// crashed redeemer does not park a bearer invite for the afternoon.
const LEASE_MS: u64 = 60_000;

/// Records older than this are swept once they can no longer do anything —
/// consumed, revoked or long expired. Keeps the manage list readable and the
/// sealed blob small without hiding anything the user might still want to see.
const RETAIN_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// Serializes read-modify-write on the sealed blob. The whole store is one value,
/// so two concurrent redemptions must not interleave a load/store pair — this is
/// what makes `reserve` atomic in the sense that matters.
static STORE_LOCK: Mutex<()> = Mutex::new(());

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum InviteState {
    /// Mintable and redeemable.
    Active,
    /// A redemption is in progress and holds the invitation until `lease_until`.
    InFlight { lease_until: u64, by: String },
    /// Spent. Terminal.
    Consumed { by: String, at: u64 },
    /// Withdrawn by the inviter. Terminal.
    Revoked { at: u64 },
}

/// What a record *means* right now, expiry folded in.
///
/// `Expired` is derived rather than stored: a record does not change when a clock
/// ticks past its deadline, and writing one on read would mean the store mutates
/// itself just by being looked at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectiveState {
    Active,
    InFlight,
    Consumed,
    Revoked,
    Expired,
}

impl EffectiveState {
    pub fn as_str(self) -> &'static str {
        match self {
            EffectiveState::Active => "active",
            EffectiveState::InFlight => "inflight",
            EffectiveState::Consumed => "consumed",
            EffectiveState::Revoked => "revoked",
            EffectiveState::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InviteRecord {
    /// Hex of the ticket's `invite_id`. The name both sides use.
    pub id: String,
    pub kind: String,
    /// The secret the ticket carries; see the module note on why it lives here.
    pub capability: [u8; CAPABILITY_LEN],
    /// Personal invitations only: the NodeId this is addressed to.
    pub recipient: Option<String>,
    /// Which room a successful redemption admits to. Never leaves this device in
    /// a QR — it is handed over only after the redeemer has proven themselves.
    pub room_slug: String,
    /// Display only, for the manage list. Same rule: never in a ticket.
    pub room_name: String,
    pub created_at: u64,
    pub expires_at: u64,
    /// Whether the ticket was minted with an onion address.
    pub tor: bool,
    pub state: InviteState,
}

/// Why a redemption was refused. Deliberately specific: these all go to the
/// *inviter's* logs and to the redeemer as a reason they can act on ("expired"
/// and "already used" call for different next steps).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedeemError {
    Unknown,
    Expired,
    Revoked,
    AlreadyUsed,
    Busy,
    WrongRecipient,
    BadCapability,
}

impl RedeemError {
    pub fn code(self) -> &'static str {
        match self {
            RedeemError::Unknown => "INVITE_UNKNOWN",
            RedeemError::Expired => "INVITE_EXPIRED",
            RedeemError::Revoked => "INVITE_REVOKED",
            RedeemError::AlreadyUsed => "INVITE_USED",
            RedeemError::Busy => "INVITE_BUSY",
            RedeemError::WrongRecipient => "INVITE_WRONG_RECIPIENT",
            RedeemError::BadCapability => "INVITE_BAD_CAPABILITY",
        }
    }
}

impl std::fmt::Display for RedeemError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

// ── pure state machine (no vault, no clock — directly testable) ─────────────

/// `expires_at == 0` means NEVER — the one invitation that does not run out.
///
/// Only a Tor invitation may carry it (`invite_api::mint` refuses it otherwise):
/// a `.onion` is hard enough to come by that a standing invitation is a risk the
/// budget can price rather than forbid. It is not free — `privacy_mana` charges for
/// every hour one stays outstanding, and a drained daily meter closes the room it
/// belongs to. Zero rather than `u64::MAX` because zero is what an older record
/// deserializing without the field would produce, and "never" is the wrong default
/// to inherit silently; every read of this field goes through the helper below so
/// there is one place that decides.
pub fn never_expires(rec: &InviteRecord) -> bool {
    rec.expires_at == 0
}

pub fn effective_state(rec: &InviteRecord, now: u64) -> EffectiveState {
    match &rec.state {
        // Terminal states outrank expiry: "you already used this" is more useful
        // than "it expired", and revocation is a decision, not a timeout.
        InviteState::Consumed { .. } => EffectiveState::Consumed,
        InviteState::Revoked { .. } => EffectiveState::Revoked,
        _ if !never_expires(rec) && now >= rec.expires_at => EffectiveState::Expired,
        InviteState::InFlight { lease_until, .. } if *lease_until > now => EffectiveState::InFlight,
        // A lapsed lease is indistinguishable from Active, which is the point.
        InviteState::InFlight { .. } | InviteState::Active => EffectiveState::Active,
    }
}

/// The proof a redeemer must produce: a MAC over the challenge and their own
/// identity, keyed by the capability.
///
/// Binding the redeemer's NodeId in is what stops a captured proof being reused
/// by a different holder, and binding the challenge is what stops it being reused
/// by the same one. The capability itself never crosses the wire.
pub fn expected_proof(
    capability: &[u8; CAPABILITY_LEN],
    invite_id: &[u8; INVITE_ID_LEN],
    challenge: &[u8; 32],
    redeemer: &str,
) -> [u8; 32] {
    let mut msg = Vec::with_capacity(INVITE_ID_LEN + 32 + redeemer.len());
    msg.extend_from_slice(invite_id);
    msg.extend_from_slice(challenge);
    msg.extend_from_slice(redeemer.as_bytes());
    *blake3::keyed_hash(capability, &msg).as_bytes()
}

/// Everything that must hold before an invitation may be spent, in the order
/// that gives the most useful refusal.
///
/// Checked as one step so it cannot drift out of sync with `reserve`.
pub fn check_redeemable(
    rec: &InviteRecord,
    now: u64,
    redeemer: &str,
    invite_id: &[u8; INVITE_ID_LEN],
    challenge: &[u8; 32],
    proof: &[u8; 32],
) -> Result<(), RedeemError> {
    match effective_state(rec, now) {
        EffectiveState::Consumed => return Err(RedeemError::AlreadyUsed),
        EffectiveState::Revoked => return Err(RedeemError::Revoked),
        EffectiveState::Expired => return Err(RedeemError::Expired),
        EffectiveState::InFlight => return Err(RedeemError::Busy),
        EffectiveState::Active => {}
    }
    // Recipient binding before the capability check: a Personal invitation handed
    // to the wrong person is a different problem from a forged proof, and the
    // inviter wants to be able to tell them apart.
    if let Some(want) = &rec.recipient {
        if want != redeemer {
            return Err(RedeemError::WrongRecipient);
        }
    }
    let want = expected_proof(&rec.capability, invite_id, challenge, redeemer);
    // Constant-time: `blake3::Hash` compares without a data-dependent early exit.
    if blake3::Hash::from(want) != blake3::Hash::from(*proof) {
        return Err(RedeemError::BadCapability);
    }
    Ok(())
}

/// Take the lease. Caller must have run `check_redeemable` in the same critical
/// section.
fn take_lease(rec: &mut InviteRecord, now: u64, redeemer: &str) {
    rec.state = InviteState::InFlight { lease_until: now + LEASE_MS, by: redeemer.to_string() };
}

/// When a record stopped being able to do anything.
///
/// The terminal event, not the deadline: an invitation revoked today but issued
/// with a year's expiry is finished *today*, and measuring retention from its
/// unreachable deadline would keep it in the list for a year and a month.
fn dead_since(rec: &InviteRecord) -> u64 {
    match &rec.state {
        InviteState::Consumed { at, .. } => *at,
        InviteState::Revoked { at } => *at,
        // Nothing happened to it; it simply ran out. A never-expiring record is
        // not dead at all, so this arm is unreachable for one — `sweep` checks
        // liveness first — but returning its issue time rather than 0 keeps the
        // arithmetic below honest if that ever stops being true.
        _ if never_expires(rec) => rec.created_at,
        _ => rec.expires_at,
    }
}

/// Drop records that can no longer do anything and are long past.
///
/// Dead records deliberately linger for a while rather than vanishing: "you used
/// this one yesterday" is worth being able to see, and an invitation that
/// disappears the moment it is spent looks like a bug.
fn sweep(records: &mut Vec<InviteRecord>, now: u64) {
    records.retain(|r| {
        let dead = matches!(
            effective_state(r, now),
            EffectiveState::Consumed | EffectiveState::Revoked | EffectiveState::Expired
        );
        !dead || now.saturating_sub(dead_since(r)) < RETAIN_MS
    });
}

// ── vault-backed store ──────────────────────────────────────────────────────

fn load(app: &AppHandle) -> Vec<InviteRecord> {
    vault::get(app, NS, KEY)
        .ok()
        .flatten()
        .and_then(|b| serde_json::from_slice::<Vec<InviteRecord>>(&b).ok())
        .unwrap_or_default()
}

fn save(app: &AppHandle, records: &[InviteRecord]) -> Result<(), String> {
    let bytes = serde_json::to_vec(records).map_err(|e| e.to_string())?;
    vault::put(app, NS, KEY, &bytes)
}

/// Every record, newest first, swept of long-dead entries.
pub fn list(app: &AppHandle) -> Vec<InviteRecord> {
    let _guard = STORE_LOCK.lock();
    let mut records = load(app);
    let now = now_ms();
    let before = records.len();
    sweep(&mut records, now);
    if records.len() != before {
        let _ = save(app, &records);
    }
    records.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    records
}

pub fn insert(app: &AppHandle, rec: InviteRecord) -> Result<(), String> {
    let _guard = STORE_LOCK.lock();
    let mut records = load(app);
    sweep(&mut records, now_ms());
    records.push(rec);
    save(app, &records)
}

/// Withdraw an invitation. Idempotent, and it wins over an in-flight lease: the
/// user asked for it to stop, so a redemption already in the air does not get to
/// finish. Returns whether the record moved (so the caller knows whether a
/// Privacy MANA recovery is owed).
pub fn revoke(app: &AppHandle, id: &str) -> Result<bool, String> {
    let _guard = STORE_LOCK.lock();
    let mut records = load(app);
    let now = now_ms();
    let mut changed = false;
    for rec in records.iter_mut() {
        if rec.id != id {
            continue;
        }
        if matches!(rec.state, InviteState::Consumed { .. } | InviteState::Revoked { .. }) {
            break;
        }
        rec.state = InviteState::Revoked { at: now };
        changed = true;
        break;
    }
    if changed {
        save(app, &records)?;
    }
    Ok(changed)
}

/// Verify and atomically reserve, in one critical section.
///
/// The check and the lease must not be separable: two redeemers that both passed
/// the check before either wrote would both be admitted, which is precisely the
/// double-spend this exists to prevent.
pub fn reserve(
    app: &AppHandle,
    id: &str,
    redeemer: &str,
    invite_id: &[u8; INVITE_ID_LEN],
    challenge: &[u8; 32],
    proof: &[u8; 32],
) -> Result<InviteRecord, RedeemError> {
    let _guard = STORE_LOCK.lock();
    let mut records = load(app);
    let now = now_ms();

    let idx = records.iter().position(|r| r.id == id).ok_or(RedeemError::Unknown)?;
    check_redeemable(&records[idx], now, redeemer, invite_id, challenge, proof)?;
    take_lease(&mut records[idx], now, redeemer);
    let claimed = records[idx].clone();
    // A failed write must not admit anyone: without the lease on disk a second
    // redeemer could still take it, so refuse rather than proceed optimistically.
    save(app, &records).map_err(|_| RedeemError::Busy)?;
    Ok(claimed)
}

/// Spend a reserved invitation. Called only after MLS admission succeeded.
pub fn commit(app: &AppHandle, id: &str, redeemer: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock();
    let mut records = load(app);
    let now = now_ms();
    for rec in records.iter_mut() {
        if rec.id == id {
            // Revocation during the round wins: the user's decision outranks a
            // redemption that was already in the air.
            if matches!(rec.state, InviteState::Revoked { .. }) {
                return Ok(());
            }
            rec.state = InviteState::Consumed { by: redeemer.to_string(), at: now };
        }
    }
    save(app, &records)
}

/// Hand a reserved invitation back after a failed round. Never resurrects a
/// terminal state.
pub fn release(app: &AppHandle, id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock();
    let mut records = load(app);
    for rec in records.iter_mut() {
        if rec.id == id && matches!(rec.state, InviteState::InFlight { .. }) {
            rec.state = InviteState::Active;
        }
    }
    save(app, &records)
}

/// Look up one record without touching its state.
pub fn get(app: &AppHandle, id: &str) -> Option<InviteRecord> {
    let _guard = STORE_LOCK.lock();
    load(app).into_iter().find(|r| r.id == id)
}

/// Is any bearer invitation still live? Drives the Privacy MANA recovery pairing —
/// revoking earns only while something revocable is actually outstanding.
pub fn has_live_general(app: &AppHandle) -> bool {
    let now = now_ms();
    let _guard = STORE_LOCK.lock();
    load(app).iter().any(|r| {
        r.kind == InviteKind::General.as_str()
            && matches!(effective_state(r, now), EffectiveState::Active | EffectiveState::InFlight)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: [u8; CAPABILITY_LEN] = [0xABu8; CAPABILITY_LEN];
    const ID: [u8; INVITE_ID_LEN] = [0x11u8; INVITE_ID_LEN];
    const CHAL: [u8; 32] = [0x22u8; 32];
    const T0: u64 = 1_700_000_000_000;

    fn rec(kind: InviteKind, recipient: Option<&str>) -> InviteRecord {
        InviteRecord {
            id: "1111".into(),
            kind: kind.as_str().into(),
            capability: CAP,
            recipient: recipient.map(|s| s.to_string()),
            room_slug: "room-1".into(),
            room_name: "Room One".into(),
            created_at: T0,
            expires_at: T0 + 3_600_000,
            tor: false,
            state: InviteState::Active,
        }
    }

    fn good_proof(redeemer: &str) -> [u8; 32] {
        expected_proof(&CAP, &ID, &CHAL, redeemer)
    }

    // ── the happy path ───────────────────────────────────────────────────────

    #[test]
    fn a_live_invitation_with_a_good_proof_is_redeemable() {
        let r = rec(InviteKind::General, None);
        assert_eq!(check_redeemable(&r, T0, "bob", &ID, &CHAL, &good_proof("bob")), Ok(()));
    }

    // ── expiry, by the inviter's clock ───────────────────────────────────────

    #[test]
    fn expiry_is_decided_here_not_by_the_redeemer() {
        let r = rec(InviteKind::General, None);
        // One millisecond before the deadline, and one past it.
        assert!(check_redeemable(&r, r.expires_at - 1, "bob", &ID, &CHAL, &good_proof("bob")).is_ok());
        assert_eq!(
            check_redeemable(&r, r.expires_at, "bob", &ID, &CHAL, &good_proof("bob")),
            Err(RedeemError::Expired)
        );
    }

    #[test]
    fn a_redeemer_whose_clock_disagrees_changes_nothing() {
        // The redeemer's clock is not an input to this function at all — which is
        // the whole design. Pinned so nobody threads one in later.
        let r = rec(InviteKind::General, None);
        assert_eq!(
            check_redeemable(&r, r.expires_at + 1, "bob", &ID, &CHAL, &good_proof("bob")),
            Err(RedeemError::Expired)
        );
    }

    // ── recipient binding ────────────────────────────────────────────────────

    #[test]
    fn a_personal_invitation_admits_only_its_recipient() {
        let r = rec(InviteKind::Personal, Some("bob"));
        assert!(check_redeemable(&r, T0, "bob", &ID, &CHAL, &good_proof("bob")).is_ok());
        assert_eq!(
            check_redeemable(&r, T0, "carol", &ID, &CHAL, &good_proof("carol")),
            Err(RedeemError::WrongRecipient)
        );
    }

    #[test]
    fn a_general_invitation_admits_anyone_who_holds_it() {
        let r = rec(InviteKind::General, None);
        for who in ["bob", "carol", "dave"] {
            assert!(check_redeemable(&r, T0, who, &ID, &CHAL, &good_proof(who)).is_ok(), "{who}");
        }
    }

    // ── the capability proof ─────────────────────────────────────────────────

    #[test]
    fn a_proof_for_a_different_redeemer_does_not_transfer() {
        // The replay that matters: Carol watches Bob redeem and reuses his proof.
        let r = rec(InviteKind::General, None);
        assert_eq!(
            check_redeemable(&r, T0, "carol", &ID, &CHAL, &good_proof("bob")),
            Err(RedeemError::BadCapability)
        );
    }

    #[test]
    fn a_proof_for_a_different_challenge_does_not_replay() {
        let r = rec(InviteKind::General, None);
        let stale = expected_proof(&CAP, &ID, &[0x33u8; 32], "bob");
        assert_eq!(
            check_redeemable(&r, T0, "bob", &ID, &CHAL, &stale),
            Err(RedeemError::BadCapability)
        );
    }

    #[test]
    fn a_proof_for_a_different_invitation_does_not_transfer() {
        let r = rec(InviteKind::General, None);
        let other = expected_proof(&CAP, &[0x99u8; INVITE_ID_LEN], &CHAL, "bob");
        assert_eq!(
            check_redeemable(&r, T0, "bob", &ID, &CHAL, &other),
            Err(RedeemError::BadCapability)
        );
    }

    #[test]
    fn guessing_the_capability_is_not_a_strategy() {
        let r = rec(InviteKind::General, None);
        assert_eq!(
            check_redeemable(&r, T0, "bob", &ID, &CHAL, &[0u8; 32]),
            Err(RedeemError::BadCapability)
        );
        let near = expected_proof(&[0xAAu8; CAPABILITY_LEN], &ID, &CHAL, "bob");
        assert_eq!(
            check_redeemable(&r, T0, "bob", &ID, &CHAL, &near),
            Err(RedeemError::BadCapability)
        );
    }

    #[test]
    fn the_capability_never_appears_in_a_proof() {
        // A proof is a MAC, not an envelope: handing one to an observer must not
        // hand them the secret.
        let proof = good_proof("bob");
        assert!(!proof.windows(4).any(|w| w == &CAP[..4]));
        assert_ne!(proof, CAP);
    }

    // ── terminal states ──────────────────────────────────────────────────────

    #[test]
    fn a_spent_invitation_stays_spent() {
        let mut r = rec(InviteKind::General, None);
        r.state = InviteState::Consumed { by: "bob".into(), at: T0 };
        assert_eq!(
            check_redeemable(&r, T0, "carol", &ID, &CHAL, &good_proof("carol")),
            Err(RedeemError::AlreadyUsed)
        );
    }

    #[test]
    fn a_revoked_invitation_reports_revoked_rather_than_expired() {
        // Even long past its deadline: "the inviter withdrew this" is the truth,
        // and it is the more actionable of the two.
        let mut r = rec(InviteKind::General, None);
        r.state = InviteState::Revoked { at: T0 };
        assert_eq!(effective_state(&r, r.expires_at + 999_999), EffectiveState::Revoked);
        assert_eq!(
            check_redeemable(&r, T0, "bob", &ID, &CHAL, &good_proof("bob")),
            Err(RedeemError::Revoked)
        );
    }

    #[test]
    fn a_spent_invitation_reports_used_rather_than_expired() {
        let mut r = rec(InviteKind::General, None);
        r.state = InviteState::Consumed { by: "bob".into(), at: T0 };
        assert_eq!(effective_state(&r, r.expires_at + 999_999), EffectiveState::Consumed);
    }

    // ── the lease ────────────────────────────────────────────────────────────

    #[test]
    fn a_second_redeemer_is_refused_while_the_lease_holds() {
        let mut r = rec(InviteKind::General, None);
        take_lease(&mut r, T0, "bob");
        assert_eq!(
            check_redeemable(&r, T0 + 1, "carol", &ID, &CHAL, &good_proof("carol")),
            Err(RedeemError::Busy)
        );
    }

    #[test]
    fn a_lapsed_lease_reopens_the_invitation() {
        // A redeemer that crashed mid-round must not park a bearer invite forever.
        let mut r = rec(InviteKind::General, None);
        take_lease(&mut r, T0, "bob");
        assert_eq!(effective_state(&r, T0 + LEASE_MS - 1), EffectiveState::InFlight);
        assert_eq!(effective_state(&r, T0 + LEASE_MS), EffectiveState::Active);
        assert!(check_redeemable(&r, T0 + LEASE_MS, "carol", &ID, &CHAL, &good_proof("carol")).is_ok());
    }

    #[test]
    fn a_lease_cannot_outlive_the_deadline() {
        let mut r = rec(InviteKind::General, None);
        let deadline = r.expires_at;
        take_lease(&mut r, deadline - 1, "bob");
        assert_eq!(effective_state(&r, deadline), EffectiveState::Expired);
    }

    #[test]
    fn exactly_one_of_two_racing_redeemers_wins() {
        // The check-then-lease pair, run the way `reserve` runs it. Carol's
        // attempt is evaluated against the record Bob has already written to.
        let mut r = rec(InviteKind::General, None);
        let bob = check_redeemable(&r, T0, "bob", &ID, &CHAL, &good_proof("bob"));
        assert!(bob.is_ok());
        take_lease(&mut r, T0, "bob");
        let carol = check_redeemable(&r, T0, "carol", &ID, &CHAL, &good_proof("carol"));
        assert_eq!(carol, Err(RedeemError::Busy));
    }

    // ── sweeping ─────────────────────────────────────────────────────────────

    #[test]
    fn live_records_are_never_swept() {
        let mut v = vec![rec(InviteKind::General, None)];
        sweep(&mut v, T0);
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn dead_records_linger_before_being_swept() {
        let mut r = rec(InviteKind::General, None);
        r.state = InviteState::Consumed { by: "bob".into(), at: T0 };
        let mut v = vec![r];
        // Still listed a day later, so the user can see what happened...
        sweep(&mut v, T0 + 24 * 60 * 60 * 1000);
        assert_eq!(v.len(), 1);
        // ...and gone well after that.
        sweep(&mut v, T0 + RETAIN_MS + 1);
        assert!(v.is_empty());
    }

    #[test]
    fn retention_runs_from_the_terminal_event_not_the_deadline() {
        // An invitation revoked today is finished today, even if it was issued
        // with a year to run. Measuring from `expires_at` would keep it listed
        // for a year and a month.
        let mut r = rec(InviteKind::General, None);
        r.expires_at = T0 + 365 * 24 * 60 * 60 * 1000;
        r.state = InviteState::Revoked { at: T0 };
        let mut v = vec![r];
        sweep(&mut v, T0 + RETAIN_MS + 1);
        assert!(v.is_empty(), "revoked records must age from the revocation");
    }

    #[test]
    fn an_expired_record_ages_from_its_deadline() {
        // Nothing happened to it, so the deadline is the only event there is.
        let r = rec(InviteKind::General, None);
        let deadline = r.expires_at;
        let mut v = vec![r];
        sweep(&mut v, deadline + RETAIN_MS - 1);
        assert_eq!(v.len(), 1);
        sweep(&mut v, deadline + RETAIN_MS + 1);
        assert!(v.is_empty());
    }

    // ── error surface ────────────────────────────────────────────────────────

    #[test]
    fn every_refusal_has_a_distinct_stable_code() {
        let all = [
            RedeemError::Unknown,
            RedeemError::Expired,
            RedeemError::Revoked,
            RedeemError::AlreadyUsed,
            RedeemError::Busy,
            RedeemError::WrongRecipient,
            RedeemError::BadCapability,
        ];
        let codes: Vec<&str> = all.iter().map(|e| e.code()).collect();
        let unique: std::collections::HashSet<&&str> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len(), "codes must be distinguishable");
        assert!(codes.iter().all(|c| c.starts_with("INVITE_")));
    }
}
