// Fatal-error overlay. Imported FIRST in main.ts so its window listeners are
// registered before any other module evaluates — this way even a module that fails
// to load/evaluate (or a mount-time render crash) is shown ON-PAGE instead of
// leaving a silent white screen. Critical in the desktop webview, which has no
// visible console.
import type { App } from "vue";

function showFatal(label: string, detail: unknown): void {
  const msg = detail instanceof Error ? detail.stack || detail.message : String(detail);
  // eslint-disable-next-line no-console
  console.error(`[enigma] ${label}:`, detail);
  const render = () => {
    let el = document.getElementById("enigma-fatal");
    if (!el) {
      el = document.createElement("div");
      el.id = "enigma-fatal";
      el.style.cssText =
        "position:fixed;inset:0;z-index:99999;overflow:auto;padding:16px 18px;" +
        "background:#0a0c11;color:#ff8a8a;font:12px/1.6 ui-monospace,monospace;" +
        "white-space:pre-wrap;word-break:break-word;";
      const title = document.createElement("div");
      title.style.cssText = "color:#ff4455;font-weight:700;margin-bottom:10px;";
      title.textContent = "Enigma26 hit an error while starting.";
      el.appendChild(title);
      (document.body || document.documentElement).appendChild(el);
    }
    el.appendChild(document.createTextNode(`${label}:\n${msg}\n\n`));
  };
  if (document.body) render();
  else document.addEventListener("DOMContentLoaded", render);
}

window.addEventListener("error", (e) => showFatal("Uncaught error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showFatal("Unhandled promise rejection", e.reason));

/** Route Vue render/component errors to the same on-page overlay. */
export function installVueErrorHandler(app: App): void {
  app.config.errorHandler = (err) => showFatal("Vue render error", err);
}
