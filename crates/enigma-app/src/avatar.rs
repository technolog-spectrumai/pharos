//! Letter avatars: the first letter of a nickname, white on a colour that nickname always
//! gets. Same palette and hash as `apps/enigma/src/utils/avatarIcon.ts`.

/// `COLOURS` in avatarIcon.ts, as 0xRRGGBB.
pub const COLOURS: [u32; 8] = [0x4f5bc4, 0x2f8f6f, 0xc2553f, 0xb07d1e, 0x8a4fbf, 0x2b7fb8, 0xc24d82, 0x55606e];

/// The first character a person would call a letter, upper-cased ("?" for none).
#[must_use]
pub fn first_letter(name: &str) -> String {
    name.trim().chars().next().map_or_else(|| "?".into(), |c| c.to_uppercase().collect())
}

/// `colourFor(name)`: `h = h*31 + charCodeAt(0)` over code points (a code point above the
/// BMP contributes its high surrogate, as in JS).
#[must_use]
pub fn colour_for(name: &str) -> u32 {
    let mut h: u32 = 0;
    for c in name.trim().chars() {
        let mut buf = [0u16; 2];
        let unit = c.encode_utf16(&mut buf)[0];
        h = h.wrapping_mul(31).wrapping_add(u32::from(unit));
    }
    COLOURS[(h % COLOURS.len() as u32) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_and_colours_match_the_ts() {
        assert_eq!(first_letter(" ann"), "A");
        assert_eq!(first_letter(""), "?");
        // "Ann": (65*31+110)*31+110 = 65985, 65985 % 8 = 1
        assert_eq!(colour_for("Ann"), COLOURS[1]);
        assert_eq!(colour_for("Ann"), colour_for(" Ann "));
    }
}
