// The voice-note button: record, see the clock run, stop, and hand the composer
// a staged clip it can preview before anything is sent.
//
// It has two backends. In a browser it records with MediaRecorder (stubbed here:
// jsdom has neither getUserMedia nor MediaRecorder), and the microphone has to
// be released the moment recording stops — a capture light left on after the
// user pressed Stop is exactly the thing a privacy app must never do. On the
// desktop it asks Rust to capture through cpal and gets WAV bytes back. Either
// way, an empty recording stages nothing, and a refused microphone leaves the
// button idle instead of stuck "recording" with no input.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import "@tauri-apps/api/core";
import { i18n } from "../../src/i18n";
import VoiceRecorderButton from "../../src/components/chat/VoiceRecorderButton.vue";

(i18n.global.locale as any).value = "en";

// ── a scriptable MediaRecorder ──────────────────────────────────────────────

interface FakeRecorder {
  options: MediaRecorderOptions | undefined;
  mimeType: string;
  started: boolean;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
}
const recorders: FakeRecorder[] = [];
let supported: string[] = [];
let recordedMime = "";
/** What the recorder "captured" — delivered on stop, as the real one does. */
let captured: Blob[] = [];

class FakeMediaRecorder implements FakeRecorder {
  static isTypeSupported(t: string) {
    return supported.includes(t);
  }
  mimeType = recordedMime;
  started = false;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    public stream: unknown,
    public options: MediaRecorderOptions | undefined,
  ) {
    recorders.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    for (const data of captured) this.ondataavailable?.({ data });
    this.onstop?.();
  }
}

const track = { stop: vi.fn() };
const getUserMedia = vi.fn(async (_c: MediaStreamConstraints) => ({ getTracks: () => [track] }));

const invokeMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

function mountButton(props: { disabled?: boolean } = {}) {
  return mount(VoiceRecorderButton, { props, global: { plugins: [i18n] } });
}
const button = (w: ReturnType<typeof mount>) => w.get("button");

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  recorders.length = 0;
  supported = ["audio/webm;codecs=opus", "audio/webm"];
  recordedMime = "audio/webm;codecs=opus";
  captured = [new Blob([new Uint8Array(800)])];
  track.stop.mockClear();
  getUserMedia.mockClear();
  getUserMedia.mockImplementation(async () => ({ getTracks: () => [track] }));
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

function useTauri() {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown>) => invokeMock(cmd, args),
  };
}

// ── browser (MediaRecorder) ─────────────────────────────────────────────────

describe("VoiceRecorderButton — in a browser", () => {
  it("records with the microphone and shows a running clock", async () => {
    const w = mountButton();
    expect(button(w).attributes("title")).toBe("Record voice message");
    await button(w).trigger("click");
    await flushPromises();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(recorders[0].started).toBe(true);
    expect(button(w).attributes("title")).toBe("Stop recording");
    expect(w.text()).toBe("0:00");

    await vi.advanceTimersByTimeAsync(65_000);
    expect(w.text()).toBe("1:05");
  });

  it("on Stop, releases the microphone and stages the clip with its length", async () => {
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(7_000);
    await button(w).trigger("click");
    await flushPromises();

    expect(track.stop).toHaveBeenCalledTimes(1);
    const [[blob, label]] = w.emitted("staged") as [Blob, string][];
    expect(label).toBe("Voice message · 0:07");
    expect(blob.size).toBe(800);
    expect(blob.type).toBe("audio/webm;codecs=opus");
    // Back to idle, and the clock has stopped with it.
    expect(button(w).attributes("title")).toBe("Record voice message");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks for the first container the browser can record", async () => {
    supported = ["audio/ogg;codecs=opus", "audio/mp4"];
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    expect(recorders[0].options).toEqual({ mimeType: "audio/ogg;codecs=opus" });
  });

  it("lets the browser choose when it can record none of the preferred containers", async () => {
    supported = [];
    recordedMime = "";
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    expect(recorders[0].options).toBeUndefined();

    await button(w).trigger("click");
    await flushPromises();
    // Neither the recorder nor the request named a type: label it as WebM.
    const [[blob]] = w.emitted("staged") as [Blob, string][];
    expect(blob.type).toBe("audio/webm");
  });

  it("labels the clip with the requested type when the recorder reports none", async () => {
    supported = ["audio/mp4"];
    recordedMime = "";
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    await button(w).trigger("click");
    await flushPromises();
    const [[blob]] = w.emitted("staged") as [Blob, string][];
    expect(blob.type).toBe("audio/mp4");
  });

  it("stages nothing when the recorder captured no audio, but still releases the microphone", async () => {
    // Empty chunks are what a muted or unplugged input produces.
    captured = [new Blob([])];
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    await button(w).trigger("click");
    await flushPromises();
    expect(w.emitted("staged")).toBeUndefined();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(button(w).attributes("title")).toBe("Record voice message");
  });

  it("stays idle when the microphone is refused", async () => {
    getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    expect(button(w).attributes("title")).toBe("Record voice message");
    expect(w.text()).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    expect(consoleError).toHaveBeenCalled();
  });

  it("starts a fresh clock for each recording", async () => {
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(3_000);
    await button(w).trigger("click");
    await flushPromises();

    await button(w).trigger("click");
    await flushPromises();
    expect(w.text()).toBe("0:00");
    await vi.advanceTimersByTimeAsync(1_000);
    await button(w).trigger("click");
    await flushPromises();
    const labels = (w.emitted("staged") as [Blob, string][]).map(([, l]) => l);
    expect(labels).toEqual(["Voice message · 0:03", "Voice message · 0:01"]);
  });

  it("cannot be started while disabled", async () => {
    const w = mountButton({ disabled: true });
    expect(button(w).attributes("disabled")).toBeDefined();
    await button(w).trigger("click");
    await flushPromises();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops its clock when it goes away mid-recording", async () => {
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);
    w.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── desktop (cpal through Rust) ─────────────────────────────────────────────

describe("VoiceRecorderButton — on the desktop", () => {
  it("records through Rust and stages the returned WAV bytes", async () => {
    useTauri();
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "audio_stop_recording" ? [82, 73, 70, 70] : null));
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    expect(invokeMock).toHaveBeenCalledWith("audio_start_recording", {});
    // The browser microphone is never touched on the desktop.
    expect(getUserMedia).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(12_000);
    await button(w).trigger("click");
    await flushPromises();

    expect(invokeMock).toHaveBeenCalledWith("audio_stop_recording", {});
    const [[blob, label]] = w.emitted("staged") as [Blob, string][];
    expect(label).toBe("Voice message · 0:12");
    expect(blob.type).toBe("audio/wav");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
    expect(button(w).attributes("title")).toBe("Record voice message");
  });

  it("stages nothing when Rust captured no samples", async () => {
    useTauri();
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "audio_stop_recording" ? [] : null));
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    await button(w).trigger("click");
    await flushPromises();
    expect(w.emitted("staged")).toBeUndefined();
    expect(button(w).attributes("title")).toBe("Record voice message");
  });

  it("returns to idle without a clip when stopping fails", async () => {
    useTauri();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "audio_stop_recording") throw new Error("device lost");
      return null;
    });
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    await button(w).trigger("click");
    await flushPromises();
    expect(w.emitted("staged")).toBeUndefined();
    expect(button(w).attributes("title")).toBe("Record voice message");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts the clock when the capture device cannot be opened", async () => {
    useTauri();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "audio_start_recording") throw new Error("no input device");
      return null;
    });
    const w = mountButton();
    await button(w).trigger("click");
    await flushPromises();
    expect(button(w).attributes("title")).toBe("Record voice message");
    expect(vi.getTimerCount()).toBe(0);
  });
});
