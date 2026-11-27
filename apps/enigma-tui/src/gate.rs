//! The lock gate in the console: first run (choose a passphrase, twice) or unlock
//! (passphrase, or the PIN when one is enrolled). Input is masked. The panic code typed
//! here erases every profile and opens an empty app, exactly like a normal unlock.

use enigma_app::session::{Gate as G, Session};
use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Alignment, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, BorderType, Clear, Paragraph, Wrap};
use ratatui::Frame;

/// The gate's typing state.
#[derive(Default)]
pub struct Gate {
    /// The fields (one to unlock, two to create).
    pub fields: [String; 2],
    /// Which field has the keyboard.
    pub at: usize,
    /// PIN instead of the passphrase.
    pub pin: bool,
    /// Asked to quit.
    pub quit: bool,
}

/// What a key did.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// Keep typing.
    Typing,
    /// The session opened.
    Open,
}

impl Gate {
    /// A key on the gate of `s`.
    pub fn on_key(&mut self, s: &mut Session, k: KeyEvent) -> Step {
        if k.kind == KeyEventKind::Release {
            return Step::Typing;
        }
        let create = s.gate() == G::Create;
        match k.code {
            KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => self.quit = true,
            KeyCode::Esc => self.quit = true,
            KeyCode::Tab if create => self.at = 1 - self.at,
            KeyCode::Tab if s.vault().pin_status().enrolled => {
                self.pin = !self.pin;
                self.fields[0].clear();
            }
            KeyCode::Backspace => {
                self.fields[self.at].pop();
            }
            KeyCode::Char(c) => self.fields[self.at].push(c),
            KeyCode::Enter => {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
                if create && self.at == 0 {
                    self.at = 1;
                    return Step::Typing;
                }
                let r = if create {
                    s.create(&self.fields[0], &self.fields[1], now)
                } else if self.pin {
                    s.pin_unlock(&self.fields[0], now)
                } else {
                    s.unlock(&self.fields[0], now)
                };
                self.fields = Default::default();
                self.at = 0;
                if r.is_ok() {
                    return Step::Open;
                }
            }
            _ => {}
        }
        Step::Typing
    }
}

/// Draw the gate.
pub fn draw(f: &mut Frame, g: &Gate, s: &Session) {
    let area = f.area();
    let create = s.gate() == G::Create;
    let mask = |t: &str| "\u{2022}".repeat(t.chars().count());
    let dim = Style::new().fg(Color::Rgb(0x8a, 0x8f, 0x98));
    let accent = Style::new().fg(Color::Rgb(0xf5, 0xb7, 0x3b));
    let mut l = vec![Line::styled(format!("Profile: {}", s.vault().profile()), dim), Line::raw("")];
    if create {
        l.push(Line::raw("Welcome to Enigma27. Choose a passphrase: it seals everything on this device."));
        l.push(Line::raw(""));
        for (i, label) in ["Passphrase:", "Again:"].iter().enumerate() {
            let mark = if g.at == i { "> " } else { "  " };
            l.push(Line::raw(format!("{mark}{label} {}", mask(&g.fields[i]))));
        }
        l.push(Line::raw(""));
        l.push(Line::styled("Enter next / create   Tab switch field   Esc quit", dim));
    } else {
        if s.from_tauri() {
            l.push(Line::styled("The earlier Enigma27 app's profile: unlock it with its passphrase.", accent));
        }
        l.push(Line::raw(format!("> {} {}", if g.pin { "PIN:" } else { "Passphrase:" }, mask(&g.fields[0]))));
        l.push(Line::raw(""));
        let tab = if s.vault().pin_status().enrolled { "   Tab PIN / passphrase" } else { "" };
        l.push(Line::styled(format!("Enter unlock{tab}   Esc quit"), dim));
    }
    if !s.error.is_empty() {
        l.push(Line::styled(s.error.clone(), Style::new().fg(Color::Rgb(0xe0, 0x7a, 0x5f))));
    }
    let (w, h) = (76.min(area.width), (l.len() as u16 + 4).min(area.height));
    let r = Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2, w, h);
    f.render_widget(Clear, r);
    let title = if create { " Enigma27: new vault " } else { " Enigma27 is locked " };
    let block = Block::bordered().title(title).title_alignment(Alignment::Center).border_type(BorderType::Double).border_style(accent);
    f.render_widget(Paragraph::new(l).wrap(Wrap { trim: false }).block(block.padding(ratatui::widgets::Padding::horizontal(1))), r);
}

#[cfg(test)]
mod tests {
    use super::*;
    use enigma_app::real::Net;
    use enigma_app::vault::{test_kdf, Profiles};

    fn key(c: KeyCode) -> KeyEvent {
        KeyEvent::new(c, KeyModifiers::NONE)
    }
    fn typ(g: &mut Gate, s: &mut Session, t: &str) {
        for c in t.chars() {
            g.on_key(s, key(KeyCode::Char(c)));
        }
    }

    #[test]
    fn create_then_unlock_with_masked_typing() {
        let base = std::env::temp_dir().join(format!("enigma-tui-gate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let mut s = Session::new(Profiles::new(base.clone()), Net::Test(std::sync::Arc::new(beacon_node::relay::Directory::default())), test_kdf()).unwrap();
        let mut g = Gate::default();
        typ(&mut g, &mut s, "password1");
        assert_eq!(g.on_key(&mut s, key(KeyCode::Enter)), Step::Typing);
        typ(&mut g, &mut s, "password1");
        assert_eq!(g.on_key(&mut s, key(KeyCode::Enter)), Step::Open);
        s.lock();
        typ(&mut g, &mut s, "nope");
        assert_eq!(g.on_key(&mut s, key(KeyCode::Enter)), Step::Typing);
        assert_eq!(s.error, "wrong passphrase");
        typ(&mut g, &mut s, "password1");
        assert_eq!(g.on_key(&mut s, key(KeyCode::Enter)), Step::Open);
        let _ = std::fs::remove_dir_all(base);
    }
}
