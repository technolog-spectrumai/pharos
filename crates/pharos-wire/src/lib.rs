//! The Pharos wire format: what one Enigma says to another, and to Proteus.
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
/// The longest message, in Unicode scalar values (Enigma' composer has the same cap).
pub const MAX_TEXT_CHARS: usize = 1000;
/// The largest frame either side accepts.
/// Room for the largest image ([`MAX_IMAGE_BYTES`]) once padded and sealed.
pub const MAX_FRAME: usize = 256 * 1024;
/// The largest image a message carries, all in one piece. Enigma shrinks a
/// picture (a screenshot) until it fits; over Tor it takes a few seconds.
pub const MAX_IMAGE_BYTES: usize = 192 * 1024;
/// The image formats a message may carry, checked by their first bytes, not
/// by what the sender says they are.
pub const IMAGE_TYPES: [&str; 3] = ["image/webp", "image/jpeg", "image/png"];
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
    #[error("an image of {0} bytes is over the limit of {MAX_IMAGE_BYTES}")]
    ImageTooLarge(usize),
    #[error("not an allowed image (WebP, JPEG or PNG), or not what it says it is: {0}")]
    ImageType(String),
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
    /// A small picture (a screenshot), whole: WebP, JPEG or PNG, at most
    /// [`MAX_IMAGE_BYTES`].
    Image { mime: String, data: Vec<u8> },
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

    /// An image envelope, checked: an allowed format whose bytes match it, within the cap.
    pub fn image(id: MsgId, sent_ms: u64, mime: &str, data: Vec<u8>) -> Result<Self> {
        check_image(mime, &data)?;
        Ok(Self::new(id, sent_ms, Body::Image { mime: mime.to_string(), data }))
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
        match &e.body {
            Body::Text(t) => check_text(t)?,
            Body::Image { mime, data } => check_image(mime, data)?,
            _ => {}
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

/// The format an image's first bytes say it is.
pub fn sniff_image(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// An image must be one of [`IMAGE_TYPES`], be what its bytes say, and fit.
pub fn check_image(mime: &str, data: &[u8]) -> Result<()> {
    if data.is_empty() {
        return Err(WireError::Empty);
    }
    if data.len() > MAX_IMAGE_BYTES {
        return Err(WireError::ImageTooLarge(data.len()));
    }
    if !IMAGE_TYPES.contains(&mime) || sniff_image(data) != Some(mime) {
        return Err(WireError::ImageType(mime.chars().take(40).collect()));
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

    fn png(n: usize) -> Vec<u8> {
        let mut v = b"\x89PNG\r\n\x1a\n".to_vec();
        v.resize(n, 7);
        v
    }

    #[test]
    fn images_round_trip_whole_and_are_checked_by_their_bytes() {
        let e = Envelope::image([1; 16], 0, "image/png", png(MAX_IMAGE_BYTES)).unwrap();
        let bytes = e.encode();
        assert_eq!(Envelope::decode(&bytes).unwrap(), e);
        // Padded to whole 32 KiB blocks, and a sealed one still fits a frame.
        let padded = pad(&bytes);
        assert_eq!(padded.len() % PAD_LARGE, 0);
        assert!(padded.len() + 1024 <= MAX_FRAME, "{} plus MLS overhead fits {MAX_FRAME}", padded.len());

        let webp = [b"RIFF".as_slice(), &[0, 0, 0, 0], b"WEBPVP8 "].concat();
        assert!(Envelope::image([0; 16], 0, "image/webp", webp).is_ok());
        assert!(Envelope::image([0; 16], 0, "image/jpeg", vec![0xff, 0xd8, 0xff, 0xe0]).is_ok());

        assert_eq!(Envelope::image([0; 16], 0, "image/png", png(MAX_IMAGE_BYTES + 1)).unwrap_err(), WireError::ImageTooLarge(MAX_IMAGE_BYTES + 1));
        assert!(matches!(Envelope::image([0; 16], 0, "image/jpeg", png(100)), Err(WireError::ImageType(_))), "a PNG called a JPEG");
        assert!(matches!(Envelope::image([0; 16], 0, "image/svg+xml", b"<svg/>".to_vec()), Err(WireError::ImageType(_))), "no SVG");
        assert!(matches!(Envelope::image([0; 16], 0, "image/gif", b"GIF89a".to_vec()), Err(WireError::ImageType(_))));
        assert_eq!(Envelope::image([0; 16], 0, "image/png", vec![]).unwrap_err(), WireError::Empty);
        // A peer that skipped the checks is refused on our side.
        let forged = Envelope::new([2; 16], 0, Body::Image { mime: "image/png".into(), data: b"<html>".to_vec() });
        assert!(matches!(Envelope::decode(&forged.encode()), Err(WireError::ImageType(_))));
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
