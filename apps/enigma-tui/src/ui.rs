//! Rendering only (ratatui widgets). Reads [`App`].

use enigma_core::MessageKind;
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::app::{App, Dialog, Focus};
use crate::codes;

const ACCENT: Color = Color::Rgb(0xf5, 0xb7, 0x3b);
const DIM: Color = Color::Rgb(0x8a, 0x8f, 0x98);
const OK: Color = Color::Rgb(0x5f, 0xd3, 0x8d);
const SELF: Color = Color::Rgb(0x7a, 0xb8, 0xff);

fn pane(title: &str, focused: bool) -> Block<'_> {
    let b = Block::bordered().title(format!(" {title} ")).border_type(BorderType::Rounded);
    if focused {
        b.border_style(Style::new().fg(ACCENT))
    } else {
        b.border_style(Style::new().fg(DIM))
    }
}

fn hhmm(ts: u64) -> String {
    let s = ts / 1000 % 86_400;
    format!("{:02}:{:02}", s / 3600, s / 60 % 60)
}

/// Draw the whole screen.
pub fn draw(f: &mut Frame, app: &App) {
    let [top, mid, bottom, help] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(8), Constraint::Length(3), Constraint::Length(1)]).areas(f.area());
    draw_top(f, app, top);
    let [left, right] = Layout::horizontal([Constraint::Length(28), Constraint::Min(30)]).areas(mid);
    draw_left(f, app, left);
    draw_chat(f, app, right);
    draw_bottom(f, app, bottom);
    let keys = [("n", "New room"), ("j", "Join"), ("i", "Invite"), ("f", "Friends"), ("b", "Your Beacon"), (":", "Commands"), ("q", "Quit")];
    let mut spans = vec![];
    for (k, what) in keys {
        spans.push(Span::styled(format!("[{k}]"), Style::new().fg(ACCENT).bold()));
        spans.push(Span::raw(format!(" {what}  ")));
    }
    spans.push(Span::styled("Tab focus", Style::new().fg(DIM)));
    f.render_widget(Paragraph::new(Line::from(spans)), help);
    if let Some(d) = &app.dialog {
        draw_dialog(f, app, d);
    }
}

fn draw_top(f: &mut Frame, app: &App, area: Rect) {
    let tor = app.backend.tor_state().label();
    let beacon = match app.my_beacon() {
        Some(b) => Span::styled(if b.name.is_empty() { b.onion[..8.min(b.onion.len())].to_string() } else { b.name }, Style::new().fg(OK).bold()),
        None => Span::styled("none", Style::new().fg(DIM)),
    };
    let line = Line::from(vec![
        Span::styled(" Enigma27 ", Style::new().fg(Color::Black).bg(ACCENT).bold()),
        Span::raw("  Tor: "),
        Span::styled(tor, Style::new().fg(Color::White)),
        Span::raw("  \u{2502}  Your Beacon: "),
        beacon,
        Span::raw("  \u{2502}  "),
        Span::styled(app.user_name.clone(), Style::new().fg(SELF)),
    ]);
    f.render_widget(Paragraph::new(line).style(Style::new().bg(Color::Rgb(0x22, 0x25, 0x2b))), area);
}

fn draw_left(f: &mut Frame, app: &App, area: Rect) {
    let [rooms_a, friends_a] = Layout::vertical([Constraint::Percentage(60), Constraint::Percentage(40)]).areas(area);
    let cur = app.engine.current_room();
    let rooms: Vec<ListItem> = app
        .engine
        .rooms()
        .iter()
        .map(|r| {
            let mut spans = vec![Span::raw(if Some(r.room.as_str()) == cur { "\u{25cf} " } else { "  " }), Span::raw(r.name.clone())];
            if let Some(n) = app.unread.get(&r.room).filter(|n| **n > 0) {
                spans.push(Span::styled(format!(" ({n})"), Style::new().fg(ACCENT).bold()));
            }
            ListItem::new(Line::from(spans))
        })
        .collect();
    let hl = Style::new().bg(Color::Rgb(0x33, 0x38, 0x42)).add_modifier(Modifier::BOLD);
    let mut st = ListState::default().with_selected(Some(app.room_sel));
    f.render_stateful_widget(List::new(rooms).block(pane("Rooms", app.focus == Focus::Rooms)).highlight_style(hl), rooms_a, &mut st);
    let friends: Vec<ListItem> = if app.friends.is_empty() {
        vec![ListItem::new(Span::styled("  none yet: [f]", Style::new().fg(DIM)))]
    } else {
        app.friends.iter().map(|fr| ListItem::new(format!("  {}  {}", fr.name, &fr.id[..6]))).collect()
    };
    let mut st = ListState::default().with_selected(if app.friends.is_empty() { None } else { Some(app.friend_sel) });
    f.render_stateful_widget(List::new(friends).block(pane("Friends", app.focus == Focus::Friends)).highlight_style(hl), friends_a, &mut st);
}

fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut out = vec![];
    for para in text.split('\n') {
        let mut line = String::new();
        for word in para.split(' ') {
            if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > width {
                out.push(std::mem::take(&mut line));
            }
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
            while line.chars().count() > width {
                let head: String = line.chars().take(width).collect();
                line = line.chars().skip(width).collect();
                out.push(head);
            }
        }
        out.push(line);
    }
    out
}

fn draw_chat(f: &mut Frame, app: &App, area: Rect) {
    let title = match app.room_name() {
        Some(n) => n,
        None => "No room".into(),
    };
    let block = pane(&title, false);
    let inner = block.inner(area);
    f.render_widget(block, area);
    let [head, msgs, input] = Layout::vertical([Constraint::Length(1), Constraint::Min(1), Constraint::Length(3)]).areas(inner);
    let enc = app.crypto_label();
    let enc_style = if enc.contains("Encrypted") { Style::new().fg(OK).bold() } else { Style::new().fg(ACCENT) };
    let dot = Span::styled(" \u{00b7} ", Style::new().fg(DIM));
    let linked = app.linked_count();
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(title.clone(), Style::new().bold()),
            dot.clone(),
            Span::styled(enc, enc_style),
            dot.clone(),
            Span::raw(format!("{linked} linked")),
            dot.clone(),
            Span::raw(app.route_label()),
            dot,
            Span::styled(app.link_label(), Style::new().fg(DIM)),
        ])),
        head,
    );
    let width = usize::from(msgs.width.saturating_sub(2)).max(10);
    let mut lines: Vec<Line> = vec![];
    for m in app.messages() {
        match m.kind {
            MessageKind::System | MessageKind::Placeholder => {
                let t = m.notice.as_ref().map_or(m.content.as_str(), |n| n.text.as_str());
                for l in wrap(t, width) {
                    lines.push(Line::styled(l, Style::new().fg(DIM).italic()).alignment(Alignment::Center));
                }
            }
            _ => {
                let align = if m.is_self { Alignment::Right } else { Alignment::Left };
                let who = if m.is_self { "You".to_string() } else { m.user.clone() };
                let color = if m.is_self { SELF } else { ACCENT };
                lines.push(
                    Line::from(vec![Span::styled(who, Style::new().fg(color).bold()), Span::styled(format!("  {}", hhmm(m.ts)), Style::new().fg(DIM))])
                        .alignment(align),
                );
                let body = match &m.kind {
                    MessageKind::Image => "[image]".to_string(),
                    MessageKind::Voice => "[voice message]".to_string(),
                    MessageKind::MapShare(_) => "[map share: not shown here]".to_string(),
                    _ => m.content.clone(),
                };
                for l in wrap(&body, width * 3 / 4) {
                    lines.push(Line::raw(l).alignment(align));
                }
                lines.push(Line::raw(""));
            }
        }
    }
    let h = usize::from(msgs.height);
    let skip = lines.len().saturating_sub(h);
    let shown: Vec<Line> = lines.into_iter().skip(skip).collect();
    f.render_widget(Paragraph::new(shown), msgs.inner(ratatui::layout::Margin::new(1, 0)));
    let focused = app.focus == Focus::Input;
    let mut text = vec![Span::raw(app.input.clone())];
    if focused {
        text.push(Span::styled("\u{2588}", Style::new().fg(ACCENT)));
    } else if app.input.is_empty() {
        text.push(Span::styled("Type a message (Tab here, Enter to send)", Style::new().fg(DIM)));
    }
    f.render_widget(Paragraph::new(Line::from(text)).block(pane("Message", focused)), input);
}

fn draw_bottom(f: &mut Frame, app: &App, area: Rect) {
    let block = Block::bordered().border_type(BorderType::Rounded).border_style(Style::new().fg(DIM));
    let mut lines = vec![];
    match app.my_beacon() {
        Some(b) => lines.push(Line::from(vec![
            Span::styled(" Your Beacon: ", Style::new().fg(DIM)),
            Span::styled(if b.name.is_empty() { b.onion.clone() } else { format!("{} ({})", b.name, b.onion) }, Style::new().fg(OK)),
            Span::styled(if app.connected() { "  linked" } else { "  connecting\u{2026}" }, Style::new().fg(DIM)),
        ])),
        None => lines.push(Line::styled(" No Beacon yet: press b and paste the pharos-beacon: code from your Beacon's screen.", Style::new().fg(ACCENT))),
    }
    let status = app.banner().unwrap_or_else(|| app.status.clone());
    if !status.is_empty() {
        lines.push(Line::styled(format!(" {status}"), Style::new().fg(Color::White)));
    }
    f.render_widget(Paragraph::new(lines).block(block), area);
}

fn centered(area: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(area.width);
    let h = h.min(area.height);
    Rect::new(area.x + (area.width - w) / 2, area.y + (area.height - h) / 2, w, h)
}

fn input_line(label: &str, value: &str) -> Vec<Line<'static>> {
    vec![
        Line::styled(label.to_string(), Style::new().fg(DIM)),
        Line::from(vec![Span::raw(format!("> {value}")), Span::styled("\u{2588}", Style::new().fg(ACCENT))]),
    ]
}

fn draw_dialog(f: &mut Frame, app: &App, d: &Dialog) {
    let area = f.area();
    let (title, lines, w, h): (&str, Vec<Line>, u16, u16) = match d {
        Dialog::NewRoom(t) => {
            let mut l = input_line("Room name:", t);
            l.push(Line::raw(""));
            l.push(Line::styled("Enter create  Esc cancel", Style::new().fg(DIM)));
            ("New room", l, 50, 7)
        }
        Dialog::Join(t) => {
            let mut l = input_line("Paste the invitation code (enigma27-invite:1:...):", t);
            l.push(Line::raw(""));
            if let Some(s) = app.backend.sample_invitation() {
                l.push(Line::styled("Demo: Ann's invitation code is", Style::new().fg(DIM)));
                l.push(Line::raw(s));
            }
            l.push(Line::styled("Enter join  Esc cancel", Style::new().fg(DIM)));
            ("Join a room", l, 80, 11)
        }
        Dialog::Invite(code) => {
            // Explicit colours: white blocks on black, so a light terminal theme does not
            // invert the code (some phone scanners refuse inverted QRs).
            let qr_style = Style::new().fg(ratatui::style::Color::White).bg(ratatui::style::Color::Black);
            let mut l: Vec<Line> = codes::qr_lines(code)
                .into_iter()
                .map(|q| Line::from(ratatui::text::Span::styled(q, qr_style)).alignment(Alignment::Center))
                .collect();
            l.push(Line::raw(code.clone()));
            l.push(Line::styled("Scan or send this code; the other device pastes it in [j] Join.  Esc close", Style::new().fg(DIM)));
            let h = (l.len() as u16 + 4).min(area.height);
            ("Invite to this room", l, 96, h)
        }
        Dialog::Friends(t) => {
            let mine = app.my_friend_code();
            let mut l = vec![
                Line::styled("My device code (share it; it says who you are, nothing more):", Style::new().fg(DIM)),
                Line::raw(mine),
                Line::raw(""),
            ];
            for fr in &app.friends {
                l.push(Line::from(vec![
                    Span::styled(format!("{}  ", fr.name), Style::new().bold()),
                    Span::styled("check code ", Style::new().fg(DIM)),
                    Span::styled(codes::check_code(app.engine.device_id(), &fr.id), Style::new().fg(ACCENT)),
                ]));
            }
            l.push(Line::raw(""));
            l.extend(input_line("Add a friend: paste their code (enigma27-friend:1:...)", t));
            l.push(Line::styled("Read the check code out loud: the same on both screens = no swap.  Esc close", Style::new().fg(DIM)));
            let h = l.len() as u16 + 4;
            ("Friends", l, 96, h)
        }
        Dialog::Beacon(t) => {
            let mut l = vec![Line::styled("Your Beacon carries your rooms' sealed messages over Tor and keeps them while you are away.", Style::new().fg(DIM)), Line::raw("")];
            l.extend(input_line("Paste the pharos-beacon: code from the Beacon's screen (empty: remove):", t));
            l.push(Line::raw(""));
            l.push(Line::styled("Enter set  Esc cancel   (:key shows this device's discovery key)", Style::new().fg(DIM)));
            ("Your Beacon", l, 96, 9)
        }
        Dialog::Command(t) => {
            let l = vec![Line::from(vec![Span::raw(format!(":{t}")), Span::styled("\u{2588}", Style::new().fg(ACCENT))]), Line::styled(":help lists the commands.  Enter run  Esc cancel", Style::new().fg(DIM))];
            ("Command", l, 80, 4)
        }
        Dialog::Info(title, v) => {
            let mut l: Vec<Line> = v.iter().map(|x| Line::raw(x.clone())).collect();
            l.push(Line::styled("Esc close", Style::new().fg(DIM)));
            let h = (l.len() as u16 + 2).min(area.height);
            (title.as_str(), l, 100, h)
        }
    };
    let r = centered(area, w, h);
    f.render_widget(Clear, r);
    let block = Block::bordered().title(format!(" {title} ")).border_type(BorderType::Double).border_style(Style::new().fg(ACCENT));
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }).block(block.padding(ratatui::widgets::Padding::horizontal(1))), r);
}
