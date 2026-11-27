//! `enigma-tui [--demo] [--name NAME]`

use std::time::{Duration, Instant};

use enigma_tui::app::App;
use enigma_tui::backend::{Backend, DemoBackend, RealBackend};
use enigma_tui::ui;
use ratatui::crossterm::event::{self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, Event};
use ratatui::crossterm::execute;

const TICK: Duration = Duration::from_millis(250);

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("enigma-tui [--demo] [--name NAME]\n  --demo  everything in memory, with a simulated friend (Ann)");
        return;
    }
    let name = args.iter().position(|a| a == "--name").and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| "Me".into());
    let backend: Box<dyn Backend> = if args.iter().any(|a| a == "--demo") {
        Box::new(DemoBackend::new())
    } else {
        match RealBackend::connect() {
            Ok(b) => Box::new(b),
            Err(e) => {
                eprintln!("enigma-tui: {e}. Run with --demo for the in-memory demo.");
                std::process::exit(2);
            }
        }
    };
    let mut app = App::new(backend, &name);
    let mut terminal = ratatui::init();
    let _ = execute!(std::io::stdout(), EnableMouseCapture, EnableBracketedPaste);
    let res = run(&mut terminal, &mut app);
    let _ = execute!(std::io::stdout(), DisableMouseCapture, DisableBracketedPaste);
    ratatui::restore();
    if let Err(e) = res {
        eprintln!("enigma-tui: {e}");
        std::process::exit(1);
    }
}

fn run(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> std::io::Result<()> {
    let mut last = Instant::now();
    while !app.quit {
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
