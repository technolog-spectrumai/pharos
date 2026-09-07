// The seam the split turns on.
//
// The workspace store draws a padlock; sealing knows which files carry one.
// They meet through an injected probe rather than an import, so an app that
// does not offer sealing can ship the file tree without the sealing commands on
// its IPC surface at all.
//
// What is pinned here is the ABSENT case, because it is the one no other test
// covers and the one the split depends on: no probe means no invoke, no
// padlock, and — the part worth a test — no throw. Every other suite installs a
// probe and asserts the badges, which is the present case.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const readDir = vi.fn();
const stat = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: (...a: unknown[]) => readDir(...a),
  stat: (...a: unknown[]) => stat(...a),
  readTextFile: vi.fn(),
  readFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const ROOT = "/home/u/work";

beforeEach(() => {
  localStorage.clear();
  for (const fn of [invoke, readDir, stat]) fn.mockReset();
  stat.mockResolvedValue({ size: 12, mtime: null });
  readDir.mockResolvedValue([{ name: "a.txt", isDirectory: false }]);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("the seal probe is optional", () => {
  it("browses a folder without one — no probe, no invoke, no throw", async () => {
    const { useWorkspace, setSealProbe } = await import("../../src/files/useWorkspace");
    setSealProbe(null);
    const workspace = useWorkspace();
    workspace.root.value = ROOT;

    // The read is what fires probes. It must complete on its own terms.
    await workspace.refresh();
    await Promise.resolve();

    expect(workspace.rows.value.map((r) => r.name)).toEqual(["a.txt"]);
    expect(invoke).not.toHaveBeenCalled();
    expect(workspace.isSealed(`${ROOT}/a.txt`)).toBe(false);
  });

  it("reprobes to nothing without one, rather than rejecting", async () => {
    const { useWorkspace, setSealProbe } = await import("../../src/files/useWorkspace");
    setSealProbe(null);
    // A rejection here would surface as an unhandled promise in the app that
    // has no sealing — the exact case this indirection exists to serve.
    await expect(useWorkspace().reprobe(`${ROOT}/a.txt`)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks the injected probe, and only it", async () => {
    const { useWorkspace, setSealProbe } = await import("../../src/files/useWorkspace");
    const asked: string[] = [];
    setSealProbe(async (path) => {
      asked.push(path);
      return path.endsWith(".txt");
    });
    const workspace = useWorkspace();
    workspace.root.value = ROOT;

    await workspace.refresh();
    await Promise.resolve();
    await Promise.resolve();

    expect(asked).toEqual([`${ROOT}/a.txt`]);
    expect(workspace.isSealed(`${ROOT}/a.txt`)).toBe(true);
    // The store reached the injected function, not the Tauri command behind it.
    expect(invoke).not.toHaveBeenCalled();
    setSealProbe(null);
  });

  it("survives a probe that rejects — one bad file is not a broken tree", async () => {
    const { useWorkspace, setSealProbe } = await import("../../src/files/useWorkspace");
    setSealProbe(() => Promise.reject(new Error("no such command")));
    const workspace = useWorkspace();
    workspace.root.value = ROOT;

    await workspace.refresh();
    await Promise.resolve();

    expect(workspace.rows.value.map((r) => r.name)).toEqual(["a.txt"]);
    expect(workspace.isSealed(`${ROOT}/a.txt`)).toBe(false);
    setSealProbe(null);
  });
});
