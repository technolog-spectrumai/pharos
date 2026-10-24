//! A peer's dialable address as text: postcard, then lowercase unpadded
//! base32 — short enough for a QR code, and case-insensitive on the way in
//! so it survives being typed.

use iroh::EndpointAddr;

use crate::error::{Error, Result};

/// `addr` as lowercase unpadded base32 of its postcard encoding.
pub fn encode(addr: &EndpointAddr) -> String {
    let bytes = postcard::to_stdvec(addr).expect("postcard into a Vec is infallible");
    let mut text = data_encoding::BASE32_NOPAD.encode(&bytes);
    text.make_ascii_lowercase();
    text
}

/// Decode [`encode`]'s output (in either case, surrounding whitespace ignored).
pub fn decode(text: &str) -> Result<EndpointAddr> {
    let bytes = data_encoding::BASE32_NOPAD
        .decode(text.trim().to_ascii_uppercase().as_bytes())
        .map_err(|e| Error::Decode(format!("address: {e}")))?;
    postcard::from_bytes(&bytes).map_err(|e| Error::Decode(format!("address: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_round_trips_in_either_case() {
        let id = iroh::SecretKey::from_bytes(&[7; 32]).public();
        let addr = EndpointAddr::new(id);
        let text = encode(&addr);
        assert_eq!(text, text.to_ascii_lowercase());
        assert_eq!(decode(&text).unwrap(), addr);
        assert_eq!(
            decode(&format!("  {}\n", text.to_ascii_uppercase())).unwrap(),
            addr
        );
    }

    #[test]
    fn junk_is_a_decode_error() {
        assert!(matches!(decode("not base32!"), Err(Error::Decode(_))));
        assert!(matches!(decode("aaaa"), Err(Error::Decode(_))));
    }
}
