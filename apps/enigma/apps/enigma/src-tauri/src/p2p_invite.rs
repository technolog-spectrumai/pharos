// Direct room invites between contacts — an offer/accept handshake over a
// dedicated ALPN on the MAIN p2p endpoint (the stable NodeId contacts store),
// mirroring the file-transfer UX: nothing happens until the invitee explicitly
// accepts. No shared room is needed — the dial goes straight to the contact's
// NodeId (resolved via n0/DHT discovery like any reconnect), and the QUIC
// connection is E2E-encrypted and mutually authenticated by NodeId, so the
// invitee knows exactly which contact is asking.
//
// Flow (inviter I → contact C):
//   I: `invite_send` → connect(C, INVITE_ALPN) → bi stream →
//      frame { v, room_name, ticket, code }
//   C: handler emits `invite://incoming` and parks the answer on a oneshot;
//      the Contacts UI shows Accept / Decline; `invite_respond` resolves it
//   C→I: one response byte. On accept, C's frontend joins via the embedded
//      ticket (or the code when its DHT toggle is on) — the exact path a
//      scanned QR takes, MLS admission included.
//   I: reads the byte within 2× the user-set connect timeout (N to reach the
//      contact + N for the human to decide — the same 2×N window shape as the
//      join modal) → accepted / declined / unreachable in the contact row.
//
// The ticket is minted fresh at send time, so its embedded addresses can't be
// stale (the inviter is online right now). The code rides along so a
// DHT-enabled invitee becomes a full secret-holder (rendezvous + re-share).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointId};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

pub const INVITE_ALPN: &[u8] = b"enigma/invite/0";

const INVITE_VERSION: u8 = 1;

/// Pending incoming invites awaiting the user's Accept/Decline, keyed by
/// invite id. Managed state — the protocol handler and the `invite_respond`
/// command must share the same map.
#[derive(Default, Clone)]
pub struct InviteState(pub Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>);

#[derive(Serialize, Deserialize)]
struct InvitePayload {
    v: u8,
    room_name: String,
    ticket: String,
    /// Ticketless-join room code; empty when the inviter's DHT toggle is off.
    code: String,
}

// ── wire frames (length-prefixed JSON, same idiom as file_xfer.rs) ─────────────

fn frame_bytes<T: Serialize>(val: &T) -> Vec<u8> {
    let body = serde_json::to_vec(val).unwrap_or_default();
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

async fn write_frame<T: Serialize>(send: &mut SendStream, val: &T) -> Result<()> {
    send.write_all(&frame_bytes(val)).await?;
    Ok(())
}

async fn read_frame<T: DeserializeOwned>(recv: &mut RecvStream) -> Result<T> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await?;
    let n = u32::from_le_bytes(len) as usize;
    if n > 64 * 1024 {
        return Err(anyhow!("control frame too large"));
    }
    let mut body = vec![0u8; n];
    recv.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

// ── inbound (the invitee side) ─────────────────────────────────────────────────

#[derive(Clone)]
pub struct InviteProtocol {
    app: AppHandle,
    pending: InviteState,
}

impl std::fmt::Debug for InviteProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("InviteProtocol")
    }
}

impl InviteProtocol {
    pub fn new(app: AppHandle, pending: InviteState) -> Self {
        Self { app, pending }
    }

    async fn serve(self, conn: Connection) -> Result<()> {
        // Authenticated by the QUIC handshake — this is who is really asking.
        let from = conn.remote_id();
        let (mut send, mut recv) = conn.accept_bi().await?;
        let payload: InvitePayload = read_frame(&mut recv).await?;
        if payload.v != INVITE_VERSION {
            return Err(anyhow!("unknown invite version {}", payload.v));
        }

        let invite_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<bool>();
        self.pending.0.lock().await.insert(invite_id.clone(), tx);
        let _ = self.app.emit(
            "invite://incoming",
            serde_json::json!({
                "inviteId": invite_id,
                "fromNodeId": from.to_string(),
                "roomName": payload.room_name,
                "ticket": payload.ticket,
                "code": payload.code,
            }),
        );

        // Decision window = the user-set connect timeout (never hardcoded); the
        // inviter waits 2× this, so an answer at the buzzer still lands.
        let window = Duration::from_secs(crate::p2p_dht::connect_timeout_secs(&self.app));
        let accepted = matches!(tokio::time::timeout(window, rx).await, Ok(Ok(true)));
        self.pending.0.lock().await.remove(&invite_id);
        // Clears a stale card if the window lapsed without an answer (harmless
        // when the user already answered — the UI dropped the card itself).
        let _ = self.app.emit("invite://resolved", serde_json::json!({ "inviteId": invite_id }));

        send.write_all(&[accepted as u8]).await?;
        let _ = send.finish();
        // Wait for the inviter's 1-byte ack so the answer is flushed before close.
        let mut ack = [0u8; 1];
        let _ = recv.read_exact(&mut ack).await;
        Ok(())
    }
}

impl ProtocolHandler for InviteProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        if let Err(e) = self.clone().serve(conn).await {
            eprintln!("[invite] serve ended: {e}");
        }
        Ok(())
    }
}

// ── outbound (the inviter side) ────────────────────────────────────────────────

/// Offer a room to a contact and wait for their answer. `Ok(true)` = accepted,
/// `Ok(false)` = declined; errors mean the contact was unreachable or never
/// answered inside the window.
pub async fn send(
    app: &AppHandle,
    endpoint: Endpoint,
    node_id: &str,
    room_name: String,
    ticket: String,
    code: String,
) -> Result<bool> {
    let id: EndpointId = node_id.parse().map_err(|_| anyhow!("invalid contact code"))?;
    // 2×N: N for the dial, N for the invitee's human decision window (which is
    // N on their side) — the same shape as the join modal's 2×N lifetime.
    let window = Duration::from_secs(2 * crate::p2p_dht::connect_timeout_secs(app));
    let exchange = async move {
        let conn = endpoint
            .connect(id, INVITE_ALPN)
            .await
            .map_err(|e| anyhow!("contact unreachable: {e}"))?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| anyhow!("open stream: {e}"))?;
        write_frame(&mut send, &InvitePayload { v: INVITE_VERSION, room_name, ticket, code })
            .await?;
        let mut answer = [0u8; 1];
        recv.read_exact(&mut answer).await.map_err(|e| anyhow!("no answer: {e}"))?;
        // Ack so the invitee's side knows the answer arrived before closing.
        let _ = send.write_all(&[1u8]).await;
        let _ = send.finish();
        Ok::<bool, anyhow::Error>(answer[0] == 1)
    };
    match tokio::time::timeout(window, exchange).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!("no answer in time")),
    }
}

// ── the invitee's answer (Contacts UI Accept/Decline) ─────────────────────────

#[tauri::command]
pub async fn invite_respond(
    pending: tauri::State<'_, InviteState>,
    invite_id: String,
    accept: bool,
) -> Result<(), String> {
    // Missing id = the window already lapsed (or a duplicate click) — a no-op,
    // not an error: the inviter side has moved on either way.
    if let Some(tx) = pending.0.lock().await.remove(&invite_id) {
        let _ = tx.send(accept);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_frame_round_trips_with_length_prefix() {
        let payload = InvitePayload {
            v: INVITE_VERSION,
            room_name: "general".into(),
            ticket: "ticket-blob".into(),
            code: "iqaa-code".into(),
        };
        let framed = frame_bytes(&payload);
        let len = u32::from_le_bytes(framed[..4].try_into().unwrap()) as usize;
        assert_eq!(len, framed.len() - 4);

        let decoded: InvitePayload = serde_json::from_slice(&framed[4..]).expect("decode body");
        assert_eq!(decoded.v, INVITE_VERSION);
        assert_eq!(decoded.room_name, "general");
        assert_eq!(decoded.ticket, "ticket-blob");
        assert_eq!(decoded.code, "iqaa-code");
    }

    #[test]
    fn empty_code_survives_the_frame() {
        // DHT off ⇒ the code field is empty, not absent — the wire format must
        // not treat that as malformed.
        let payload = InvitePayload {
            v: INVITE_VERSION,
            room_name: "r".into(),
            ticket: "t".into(),
            code: String::new(),
        };
        let framed = frame_bytes(&payload);
        let decoded: InvitePayload = serde_json::from_slice(&framed[4..]).expect("decode");
        assert!(decoded.code.is_empty());
    }
}
