//! `enigma-tui [--demo] [--name NAME] [--data DIR]`
//!
//! Without `--demo`: the real app behind its lock gate (the profile vault in the same data
//! dir as the Slint and earlier Tauri apps), attached to Your Beacon over Tor. `--demo`:
//! everything in memory, with a simulated friend (Ann).

use std::time::{Duration, Instant};

use enigma_app::real::Net;
use enigma_app::session::Session;
use enigma_app::vault::{default_base, KdfParams, Profiles};
use enigma_tui::app::App;
use enigma_tui::backend::DemoBackend;
use enigma_tui::gate::{self, Gate, Step};
use enigma_tui::ui;
use ratatui::crossterm::event::{self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event};
use ratatui::crossterm::execute;

const TICK: Duration = Duration::from_millis(250);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("enigma-tui [--demo] [--name NAME] [--data DIR]\n  --demo  everything in memory, with a simulated friend (Ann)\n  --data  where profiles live (default: the Enigma27 data dir)");
        return;
    }
    let after = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let name = after("--name").unwrap_or_else(|| "Me".into());
    let demo = args.iter().any(|a| a == "--demo");
    let mut session = if demo {
        None
    } else {
        let base = after("--data").map_or_else(default_base, std::path::PathBuf::from);
        match Session::new(Profiles::new(base), Net::Tor, KdfParams::default()) {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("enigma-tui: {e}");
                std::process::exit(2);
            }
        }
    };
    let mut terminal = ratatui::init();
    let _ = execute!(std::io::stdout(), EnableMouseCapture, EnableBracketedPaste);
    let res = (|| -> std::io::Result<()> {
        if session.is_none() {
            let mut app = App::new(Box::new(DemoBackend::new()), &name);
            return run(&mut terminal, &mut app);
        }
        loop {
            let Some(mut s) = session.take() else { return Ok(()) };
            if !run_gate(&mut terminal, &mut s)? {
                return Ok(());
            }
            let Some(mut app) = App::from_session(s) else { return Ok(()) };
            run(&mut terminal, &mut app)?;
            let quit = app.quit;
            let mut s = app.session.take().expect("the session");
            drop(app);
            s.lock();
            if quit {
                return Ok(());
            }
            session = Some(s);
        }
    })();
    let _ = execute!(std::io::stdout(), DisableMouseCapture, DisableBracketedPaste);
    ratatui::restore();
    if let Err(e) = res {
        eprintln!("enigma-tui: {e}");
        std::process::exit(1);
    }
}

/// The gate until it opens (true) or the user quits (false).
fn run_gate(terminal: &mut ratatui::DefaultTerminal, s: &mut Session) -> std::io::Result<bool> {
    let mut g = Gate::default();
    loop {
        terminal.draw(|f| gate::draw(f, &g, s))?;
        if event::poll(TICK)? {
            if let Event::Key(k) = event::read()? {
                if g.on_key(s, k) == Step::Open {
                    return Ok(true);
                }
            }
        }
        if g.quit {
            return Ok(false);
        }
    }
}

fn run(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> std::io::Result<()> {
    let mut last = Instant::now();
    while !app.quit && !app.lock {
        terminal.draw(|f| ui::draw(f, app))?;
        let wait = TICK.saturating_sub(last.elapsed());
        if event::poll(wait)? {
            match event::read()? {
                Event::Key(k) => app.on_key(k),
                Event::Mouse(m) => app.on_mouse(m),
                Event::Paste(s) => app.on_paste(&s),
                _ => {}
            }
        }
        if last.elapsed() >= TICK {
            app.tick();
            last = Instant::now();
        }
    }
    Ok(())
}
