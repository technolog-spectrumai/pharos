//! A `Board` on stdin/stdout, so the frontend tests can drive the REAL CRDT.
//!
//! One JSON request per line, one JSON response per line. This exists so that
//! `apps/sketch`'s session tests exercise the yrs code that actually ships
//! instead of a JavaScript lookalike — a second implementation would converge
//! with itself and prove nothing about this one.
//!
//! It mirrors `apps/sketch/src-tauri/src/document.rs` deliberately: same
//! operations, same `{shapes, update}` answer. When that file changes, this
//! one does too, and the session tests are what notice.

use std::io::{BufRead, Write};

use board::Board;

fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let pat = format!("\"{key}\":");
    let start = line.find(&pat)? + pat.len();
    Some(line[start..].trim_start())
}

/// A JSON string value, unescaped enough for the shapes these tests use.
fn string_at(rest: &str) -> Option<String> {
    let rest = rest.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    let n = u32::from_str_radix(&hex, 16).ok()?;
                    out.push(char::from_u32(n)?);
                }
                other => out.push(other),
            },
            '"' => return Some(out),
            other => out.push(other),
        }
    }
    None
}

fn str_field(line: &str, key: &str) -> Option<String> {
    string_at(field(line, key)?)
}

/// Every JSON string inside the value that follows `key`, in order.
fn strings_after(line: &str, key: &str) -> Vec<String> {
    let Some(rest) = field(line, key) else { return Vec::new() };
    let mut out = Vec::new();
    let mut i = 0;
    let bytes: Vec<char> = rest.chars().collect();
    let mut depth = 0i32;
    while i < bytes.len() {
        match bytes[i] {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            '"' => {
                let tail: String = bytes[i..].iter().collect();
                if let Some(s) = string_at(&tail) {
                    // Skip the raw span, not the decoded length.
                    let mut j = i + 1;
                    while j < bytes.len() {
                        if bytes[j] == '\\' {
                            j += 2;
                            continue;
                        }
                        if bytes[j] == '"' {
                            break;
                        }
                        j += 1;
                    }
                    out.push(s);
                    i = j;
                }
            }
            _ => {}
        }
        i += 1;
    }
    out
}

/// The numbers inside the array that follows `key`.
fn bytes_after(line: &str, key: &str) -> Vec<u8> {
    let Some(rest) = field(line, key) else { return Vec::new() };
    let end = rest.find(']').unwrap_or(rest.len());
    rest[..end]
        .trim_start_matches('[')
        .split(',')
        .filter_map(|n| n.trim().parse::<u8>().ok())
        .collect()
}

fn num_field(line: &str, key: &str) -> u32 {
    field(line, key)
        .map(|r| {
            r.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
        })
        .and_then(|d| d.parse().ok())
        .unwrap_or(0)
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

fn shapes_json(board: &Board) -> String {
    let items: Vec<String> = board
        .shapes()
        .iter()
        .map(|s| format!("\"{}\"", escape(s)))
        .collect();
    format!("[{}]", items.join(","))
}

fn bytes_json(b: &[u8]) -> String {
    let items: Vec<String> = b.iter().map(|x| x.to_string()).collect();
    format!("[{}]", items.join(","))
}

fn committed(board: &Board, update: Option<Vec<u8>>) -> String {
    let u = match update {
        Some(u) if u.len() > 2 => bytes_json(&u),
        _ => "null".to_string(),
    };
    let bg = match board.background() {
        Some(c) => format!("\"{}\"", escape(&c)),
        None => "null".to_string(),
    };
    let (w, h) = board.size();
    format!(
        "{{\"shapes\":{},\"update\":{},\"background\":{},\"width\":{},\"height\":{}}}",
        shapes_json(board),
        u,
        bg,
        w,
        h
    )
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let mut board = Board::new();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let op = str_field(&line, "op").unwrap_or_default();
        let before = board.state_vector();

        let response = match op.as_str() {
            "reset" => {
                board = Board::new();
                committed(&board, None)
            }
            "put" => {
                let id = str_field(&line, "id").unwrap_or_default();
                let shape = str_field(&line, "shape").unwrap_or_default();
                board.put(&id, &shape);
                committed(&board, board.diff(&before).ok())
            }
            "put_many" => {
                // `[[id, shape], ...]` — flat pairs in document order.
                let flat = strings_after(&line, "shapes");
                for pair in flat.chunks(2) {
                    if let [id, shape] = pair {
                        board.put(id, shape);
                    }
                }
                committed(&board, board.diff(&before).ok())
            }
            "remove" => {
                for id in strings_after(&line, "ids") {
                    board.remove(&id);
                }
                committed(&board, board.diff(&before).ok())
            }
            "clear" => {
                board.clear();
                committed(&board, board.diff(&before).ok())
            }
            "set_background" => {
                let color = str_field(&line, "color");
                board.set_background(color.as_deref());
                committed(&board, board.diff(&before).ok())
            }
            "set_size" => {
                board.set_size(num_field(&line, "width"), num_field(&line, "height"));
                committed(&board, board.diff(&before).ok())
            }
            "read" => {
                let (w, h) = board.size();
                let bg = match board.background() {
                    Some(c) => format!("\"{}\"", escape(&c)),
                    None => "null".to_string(),
                };
                format!(
                    "{{\"shapes\":{},\"update\":null,\"background\":{bg},\"width\":{w},\"height\":{h}}}",
                    shapes_json(&board)
                )
            }
            "apply" => match board.apply(&bytes_after(&line, "update")) {
                Ok(()) => committed(&board, None),
                Err(e) => format!("{{\"error\":\"{}\"}}", escape(&e.to_string())),
            },
            "snapshot" => format!(
                "{{\"shapes\":[],\"update\":null,\"bytes\":{}}}",
                bytes_json(&board.snapshot())
            ),
            "state_vector" => format!(
                "{{\"shapes\":[],\"update\":null,\"bytes\":{}}}",
                bytes_json(&board.state_vector())
            ),
            "diff" => match board.diff(&bytes_after(&line, "have")) {
                Ok(d) => format!("{{\"shapes\":[],\"update\":null,\"bytes\":{}}}", bytes_json(&d)),
                Err(e) => format!("{{\"error\":\"{}\"}}", escape(&e.to_string())),
            },
            "compact" => {
                board = board.compacted();
                committed(&board, None)
            }
            other => format!("{{\"error\":\"bad_update: unknown op {}\"}}", escape(other)),
        };

        if writeln!(out, "{response}").is_err() || out.flush().is_err() {
            break;
        }
    }
}
