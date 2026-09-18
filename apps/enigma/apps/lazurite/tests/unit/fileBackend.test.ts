// The workspace store, with Lazurite's Rust backend injected.
//
// The store is petalite's and reads however it is told to; Lazurite tells it
// to go through the workspace commands, which hold the boundary. What is
// pinned here is the seam: listings arrive with `sealed` already answered so
// no probe is asked, the root is opened once and its canonical spelling
// adopted, the recent list is kept, and a refusal leaves the workspace alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
// The plugin must never be reached once a backend is installed.
const readDir = vi.fn(() => { throw new Error("the fs plugin must not be used"); });
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: (...a: unknown[]) => readDir(...a), stat: vi.fn(), readTextFile: vi.fn(), readFile: vi.fn(),
}));

type Row = { name: string; path: string; isDirectory: boolean; sealed?: boolean; size?: number };

function rust(listing: Record<string, Row[]>, roots: Record<string, string> = {}) {
  invoke.mockImplementation(async (cmd: string, args: Record<string, string>) => {
    switch (cmd) {
      case "workspace_open": {
        const canonical = roots[args.root] ?? args.root;
        if (canonical === "REFUSE") throw "cannot_open: cannot open that folder";
        return { root: canonical, name: canonical.split("/").pop() };
      }
      case "workspace_list": return listing[args.dir] ?? [];
      case "workspace_read_text": return `text of ${args.path}`;
      case "workspace_read_bytes": return new Uint8Array([137, 80, 78, 71]);
      default: throw new Error(`unexpected command ${cmd}`);
    }
  });
}

beforeEach(async () => {
  localStorage.clear();
  invoke.mockReset();
  readDir.mockClear();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const { setFileBackend, setSealProbe, useWorkspace } = await import("petalite/files");
  const { rustBackend } = await import("../../src/files/fs");
  setFileBackend(rustBackend);
  setSealProbe(null);
  const ws = useWorkspace();
  ws.clearRoot();
  ws.recent.value = [];
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the Rust file backend", () => {
  it("lists through Rust, takes sealed from the listing, and asks no probe", async () => {
    const { setSealProbe, useWorkspace } = await import("petalite/files");
    const probe = vi.fn(async () => true);
    setSealProbe(probe);
    rust({ "/w": [
      { name: "b.md", path: "/w/b.md", isDirectory: false, sealed: false, size: 2 },
      { name: "a.md", path: "/w/a.md", isDirectory: false, sealed: true, size: 3 },
      { name: "sub", path: "/w/sub", isDirectory: true },
    ] });
    const ws = useWorkspace();
    ws.root.value = "/w";
    await ws.refresh();
    await Promise.resolve();

    expect(ws.rows.value.map((r) => r.name)).toEqual(["sub", "a.md", "b.md"]);
    expect(ws.isSealed("/w/a.md")).toBe(true);
    expect(ws.isSealed("/w/b.md")).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    expect(readDir).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("workspace_list", { dir: "/w" });
    setSealProbe(null);
  });

  it("opens the root in Rust once, and adopts the canonical spelling it answers", async () => {
    const { useWorkspace } = await import("petalite/files");
    rust({ "/real/w": [] }, { "/link/w": "/real/w" });
    const ws = useWorkspace();
    ws.root.value = "/link/w";
    await ws.refresh();
    expect(ws.root.value).toBe("/real/w");
    expect(JSON.parse(localStorage.getItem("zinnia:workspace")!)).toEqual({ root: "/real/w" });
    await ws.refresh();
    const opens = invoke.mock.calls.filter(([cmd]) => cmd === "workspace_open");
    expect(opens).toHaveLength(1);
    expect(ws.unreadable.value).toBe(false);
  });

  it("keeps a recent list, most recent first, without repeats", async () => {
    const { useWorkspace } = await import("petalite/files");
    rust({});
    const ws = useWorkspace();
    expect(await ws.switchRoot("/a")).toBe(true);
    expect(await ws.switchRoot("/b")).toBe(true);
    expect(await ws.switchRoot("/a")).toBe(true);
    expect(ws.root.value).toBe("/a");
    expect(ws.recent.value).toEqual(["/a", "/b"]);
    expect(JSON.parse(localStorage.getItem("zinnia:workspaces:recent")!)).toEqual(["/a", "/b"]);
  });

  it("leaves the current workspace alone when Rust refuses the next one", async () => {
    const { useWorkspace } = await import("petalite/files");
    rust({ "/w": [] }, { "/gone": "REFUSE" });
    const ws = useWorkspace();
    await ws.switchRoot("/w");
    expect(await ws.switchRoot("/gone")).toBe(false);
    expect(ws.root.value).toBe("/w");
    expect(ws.error.value).toContain("cannot_open");
    expect(ws.recent.value).toEqual(["/w"]);
  });

  it("shows a remembered folder that no longer opens as unreadable, offering the picker", async () => {
    const { useWorkspace } = await import("petalite/files");
    rust({}, { "/w": "REFUSE" });
    const ws = useWorkspace();
    ws.root.value = "/w";
    await ws.refresh();
    expect(ws.unreadable.value).toBe(true);
    expect(ws.rows.value).toEqual([]);
  });

  it("reads text and pictures through Rust", async () => {
    const { useWorkspace } = await import("petalite/files");
    rust({});
    const ws = useWorkspace();
    expect(await ws.readText({ name: "a.md", path: "/w/a.md", isDirectory: false })).toBe("text of /w/a.md");
    expect(await ws.readImage({ name: "p.png", path: "/w/p.png", isDirectory: false }))
      .toBe("data:image/png;base64,iVBORw==");
    expect(invoke).toHaveBeenCalledWith("workspace_read_bytes", { path: "/w/p.png" });
  });
});
