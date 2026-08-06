import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getMaxFileSizeMb,
  setMaxFileSizeMb,
  clampMaxFileSizeMb,
  MAX_FILE_SIZE_MAX_MB,
  getMeetingReminderMins,
  setMeetingReminderMins,
  clampMeetingReminderMins,
  MEETING_REMINDER_DEFAULT_MINS,
  MEETING_REMINDER_MAX_MINS,
  getFileChunkKib,
  setFileChunkKib,
  getFileIntegrity,
  setFileIntegrity,
  getBuildConfig,
  vaultSetPanicCode,
  vaultClearPanicCode,
  vaultHasPanicCode,
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

describe("appStorage — meeting reminder lead time", () => {
  it("falls back to the default when nothing is stored", async () => {
    expect(await getMeetingReminderMins()).toBe(MEETING_REMINDER_DEFAULT_MINS);
  });

  it("a stored value wins and is clamped; 0 = reminders off", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "5" : null));
    expect(await getMeetingReminderMins()).toBe(5);

    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "0" : null));
    expect(await getMeetingReminderMins()).toBe(0);

    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "99999" : null));
    expect(await getMeetingReminderMins()).toBe(MEETING_REMINDER_MAX_MINS);
  });

  it("set persists the clamped value; garbage falls back to the default", async () => {
    expect(await setMeetingReminderMins(Number.NaN)).toBe(MEETING_REMINDER_DEFAULT_MINS);
    expect(invokeMock).toHaveBeenCalledWith(
      "kv_put",
      expect.objectContaining({ k: "meeting_reminder_mins", v: String(MEETING_REMINDER_DEFAULT_MINS) }),
    );
  });

  it("clamp bounds negatives to 0 (off)", () => {
    expect(clampMeetingReminderMins(-10)).toBe(0);
    expect(clampMeetingReminderMins(25 * 60)).toBe(MEETING_REMINDER_MAX_MINS);
  });
});

// The panic code (duress passphrase) is arm/disarm-only from the frontend — the
// wipe itself is entirely Rust-side, triggered by typing the code at the unlock
// gate. These pin the command names and argument shape the Rust commands expect.
describe("appStorage — panic code", () => {
  it("arming passes the current passphrase alongside the code", async () => {
    await vaultSetPanicCode("real-pass", "burn-it");
    expect(invokeMock).toHaveBeenCalledWith("vault_set_panic_code", {
      current: "real-pass",
      code: "burn-it",
    });
  });

  it("disarming only needs the current passphrase", async () => {
    await vaultClearPanicCode("real-pass");
    expect(invokeMock).toHaveBeenCalledWith("vault_clear_panic_code", { current: "real-pass" });
  });

  it("reports whether one is armed", async () => {
    invokeMock.mockImplementation(async (cmd: string) => cmd === "vault_has_panic_code");
    expect(await vaultHasPanicCode()).toBe(true);

    invokeMock.mockResolvedValue(false);
    expect(await vaultHasPanicCode()).toBe(false);
  });
});

// Transfer chunking and the integrity toggle: both DEVICE-LOCAL settings whose
// clamp/default come from the build config, not from callers.
describe("appStorage — file chunk size", () => {
  it("falls back to the build-config default when nothing is stored", async () => {
    expect(await getFileChunkKib()).toBe(getBuildConfig().file_chunk_kib.default);
  });

  it("clamps a stored value into the build-config bounds", async () => {
    const clamp = getBuildConfig().file_chunk_kib;

    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "1" : null));
    expect(await getFileChunkKib()).toBe(clamp.min);

    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "kv_get" ? String(clamp.max * 10) : null,
    );
    expect(await getFileChunkKib()).toBe(clamp.max);
  });

  it("set persists the clamped value; garbage falls back to the default", async () => {
    const clamp = getBuildConfig().file_chunk_kib;
    expect(await setFileChunkKib(clamp.max * 99)).toBe(clamp.max);
    expect(invokeMock).toHaveBeenCalledWith(
      "kv_put",
      expect.objectContaining({ k: "file_chunk_kib", v: String(clamp.max) }),
    );
    expect(await setFileChunkKib(Number.NaN)).toBe(clamp.default);
  });
});

describe("appStorage — transfer integrity toggle", () => {
  it("defaults to the build config when unset", async () => {
    expect(await getFileIntegrity()).toBe(getBuildConfig().file_integrity_default);
  });

  it("round-trips on and off as explicit strings", async () => {
    await setFileIntegrity(false);
    expect(invokeMock).toHaveBeenCalledWith(
      "kv_put",
      expect.objectContaining({ k: "file_integrity", v: "off" }),
    );

    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "off" : null));
    expect(await getFileIntegrity()).toBe(false);

    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "on" : null));
    expect(await getFileIntegrity()).toBe(true);
  });

  it("an unrecognised stored value falls back to the default rather than off", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "kv_get" ? "maybe" : null));
    expect(await getFileIntegrity()).toBe(getBuildConfig().file_integrity_default);
  });
});
