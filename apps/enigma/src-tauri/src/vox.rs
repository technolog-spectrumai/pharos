// Real-time 1:1 voice calls over iroh (QUIC), end-to-end encrypted by iroh's
// TLS 1.3 transport (peers authenticated by node id). No WebRTC / STUN / TURN.
//
// The custom ALPN (`enigma/vox/0`) is accepted on the app's MAIN p2p endpoint
// (p2p_iroh.rs), alongside gossip and invites — so a callee is call-reachable at
// the exact stable NodeId their contacts/nickname already resolve to, and the call
// inherits the main node's lifecycle (airplane / Tor / profile-switch teardown).
// The callee shares a `VoxTicket` (its EndpointAddr, base32-encoded) out of band —
// pasted or as a QR; a room-peer or nickname/contact call dials the peer NodeId
// directly. The caller `endpoint.connect()`s, opens one control bi-stream for the
// hello / accept / decline handshake, and then audio flows over unreliable QUIC
// datagrams (no head-of-line blocking).
//
// Audio is captured/played natively with cpal (already a dep) — so no webview
// getUserMedia is involved. cpal::Stream is !Send, so capture and playback each
// live on their own dedicated OS thread (mirrors the WAV recorder in lib.rs),
// talking to the async QUIC tasks over channels.
//
// Frames are companded with G.711 μ-law (pure Rust, no native codec dep): 1 byte
// per sample, halving bandwidth and keeping a 10 ms frame well under the QUIC
// datagram size limit. Clear for speech.
//
// Media is additionally E2E-encrypted by a per-call ephemeral 2-member MLS group
// (rotor_core) keying two directional ChaCha20-Poly1305 ciphers, fail-soft to the
// QUIC-TLS transport when the MLS handshake can't complete.
//
// Emits `vox://state` (call progress), `vox://incoming` (ring) and `vox://spectrum`
// (equalizer) events. Networked commands are blocked offline and in Tor-exclusive
// mode (voice is iroh-only — a direct QUIC call would leak the IP outside Tor).

use std::collections::VecDeque;
use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc as stdmpsc;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use bytes::Bytes;
use chacha20poly1305::aead::Aead;
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rotor_core::RotorSession;
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler};
use iroh::{Endpoint, EndpointAddr, EndpointId};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot};

use crate::{active_config, load_profile_state, AppConfigState};
use crate::p2p_iroh::P2pState;

pub(crate) const VOX_ALPN: &[u8] = b"enigma/vox/0";
const SAMPLE_RATE: u32 = 48_000;
/// 10 ms @ 48 kHz mono — one μ-law frame (480 bytes + 2-byte seq) per datagram,
/// comfortably under the QUIC datagram MTU, and low latency.
const FRAME_SAMPLES: usize = 480;
/// Hard cap on the playback jitter buffer (~0.5 s) so we never drift unbounded.
const MAX_BUFFERED_SAMPLES: usize = (SAMPLE_RATE as usize) / 2;
/// Real-time equalizer of the *incoming* voice, emitted as `vox://spectrum`.
const SPECTRUM_BARS: usize = 24;
const FFT_SIZE: usize = 1024;

// ── G.711 μ-law companding (pure Rust) ───────────────────────────────────────

const ULAW_BIAS: i32 = 0x84;
const ULAW_CLIP: i32 = 32_635;

fn linear_to_ulaw(sample: i16) -> u8 {
    let mut pcm = sample as i32;
    let sign: u8 = if pcm < 0 { 0x80 } else { 0 };
    if pcm < 0 {
        pcm = -pcm;
    }
    if pcm > ULAW_CLIP {
        pcm = ULAW_CLIP;
    }
    pcm += ULAW_BIAS; // now in 0x84..=0x7FFF, so the top set bit is at index 7..=14
    let exponent = ((31 - (pcm as u32).leading_zeros() as i32) - 7).clamp(0, 7);
    let mantissa = (pcm >> (exponent + 3)) & 0x0F;
    !(sign | ((exponent as u8) << 4) | mantissa as u8)
}

fn ulaw_to_linear(ulaw: u8) -> i16 {
    let u = !ulaw;
    let sign = u & 0x80;
    let exponent = ((u >> 4) & 0x07) as i32;
    let mantissa = (u & 0x0F) as i32;
    let mut sample = ((mantissa << 3) + ULAW_BIAS) << exponent;
    sample -= ULAW_BIAS;
    if sign != 0 {
        -(sample as i16)
    } else {
        sample as i16
    }
}

/// Linear-interpolating resampler — maps `input` to exactly `out_len` samples.
/// Good enough for voice; lets each device run at its own native rate while the
/// wire format stays a fixed 48 kHz μ-law stream so any two peers interoperate.
fn resample_linear(input: &[f32], out_len: usize) -> Vec<f32> {
    if out_len == 0 {
        return Vec::new();
    }
    if input.len() == out_len {
        return input.to_vec();
    }
    if input.len() < 2 {
        return vec![input.first().copied().unwrap_or(0.0); out_len];
    }
    let ratio = (input.len() - 1) as f32 / (out_len.max(2) - 1) as f32;
    (0..out_len)
        .map(|i| {
            let pos = i as f32 * ratio;
            let idx = pos.floor() as usize;
            let frac = pos - idx as f32;
            let a = input[idx.min(input.len() - 1)];
            let b = input[(idx + 1).min(input.len() - 1)];
            a + (b - a) * frac
        })
        .collect()
}

// ── state ────────────────────────────────────────────────────────────────────

/// Managed call state. Lazily holds the single `VoxShared` (one call at a time);
/// both the inbound protocol handler (registered on the main p2p router) and the
/// commands resolve the same instance via `shared`.
#[derive(Default, Clone)]
pub struct VoxState(pub Arc<StdMutex<Option<VoxShared>>>);

impl VoxState {
    /// Get (or lazily create) the shared call state. All `VoxShared` fields are
    /// behind `Arc`s, so every caller shares the same generation/mute/pending/conn.
    fn shared(&self, app: &AppHandle) -> VoxShared {
        self.0
            .lock()
            .unwrap()
            .get_or_insert_with(|| VoxShared::new(app.clone()))
            .clone()
    }
}

/// Everything the inbound protocol handler and the commands both need, behind
/// `Arc`s so it can be cloned into the router and the per-call tasks.
#[derive(Clone)]
pub struct VoxShared {
    app: AppHandle,
    /// Bumped to tear down the active call's audio loops (hangup / superseded).
    generation: Arc<AtomicU64>,
    /// Local mic gate — when true the capture loop drains but sends nothing.
    mute: Arc<AtomicBool>,
    /// A pending inbound call awaiting the user's accept/decline.
    pending: Arc<StdMutex<Option<oneshot::Sender<bool>>>>,
    /// The live connection, so `vox_hangup` can close it.
    conn: Arc<StdMutex<Option<Connection>>>,
    /// Our display name, sent in the hello / accept control frames.
    my_name: Arc<StdMutex<String>>,
    /// Our MLS device identity (same one the chat uses) for the call's MLS group.
    my_identity: Arc<StdMutex<String>>,
}

impl VoxShared {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            generation: Arc::new(AtomicU64::new(0)),
            mute: Arc::new(AtomicBool::new(false)),
            pending: Arc::new(StdMutex::new(None)),
            conn: Arc::new(StdMutex::new(None)),
            my_name: Arc::new(StdMutex::new(String::new())),
            my_identity: Arc::new(StdMutex::new(String::new())),
        }
    }
}

// ── ticket ───────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct VoxTicket {
    call_id: String,
    peer: EndpointAddr,
}

impl VoxTicket {
    fn encode(&self) -> String {
        let bytes = postcard::to_stdvec(self).expect("postcard::to_stdvec is infallible");
        let mut text = data_encoding::BASE32_NOPAD.encode(&bytes);
        text.make_ascii_lowercase();
        text
    }
    fn decode(s: &str) -> Result<Self> {
        let bytes = data_encoding::BASE32_NOPAD.decode(s.trim().to_ascii_uppercase().as_bytes())?;
        Ok(postcard::from_bytes(&bytes)?)
    }
}

// ── control frames (over the bi-stream) ───────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Hello {
    name: String,
    /// Shared call id (from the ticket) — also the MLS group/export context.
    #[serde(default)]
    call_id: String,
    /// base64 MLS KeyPackage; empty ⇒ caller isn't offering MLS.
    #[serde(default)]
    key_package: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Control {
    kind: String, // "accept" | "decline"
    #[serde(default)]
    name: String,
    /// base64 MLS Welcome; empty ⇒ callee couldn't establish the group.
    #[serde(default)]
    welcome: String,
    #[serde(default)]
    can_mls: bool,
}

/// Caller's authoritative decision on whether the call is MLS-encrypted, sent
/// after it has (or hasn't) joined the group — so both sides agree on the mode.
#[derive(Serialize, Deserialize)]
struct Ready {
    enc: String, // "mls" | "transport"
}

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

// ── events ───────────────────────────────────────────────────────────────────

fn emit_state(app: &AppHandle, state: &str, peer: Option<&str>) {
    let _ = app.emit("vox://state", serde_json::json!({ "state": state, "peer": peer }));
}

fn emit_incoming(app: &AppHandle, from_name: &str, node_id: &str, call_id: &str) {
    let _ = app.emit(
        "vox://incoming",
        serde_json::json!({ "from_name": from_name, "node_id": node_id, "call_id": call_id }),
    );
}

fn emit_connected(app: &AppHandle, peer: &str, encrypted: bool) {
    let _ = app.emit(
        "vox://state",
        serde_json::json!({
            "state": "connected",
            "peer": peer,
            "encryption": if encrypted { "mls" } else { "transport" },
        }),
    );
}

// ── MLS-keyed media crypto ────────────────────────────────────────────────────

fn b64(bytes: &[u8]) -> String {
    data_encoding::BASE64.encode(bytes)
}
fn unb64(s: &str) -> Result<Vec<u8>> {
    data_encoding::BASE64.decode(s.as_bytes()).map_err(|e| anyhow!("base64: {e}"))
}

/// Per-direction AEAD ciphers derived from the call's MLS exporter secret.
struct VoxKeys {
    send: ChaCha20Poly1305,
    recv: ChaCha20Poly1305,
}

/// 96-bit nonce from a per-direction monotonic counter. The two directions use
/// independent keys, so a counter is sufficient to keep every (key, nonce) unique.
fn nonce_from_counter(counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    n
}

/// Export two directional 256-bit keys from a freshly-joined MLS group and wrap
/// them as ChaCha20-Poly1305 ciphers, assigned by role.
fn derive_vox_keys(session: &RotorSession, call_id: &str, caller: bool) -> Result<VoxKeys> {
    let ctx = call_id.as_bytes();
    let c2s = session.export_secret("enigma/vox/c2s", ctx, 32).map_err(|e| anyhow!("export c2s: {e}"))?;
    let s2c = session.export_secret("enigma/vox/s2c", ctx, 32).map_err(|e| anyhow!("export s2c: {e}"))?;
    let mk = |k: &[u8]| ChaCha20Poly1305::new_from_slice(k).map_err(|e| anyhow!("cipher init: {e}"));
    let (c2s, s2c) = (mk(&c2s)?, mk(&s2c)?);
    Ok(if caller {
        VoxKeys { send: c2s, recv: s2c }
    } else {
        VoxKeys { send: s2c, recv: c2s }
    })
}

/// Callee side: form a 2-member MLS group from the caller's KeyPackage and return
/// the base64 Welcome to send back plus our directional keys.
fn mls_callee(call_id: &str, identity: &str, caller_kp_b64: &str) -> Result<(String, VoxKeys)> {
    let kp = unb64(caller_kp_b64)?;
    let mut session = RotorSession::new(call_id.to_string(), identity.to_string())
        .map_err(|e| anyhow!("mls new: {e}"))?;
    session.create_group().map_err(|e| anyhow!("mls create_group: {e}"))?;
    let (welcome, _commit) = session.add_member(&kp).map_err(|e| anyhow!("mls add_member: {e}"))?;
    let keys = derive_vox_keys(&session, call_id, false)?;
    Ok((b64(&welcome), keys))
}

/// Caller side: fresh session + our KeyPackage (base64). The session is kept so we
/// can join from the Welcome the callee returns.
fn mls_caller_start(call_id: &str, identity: &str) -> Result<(RotorSession, String)> {
    let mut session = RotorSession::new(call_id.to_string(), identity.to_string())
        .map_err(|e| anyhow!("mls new: {e}"))?;
    let kp = session.key_package().map_err(|e| anyhow!("mls key_package: {e}"))?;
    Ok((session, b64(&kp)))
}

/// Caller side: finish the handshake by joining from the Welcome and deriving keys.
fn mls_caller_join(session: &mut RotorSession, welcome_b64: &str, call_id: &str) -> Result<VoxKeys> {
    let welcome = unb64(welcome_b64)?;
    session.join_from_welcome(&welcome).map_err(|e| anyhow!("mls join: {e}"))?;
    derive_vox_keys(session, call_id, true)
}

// ── network policy ───────────────────────────────────────────────────────────

const TOR_BLOCKED: &str = "Voice calls are unavailable in Tor mode.";

/// Airplane mode blocks all networking; Tor-exclusive mode blocks voice because it
/// is iroh-only (a direct QUIC call from a Tor-routed profile would leak the IP).
/// Every network-touching command runs this first (mirrors file_xfer).
fn check_network_policy(app: &AppHandle, config: &State<'_, AppConfigState>) -> Result<(), String> {
    if matches!(active_config(config), Ok(cfg) if crate::is_offline(&load_profile_state(app, &cfg))) {
        return Err(crate::file_xfer::OFFLINE_BLOCKED.to_string());
    }
    if matches!(active_config(config), Ok(cfg) if crate::is_use_tor(&load_profile_state(app, &cfg))) {
        return Err(TOR_BLOCKED.to_string());
    }
    Ok(())
}

// ── inbound (callee) ─────────────────────────────────────────────────────────

/// Accepts `VOX_ALPN` on the main p2p router (registered in `p2p_iroh::ensure_started`).
/// Resolves the shared call state lazily so it's the same instance the commands use.
#[derive(Clone)]
pub(crate) struct VoxProtocol {
    app: AppHandle,
    state: VoxState,
}

impl VoxProtocol {
    pub(crate) fn new(app: AppHandle, state: VoxState) -> Self {
        Self { app, state }
    }
}

impl std::fmt::Debug for VoxProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VoxProtocol")
    }
}

impl ProtocolHandler for VoxProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        // The whole call lives inside this future — when it returns, `conn` drops.
        if let Err(e) = self.state.shared(&self.app).handle_incoming(conn).await {
            eprintln!("[vox] inbound call ended: {e}");
        }
        Ok(())
    }
}

impl VoxShared {
    async fn handle_incoming(self, conn: Connection) -> Result<()> {
        let (mut send, mut recv) = conn.accept_bi().await?;
        let hello: Hello = read_frame(&mut recv).await?;
        let node_id = conn.remote_id().to_string();

        // One call at a time.
        let busy = self.conn.lock().unwrap().is_some() || self.pending.lock().unwrap().is_some();
        if busy {
            let _ = write_frame(&mut send, &Control { kind: "decline".into(), ..Default::default() }).await;
            conn.close(0u32.into(), b"busy");
            return Ok(());
        }

        let (tx, rx) = oneshot::channel::<bool>();
        *self.pending.lock().unwrap() = Some(tx);
        emit_incoming(&self.app, &hello.name, &node_id, &hello.call_id);
        emit_state(&self.app, "ringing", Some(&hello.name));

        // Wait for the user to accept/decline, or for the caller to give up.
        let accepted = tokio::select! {
            d = rx => d.unwrap_or(false),
            _ = conn.closed() => false,
        };
        *self.pending.lock().unwrap() = None;

        if !accepted {
            let _ = write_frame(&mut send, &Control { kind: "decline".into(), ..Default::default() }).await;
            emit_state(&self.app, "ended", None);
            conn.close(0u32.into(), b"declined");
            return Ok(());
        }

        let my_name = self.my_name.lock().unwrap().clone();
        let my_identity = self.my_identity.lock().unwrap().clone();

        // Try to establish the call's MLS group from the caller's KeyPackage.
        // Fail-soft: if anything goes wrong we still connect, transport-only.
        let mut keys: Option<VoxKeys> = None;
        let mut welcome = String::new();
        let mut can_mls = false;
        if !hello.key_package.is_empty() {
            match mls_callee(&hello.call_id, &my_identity, &hello.key_package) {
                Ok((w, k)) => {
                    welcome = w;
                    keys = Some(k);
                    can_mls = true;
                }
                Err(e) => eprintln!("[vox] callee MLS failed — falling back to transport: {e}"),
            }
        }

        write_frame(&mut send, &Control { kind: "accept".into(), name: my_name, welcome, can_mls }).await?;

        // The caller's Ready frame is authoritative for the final mode.
        let ready: Ready = read_frame(&mut recv).await?;
        let keys = if ready.enc == "mls" { keys } else { None };
        self.run_call(conn, hello.name, keys).await
    }

    // ── outbound (caller) ─────────────────────────────────────────────────────
    async fn dial(self, endpoint: Endpoint, addr: EndpointAddr, call_id: String) -> Result<()> {
        emit_state(&self.app, "calling", None);
        let conn = endpoint.connect(addr, VOX_ALPN).await?;
        let (mut send, mut recv) = conn.open_bi().await?;
        let my_name = self.my_name.lock().unwrap().clone();
        let my_identity = self.my_identity.lock().unwrap().clone();

        // Prepare our MLS KeyPackage (fail-soft: empty ⇒ transport-only).
        let mut mls = mls_caller_start(&call_id, &my_identity).ok();
        let key_package = mls.as_ref().map(|(_, kp)| kp.clone()).unwrap_or_default();
        write_frame(&mut send, &Hello { name: my_name, call_id: call_id.clone(), key_package }).await?;

        let ctrl: Control = read_frame(&mut recv).await?;
        if ctrl.kind != "accept" {
            emit_state(&self.app, "ended", None);
            conn.close(0u32.into(), b"declined");
            return Ok(());
        }
        let peer = if ctrl.name.is_empty() { "Peer".to_string() } else { ctrl.name };

        // Complete MLS if the callee could, otherwise fall back to transport.
        let mut keys: Option<VoxKeys> = None;
        if ctrl.can_mls && !ctrl.welcome.is_empty() {
            if let Some((mut session, _)) = mls.take() {
                match mls_caller_join(&mut session, &ctrl.welcome, &call_id) {
                    Ok(k) => keys = Some(k),
                    Err(e) => eprintln!("[vox] caller MLS join failed — falling back to transport: {e}"),
                }
            }
        }
        let enc = if keys.is_some() { "mls" } else { "transport" };
        write_frame(&mut send, &Ready { enc: enc.into() }).await?;
        self.run_call(conn, peer, keys).await
    }

    // ── shared call loop ──────────────────────────────────────────────────────
    async fn run_call(self, conn: Connection, peer_name: String, keys: Option<VoxKeys>) -> Result<()> {
        let my_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.conn.lock().unwrap() = Some(conn.clone());
        self.mute.store(false, Ordering::SeqCst);
        let encrypted = keys.is_some();
        emit_connected(&self.app, &peer_name, encrypted);

        // capture (mic → Opus) on its own thread → frame_rx → datagrams
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Bytes>();
        let cap_stop = Arc::new(AtomicBool::new(false));
        spawn_capture_thread(frame_tx, self.mute.clone(), cap_stop.clone());

        // playback (Opus → speaker) on its own thread, fed raw packets
        let (pkt_tx, pkt_rx) = stdmpsc::channel::<Bytes>();
        let out_stop = Arc::new(AtomicBool::new(false));
        spawn_playback_thread(self.app.clone(), pkt_rx, out_stop.clone());

        eprintln!(
            "[vox] call connected (encryption={}, max_datagram_size={:?})",
            if encrypted { "mls" } else { "transport" },
            conn.max_datagram_size()
        );

        // Split the keys per task (each cipher owned by exactly one direction).
        let (send_cipher, recv_cipher) = match keys {
            Some(k) => (Some(k.send), Some(k.recv)),
            None => (None, None),
        };

        let send_conn = conn.clone();
        let send_task = tauri::async_runtime::spawn(async move {
            let mut counter: u64 = 0;
            let mut logged_err = false;
            while let Some(frame) = frame_rx.recv().await {
                // mls: [counter u64][ChaCha20-Poly1305(μ-law)];  transport: [seq u16][μ-law]
                let dg = match &send_cipher {
                    Some(cipher) => {
                        let nonce = nonce_from_counter(counter);
                        match cipher.encrypt(Nonce::from_slice(&nonce), frame.as_ref()) {
                            Ok(ct) => {
                                let mut d = Vec::with_capacity(8 + ct.len());
                                d.extend_from_slice(&counter.to_be_bytes());
                                d.extend_from_slice(&ct);
                                d
                            }
                            Err(_) => {
                                counter = counter.wrapping_add(1);
                                continue;
                            }
                        }
                    }
                    None => {
                        let mut d = Vec::with_capacity(frame.len() + 2);
                        d.extend_from_slice(&(counter as u16).to_le_bytes());
                        d.extend_from_slice(&frame);
                        d
                    }
                };
                if let Err(e) = send_conn.send_datagram(Bytes::from(dg)) {
                    if !logged_err {
                        eprintln!("[vox] send_datagram failed (audio won't flow): {e}");
                        logged_err = true;
                    }
                }
                counter = counter.wrapping_add(1);
            }
        });

        let recv_conn = conn.clone();
        let recv_task = tauri::async_runtime::spawn(async move {
            let mut first = true;
            while let Ok(data) = recv_conn.read_datagram().await {
                let payload: Option<Bytes> = match &recv_cipher {
                    Some(cipher) => {
                        if data.len() < 8 + 16 {
                            None // too short to hold counter + AEAD tag
                        } else {
                            let mut c = [0u8; 8];
                            c.copy_from_slice(&data[..8]);
                            let nonce = nonce_from_counter(u64::from_be_bytes(c));
                            cipher
                                .decrypt(Nonce::from_slice(&nonce), &data[8..])
                                .ok()
                                .map(Bytes::from)
                        }
                    }
                    None => {
                        if data.len() <= 2 {
                            None
                        } else {
                            Some(Bytes::copy_from_slice(&data[2..]))
                        }
                    }
                };
                let Some(pt) = payload else { continue };
                if first {
                    eprintln!("[vox] first audio datagram decoded ({} bytes)", pt.len());
                    first = false;
                }
                if pkt_tx.send(pt).is_err() {
                    break;
                }
            }
        });

        // Hold the call open until the connection closes or we're torn down.
        loop {
            if self.generation.load(Ordering::SeqCst) != my_gen {
                break;
            }
            tokio::select! {
                _ = conn.closed() => break,
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }
        }

        cap_stop.store(true, Ordering::SeqCst);
        out_stop.store(true, Ordering::SeqCst);
        send_task.abort();
        recv_task.abort();
        conn.close(0u32.into(), b"bye");
        {
            let mut held = self.conn.lock().unwrap();
            if held.as_ref().is_some_and(|c| c.stable_id() == conn.stable_id()) {
                *held = None;
            }
        }
        emit_state(&self.app, "ended", None);
        Ok(())
    }
}

// ── cpal: capture (mic → μ-law frames) ───────────────────────────────────────

fn spawn_capture_thread(frame_tx: mpsc::UnboundedSender<Bytes>, mute: Arc<AtomicBool>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            eprintln!("[vox] no input device");
            return;
        };
        // Use the device's native config (exactly like the WAV recorder) and
        // resample to 48 kHz for the wire — never require a specific rate.
        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[vox] no input config: {e}");
                return;
            }
        };
        let ch = config.channels() as usize;
        let in_rate = config.sample_rate().0 as usize;
        let cap_chunk = (in_rate / 100).max(1); // 10 ms at the device's native rate
        let ring: Arc<StdMutex<VecDeque<f32>>> = Arc::new(StdMutex::new(VecDeque::new()));

        macro_rules! build {
            ($T:ty, $conv:expr) => {
                device.build_input_stream(
                    &config.clone().into(),
                    {
                        let ring = ring.clone();
                        move |data: &[$T], _: &_| {
                            let mut buf = ring.lock().unwrap();
                            if ch == 1 {
                                buf.extend(data.iter().map($conv));
                            } else {
                                for f in data.chunks(ch) {
                                    let s: f32 = f.iter().map($conv).sum::<f32>() / ch as f32;
                                    buf.push_back(s);
                                }
                            }
                        }
                    },
                    |e| eprintln!("[vox] input stream error: {e}"),
                    None,
                )
            };
        }

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => build!(f32, |&s: &f32| s),
            cpal::SampleFormat::I16 => build!(i16, |&s: &i16| s as f32 / i16::MAX as f32),
            cpal::SampleFormat::U16 => build!(u16, |&s: &u16| (s as f32 / u16::MAX as f32) * 2.0 - 1.0),
            fmt => {
                eprintln!("[vox] unsupported input format: {fmt:?}");
                return;
            }
        };
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[vox] build_input_stream: {e}");
                return;
            }
        };
        if let Err(e) = stream.play() {
            eprintln!("[vox] input play: {e}");
            return;
        }
        eprintln!(
            "[vox] capture started: dev={} {}Hz {}ch {:?}",
            device.name().unwrap_or_else(|_| "?".into()),
            config.sample_rate().0,
            ch,
            config.sample_format()
        );

        let mut payload = [0u8; FRAME_SAMPLES];
        let mut sent = 0u64;
        let mut last_log = Instant::now();

        while !stop.load(Ordering::SeqCst) {
            // Drain every complete 10 ms frame currently buffered.
            loop {
                let chunk: Option<Vec<f32>> = {
                    let mut buf = ring.lock().unwrap();
                    // Guard against runaway backlog (e.g. if the loop stalls).
                    if buf.len() > in_rate {
                        buf.clear();
                    }
                    if buf.len() >= cap_chunk {
                        Some(buf.drain(..cap_chunk).collect())
                    } else {
                        None
                    }
                };
                let Some(chunk) = chunk else { break };
                if mute.load(Ordering::SeqCst) {
                    continue; // drained but not transmitted → peer hears silence
                }
                // Native-rate 10 ms chunk → 48 kHz 480-sample frame → μ-law.
                let frame48 = if in_rate == SAMPLE_RATE as usize {
                    chunk
                } else {
                    resample_linear(&chunk, FRAME_SAMPLES)
                };
                for (i, slot) in payload.iter_mut().enumerate() {
                    let s = frame48.get(i).copied().unwrap_or(0.0);
                    *slot = linear_to_ulaw((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                }
                let _ = frame_tx.send(Bytes::copy_from_slice(&payload));
                sent += 1;
            }
            if last_log.elapsed() >= Duration::from_secs(2) {
                if sent == 0 {
                    eprintln!("[vox] capture: NO mic frames in 2s — mic silent/busy/denied?");
                } else {
                    eprintln!("[vox] capture: {sent} frames sent in 2s");
                }
                sent = 0;
                last_log = Instant::now();
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        // stream dropped here → capture stops
    });
}

// ── equalizer: incoming-audio spectrum ───────────────────────────────────────

/// Hann-windowed FFT of `window` reduced to `SPECTRUM_BARS` log-spaced bands,
/// auto-gained against a decaying running peak so the bars stay lively at any
/// volume. Each band is normalised to 0.0..=1.0.
fn compute_spectrum(window: &[f32], fft: &Arc<dyn Fft<f32>>, running_peak: &mut f32) -> Vec<f32> {
    let n = window.len();
    let mut buf: Vec<Complex<f32>> = window
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            let hann = 0.5 - 0.5 * (2.0 * PI * i as f32 / (n as f32 - 1.0)).cos();
            Complex { re: s * hann, im: 0.0 }
        })
        .collect();
    fft.process(&mut buf);

    let half = n / 2;
    let min_bin = 1.0f32;
    let max_bin = half as f32;
    let mut bands = vec![0f32; SPECTRUM_BARS];
    let mut frame_peak = 1e-6f32;
    for (b, slot) in bands.iter_mut().enumerate() {
        let lo = (min_bin * (max_bin / min_bin).powf(b as f32 / SPECTRUM_BARS as f32)).floor() as usize;
        let hi = (min_bin * (max_bin / min_bin).powf((b as f32 + 1.0) / SPECTRUM_BARS as f32)).ceil() as usize;
        let hi = hi.max(lo + 1).min(half);
        let mut sum = 0f32;
        for k in lo..hi {
            sum += buf[k].norm();
        }
        let mag = (sum / (hi - lo) as f32).sqrt(); // perceptual-ish
        *slot = mag;
        frame_peak = frame_peak.max(mag);
    }
    *running_peak = (*running_peak * 0.92).max(frame_peak);
    let denom = running_peak.max(1e-4);
    for v in bands.iter_mut() {
        *v = (*v / denom).clamp(0.0, 1.0);
    }
    bands
}

// ── cpal: playback (Opus packets → speaker) ──────────────────────────────────

fn spawn_playback_thread(app: AppHandle, pkt_rx: stdmpsc::Receiver<Bytes>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            eprintln!("[vox] no output device");
            return;
        };
        // Native output config (never require 48 kHz); we resample the 48 kHz
        // wire stream down/up to whatever the speaker wants.
        let config = match device.default_output_config() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[vox] no output config: {e}");
                return;
            }
        };
        let ch = config.channels() as usize;
        let out_rate = config.sample_rate().0 as usize;
        let pcm: Arc<StdMutex<VecDeque<f32>>> = Arc::new(StdMutex::new(VecDeque::new()));

        macro_rules! build {
            ($T:ty, $from:expr) => {
                device.build_output_stream(
                    &config.clone().into(),
                    {
                        let pcm = pcm.clone();
                        move |data: &mut [$T], _: &_| {
                            let mut buf = pcm.lock().unwrap();
                            for frame in data.chunks_mut(ch) {
                                let s = buf.pop_front().unwrap_or(0.0);
                                let v = $from(s);
                                for o in frame.iter_mut() {
                                    *o = v;
                                }
                            }
                        }
                    },
                    |e| eprintln!("[vox] output stream error: {e}"),
                    None,
                )
            };
        }

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => build!(f32, |s: f32| s),
            cpal::SampleFormat::I16 => build!(i16, |s: f32| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16),
            cpal::SampleFormat::U16 => build!(u16, |s: f32| (((s.clamp(-1.0, 1.0) + 1.0) * 0.5) * u16::MAX as f32) as u16),
            fmt => {
                eprintln!("[vox] unsupported output format: {fmt:?}");
                return;
            }
        };
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[vox] build_output_stream: {e}");
                return;
            }
        };
        if let Err(e) = stream.play() {
            eprintln!("[vox] output play: {e}");
            return;
        }
        eprintln!(
            "[vox] playback started: dev={} {}Hz {}ch {:?}",
            device.name().unwrap_or_else(|_| "?".into()),
            config.sample_rate().0,
            ch,
            config.sample_format()
        );

        // Equalizer analysis: accumulate decoded samples and emit a spectrum
        // ~30×/s while a call is live.
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let mut analysis: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
        let mut running_peak = 1e-4f32;
        let mut last_emit = Instant::now();
        let mut got = 0u64;
        let mut last_log = Instant::now();

        while !stop.load(Ordering::SeqCst) {
            if last_log.elapsed() >= Duration::from_secs(2) {
                if got == 0 {
                    eprintln!("[vox] playback: NO audio packets in 2s — datagrams not arriving");
                } else {
                    eprintln!("[vox] playback: {got} packets played in 2s");
                }
                got = 0;
                last_log = Instant::now();
            }
            match pkt_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(packet) => {
                    got += 1;
                    // μ-law → f32 @ 48 kHz; the equalizer analyses this 48 kHz domain.
                    let frame48: Vec<f32> =
                        packet.iter().map(|&b| ulaw_to_linear(b) as f32 / i16::MAX as f32).collect();
                    analysis.extend_from_slice(&frame48);
                    // Resample to the speaker's native rate before enqueueing.
                    let out_samples = if out_rate == SAMPLE_RATE as usize {
                        frame48.clone()
                    } else {
                        let n = (frame48.len() * out_rate / SAMPLE_RATE as usize).max(1);
                        resample_linear(&frame48, n)
                    };
                    {
                        let mut buf = pcm.lock().unwrap();
                        if buf.len() > MAX_BUFFERED_SAMPLES {
                            buf.clear(); // we've drifted too far behind — resync
                        }
                        buf.extend(out_samples);
                    }
                    if analysis.len() >= FFT_SIZE && last_emit.elapsed() >= Duration::from_millis(33) {
                        let start = analysis.len() - FFT_SIZE;
                        let bands = compute_spectrum(&analysis[start..], &fft, &mut running_peak);
                        let _ = app.emit("vox://spectrum", serde_json::json!({ "bands": bands }));
                        analysis.clear();
                        last_emit = Instant::now();
                    } else if analysis.len() > FFT_SIZE * 4 {
                        let drop_to = analysis.len() - FFT_SIZE;
                        analysis.drain(..drop_to); // bound memory if we're not emitting
                    }
                }
                Err(stdmpsc::RecvTimeoutError::Timeout) => {}
                Err(stdmpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        // stream dropped here → playback stops
    });
}

// ── tauri commands ───────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct VoxCreated {
    ticket: String,
    node_id: String,
    /// The call id embedded in the ticket — lets a room-flow initiator match the
    /// inbound `vox://incoming` it triggered and auto-accept it.
    call_id: String,
}

/// Open a call slot (we are the callee/listener) and return a shareable ticket. The
/// ticket embeds our MAIN endpoint address, so a joiner reaches us at the same
/// NodeId our contacts/chat already use.
#[tauri::command]
pub async fn vox_create(
    app: AppHandle,
    vox: State<'_, VoxState>,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    name: String,
    identity: String,
) -> Result<VoxCreated, String> {
    check_network_policy(&app, &config)?;
    let endpoint = crate::p2p_iroh::vox_endpoint(&app, &p2p, None)
        .await
        .map_err(|e| e.to_string())?;
    let shared = vox.shared(&app);
    *shared.my_name.lock().unwrap() = name;
    *shared.my_identity.lock().unwrap() = identity;
    let node_id = endpoint.id().to_string();
    let call_id = format!("{}-{}", node_id, now_millis());
    let ticket = VoxTicket { call_id: call_id.clone(), peer: endpoint.addr() }.encode();
    Ok(VoxCreated { ticket, node_id, call_id })
}

/// Dial a callee from their ticket (we are the caller). Returns once dialing has
/// started; progress arrives via `vox://state`.
#[tauri::command]
pub async fn vox_join(
    app: AppHandle,
    vox: State<'_, VoxState>,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    ticket: String,
    name: String,
    identity: String,
) -> Result<(), String> {
    check_network_policy(&app, &config)?;
    let ticket = VoxTicket::decode(&ticket).map_err(|e| format!("invalid ticket: {e}"))?;
    // Seed the ticket's embedded address into discovery so the dial can resolve it.
    let endpoint = crate::p2p_iroh::vox_endpoint(&app, &p2p, Some(ticket.peer.clone()))
        .await
        .map_err(|e| e.to_string())?;
    let shared = vox.shared(&app);
    *shared.my_name.lock().unwrap() = name;
    *shared.my_identity.lock().unwrap() = identity;
    let call_id = ticket.call_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = shared.clone().dial(endpoint, ticket.peer, call_id).await {
            eprintln!("[vox] dial failed: {e}");
            emit_state(&shared.app, "error", None);
        }
    });
    Ok(())
}

/// Dial a callee by their NodeId (no ticket) — a saved contact or a DHT nickname
/// claim. The address is resolved on demand via n0/DHT discovery; the callee still
/// rings (vox://incoming).
#[tauri::command]
pub async fn vox_call_node(
    app: AppHandle,
    vox: State<'_, VoxState>,
    config: State<'_, AppConfigState>,
    p2p: State<'_, P2pState>,
    node_id: String,
    name: String,
    identity: String,
) -> Result<(), String> {
    check_network_policy(&app, &config)?;
    let target: EndpointId = node_id.parse().map_err(|_| "invalid node id".to_string())?;
    let endpoint = crate::p2p_iroh::vox_endpoint(&app, &p2p, None)
        .await
        .map_err(|e| e.to_string())?;
    let shared = vox.shared(&app);
    *shared.my_name.lock().unwrap() = name;
    *shared.my_identity.lock().unwrap() = identity;
    // Address-less EndpointAddr — `endpoint.connect` triggers discovery.
    let addr = EndpointAddr::from_parts(target, []);
    let call_id = format!("{}-{}", node_id, now_millis());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = shared.clone().dial(endpoint, addr, call_id).await {
            eprintln!("[vox] dial-by-node failed: {e}");
            emit_state(&shared.app, "error", None);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn vox_accept(app: AppHandle, vox: State<'_, VoxState>) -> Result<(), String> {
    if let Some(tx) = vox.shared(&app).pending.lock().unwrap().take() {
        let _ = tx.send(true);
    }
    Ok(())
}

#[tauri::command]
pub async fn vox_decline(app: AppHandle, vox: State<'_, VoxState>) -> Result<(), String> {
    if let Some(tx) = vox.shared(&app).pending.lock().unwrap().take() {
        let _ = tx.send(false);
    }
    Ok(())
}

#[tauri::command]
pub async fn vox_hangup(app: AppHandle, vox: State<'_, VoxState>) -> Result<(), String> {
    let shared = vox.shared(&app);
    shared.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(tx) = shared.pending.lock().unwrap().take() {
        let _ = tx.send(false);
    }
    if let Some(conn) = shared.conn.lock().unwrap().take() {
        conn.close(0u32.into(), b"hangup");
    }
    Ok(())
}

#[tauri::command]
pub async fn vox_set_mute(app: AppHandle, vox: State<'_, VoxState>, muted: bool) -> Result<(), String> {
    vox.shared(&app).mute.store(muted, Ordering::SeqCst);
    Ok(())
}

/// Tear down any live/pending call (airplane / Tor toggle / profile switch). The
/// main endpoint itself is owned and closed by p2p_iroh.
pub async fn shutdown(app: &AppHandle, vox: &VoxState) {
    let shared = vox.0.lock().unwrap().clone();
    if let Some(shared) = shared {
        shared.generation.fetch_add(1, Ordering::SeqCst);
        let mut active = false;
        if let Some(tx) = shared.pending.lock().unwrap().take() {
            let _ = tx.send(false);
            active = true;
        }
        if let Some(conn) = shared.conn.lock().unwrap().take() {
            conn.close(0u32.into(), b"shutdown");
            active = true;
        }
        if active {
            emit_state(app, "ended", None);
        }
    }
}

/// Whether a call is live or ringing — the lock watchdog (vault.rs) treats this
/// as presence so its fallback never hangs up a call the user is actually on.
/// Never panics: it runs inside the watchdog's forever-loop, where an unwrap on a
/// poisoned lock would kill the fallback silently for the rest of the process. A
/// lock we can't read reads as "no call", so the watchdog stays free to lock.
pub fn in_call(app: &AppHandle) -> bool {
    use tauri::Manager;
    let Some(shared) = app.state::<VoxState>().0.lock().ok().and_then(|s| s.clone()) else {
        return false;
    };
    let pending = shared.pending.lock().map(|p| p.is_some()).unwrap_or(false);
    let connected = shared.conn.lock().map(|c| c.is_some()).unwrap_or(false);
    pending || connected
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulaw_round_trips_within_quantisation() {
        // μ-law is lossy, but should stay close for a range of amplitudes and
        // preserve sign + silence exactly.
        assert_eq!(ulaw_to_linear(linear_to_ulaw(0)), 0);
        for &v in &[-32768i16, -20000, -4000, -100, 100, 4000, 20000, 32767] {
            let decoded = ulaw_to_linear(linear_to_ulaw(v));
            assert_eq!(decoded.signum(), v.signum(), "sign preserved for {v}");
            let err = (decoded as i32 - v as i32).abs();
            // Worst-case μ-law step near full scale is a few percent.
            assert!(err <= (v.unsigned_abs() as i32 / 8) + 256, "‖{v}-{decoded}‖={err}");
        }
    }

    #[test]
    fn frame_round_trips() {
        let bytes = frame_bytes(&Hello { name: "alice".into(), call_id: "c1".into(), key_package: String::new() });
        // 4-byte LE length prefix + JSON body.
        let len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        assert_eq!(len, bytes.len() - 4);
        let parsed: Hello = serde_json::from_slice(&bytes[4..]).expect("decode body");
        assert_eq!(parsed.name, "alice");
        assert_eq!(parsed.call_id, "c1");
    }

    #[test]
    fn control_decline_is_not_accept() {
        let c = Control { kind: "decline".into(), ..Default::default() };
        assert_ne!(c.kind, "accept");
        assert!(!c.can_mls);
    }

    // Full MLS → exporter → ChaCha20-Poly1305 pipeline, in-process (no audio/network):
    // both peers derive matching directional keys, frames round-trip each way, and
    // tampering is rejected.
    #[test]
    fn mls_keyed_audio_round_trips_both_directions_and_rejects_tampering() {
        let (mut caller_session, kp) = mls_caller_start("call-xyz", "alice").unwrap();
        let (welcome, callee_keys) = mls_callee("call-xyz", "bob", &kp).unwrap();
        let caller_keys = mls_caller_join(&mut caller_session, &welcome, "call-xyz").unwrap();

        let frame = [0xABu8; FRAME_SAMPLES];
        let nonce = nonce_from_counter(7);
        let n = Nonce::from_slice(&nonce);

        // caller → callee (c2s)
        let ct = caller_keys.send.encrypt(n, frame.as_ref()).unwrap();
        assert_eq!(callee_keys.recv.decrypt(n, ct.as_ref()).unwrap(), frame);

        // callee → caller (s2c)
        let ct2 = callee_keys.send.encrypt(n, frame.as_ref()).unwrap();
        assert_eq!(caller_keys.recv.decrypt(n, ct2.as_ref()).unwrap(), frame);

        // tamper → authentication fails
        let mut bad = ct.clone();
        bad[0] ^= 0x01;
        assert!(callee_keys.recv.decrypt(n, bad.as_ref()).is_err());

        // wrong direction key can't decrypt (c2s ciphertext with the s2c recv key)
        assert!(caller_keys.recv.decrypt(n, ct.as_ref()).is_err());
    }

    #[test]
    fn resample_changes_length_and_preserves_endpoints() {
        let src: Vec<f32> = (0..441).map(|i| i as f32 / 440.0).collect(); // 10 ms @ 44.1 kHz
        let dst = resample_linear(&src, FRAME_SAMPLES); // → 10 ms @ 48 kHz
        assert_eq!(dst.len(), FRAME_SAMPLES);
        assert!((dst[0] - 0.0).abs() < 1e-6, "first sample preserved");
        assert!((dst[FRAME_SAMPLES - 1] - 1.0).abs() < 1e-6, "last sample preserved");
        // identity when lengths match
        assert_eq!(resample_linear(&src, src.len()), src);
    }

    #[test]
    fn spectrum_is_flat_for_silence_and_peaks_for_a_tone() {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);

        let mut peak = 1e-4f32;
        let silent = vec![0f32; FFT_SIZE];
        let s = compute_spectrum(&silent, &fft, &mut peak);
        assert_eq!(s.len(), SPECTRUM_BARS);
        assert!(s.iter().cloned().fold(0.0, f32::max) < 0.05, "silence is flat");

        let mut peak2 = 1e-4f32;
        let tone: Vec<f32> = (0..FFT_SIZE)
            .map(|i| (2.0 * PI * 1000.0 * i as f32 / SAMPLE_RATE as f32).sin())
            .collect();
        let t = compute_spectrum(&tone, &fft, &mut peak2);
        let max = t.iter().cloned().fold(0.0, f32::max);
        assert!(max > 0.8, "tone produces a dominant band (max={max})");
        let loud = t.iter().filter(|&&v| v > 0.5).count();
        assert!(loud <= 6, "energy is concentrated in a few bands (loud={loud})");
    }

    // Drives the real iroh network path Vox depends on — two endpoints connect
    // over VOX_ALPN, run the bi-stream hello/accept handshake, and exchange a
    // datagram — without cpal (no audio devices needed). This mirrors what
    // VoxProtocol::handle_incoming and VoxShared::dial do on the wire.
    #[tokio::test]
    async fn two_endpoints_handshake_and_exchange_a_datagram() -> Result<()> {
        use iroh::{endpoint::presets, RelayMode};

        // ── callee ────────────────────────────────────────────────────────────
        let server = Endpoint::builder(presets::Minimal)
            .alpns(vec![VOX_ALPN.to_vec()])
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await?;
        let server_addr = server.addr();

        let srv = tokio::spawn(async move {
            let incoming = server.accept().await.expect("incoming connection");
            let conn = incoming.accept().expect("accept").await.expect("connection");
            let (mut send, mut recv) = conn.accept_bi().await.expect("accept_bi");
            let hello: Hello = read_frame(&mut recv).await.expect("read hello");
            assert_eq!(hello.name, "caller");
            write_frame(&mut send, &Control { kind: "accept".into(), name: "callee".into(), ..Default::default() })
                .await
                .expect("write accept");
            // Echo datagrams until the caller hangs up.
            while let Ok(dg) = conn.read_datagram().await {
                let _ = conn.send_datagram(dg);
            }
        });

        // ── caller ────────────────────────────────────────────────────────────
        let client = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .bind()
            .await?;
        let conn = tokio::time::timeout(Duration::from_secs(10), client.connect(server_addr, VOX_ALPN))
            .await
            .map_err(|_| anyhow!("connect timed out"))??;

        let (mut send, mut recv) = conn.open_bi().await?;
        write_frame(&mut send, &Hello { name: "caller".into(), call_id: "c".into(), key_package: String::new() }).await?;
        let ctrl: Control = read_frame(&mut recv).await?;
        assert_eq!(ctrl.kind, "accept");
        assert_eq!(ctrl.name, "callee");

        // Datagrams are unreliable — send a few until one round-trips.
        let payload = Bytes::from_static(&[9u8, 8, 7, 6]);
        let mut echoed = None;
        for _ in 0..50 {
            let _ = conn.send_datagram(payload.clone());
            if let Ok(Ok(dg)) =
                tokio::time::timeout(Duration::from_millis(100), conn.read_datagram()).await
            {
                echoed = Some(dg);
                break;
            }
        }
        assert_eq!(echoed.as_deref(), Some(payload.as_ref()), "datagram echoed back");

        conn.close(0u32.into(), b"bye");
        let _ = tokio::time::timeout(Duration::from_secs(2), srv).await;
        Ok(())
    }
}
