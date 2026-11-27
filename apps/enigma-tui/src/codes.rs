//! Text codes: the Friends pairing code and check code (identical to
//! `apps/enigma/src/stores/friends.ts`), the invitation code, and QR drawing with half blocks.

use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use qrcodegen::{QrCode, QrCodeEcc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// `enigma27-friend:1:` (friends.ts `PREFIX`).
pub const FRIEND_PREFIX: &str = "enigma27-friend:1:";
/// `enigma27-invite:1:` + base64url JSON.
pub const INVITE_PREFIX: &str = "enigma27-invite:1:";

/// 64 lowercase hex digits.
#[must_use]
pub fn is_device_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn clip(s: &str, n: usize) -> String {
    // friends.ts slices UTF-16 units; for names this is close enough (chars).
    s.chars().take(n).collect()
}

/// `encodePairing(id, name)`.
#[must_use]
pub fn encode_pairing(id: &str, name: &str) -> String {
    format!("{FRIEND_PREFIX}{id}:{}", URL_SAFE_NO_PAD.encode(clip(name.trim(), 80)))
}

/// `decodePairing(text)`: (id, name); a bare device id is accepted with no name.
#[must_use]
pub fn decode_pairing(text: &str) -> Option<(String, String)> {
    let t = text.trim();
    if is_device_id(&t.to_lowercase()) {
        return Some((t.to_lowercase(), String::new()));
    }
    let rest = t.strip_prefix(FRIEND_PREFIX)?;
    let mut parts = rest.split(':');
    let id = parts.next()?.to_string();
    if !is_device_id(&id) {
        return None;
    }
    let name = parts.next().unwrap_or("");
    let decoded = URL_SAFE_NO_PAD
        .decode(name.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(name))
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .map(|s| clip(&s, 80))
        .unwrap_or_default();
    Some((id, decoded))
}

/// `checkCode(a, b)`: "0123 4567 8901", the same in either order.
#[must_use]
pub fn check_code(a: &str, b: &str) -> String {
    let (x, y) = if a <= b { (a, b) } else { (b, a) };
    let d = Sha256::digest(format!("enigma27-pair:{x}:{y}").as_bytes());
    let n = d[..6].iter().fold(0u64, |n, b| (n << 8) | u64::from(*b));
    let s = format!("{:012}", n % 1_000_000_000_000);
    format!("{} {} {}", &s[..4], &s[4..8], &s[8..])
}

/// What an invitation code carries: the room and the inviter's onion to hand a key package to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Invitation {
    /// Room name.
    pub name: String,
    /// Room slug.
    pub room: String,
    /// Inviter's onion.
    pub onion: String,
}

/// The code text.
#[must_use]
pub fn encode_invitation(inv: &Invitation) -> String {
    format!("{INVITE_PREFIX}{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(inv).unwrap_or_default()))
}

/// Parse a pasted code.
#[must_use]
pub fn decode_invitation(text: &str) -> Option<Invitation> {
    let b = URL_SAFE_NO_PAD.decode(text.trim().strip_prefix(INVITE_PREFIX)?).ok()?;
    serde_json::from_slice(&b).ok().filter(|i: &Invitation| !i.name.trim().is_empty())
}

/// RFC 4648 base32, lowercase, no padding (onion style).
#[must_use]
pub fn base32_lower(b: &[u8]) -> String {
    const A: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let (mut out, mut buf, mut bits) = (String::new(), 0u32, 0u32);
    for &x in b {
        buf = (buf << 8) | u32::from(x);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(A[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// A QR code as lines of Unicode half blocks: two modules per character row, light modules
/// drawn, with the standard 4-module quiet zone. The UI draws the lines white on black
/// so the code reads dark-on-light whatever the terminal's theme.
#[must_use]
pub fn qr_lines(text: &str) -> Vec<String> {
    let Ok(qr) = QrCode::encode_text(text, QrCodeEcc::Low) else { return vec!["(code too long for a QR)".into()] };
    let q = 4i32;
    let n = qr.size();
    let light = |x: i32, y: i32| !(x >= 0 && y >= 0 && x < n && y < n && qr.get_module(x, y));
    let mut out = vec![];
    let mut y = -q;
    while y < n + q {
        let mut line = String::new();
        for x in -q..n + q {
            line.push(match (light(x, y), light(x, y + 1)) {
                (true, true) => '\u{2588}',
                (true, false) => '\u{2580}',
                (false, true) => '\u{2584}',
                (false, false) => ' ',
            });
        }
        out.push(line);
        y += 2;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const B: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    #[test]
    fn pairing_round_trips_and_matches_the_ts_format() {
        let c = encode_pairing(A, " Ann ");
        assert_eq!(c, format!("enigma27-friend:1:{A}:QW5u"));
        assert_eq!(decode_pairing(&c), Some((A.into(), "Ann".into())));
        assert_eq!(decode_pairing(&B.to_uppercase()), Some((B.into(), String::new())));
        assert_eq!(decode_pairing("enigma27-friend:1:xyz:QW5u"), None);
        assert_eq!(decode_pairing("hello"), None);
        let u = encode_pairing(A, "Zoë ✓");
        assert_eq!(decode_pairing(&u).unwrap().1, "Zoë ✓");
    }

    #[test]
    fn check_code_is_symmetric_twelve_digits() {
        let c = check_code(A, B);
        assert_eq!(c, check_code(B, A));
        // the vector friends.ts' checkCode gives (computed with node's SHA-256)
        assert_eq!(c, "1668 7126 9524");
        assert_eq!(c.len(), 14);
        assert!(c.chars().filter(char::is_ascii_digit).count() == 12);
    }

    #[test]
    fn invitation_and_qr() {
        let i = Invitation { name: "R".into(), room: "topic-R".into(), onion: "x.onion".into() };
        assert_eq!(decode_invitation(&encode_invitation(&i)), Some(i.clone()));
        assert_eq!(decode_invitation("nope"), None);
        let q = qr_lines(&encode_invitation(&i));
        assert!(q.len() > 10 && q.iter().all(|l| l.chars().count() == q[0].chars().count()));
        assert_eq!(base32_lower(b"foobar"), "mzxw6ytboi");
    }
}
