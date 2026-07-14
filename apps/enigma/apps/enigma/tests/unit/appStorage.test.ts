import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getMaxFileSizeMb,
  setMaxFileSizeMb,
  clampMaxFileSizeMb,
  MAX_FILE_SIZE_MAX_MB,
} from "rakotis";

// The max-file-size setting is stored in the encrypted kv; the *shipped default*
// belongs to the app's build config (policy.fileShare.defaultMaxFileSizeMb) and is
// passed in by callers — these tests pin that contract.

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).__TAURI_INTERNALS__ = {};
  invokeMock.mockResolvedValue(null);
});

describe("appStorage — max file size", () => {
  it("returns the caller's default when nothing is stored", async () => {
    expect(await getMaxFileSizeMb(16)).toBe(16);
  });

  it("a stored value wins over the default and is clamped to the max", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "1" : null));
    expect(await getMaxFileSizeMb(16)).toBe(1);

    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "kv_get" ? String(MAX_FILE_SIZE_MAX_MB * 10) : null,
    );
    expect(await getMaxFileSizeMb(16)).toBe(MAX_FILE_SIZE_MAX_MB);
  });

  it("a stored 0 means unlimited even with a nonzero default", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "0" : null));
    expect(await getMaxFileSizeMb(16)).toBe(0);
  });

  it("set persists the clamped value; garbage input falls back to the default", async () => {
    expect(await setMaxFileSizeMb(Number.NaN, 16)).toBe(16);
    expect(invokeMock).toHaveBeenCalledWith(
      "kv_put",
      expect.objectContaining({ k: "max_file_size_mb", v: "16" }),
    );
  });

  it("clamp bounds negative input to 0 and honours the fallback", () => {
    expect(clampMaxFileSizeMb(-5)).toBe(0);
    expect(clampMaxFileSizeMb(Number.NaN, 7)).toBe(7);
  });
});
