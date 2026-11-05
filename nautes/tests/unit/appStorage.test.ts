import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  vaultSetPanicCode,
  vaultClearPanicCode,
  vaultHasPanicCode,
} from "rakotis";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).__TAURI_INTERNALS__ = {};
  invokeMock.mockResolvedValue(null);
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
