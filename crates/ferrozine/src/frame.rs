//! Length-prefixed frames on a byte stream: `u32_le(len) ‖ body`.
//!
//! Two kinds, each with a bound checked *before* the body is allocated, so a
//! peer cannot make the reader reserve gigabytes by sending a large length:
//! control frames are JSON, at most [`MAX_CONTROL`]; data frames are opaque
//! (MLS ciphertext), bounded by the caller.

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{Error, Result};

/// The largest control frame. A KeyPackage is about 1 KiB and a Welcome about
/// 2 KiB, so this is generous.
pub const MAX_CONTROL: usize = 64 * 1024;

/// Write `body` as one frame.
pub async fn write_blob<W: AsyncWrite + Unpin>(w: &mut W, body: &[u8]) -> Result<()> {
    let len = u32::try_from(body.len()).map_err(|_| Error::Protocol("frame over 4 GiB".into()))?;
    w.write_all(&len.to_le_bytes()).await?;
    w.write_all(body).await?;
    Ok(())
}

/// Read one frame of at most `max` bytes. `Ok(None)` is a clean end of stream
/// before the frame began; an end of stream inside a frame is an error.
pub async fn read_blob<R: AsyncRead + Unpin>(r: &mut R, max: usize) -> Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let n = u32::from_le_bytes(len) as usize;
    if n > max {
        return Err(Error::Protocol(format!("frame too large ({n} > {max})")));
    }
    let mut body = vec![0u8; n];
    r.read_exact(&mut body).await?;
    Ok(Some(body))
}

/// Write `value` as a JSON control frame.
pub async fn write_control<W: AsyncWrite + Unpin, T: Serialize>(
    w: &mut W,
    value: &T,
) -> Result<()> {
    let body = serde_json::to_vec(value).map_err(|e| Error::Protocol(e.to_string()))?;
    write_blob(w, &body).await
}

/// Read one JSON control frame.
pub async fn read_control<R: AsyncRead + Unpin, T: DeserializeOwned>(r: &mut R) -> Result<T> {
    let body = read_blob(r, MAX_CONTROL)
        .await?
        .ok_or_else(|| Error::Protocol("stream ended before a control frame".into()))?;
    serde_json::from_slice(&body).map_err(|e| Error::Protocol(format!("control frame: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip_and_a_clean_end_is_none() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        write_blob(&mut a, b"hello").await.unwrap();
        write_control(&mut a, &serde_json::json!({ "k": 1 }))
            .await
            .unwrap();
        drop(a);
        assert_eq!(
            read_blob(&mut b, 16).await.unwrap().as_deref(),
            Some(&b"hello"[..])
        );
        let v: serde_json::Value = read_control(&mut b).await.unwrap();
        assert_eq!(v["k"], 1);
        assert_eq!(read_blob(&mut b, 16).await.unwrap(), None);
    }

    #[tokio::test]
    async fn an_oversized_length_is_refused_before_allocating() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&u32::MAX.to_le_bytes()).await.unwrap();
        assert!(matches!(
            read_blob(&mut b, 1024).await,
            Err(Error::Protocol(_))
        ));
    }

    #[tokio::test]
    async fn a_stream_cut_inside_a_frame_is_an_error_not_an_end() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&10u32.to_le_bytes()).await.unwrap();
        a.write_all(b"abc").await.unwrap();
        drop(a);
        assert!(read_blob(&mut b, 64).await.is_err());
    }
}
