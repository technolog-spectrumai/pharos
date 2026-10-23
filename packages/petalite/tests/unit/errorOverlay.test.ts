// @vitest-environment jsdom
//
// The fatal-error overlay.
//
// The desktop webview has no visible console, so without this a failure while
// starting is a white rectangle and nothing else. What is pinned is that each
// way an error can escape — a throw, a rejection nobody awaited, an error
// inside a Vue component — ends up as readable text on screen, in ONE overlay.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent } from "vue";
import { installVueErrorHandler } from "../../src/errorOverlay";

const overlay = () => document.getElementById("zinnia-fatal");

beforeEach(() => {
  document.body.replaceChildren();
});

function rejection(reason: unknown): Event {
  // jsdom has no PromiseRejectionEvent constructor; the listener only reads
  // `reason`, which is what the real event carries.
  return Object.assign(new Event("unhandledrejection"), { reason });
}

describe("an error while starting", () => {
  it("is shown as its stack, under a heading that says the app did not start", () => {
    const error = new Error("cannot read the config");
    window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));

    expect(overlay()?.textContent).toBe(`Zinnia hit an error while starting.\n\n${error.stack}`);
  });

  it("falls back to the message when the event carries no error object", () => {
    // A cross-origin script error arrives as a message with no error at all.
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));

    expect(overlay()?.textContent).toBe("Zinnia hit an error while starting.\n\nScript error.");
  });

  it("draws over the app rather than inside it", () => {
    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    const el = overlay()!;
    expect(el.parentElement).toBe(document.body);
    expect(el.style.position).toBe("fixed");
  });

  it("reuses one overlay for a second error, showing the latest", () => {
    // Errors cascade during a broken boot. Stacking an overlay per error would
    // bury the first, and the first is usually the cause.
    window.dispatchEvent(new ErrorEvent("error", { message: "first" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "second" }));

    expect(document.querySelectorAll("#zinnia-fatal")).toHaveLength(1);
    expect(overlay()?.textContent).toBe("Zinnia hit an error while starting.\n\nsecond");
  });

  it("puts the text in as text, never as markup", () => {
    // An error message can quote the file that broke. Rendered as HTML, a
    // message containing a tag would be drawn rather than read.
    window.dispatchEvent(new ErrorEvent("error", { message: "<img src=x onerror=alert(1)>" }));

    expect(overlay()?.querySelector("img")).toBeNull();
    expect(overlay()?.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("a rejected promise nobody awaited", () => {
  it("is shown as the rejection's stack", () => {
    const reason = new Error("invoke failed");
    window.dispatchEvent(rejection(reason));

    expect(overlay()?.textContent).toBe(`Zinnia hit an error while starting.\n\n${reason.stack}`);
  });

  it("is shown as-is when the rejection is not an Error", () => {
    // Tauri's invoke rejects with a plain string.
    window.dispatchEvent(rejection("workspace_open: not a folder"));

    expect(overlay()?.textContent).toBe("Zinnia hit an error while starting.\n\nworkspace_open: not a folder");
  });
});

describe("an error inside a Vue component", () => {
  it("is logged and shown, under a heading that does not claim it was during start-up", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("render broke");
    const app = createApp(
      defineComponent({
        setup() {
          throw failure;
        },
        render: () => null,
      }),
    );
    installVueErrorHandler(app);

    app.mount(document.createElement("div"));

    expect(log).toHaveBeenCalledWith("[zinnia]", failure);
    expect(overlay()?.textContent).toBe(`Zinnia hit an error.\n\n${failure.stack}`);
    app.unmount();
    log.mockRestore();
  });

  it("shows a thrown value that is not an Error as its text", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp({ render: () => null });
    installVueErrorHandler(app);

    app.config.errorHandler!("bad state", null, "setup function");

    expect(overlay()?.textContent).toBe("Zinnia hit an error.\n\nbad state");
    log.mockRestore();
  });
});
