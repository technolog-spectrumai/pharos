// Real-time 1:1 voice calls over iroh (QUIC), end-to-end encrypted by iroh's
// TLS 1.3 transport (peers authenticated by node id). No WebRTC / STUN / TURN.
//
// A dedicated iroh node accepts a custom ALPN (`enigma/vox/0`). The callee shares
// a `VoxTicket` (its EndpointAddr, base32-encoded) out of band — pasted or as a QR.
// The caller `endpoint.connect()`s to it, opens one control bi-stream for the
// hello / accept / decline handshake, and then audio flows as Opus frames over
// unreliable QUIC datagrams (no head-of-line blocking).
//
// Audio is captured/played natively with cpal (already a dep) — so no webview
// getUserMedia is involved. cpal::Stream is !Send, so capture and playback each
// live on their own dedicated OS thread (mirrors the WAV recorder in lib.rs),
// talking to the async QUIC tasks over channels.
//
// Frames are companded with G.711 μ-law (pure Rust, no native codec dep): 1 byte
// per sample, halving bandwidth and keeping a 10 ms frame well under the QUIC
// datagram size limit. Clear for speech; can be swapped for Opus later if a
// libopus build toolchain is available on every target.
//
// Emits `vox://state` (call progress) and `vox://incoming` (ring) events.

use std::collections::VecDeque;
use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc as stdmpsc;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use bytes::Bytes;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, RelayMode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, Mutex};

const VOX_ALPN: &[u8] = b"enigma/vox/0";
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

#[derive(Default)]
pub struct VoxState(pub Mutex<Option<VoxNode>>);

pub struct VoxNode {
    endpoint: Endpoint,
    _router: Router,
    shared: VoxShared,
}

/// Everything the inbound protocol handler and the commands both need, behind
/// `Arc`s so it can be cloned into the router and the per-call tasks.
#[derive(Clone)]
struct VoxShared {
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
}

#[derive(Serialize, Deserialize)]
struct Control {
    kind: String, // "accept" | "decline"
    #[serde(default)]
    name: String,
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

fn emit_incoming(app: &AppHandle, from_name: &str, node_id: &str) {
    let _ = app.emit(
        "vox://incoming",
        serde_json::json!({ "from_name": from_name, "node_id": node_id }),
    );
}

// ── lifecycle ────────────────────────────────────────────────────────────────

async fn ensure_started(app: &AppHandle, state: &VoxState) -> Result<()> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Ok(());
    }
    let endpoint = Endpoint::builder(presets::N0)
        .relay_mode(RelayMode::Default)
        .bind()
        .await
        .map_err(|e| anyhow!("vox iroh bind failed: {e}"))?;
    let shared = VoxShared {
        app: app.clone(),
        generation: Arc::new(AtomicU64::new(0)),
        mute: Arc::new(AtomicBool::new(false)),
        pending: Arc::new(StdMutex::new(None)),
        conn: Arc::new(StdMutex::new(None)),
        my_name: Arc::new(StdMutex::new(String::new())),
    };
    let router = Router::builder(endpoint.clone())
        .accept(VOX_ALPN, VoxProtocol { shared: shared.clone() })
        .spawn();
    *guard = Some(VoxNode { endpoint, _router: router, shared });
    Ok(())
}

// ── inbound (callee) ─────────────────────────────────────────────────────────

#[derive(Clone)]
struct VoxProtocol {
    shared: VoxShared,
}

impl std::fmt::Debug for VoxProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VoxProtocol")
    }
}

impl ProtocolHandler for VoxProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        // The whole call lives inside this future — when it returns, `conn` drops.
        if let Err(e) = self.shared.clone().handle_incoming(conn).await {
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
            let _ = write_frame(&mut send, &Control { kind: "decline".into(), name: String::new() }).await;
            conn.close(0u32.into(), b"busy");
            return Ok(());
        }

        let (tx, rx) = oneshot::channel::<bool>();
        *self.pending.lock().unwrap() = Some(tx);
        emit_incoming(&self.app, &hello.name, &node_id);
        emit_state(&self.app, "ringing", Some(&hello.name));

        // Wait for the user to accept/decline, or for the caller to give up.
        let accepted = tokio::select! {
            d = rx => d.unwrap_or(false),
            _ = conn.closed() => false,
        };
        *self.pending.lock().unwrap() = None;

        if !accepted {
            let _ = write_frame(&mut send, &Control { kind: "decline".into(), name: String::new() }).await;
            emit_state(&self.app, "ended", None);
            conn.close(0u32.into(), b"declined");
            return Ok(());
        }

        let my_name = self.my_name.lock().unwrap().clone();
        write_frame(&mut send, &Control { kind: "accept".into(), name: my_name }).await?;
        self.run_call(conn, hello.name).await
    }

    // ── outbound (caller) ─────────────────────────────────────────────────────
    async fn dial(self, endpoint: Endpoint, addr: EndpointAddr) -> Result<()> {
        emit_state(&self.app, "calling", None);
        let conn = endpoint.connect(addr, VOX_ALPN).await?;
        let (mut send, mut recv) = conn.open_bi().await?;
        let my_name = self.my_name.lock().unwrap().clone();
        write_frame(&mut send, &Hello { name: my_name }).await?;

        let ctrl: Control = read_frame(&mut recv).await?;
        if ctrl.kind != "accept" {
            emit_state(&self.app, "ended", None);
            conn.close(0u32.into(), b"declined");
            return Ok(());
        }
        let peer = if ctrl.name.is_empty() { "Peer".to_string() } else { ctrl.name };
        self.run_call(conn, peer).await
    }

    // ── shared call loop ──────────────────────────────────────────────────────
    async fn run_call(self, conn: Connection, peer_name: String) -> Result<()> {
        let my_gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *self.conn.lock().unwrap() = Some(conn.clone());
        self.mute.store(false, Ordering::SeqCst);
        emit_state(&self.app, "connected", Some(&peer_name));

        // capture (mic → Opus) on its own thread → frame_rx → datagrams
        let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<Bytes>();
        let cap_stop = Arc::new(AtomicBool::new(false));
        spawn_capture_thread(frame_tx, self.mute.clone(), cap_stop.clone());

        // playback (Opus → speaker) on its own thread, fed raw packets
        let (pkt_tx, pkt_rx) = stdmpsc::channel::<Bytes>();
        let out_stop = Arc::new(AtomicBool::new(false));
        spawn_playback_thread(self.app.clone(), pkt_rx, out_stop.clone());

        eprintln!("[vox] call connected (max_datagram_size={:?})", conn.max_datagram_size());

        let send_conn = conn.clone();
        let send_task = tauri::async_runtime::spawn(async move {
            let mut seq: u16 = 0;
            let mut logged_err = false;
            while let Some(frame) = frame_rx.recv().await {
                let mut buf = Vec::with_capacity(frame.len() + 2);
                buf.extend_from_slice(&seq.to_le_bytes());
                buf.extend_from_slice(&frame);
                if let Err(e) = send_conn.send_datagram(Bytes::from(buf)) {
                    if !logged_err {
                        eprintln!("[vox] send_datagram failed (audio won't flow): {e}");
                        logged_err = true;
                    }
                }
                seq = seq.wrapping_add(1);
            }
        });

        let recv_conn = conn.clone();
        let recv_task = tauri::async_runtime::spawn(async move {
            let mut first = true;
            while let Ok(data) = recv_conn.read_datagram().await {
                if data.len() <= 2 {
                    continue;
                }
                if first {
                    eprintln!("[vox] first audio datagram received ({} bytes)", data.len());
                    first = false;
                }
                // Strip the 2-byte sequence prefix; forward the audio packet.
                if pkt_tx.send(Bytes::copy_from_slice(&data[2..])).is_err() {
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
}

/// Open a call slot (we are the callee) and return a shareable ticket + QR source.
#[tauri::command]
pub async fn vox_create(app: AppHandle, vox: State<'_, VoxState>, name: String) -> Result<VoxCreated, String> {
    ensure_started(&app, &vox).await.map_err(|e| e.to_string())?;
    let guard = vox.0.lock().await;
    let node = guard.as_ref().ok_or("vox not started")?;
    *node.shared.my_name.lock().unwrap() = name;
    let node_id = node.endpoint.id().to_string();
    let ticket = VoxTicket {
        call_id: format!("{}-{}", node_id, now_millis()),
        peer: node.endpoint.addr(),
    }
    .encode();
    Ok(VoxCreated { ticket, node_id })
}

/// Dial a callee from their ticket (we are the caller). Returns once dialing has
/// started; progress arrives via `vox://state`.
#[tauri::command]
pub async fn vox_join(app: AppHandle, vox: State<'_, VoxState>, ticket: String, name: String) -> Result<(), String> {
    ensure_started(&app, &vox).await.map_err(|e| e.to_string())?;
    let ticket = VoxTicket::decode(&ticket).map_err(|e| format!("invalid ticket: {e}"))?;
    let (endpoint, shared) = {
        let guard = vox.0.lock().await;
        let node = guard.as_ref().ok_or("vox not started")?;
        *node.shared.my_name.lock().unwrap() = name;
        (node.endpoint.clone(), node.shared.clone())
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) = shared.clone().dial(endpoint, ticket.peer).await {
            eprintln!("[vox] dial failed: {e}");
            emit_state(&shared.app, "error", None);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn vox_accept(vox: State<'_, VoxState>) -> Result<(), String> {
    let guard = vox.0.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(tx) = node.shared.pending.lock().unwrap().take() {
            let _ = tx.send(true);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn vox_decline(vox: State<'_, VoxState>) -> Result<(), String> {
    let guard = vox.0.lock().await;
    if let Some(node) = guard.as_ref() {
        if let Some(tx) = node.shared.pending.lock().unwrap().take() {
            let _ = tx.send(false);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn vox_hangup(vox: State<'_, VoxState>) -> Result<(), String> {
    let guard = vox.0.lock().await;
    if let Some(node) = guard.as_ref() {
        node.shared.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = node.shared.pending.lock().unwrap().take() {
            let _ = tx.send(false);
        }
        if let Some(conn) = node.shared.conn.lock().unwrap().take() {
            conn.close(0u32.into(), b"hangup");
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn vox_set_mute(vox: State<'_, VoxState>, muted: bool) -> Result<(), String> {
    let guard = vox.0.lock().await;
    if let Some(node) = guard.as_ref() {
        node.shared.mute.store(muted, Ordering::SeqCst);
    }
    Ok(())
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
        let bytes = frame_bytes(&Hello { name: "alice".into() });
        // 4-byte LE length prefix + JSON body.
        let len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        assert_eq!(len, bytes.len() - 4);
        let parsed: Hello = serde_json::from_slice(&bytes[4..]).expect("decode body");
        assert_eq!(parsed.name, "alice");
    }

    #[test]
    fn control_decline_is_not_accept() {
        let c = Control { kind: "decline".into(), name: String::new() };
        assert_ne!(c.kind, "accept");
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
        use iroh::endpoint::presets;

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
            write_frame(&mut send, &Control { kind: "accept".into(), name: "callee".into() })
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
        write_frame(&mut send, &Hello { name: "caller".into() }).await?;
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
