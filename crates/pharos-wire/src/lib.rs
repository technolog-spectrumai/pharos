//! The Pharos wire format: what one Nautes says to another, and to Proteus.
//!
//! Three layers, inside out:
//! 1. [`Envelope`]: a version, a message id, a send time and a [`Body`]
//!    (postcard-encoded).
//! 2. [`pad`] / [`unpad`]: the encoded envelope padded to one of a few fixed
//!    sizes ([`PAD_BUCKETS`]) *before* it is sealed, so the ciphertext's length
//!    says only "short", "medium" or "long".
//! 3. [`write_frame`] / [`read_frame`]: a u32 big-endian length, then the bytes,
//!    refused above [`MAX_FRAME`] before anything is allocated.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The wire version this build speaks. A peer with another version is refused.
pub const VERSION: u8 = 1;
/// The longest message, in Unicode scalar values (Nautes' composer has the same cap).
pub const MAX_TEXT_CHARS: usize = 1000;
/// The largest frame either side accepts.
pub const MAX_FRAME: usize = 64 * 1024;
/// Padded plaintext sizes. 1000 characters of 4-byte UTF-8 fit in the last one.
pub const PAD_BUCKETS: [usize; 3] = [512, 2048, 8192];
/// The padded size for MLS handshake traffic (commits, welcomes), which can be larger.
pub const PAD_LARGE: usize = 32 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WireError {
    #[error("unsupported wire version {0}")]
    Version(u8),
    #[error("message is empty")]
    Empty,
    #[error("message is longer than {MAX_TEXT_CHARS} characters")]
    TooLong,
    #[error("frame of {0} bytes is over the limit")]
    FrameTooLarge(usize),
    #[error("malformed: {0}")]
    Malformed(String),
    #[error("i/o: {0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, WireError>;

/// A 16-byte message id, random per message; acknowledgements and de-duplication use it.
pub type MsgId = [u8; 16];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Body {
    /// A short text message.
    Text(String),
    /// "I have these" — lets the sender drop them from its outbox.
    Ack(Vec<MsgId>),
    /// An MLS handshake message (commit or welcome) for the friendship's group.
    Mls(Vec<u8>),
    /// Keep-alive / presence; carries nothing.
    Ping,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u8,
    pub id: MsgId,
    /// Sender's clock, Unix milliseconds. Shown, never trusted for ordering security.
    pub sent_ms: u64,
    pub body: Body,
}

impl Envelope {
    pub fn new(id: MsgId, sent_ms: u64, body: Body) -> Self {
        Envelope { v: VERSION, id, sent_ms, body }
    }

    /// A text envelope, checked against the length cap.
    pub fn text(id: MsgId, sent_ms: u64, text: &str) -> Result<Self> {
        check_text(text)?;
        Ok(Self::new(id, sent_ms, Body::Text(text.trim().to_string())))
    }

    pub fn encode(&self) -> Vec<u8> {
        postcard::to_stdvec(self).expect("an envelope always encodes")
    }

    /// Decode and validate: right version, text within the cap.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let e: Envelope = postcard::from_bytes(bytes).map_err(|e| WireError::Malformed(e.to_string()))?;
        if e.v != VERSION {
            return Err(WireError::Version(e.v));
        }
        if let Body::Text(t) = &e.body {
            check_text(t)?;
        }
        Ok(e)
    }
}

/// A message must have something in it and be at most [`MAX_TEXT_CHARS`] long.
pub fn check_text(text: &str) -> Result<()> {
    let t = text.trim();
    if t.is_empty() {
        return Err(WireError::Empty);
    }
    if t.chars().count() > MAX_TEXT_CHARS {
        return Err(WireError::TooLong);
    }
    Ok(())
}

/// The bucket `len` (plus the 4-byte length prefix) pads to.
pub fn padded_len(len: usize) -> usize {
    let need = len + 4;
    PAD_BUCKETS.iter().copied().find(|b| *b >= need).unwrap_or_else(|| {
        // Larger than any text bucket: round up to a multiple of PAD_LARGE.
        need.div_ceil(PAD_LARGE) * PAD_LARGE
    })
}

/// `len:u32be || data || zeros` up to [`padded_len`].
pub fn pad(data: &[u8]) -> Vec<u8> {
    let total = padded_len(data.len());
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
    out.resize(total, 0);
    out
}

/// Inverse of [`pad`]; refuses a length past the end or non-zero padding.
pub fn unpad(padded: &[u8]) -> Result<&[u8]> {
    if padded.len() < 4 {
        return Err(WireError::Malformed("short padding".into()));
    }
    let n = u32::from_be_bytes(padded[..4].try_into().unwrap()) as usize;
    let rest = &padded[4..];
    if n > rest.len() {
        return Err(WireError::Malformed("padding length past the end".into()));
    }
    if rest[n..].iter().any(|b| *b != 0) {
        return Err(WireError::Malformed("non-zero padding".into()));
    }
    Ok(&rest[..n])
}

/// Write one length-prefixed frame.
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, data: &[u8]) -> Result<()> {
    if data.len() > MAX_FRAME {
        return Err(WireError::FrameTooLarge(data.len()));
    }
    let io = |e: std::io::Error| WireError::Io(e.to_string());
    w.write_all(&(data.len() as u32).to_be_bytes()).await.map_err(io)?;
    w.write_all(data).await.map_err(io)?;
    w.flush().await.map_err(io)
}

/// Read one frame, refusing a declared length over [`MAX_FRAME`] before allocating.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Vec<u8>> {
    let io = |e: std::io::Error| WireError::Io(e.to_string());
    let mut len = [0u8; 4];
    r.read_exact(&mut len).await.map_err(io)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(WireError::FrameTooLarge(n));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).await.map_err(io)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_round_trips() {
        let e = Envelope::text([7; 16], 1_700_000_000_000, "  hello  ").unwrap();
        assert_eq!(e.body, Body::Text("hello".into()));
        assert_eq!(Envelope::decode(&e.encode()).unwrap(), e);
    }

    #[test]
    fn text_cap_counts_characters_not_bytes() {
        let ok = "ż".repeat(MAX_TEXT_CHARS);
        assert!(Envelope::text([0; 16], 0, &ok).is_ok());
        let long = "a".repeat(MAX_TEXT_CHARS + 1);
        assert_eq!(Envelope::text([0; 16], 0, &long).unwrap_err(), WireError::TooLong);
        assert_eq!(Envelope::text([0; 16], 0, "   ").unwrap_err(), WireError::Empty);
    }

    #[test]
    fn decode_refuses_other_versions_and_overlong_text() {
        let mut e = Envelope::new([1; 16], 0, Body::Ping);
        e.v = 9;
        assert_eq!(Envelope::decode(&e.encode()).unwrap_err(), WireError::Version(9));
        // A peer that skipped the cap still gets refused on our side.
        let e = Envelope::new([1; 16], 0, Body::Text("x".repeat(MAX_TEXT_CHARS + 1)));
        assert_eq!(Envelope::decode(&e.encode()).unwrap_err(), WireError::TooLong);
        assert!(matches!(Envelope::decode(&[0xff, 0xff]), Err(WireError::Malformed(_))));
    }

    #[test]
    fn padding_hides_length_within_a_bucket() {
        let a = pad(&Envelope::text([0; 16], 0, "hi").unwrap().encode());
        let b = pad(&Envelope::text([0; 16], 0, &"x".repeat(400)).unwrap().encode());
        assert_eq!(a.len(), 512);
        assert_eq!(b.len(), 512);
        let longest = Envelope::text([0; 16], u64::MAX, &"𝄞".repeat(MAX_TEXT_CHARS)).unwrap().encode();
        assert_eq!(pad(&longest).len(), 8192);
        assert_eq!(padded_len(9000), PAD_LARGE);
        for data in [&b""[..], b"abc", &[9u8; 600][..]] {
            assert_eq!(unpad(&pad(data)).unwrap(), data);
        }
    }

    #[test]
    fn unpad_refuses_tampering() {
        let mut p = pad(b"abc");
        p[100] = 1;
        assert!(unpad(&p).is_err());
        let mut p = pad(b"abc");
        p[..4].copy_from_slice(&10_000u32.to_be_bytes());
        assert!(unpad(&p).is_err());
        assert!(unpad(&[0, 0]).is_err());
    }

    #[tokio::test]
    async fn frames_round_trip_and_refuse_oversize() {
        let (mut a, mut b) = tokio::io::duplex(1 << 20);
        write_frame(&mut a, b"one").await.unwrap();
        write_frame(&mut a, &[]).await.unwrap();
        assert_eq!(read_frame(&mut b).await.unwrap(), b"one");
        assert_eq!(read_frame(&mut b).await.unwrap(), b"");
        assert!(matches!(write_frame(&mut a, &vec![0; MAX_FRAME + 1]).await, Err(WireError::FrameTooLarge(_))));
        // A hostile length prefix is refused without reading (or allocating) the body.
        use tokio::io::AsyncWriteExt;
        a.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
        assert_eq!(read_frame(&mut b).await.unwrap_err(), WireError::FrameTooLarge(u32::MAX as usize));
    }
}
