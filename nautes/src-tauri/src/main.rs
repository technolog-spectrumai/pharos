#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMABUF renderer breaks WebGL on NVIDIA/hybrid-GPU stacks:
    // the canvas renders fully transparent while normal DOM paints fine. This
    // was set for the Map tab, the app's one WebGL surface, which moved to
    // Morion on 2026-10-03. It stays for now: it also changes how the whole
    // window is composited on those stacks, and the app has not been run
    // without it (todo.md).
    // Must be set BEFORE GTK/WebKit initializes, hence here and not in run().
    // Respect an explicit user override (e.g. =0 to re-enable DMABUF).
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    nautes_lib::run()
}
