//! Pictures and codes from files: an image file to the data URL a room sends (scaled
//! down, re-encoded as JPEG, so no metadata such as GPS leaves the device), data URLs
//! back to bytes, and QR codes read from an image file (rqrr), for Join / Friends /
//! Your Beacon when there is no camera.

use std::path::Path;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

/// Longest side of a sent picture.
pub const IMAGE_MAX_SIDE: u32 = 1280;

/// Decode an image file (PNG / JPEG).
///
/// # Errors
/// Not readable, not an image.
pub fn load_image(path: &Path) -> Result<image::DynamicImage, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    image::load_from_memory(&bytes).map_err(|e| format!("not a picture: {e}"))
}

/// An image file as a `data:image/jpeg;base64,…` URL, at most [`IMAGE_MAX_SIDE`] wide or
/// high. Re-encoding drops EXIF (location, camera).
///
/// # Errors
/// Not readable, not an image.
pub fn image_data_url(path: &Path) -> Result<String, String> {
    let img = load_image(path)?;
    image_to_data_url(&img)
}

/// [`image_data_url`] for a decoded image.
///
/// # Errors
/// The encoder's.
pub fn image_to_data_url(img: &image::DynamicImage) -> Result<String, String> {
    let img = if img.width() > IMAGE_MAX_SIDE || img.height() > IMAGE_MAX_SIDE { img.thumbnail(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE) } else { img.clone() };
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80).encode_image(&rgb).map_err(|e| e.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", B64.encode(out)))
}

/// `data:<mime>;base64,<data>` → (mime, bytes).
#[must_use]
pub fn decode_data_url(url: &str) -> Option<(String, Vec<u8>)> {
    let rest = url.strip_prefix("data:")?;
    let (head, data) = rest.split_once(',')?;
    let mime = head.strip_suffix(";base64")?;
    Some((mime.to_string(), B64.decode(data.trim()).ok()?))
}

/// A data URL's picture as RGBA8 (width, height, pixels).
#[must_use]
pub fn data_url_rgba(url: &str) -> Option<(u32, u32, Vec<u8>)> {
    let (_, bytes) = decode_data_url(url)?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    Some((img.width(), img.height(), img.into_raw()))
}

/// Every QR code's text found in a decoded image.
#[must_use]
pub fn scan_qr(img: &image::DynamicImage) -> Vec<String> {
    let g = img.to_luma8();
    let (w, h) = (g.width() as usize, g.height() as usize);
    let mut p = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| g.get_pixel(x as u32, y as u32).0[0]);
    p.detect_grids().into_iter().filter_map(|grid| grid.decode().ok().map(|(_, t)| t)).collect()
}

/// The first QR code in an image file (a screenshot or photo of an invitation, a friend
/// code, a `pharos-beacon:` code).
///
/// # Errors
/// Not an image, or no code found.
pub fn scan_qr_file(path: &Path) -> Result<String, String> {
    let img = load_image(path)?;
    scan_qr(&img).into_iter().next().ok_or_else(|| "no QR code found in that picture".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qr_png(text: &str, dir: &Path) -> std::path::PathBuf {
        let (side, m) = crate::codes::qr_modules(text).unwrap();
        let (scale, quiet) = (6u32, 4u32);
        let px = (side as u32 + 2 * quiet) * scale;
        let img = image::GrayImage::from_fn(px, px, |x, y| {
            let (mx, my) = ((x / scale) as i64 - i64::from(quiet), (y / scale) as i64 - i64::from(quiet));
            let dark = mx >= 0 && my >= 0 && (mx as usize) < side && (my as usize) < side && m[my as usize * side + mx as usize];
            image::Luma([if dark { 0 } else { 255 }])
        });
        let p = dir.join("code.png");
        img.save(&p).unwrap();
        p
    }

    #[test]
    fn a_qr_in_a_png_reads_back_and_a_picture_becomes_a_small_jpeg() {
        let dir = std::env::temp_dir().join(format!("enigma-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let code = crate::codes::encode_pairing(&"a".repeat(64), "Ann");
        let p = qr_png(&code, &dir);
        assert_eq!(scan_qr_file(&p).unwrap(), code);
        let url = image_data_url(&p).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        let (w, h, px) = data_url_rgba(&url).unwrap();
        assert_eq!(px.len(), (w * h * 4) as usize);
        let big = image::DynamicImage::ImageRgb8(image::RgbImage::new(4000, 1000));
        let (w, h, _) = data_url_rgba(&image_to_data_url(&big).unwrap()).unwrap();
        assert_eq!((w, h), (1280, 320));
        assert!(scan_qr_file(&dir.join("missing.png")).is_err());
        assert_eq!(decode_data_url("data:text/plain;base64,aGk=").unwrap(), ("text/plain".into(), b"hi".to_vec()));
        let _ = std::fs::remove_dir_all(dir);
    }
}
