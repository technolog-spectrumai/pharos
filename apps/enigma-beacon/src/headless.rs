//! Off-screen rendering with Slint's software renderer: for the UI tests and the screenshots
//! (`examples/screens.rs`). No window system needed.

use std::cell::RefCell;
use std::rc::Rc;

use slint::platform::software_renderer::{MinimalSoftwareWindow, RepaintBufferType};
use slint::platform::{Platform, WindowAdapter, WindowEvent};
use slint::{PhysicalSize, PlatformError, Rgb8Pixel};

struct Headless {
    last: RefCell<Option<Rc<MinimalSoftwareWindow>>>,
}

impl Platform for Headless {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, PlatformError> {
        let w = MinimalSoftwareWindow::new(RepaintBufferType::NewBuffer);
        *self.last.borrow_mut() = Some(w.clone());
        Ok(w)
    }
}

thread_local! {
    static WINDOWS: RefCell<Option<Rc<Headless>>> = const { RefCell::new(None) };
}

struct Fwd(Rc<Headless>);

impl Platform for Fwd {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, PlatformError> {
        self.0.create_window_adapter()
    }
}

/// Install the headless platform on this thread (idempotent). Call before creating a window.
pub fn init() {
    WINDOWS.with(|w| {
        if w.borrow().is_some() {
            return;
        }
        let h = Rc::new(Headless { last: RefCell::new(None) });
        if slint::platform::set_platform(Box::new(Fwd(h.clone()))).is_ok() {
            *w.borrow_mut() = Some(h);
        }
    });
}

fn last_window() -> Option<Rc<MinimalSoftwareWindow>> {
    WINDOWS.with(|w| w.borrow().as_ref().and_then(|h| h.last.borrow().clone()))
}

/// An RGB image.
pub struct Shot {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// Row-major RGB8.
    pub rgb: Vec<u8>,
}

/// Render the most recently created window at `w`×`h` logical pixels and `scale`.
///
/// # Panics
/// If [`init`] was not called before the window was created.
#[must_use]
pub fn render(component: &impl slint::ComponentHandle, w: u32, h: u32, scale: f32) -> Shot {
    let win = last_window().expect("headless::init() before creating the window");
    let (pw, ph) = ((w as f32 * scale) as u32, (h as f32 * scale) as u32);
    win.dispatch_event(WindowEvent::ScaleFactorChanged { scale_factor: scale });
    win.set_size(PhysicalSize::new(pw, ph));
    component.show().expect("show");
    // let layouts and the ListView settle
    for _ in 0..3 {
        slint::platform::update_timers_and_animations();
        let mut buf = vec![Rgb8Pixel::default(); (pw * ph) as usize];
        win.request_redraw();
        win.draw_if_needed(|r| {
            r.render(&mut buf, pw as usize);
        });
    }
    let mut buf = vec![Rgb8Pixel::default(); (pw * ph) as usize];
    win.request_redraw();
    win.draw_if_needed(|r| {
        r.render(&mut buf, pw as usize);
    });
    let rgb = buf.iter().flat_map(|p| [p.r, p.g, p.b]).collect();
    Shot { width: pw, height: ph, rgb }
}
