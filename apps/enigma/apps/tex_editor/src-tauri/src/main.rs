// Prevents an extra console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer misbehaves on NVIDIA and hybrid-GPU Linux
    // setups — the window comes up transparent or black. Disabling it costs
    // nothing here and is the difference between an app that renders and one
    // that does not, so it happens before GTK initialises.
    #[cfg(target_os = "linux")]
    // SAFETY: single-threaded, before any GUI or GTK code runs.
    unsafe {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tex_editor_lib::run();
}
