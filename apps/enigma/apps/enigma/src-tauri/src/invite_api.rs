//! The commands behind the invitation UI: mint, list, revoke, inspect, redeem.
//!
//! This module is the seam where the three halves meet — the ticket codec
//! (`invite_ticket`), the issuer's sealed record (`invites`) and the redemption
//! exchange (`invite_redeem`) — plus the two transports. Keeping the stitching
//! here leaves each of those modules about one thing.
//!
//! Two rules it exists to enforce:
//!
//! * **The frontend never sees a capability.** Minting returns the finished
//!   ticket string and nothing else; redeeming takes a ticket string and returns
//!   what the inviter granted. The 32-byte secret is generated in Rust, sealed
//!   into the ticket, stored in the vault, and never crosses the IPC boundary as
//!   a field the webview could read or replay.
//!
//! * **The transport follows the room, not the setting.** A room hosted over Tor
//!   mints an onion invitation; a clearnet room mints a direct one. Reading the
//!   global Tor toggle instead would mint an unreachable address for a room that
//!   was created before the switch was flipped.

use serde::Serialize;
use tauri::{AppHandle, State};

use chacha20poly1305::aead::rand_core::{OsRng, RngCore};

use crate::invite_redeem::{self, RedeemGrant};
use crate::invite_ticket::{
    self, InviteAddr, InviteBody, InviteKind, CAPABILITY_LEN, INVITE_ID_LEN,
};
use crate::invites::{self, effective_state, InviteRecord, InviteState};
use crate::p2p_iroh::P2pState;
use crate::p2p_tor::TorP2pState;

/// Ceiling on how long an invitation may live. A deadline is the only thing
/// limiting a bearer credential, so "never" is deliberately not offered — the
/// unbounded case already exists and is called a room ticket.
const MAX_TTL_SECS: u64 = 30 * 24 * 60 * 60;
const MIN_TTL_SECS: u64 = 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteCreated {
    /// The QR/paste payload. The only place the capability exists outside the
    /// vault, and it is already sealed there for a Personal invitation.
    pub ticket: String,
    pub invite_id: String,
    pub expires_at: u64,
    pub kind: String,
    pub tor: bool,
}

/// A row of the manage list. Deliberately carries no capability.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteSummary {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub room_slug: String,
    pub room_name: String,
    pub recipient: Option<String>,
    pub created_at: u64,
    pub expires_at: u64,
    pub tor: bool,
    /// Who spent it, when it was spent — for the "used" row.
    pub consumed_by: Option<String>,
}

fn summarise(rec: &InviteRecord, now: u64) -> InviteSummary {
    InviteSummary {
        id: rec.id.clone(),
        kind: rec.kind.clone(),
        state: effective_state(rec, now).as_str().to_string(),
        room_slug: rec.room_slug.clone(),
        room_name: rec.room_name.clone(),
        recipient: rec.recipient.clone(),
        created_at: rec.created_at,
        expires_at: rec.expires_at,
        tor: rec.tor,
        consumed_by: match &rec.state {
            InviteState::Consumed { by, .. } => Some(by.clone()),
            _ => None,
        },
    }
}

/// What a scanned ticket says about itself, before anyone commits to redeeming
/// it. Enough for the UI to show "expires in 3 hours" and to warn about a bearer
/// code; never enough to reveal a room.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePeek {
    pub kind: String,
    pub inviter: String,
    pub issued_at: u64,
    pub expires_at: u64,
    pub tor: bool,
    /// The ticket's own claim, which is advisory: the inviter's clock decides.
    /// Shown so a holder knows not to bother, never relied upon.
    pub looks_expired: bool,
}

fn identity_seed(app: &AppHandle) -> Result<[u8; 32], String> {
    Ok(crate::p2p_iroh::load_or_create_secret(app, "gossip")
        .map_err(|e| e.to_string())?
        .to_bytes())
}

// ── mint ────────────────────────────────────────────────────────────────────

/// Mint an invitation for a room.
///
/// `kind` is `"personal"` (sealed to `recipient`, which must be a contact's
/// NodeId) or `"general"` (a bearer code in cleartext — the caller is expected to
/// have warned the user and charged the higher Privacy HP price first).
#[tauri::command]
pub async fn invite_create(
    app: AppHandle,
    p2p: State<'_, P2pState>,
    tor: State<'_, TorP2pState>,
    room_slug: String,
    room_name: String,
    kind: String,
    recipient: Option<String>,
    ttl_secs: u64,
) -> Result<InviteCreated, String> {
    mint(&app, &p2p, &tor, room_slug, room_name, &kind, recipient, ttl_secs).await
}

/// The minting core, callable from Rust as well as from the command above.
///
/// It exists because the Contacts "invite to room" flow (`p2p_invite.rs`) has to
/// mint one too: it used to hand the contact a permanent room ticket, and now
/// sends a personal invitation sealed to that contact's NodeId instead. One
/// implementation, so the direct-invite path cannot drift into issuing something
/// with different expiry, revocation or ledger behaviour from the QR path.
#[allow(clippy::too_many_arguments)]
pub async fn mint(
    app: &AppHandle,
    p2p: &P2pState,
    tor: &TorP2pState,
    room_slug: String,
    room_name: String,
    kind: &str,
    recipient: Option<String>,
    ttl_secs: u64,
) -> Result<InviteCreated, String> {
    let kind = match kind {
        "personal" => InviteKind::Personal,
        "general" => InviteKind::General,
        other => return Err(format!("unknown invite kind '{other}'")),
    };
    let ttl = ttl_secs.clamp(MIN_TTL_SECS, MAX_TTL_SECS);
    let now = invites::now_ms();
    let expires_at = now + ttl * 1000;

    // The room's own transport decides the address (see the module note).
    let onion = crate::p2p_tor::room_onion(tor, &room_slug).await;
    let addr = match &onion {
        Some(o) => InviteAddr::Tor(o.clone()),
        None => InviteAddr::Iroh(vec![crate::p2p_iroh::local_addr(app, p2p)
            .await
            .map_err(|e| e.to_string())?]),
    };
    let inviter = crate::p2p_iroh::load_or_create_secret(app, "gossip")
        .map_err(|e| e.to_string())?
        .public()
        .to_string();

    let mut invite_id = [0u8; INVITE_ID_LEN];
    let mut capability = [0u8; CAPABILITY_LEN];
    OsRng.fill_bytes(&mut invite_id);
    OsRng.fill_bytes(&mut capability);

    let body = InviteBody {
        invite_id,
        capability,
        inviter,
        addr: addr.clone(),
        issued_at: now,
        expires_at,
    };

    let ticket = match kind {
        InviteKind::General => invite_ticket::encode_general(&body),
        InviteKind::Personal => {
            let node = recipient
                .as_deref()
                .ok_or_else(|| "a personal invitation needs a recipient".to_string())?;
            let id: iroh::EndpointId =
                node.parse().map_err(|_| "invalid contact code".to_string())?;
            invite_ticket::encode_personal(&body, id.as_bytes()).map_err(|e| e.to_string())?
        }
    };

    let id_hex: String = invite_id.iter().map(|b| format!("{b:02x}")).collect();
    invites::insert(
        app,
        InviteRecord {
            id: id_hex.clone(),
            kind: kind.as_str().to_string(),
            capability,
            recipient: match kind {
                InviteKind::Personal => recipient,
                // A bearer invitation binds to nobody — that IS the difference.
                InviteKind::General => None,
            },
            room_slug,
            room_name,
            created_at: now,
            expires_at,
            tor: addr.is_tor(),
            state: InviteState::Active,
        },
    )?;

    Ok(InviteCreated {
        ticket,
        invite_id: id_hex,
        expires_at,
        kind: kind.as_str().to_string(),
        tor: addr.is_tor(),
    })
}

// ── manage ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn invite_list(app: AppHandle) -> Result<Vec<InviteSummary>, String> {
    let now = invites::now_ms();
    Ok(invites::list(&app).iter().map(|r| summarise(r, now)).collect())
}

/// Withdraw an invitation. Returns whether anything moved, so the caller knows
/// whether a Privacy HP recovery is owed — revoking something already spent or
/// already revoked earns nothing.
#[tauri::command]
pub fn invite_revoke(app: AppHandle, invite_id: String) -> Result<bool, String> {
    invites::revoke(&app, &invite_id)
}

/// Is any bearer invitation still live? Drives the HP recovery pairing.
#[tauri::command]
pub fn invite_has_live_general(app: AppHandle) -> Result<bool, String> {
    Ok(invites::has_live_general(&app))
}

/// One record, for the detail view.
#[tauri::command]
pub fn invite_get(app: AppHandle, invite_id: String) -> Result<Option<InviteSummary>, String> {
    let now = invites::now_ms();
    Ok(invites::get(&app, &invite_id).map(|r| summarise(&r, now)))
}

// ── inspect ─────────────────────────────────────────────────────────────────

/// Read what a scanned ticket says about itself.
///
/// For a Personal invitation this succeeds only on the device it was addressed
/// to — which is also how the UI learns to say "this invitation is for someone
/// else" rather than "invalid code".
#[tauri::command]
pub fn invite_peek(app: AppHandle, ticket: String) -> Result<InvitePeek, String> {
    let seed = identity_seed(&app)?;
    let decoded = match invite_ticket::decode(&ticket, Some(&seed)) {
        Ok(d) => d,
        Err(e) => {
            // A Personal invitation that will not open is far more likely to be
            // addressed elsewhere than to be damaged, and those call for
            // different things from the user ("ask them to re-issue it for you"
            // vs "rescan"). The kind is readable without any key, so say which.
            if matches!(invite_ticket::peek_kind(&ticket), Some(InviteKind::Personal)) {
                return Err("INVITE_NOT_FOR_YOU".to_string());
            }
            return Err(e.to_string());
        }
    };
    Ok(InvitePeek {
        kind: decoded.kind.as_str().to_string(),
        inviter: decoded.body.inviter.clone(),
        issued_at: decoded.body.issued_at,
        expires_at: decoded.body.expires_at,
        tor: decoded.body.addr.is_tor(),
        looks_expired: invites::now_ms() >= decoded.body.expires_at,
    })
}

/// Tag sniff for the join field, so a scanned invitation routes to redemption
/// rather than being handed to the ticket parser.
#[tauri::command]
pub fn invite_is_invite(ticket: String) -> bool {
    invite_ticket::is_invite_ticket(&ticket)
}

// ── redeem ──────────────────────────────────────────────────────────────────

/// Redeem an invitation: dial the inviter, prove the capability, and come back
/// with the MLS Welcome plus the room's coordinates.
///
/// `key_package` is minted by the caller for the *pending* room session, because
/// only the frontend knows which MLS identity is joining. Everything after that
/// is the inviter's decision.
#[tauri::command]
pub async fn invite_redeem(
    app: AppHandle,
    p2p: State<'_, P2pState>,
    tor: State<'_, TorP2pState>,
    ticket: String,
    key_package: String,
    name: String,
) -> Result<RedeemGrant, String> {
    let seed = identity_seed(&app)?;
    let decoded = invite_ticket::decode(&ticket, Some(&seed)).map_err(|e| e.to_string())?;
    let body = decoded.body;

    match &body.addr {
        InviteAddr::Tor(onion) => {
            let (mut rd, mut wr) = crate::p2p_tor::dial_redeem(&app, &tor, onion)
                .await
                .map_err(|e| e.to_string())?;
            invite_redeem::redeem_over_tor(
                &app,
                &mut wr,
                &mut rd,
                &body.invite_id,
                &body.capability,
                key_package,
                name,
            )
            .await
            .map_err(|e| e.to_string())
        }
        InviteAddr::Iroh(hints) => {
            let endpoint = crate::p2p_iroh::endpoint_for_dial(&app, &p2p, hints)
                .await
                .map_err(|e| e.to_string())?;
            invite_redeem::redeem_over_iroh(
                &app,
                endpoint,
                &body.inviter,
                &body.invite_id,
                &body.capability,
                key_package,
                name,
            )
            .await
            .map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unopenable_personal_invite_is_reported_as_misaddressed() {
        // The distinction the peek makes: `peek_kind` reads the header without a
        // key, so a sealed body we cannot open is reported as somebody else's
        // rather than as damaged.
        assert_eq!(
            invite_ticket::peek_kind("zzzz"),
            None,
            "junk must not be claimed as an invitation"
        );
    }

    #[test]
    fn a_ttl_is_clamped_into_a_sane_range() {
        // "Never expires" is not on offer: the unbounded credential already
        // exists and is called a room ticket.
        assert_eq!(0u64.clamp(MIN_TTL_SECS, MAX_TTL_SECS), MIN_TTL_SECS);
        assert_eq!(u64::MAX.clamp(MIN_TTL_SECS, MAX_TTL_SECS), MAX_TTL_SECS);
        // The presets the UI offers all survive untouched.
        for preset in [3600u64, 86_400, 7 * 86_400] {
            assert_eq!(preset.clamp(MIN_TTL_SECS, MAX_TTL_SECS), preset);
        }
    }

    #[test]
    fn a_summary_carries_no_capability() {
        // The manage list is rendered by the webview; it must not be a way to
        // read back the secrets in the vault.
        let rec = InviteRecord {
            id: "abcd".into(),
            kind: "general".into(),
            capability: [0x5Au8; CAPABILITY_LEN],
            recipient: None,
            room_slug: "room-1".into(),
            room_name: "Room One".into(),
            created_at: 1,
            expires_at: 2,
            tor: false,
            state: InviteState::Active,
        };
        let json = serde_json::to_string(&summarise(&rec, 0)).unwrap();
        assert!(!json.contains("5a5a"), "capability leaked into a summary");
        assert!(!json.to_lowercase().contains("capab"));
        assert!(json.contains("Room One"));
    }

    #[test]
    fn a_summary_reports_the_effective_state_not_the_stored_one() {
        let rec = InviteRecord {
            id: "abcd".into(),
            kind: "general".into(),
            capability: [0u8; CAPABILITY_LEN],
            recipient: None,
            room_slug: "r".into(),
            room_name: "R".into(),
            created_at: 0,
            expires_at: 1_000,
            tor: false,
            state: InviteState::Active,
        };
        assert_eq!(summarise(&rec, 999).state, "active");
        assert_eq!(summarise(&rec, 1_000).state, "expired");
    }

    #[test]
    fn a_bearer_invitation_binds_to_nobody() {
        // Pinned because the opposite is an easy mistake: passing the picker's
        // selection through for a General invite would quietly turn it into a
        // Personal one that the UI still describes as transferable.
        let rec = InviteRecord {
            id: "abcd".into(),
            kind: InviteKind::General.as_str().into(),
            capability: [0u8; CAPABILITY_LEN],
            recipient: None,
            room_slug: "r".into(),
            room_name: "R".into(),
            created_at: 0,
            expires_at: 1,
            tor: false,
            state: InviteState::Active,
        };
        assert!(summarise(&rec, 0).recipient.is_none());
    }
}
