//! Proteus' own page: how to connect Enigma to it.
//!
//! Served on the onion itself, so it opens in Tor Browser for anyone who has
//! the address. It shows the Proteus code (`pharos-proteus:…`, see
//! `pharos_id::ProteusCode`) as a QR image and as text, with both to download.
//! Enigma takes that code under "You and your Proteus".
//!
//! Everything is made once, at start, from the onion and the configured name:
//! no request computes anything, and nothing a visitor sends reaches the page.
//! No JavaScript and no SVG, so it works at Tor Browser's "Safest" level; a
//! strict Content-Security-Policy says so to the browser as well.
//!
//! | Path | What |
//! |---|---|
//! | `/` | the page, in English |
//! | `/pl` | the page, in Polish |
//! | `/proteus-qr.png` | the QR code |
//! | `/proteus.txt` | the code as text |

use anyhow::{anyhow, Result};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::sync::Arc;

/// Pixels per QR module, and modules of quiet zone around the code.
const SCALE: usize = 10;
const QUIET: usize = 4;

const CSP: &str = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; \
                   base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

pub struct Page {
    /// The code, `pharos-proteus:…`.
    pub code: String,
    pub onion: String,
    en: String,
    pl: String,
    png: Vec<u8>,
}

impl Page {
    pub fn build(onion: &str, name: &str) -> Result<Self> {
        let c = pharos_id::ProteusCode::new(onion, name).map_err(|e| anyhow!("the page's code: {e}"))?;
        let code = c.to_text();
        let onion = c.onion_address();
        let png = qr_png(&code)?;
        let (en, pl) = (html(&EN, &c.name, &onion, &code), html(&PL, &c.name, &onion, &code));
        Ok(Page { code, onion, en, pl, png })
    }
}

pub fn router(page: Arc<Page>) -> Router {
    Router::new()
        .route("/", get(en))
        .route("/pl", get(pl))
        .route("/proteus-qr.png", get(png))
        .route("/proteus.txt", get(txt))
        .with_state(page)
}

type St = axum::extract::State<Arc<Page>>;

fn guarded(content_type: &'static str, body: impl IntoResponse) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_SECURITY_POLICY, CSP),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::X_FRAME_OPTIONS, "DENY"),
        ],
        body,
    )
        .into_response()
}

async fn en(axum::extract::State(p): St) -> Response {
    guarded("text/html; charset=utf-8", p.en.clone())
}

async fn pl(axum::extract::State(p): St) -> Response {
    guarded("text/html; charset=utf-8", p.pl.clone())
}

async fn png(axum::extract::State(p): St) -> Response {
    let mut r = guarded("image/png", p.png.clone());
    r.headers_mut().insert(header::CONTENT_DISPOSITION, "inline; filename=\"proteus-qr.png\"".parse().unwrap());
    r
}

async fn txt(axum::extract::State(p): St) -> Response {
    guarded("text/plain; charset=utf-8", format!("{}\n", p.code))
}

fn qr(text: &str) -> Result<qrcodegen::QrCode> {
    qrcodegen::QrCode::encode_text(text, qrcodegen::QrCodeEcc::Medium).map_err(|e| anyhow!("QR code: {e:?}"))
}

/// The QR code as a greyscale PNG, black on white with a quiet zone.
pub fn qr_png(text: &str) -> Result<Vec<u8>> {
    let q = qr(text)?;
    let n = q.size() as usize;
    let side = (n + 2 * QUIET) * SCALE;
    let mut px = vec![255u8; side * side];
    for y in 0..n {
        for x in 0..n {
            if q.get_module(x as i32, y as i32) {
                for dy in 0..SCALE {
                    let row = ((y + QUIET) * SCALE + dy) * side;
                    let col = (x + QUIET) * SCALE;
                    px[row + col..row + col + SCALE].fill(0);
                }
            }
        }
    }
    let mut out = Vec::new();
    {
        let mut e = png::Encoder::new(&mut out, side as u32, side as u32);
        e.set_color(png::ColorType::Grayscale);
        e.set_depth(png::BitDepth::Eight);
        e.write_header()?.write_image_data(&px)?;
    }
    Ok(out)
}

/// The QR code drawn with half blocks, two module rows per text line, for a
/// terminal with a dark background (light modules are drawn, as `qrencode -t
/// UTF8` does).
pub fn qr_terminal(text: &str) -> Result<String> {
    let q = qr(text)?;
    let n = q.size();
    let q2 = 2; // quiet zone in modules
    let light = |x: i32, y: i32| !(0..n).contains(&x) || !(0..n).contains(&y) || !q.get_module(x, y);
    let mut s = String::new();
    let mut y = -q2;
    while y < n + q2 {
        for x in -q2..n + q2 {
            s.push(match (light(x, y), light(x, y + 1)) {
                (true, true) => '█',
                (true, false) => '▀',
                (false, true) => '▄',
                (false, false) => ' ',
            });
        }
        s.push('\n');
        y += 2;
    }
    Ok(s)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

struct Words {
    lang: &'static str,
    lead: &'static str,
    connect: &'static str,
    steps: [&'static str; 3],
    qr_alt: &'static str,
    as_text: &'static str,
    get_png: &'static str,
    get_txt: &'static str,
    address: &'static str,
    share: &'static str,
    other: (&'static str, &'static str),
}

const EN: Words = Words {
    lang: "en",
    lead: "This is a Proteus. It keeps sealed messages for people who use Enigma while they are offline, and cannot read them.",
    connect: "Connect Enigma to it",
    steps: [
        "In Enigma, open <b>Friends</b>, then ⚙ <b>You and your Proteus</b>.",
        "Scan this QR code with the camera button, or paste the code below.",
        "Save. Enigma checks that it can reach this Proteus.",
    ],
    qr_alt: "QR code of this Proteus",
    as_text: "The code as text",
    get_png: "Download the QR code (PNG)",
    get_txt: "Download the code (text)",
    address: "Its address",
    share: "Give the address and the code only to people you want to use this Proteus.",
    other: ("/pl", "Polski"),
};

const PL: Words = Words {
    lang: "pl",
    lead: "To jest Proteus. Przechowuje zaszyfrowane wiadomości dla osób korzystających z Enigmy, gdy są offline, i nie może ich przeczytać.",
    connect: "Połącz z nim Enigmę",
    steps: [
        "W Enigmie otwórz <b>Znajomi</b>, a potem ⚙ <b>Ty i Twój Proteus</b>.",
        "Zeskanuj ten kod QR przyciskiem aparatu albo wklej kod poniżej.",
        "Zapisz. Enigma sprawdzi, czy może połączyć się z tym Proteusem.",
    ],
    qr_alt: "Kod QR tego Proteusa",
    as_text: "Kod jako tekst",
    get_png: "Pobierz kod QR (PNG)",
    get_txt: "Pobierz kod (tekst)",
    address: "Jego adres",
    share: "Podawaj adres i kod tylko osobom, które mają korzystać z tego Proteusa.",
    other: ("/", "English"),
};

fn html(w: &Words, name: &str, onion: &str, code: &str) -> String {
    let (name, onion, code) = (esc(name), esc(onion), esc(code));
    let steps: String = w.steps.iter().map(|s| format!("<li>{s}</li>")).collect();
    format!(
        r#"<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>{name} · Proteus</title>
<style>
  :root {{ color-scheme: light dark; --bg: #f6f7fb; --fg: #161a2b; --card: #ffffff; --line: #d9dcea; --accent: #5b67c7; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg: #0b0d14; --fg: #e8eaf4; --card: #161a2b; --line: #2a3050; --accent: #8c96e8; }} }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }}
  main {{ max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }}
  header {{ display: flex; align-items: center; gap: .75rem; }}
  .mark {{ width: 2.5rem; height: 2.5rem; border-radius: .6rem; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 800; font-size: 1.4rem; }}
  h1 {{ margin: 0; font-size: 1.6rem; }}
  .kind {{ opacity: .65; font-size: .9rem; }}
  section {{ background: var(--card); border: 1px solid var(--line); border-radius: 1rem; padding: 1rem 1.25rem; margin-top: 1rem; }}
  h2 {{ margin: 0 0 .5rem; font-size: 1.1rem; }}
  ol {{ margin: 0 0 1rem; padding-left: 1.25rem; }}
  .qr {{ display: block; margin: 0 auto; width: min(300px, 80vw); height: auto; image-rendering: pixelated; border-radius: .5rem; }}
  pre {{ white-space: pre-wrap; word-break: break-all; background: var(--bg); border: 1px solid var(--line); border-radius: .5rem; padding: .75rem; font-size: .85rem; user-select: all; }}
  a {{ color: var(--accent); }}
  .links {{ display: flex; flex-wrap: wrap; gap: .5rem 1.25rem; }}
  code {{ word-break: break-all; }}
  footer {{ margin-top: 1.5rem; opacity: .6; font-size: .85rem; display: flex; justify-content: space-between; }}
</style>
</head>
<body>
<main>
  <header><div class="mark" aria-hidden="true">P</div><div><h1>{name}</h1><div class="kind">Proteus</div></div></header>
  <p>{lead}</p>
  <section>
    <h2>{connect}</h2>
    <ol>{steps}</ol>
    <img class="qr" src="/proteus-qr.png" width="410" height="410" alt="{qr_alt}">
  </section>
  <section>
    <h2>{as_text}</h2>
    <pre>{code}</pre>
    <div class="links"><a href="/proteus-qr.png" download="proteus-qr.png">{get_png}</a><a href="/proteus.txt" download="proteus.txt">{get_txt}</a></div>
  </section>
  <section>
    <h2>{address}</h2>
    <p><code>{onion}</code></p>
    <p>{share}</p>
  </section>
  <footer><span>Proteus {version} · Pharos</span><a href="{other_href}" lang="{other_lang}">{other_label}</a></footer>
</main>
</body>
</html>
"#,
        lang = w.lang,
        lead = w.lead,
        connect = w.connect,
        qr_alt = w.qr_alt,
        as_text = w.as_text,
        get_png = w.get_png,
        get_txt = w.get_txt,
        address = w.address,
        share = w.share,
        version = env!("CARGO_PKG_VERSION"),
        other_href = w.other.0,
        other_lang = if w.lang == "en" { "pl" } else { "en" },
        other_label = w.other.1,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// A well-formed onion address (any 32 bytes make one).
    fn onion() -> String {
        pharos_id::ProteusCode { v: 1, onion: [9u8; 32], name: "x".into() }.onion_address()
    }

    async fn get(app: &Router, path: &str) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let res = app.clone().oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        (status, headers, res.into_body().collect().await.unwrap().to_bytes().to_vec())
    }

    /// Decode the QR image the page serves, the way a phone camera would.
    fn decode_png(bytes: &[u8]) -> String {
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        let (w, h) = (info.width as usize, info.height as usize);
        let mut img = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| buf[y * w + x]);
        let grids = img.detect_grids();
        assert_eq!(grids.len(), 1, "exactly one QR code in the image");
        grids[0].decode().unwrap().1
    }

    #[tokio::test]
    async fn the_page_shows_the_code_as_text_and_as_a_qr_that_decodes_to_it() {
        let page = Arc::new(Page::build(&onion(), "Alice's Pi").unwrap());
        let app = router(page.clone());
        let (s, h, body) = get(&app, "/").await;
        let html = String::from_utf8(body).unwrap();
        assert_eq!(s, StatusCode::OK);
        assert_eq!(h[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert!(html.contains(&page.code), "the code is on the page");
        assert!(html.contains(&onion()), "and the address");
        assert!(html.contains("Alice&#39;s Pi"), "the name, escaped");
        assert!(html.contains("You and your Proteus"), "names the place in Enigma");

        let (s, h, txt) = get(&app, "/proteus.txt").await;
        assert_eq!((s, h[header::CONTENT_TYPE].to_str().unwrap()), (StatusCode::OK, "text/plain; charset=utf-8"));
        assert_eq!(String::from_utf8(txt).unwrap().trim(), page.code);

        let (s, h, png) = get(&app, "/proteus-qr.png").await;
        assert_eq!((s, h[header::CONTENT_TYPE].to_str().unwrap()), (StatusCode::OK, "image/png"));
        assert_eq!(decode_png(&png), page.code);
        // What a phone scans is what Enigma takes.
        let c = pharos_id::ProteusCode::from_text(&decode_png(&png)).unwrap();
        assert_eq!((c.onion_address(), c.name.as_str()), (onion(), "Alice's Pi"));
    }

    #[tokio::test]
    async fn the_page_runs_no_script_and_says_so_to_the_browser() {
        let app = router(Arc::new(Page::build(&onion(), "<script>alert(1)</script>").unwrap()));
        for path in ["/", "/pl"] {
            let (_, h, body) = get(&app, path).await;
            let html = String::from_utf8(body).unwrap();
            assert!(!html.to_lowercase().contains("<script"), "{path}: no script, not even from the name");
            assert!(!html.contains("<svg"), "{path}: no SVG (off at Tor Browser's Safest level)");
            let csp = h[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
            assert!(csp.contains("default-src 'none'") && !csp.contains("script-src"), "{csp}");
            assert_eq!(h[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert_eq!(h[header::REFERRER_POLICY], "no-referrer");
        }
    }

    #[tokio::test]
    async fn polish_and_english_link_to_each_other() {
        let app = router(Arc::new(Page::build(&onion(), "Pi").unwrap()));
        let en = String::from_utf8(get(&app, "/").await.2).unwrap();
        let pl = String::from_utf8(get(&app, "/pl").await.2).unwrap();
        assert!(en.contains(r#"<html lang="en">"#) && en.contains(r#"href="/pl""#));
        assert!(pl.contains(r#"<html lang="pl">"#) && pl.contains("Ty i Twój Proteus") && pl.contains(r#"href="/""#));
        assert_eq!(get(&app, "/nothing").await.0, StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_bad_address_or_name_does_not_make_a_page() {
        assert!(Page::build("not-an-onion", "Pi").is_err());
        assert!(Page::build(&onion(), "  ").is_err());
    }

    #[test]
    fn the_terminal_qr_is_square_and_quiet_zoned() {
        let t = qr_terminal("pharos-proteus:TEST").unwrap();
        let lines: Vec<&str> = t.lines().collect();
        let w = lines[0].chars().count();
        assert!(lines.iter().all(|l| l.chars().count() == w));
        assert!(lines[0].chars().all(|c| c == '█' || c == '▀'), "the top edge is quiet zone");
        assert!((w + 1) / 2 <= lines.len() + 1 && lines.len() <= (w + 1) / 2 + 1);
    }
}
