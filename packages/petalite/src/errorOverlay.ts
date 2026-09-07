// Fatal-error overlay. Imported FIRST in main.ts so a failure during startup
// shows up as text rather than a white rectangle — the desktop webview has no
// visible console, so without this a boot error is silent.
import type { App } from "vue";

function show(title: string, detail: string) {
  let el = document.getElementById("zinnia-fatal");
  if (!el) {
    el = document.createElement("div");
    el.id = "zinnia-fatal";
    el.style.cssText =
      "position:fixed;inset:0;z-index:99999;overflow:auto;padding:16px;" +
      "background:#0a0c11;color:#ff8a8a;font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap";
    document.body.appendChild(el);
  }
  el.textContent = `${title}\n\n${detail}`;
}

window.addEventListener("error", (e) => {
  show("Zinnia hit an error while starting.", String(e.error?.stack ?? e.message));
});
window.addEventListener("unhandledrejection", (e) => {
  show("Zinnia hit an error while starting.", String((e.reason as Error)?.stack ?? e.reason));
});

export function installVueErrorHandler(app: App) {
  app.config.errorHandler = (err) => {
    console.error("[zinnia]", err);
    show("Zinnia hit an error.", String((err as Error)?.stack ?? err));
  };
}
