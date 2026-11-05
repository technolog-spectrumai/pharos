// The fatal-error overlay is the desktop webview's only console: main.ts imports
// it first so that a module that fails to evaluate, a stray rejection or a
// render crash puts its stack ON the page instead of leaving a white window.
// Pinned here: each of the three routes reaches the overlay with its label and
// detail, errors pile up in ONE overlay rather than stacking new ones, and an
// error raised before <body> exists still shows once the page has parsed.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { createApp, defineComponent } from "vue";

let installVueErrorHandler: typeof import("../../src/errorOverlay").installVueErrorHandler;
const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

beforeAll(async () => {
  // Importing registers the window listeners, exactly as main.ts does.
  ({ installVueErrorHandler } = await import("../../src/errorOverlay"));
});

afterEach(() => {
  document.getElementById("enigma-fatal")?.remove();
  consoleError.mockClear();
});

const overlay = () => document.getElementById("enigma-fatal");

function raise(error: unknown, message = "") {
  window.dispatchEvent(new ErrorEvent("error", { error, message }));
}

describe("errorOverlay — uncaught errors", () => {
  it("puts an uncaught error's stack on the page under a title", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at main.ts:1:1";
    raise(err);

    const el = overlay()!;
    expect(el.parentElement).toBe(document.body);
    expect(el.firstElementChild!.textContent).toBe("Enigma26 hit an error while starting.");
    expect(el.textContent).toContain("Uncaught error:\nError: boom\n    at main.ts:1:1");
    // It must cover the app, not sit under it.
    expect(el.style.position).toBe("fixed");
    expect(el.style.zIndex).toBe("99999");
    expect(consoleError).toHaveBeenCalledWith("[enigma] Uncaught error:", err);
  });

  it("falls back to the message when the error has no stack, and to the event text when there is no error", () => {
    const bare = new Error("no stack here");
    bare.stack = "";
    raise(bare);
    // A cross-origin script error arrives with no error object at all.
    raise(null, "Script error.");
    expect(overlay()!.textContent).toContain("Uncaught error:\nno stack here");
    expect(overlay()!.textContent).toContain("Uncaught error:\nScript error.");
  });

  it("collects every error in one overlay instead of stacking new ones", () => {
    raise(new Error("first"));
    raise(new Error("second"));
    expect(document.querySelectorAll("#enigma-fatal")).toHaveLength(1);
    expect(overlay()!.textContent!.match(/Enigma26 hit an error/g)).toHaveLength(1);
    expect(overlay()!.textContent).toMatch(/first[\s\S]*second/);
  });
});

describe("errorOverlay — unhandled rejections", () => {
  it("shows the rejection reason, whatever was rejected", () => {
    const ev = Object.assign(new Event("unhandledrejection"), { reason: "vault locked" });
    window.dispatchEvent(ev);
    expect(overlay()!.textContent).toContain("Unhandled promise rejection:\nvault locked");
    expect(consoleError).toHaveBeenCalledWith("[enigma] Unhandled promise rejection:", "vault locked");
  });
});

describe("errorOverlay — Vue render errors", () => {
  it("routes a component that throws while rendering to the same overlay", () => {
    const Broken = defineComponent({
      render() {
        throw new Error("render exploded");
      },
    });
    const app = createApp(Broken);
    installVueErrorHandler(app);
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      app.mount(host);
    } finally {
      app.unmount();
      host.remove();
    }
    expect(overlay()!.textContent).toContain("Vue render error:\nError: render exploded");
  });
});

describe("errorOverlay — before the body exists", () => {
  it("waits for DOMContentLoaded rather than losing the error", () => {
    const body = document.body;
    body.remove();
    try {
      expect(document.body).toBeNull();
      raise(new Error("too early"));
      expect(overlay()).toBeNull();

      document.documentElement.appendChild(body);
      document.dispatchEvent(new Event("DOMContentLoaded"));
      expect(overlay()!.parentElement).toBe(body);
      expect(overlay()!.textContent).toContain("too early");
    } finally {
      if (!body.isConnected) document.documentElement.appendChild(body);
    }
  });
});
