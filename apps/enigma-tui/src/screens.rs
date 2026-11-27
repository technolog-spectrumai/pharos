//! Rendering the screen off-terminal: to a ratatui `Buffer` (TestBackend), to plain text and
//! to an HTML page styled like a dark terminal (for screenshots).

use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier};
use ratatui::Terminal;

use crate::app::App;
use crate::ui;

/// The screen at `w` x `h`.
#[must_use]
pub fn render(app: &App, w: u16, h: u16) -> Buffer {
    let mut t = Terminal::new(TestBackend::new(w, h)).expect("test backend");
    t.draw(|f| ui::draw(f, app)).expect("draw");
    t.backend().buffer().clone()
}

/// Plain text, one line per row (wide characters' trailing cells skipped).
#[must_use]
pub fn to_text(b: &Buffer) -> String {
    let mut out = String::new();
    for y in 0..b.area.height {
        let mut skip = 0;
        let mut line = String::new();
        for x in 0..b.area.width {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            let s = b[(x, y)].symbol();
            skip = unicode_width(s).saturating_sub(1);
            line.push_str(s);
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

fn unicode_width(s: &str) -> usize {
    ratatui::text::Span::raw(s).width()
}

fn css(c: Color, fg: bool) -> Option<String> {
    let rgb = match c {
        Color::Reset => return None,
        Color::Rgb(r, g, b) => (r, g, b),
        Color::Black => (0x16, 0x18, 0x1d),
        Color::White | Color::Gray => (0xe6, 0xe6, 0xe6),
        Color::DarkGray => (0x6b, 0x70, 0x78),
        Color::Red | Color::LightRed => (0xef, 0x5f, 0x5f),
        Color::Green | Color::LightGreen => (0x5f, 0xd3, 0x8d),
        Color::Yellow | Color::LightYellow => (0xf5, 0xb7, 0x3b),
        Color::Blue | Color::LightBlue => (0x7a, 0xb8, 0xff),
        Color::Magenta | Color::LightMagenta => (0xc6, 0x8a, 0xff),
        Color::Cyan | Color::LightCyan => (0x5f, 0xd7, 0xd7),
        Color::Indexed(_) => return None,
    };
    let _ = fg;
    Some(format!("#{:02x}{:02x}{:02x}", rgb.0, rgb.1, rgb.2))
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// An HTML page: a dark terminal window with the buffer in it, one span per styled run.
#[must_use]
pub fn to_html(b: &Buffer, title: &str) -> String {
    let mut rows = String::new();
    for y in 0..b.area.height {
        let mut skip = 0;
        rows.push_str("<div class=\"r\">");
        let mut x = 0;
        while x < b.area.width {
            let c = &b[(x, y)];
            if skip > 0 {
                skip -= 1;
                x += 1;
                continue;
            }
            let w = unicode_width(c.symbol()).max(1);
            skip = w - 1;
            let mut style = String::new();
            let (mut fg, mut bg) = (css(c.fg, true), css(c.bg, false));
            if c.modifier.contains(Modifier::REVERSED) {
                std::mem::swap(&mut fg, &mut bg);
            }
            if let Some(f) = fg {
                style.push_str(&format!("color:{f};"));
            }
            if let Some(bk) = bg {
                style.push_str(&format!("background:{bk};"));
            }
            if c.modifier.contains(Modifier::BOLD) {
                style.push_str("font-weight:700;");
            }
            if c.modifier.contains(Modifier::ITALIC) {
                style.push_str("font-style:italic;");
            }
            let sym = if c.symbol().is_empty() { " " } else { c.symbol() };
            rows.push_str(&format!("<span style=\"{style}width:{w}ch\">{}</span>", esc(sym)));
            x += 1;
        }
        rows.push_str("</div>\n");
    }
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{t}</title><style>
body{{margin:0;background:#0b0d10;padding:24px;display:inline-block}}
.win{{background:#16181d;border-radius:10px;box-shadow:0 10px 40px #000a;overflow:hidden;display:inline-block}}
.bar{{height:28px;background:#22252b;display:flex;align-items:center;padding:0 12px;gap:8px;font:12px sans-serif;color:#8a8f98}}
.dot{{width:12px;height:12px;border-radius:50%}}
.term{{padding:10px 12px;color:#e6e6e6;font-family:"DejaVu Sans Mono","Liberation Mono",Menlo,monospace;font-size:14px;line-height:1.25}}
.r{{white-space:pre;height:1.25em;display:flex}}
.r span{{display:inline-block;text-align:left;overflow:visible}}
</style></head><body><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span style="margin-left:8px">{t}</span></div><div class="term">
{rows}</div></div></body></html>
"#,
        t = esc(title)
    )
}
