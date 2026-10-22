// appStorage inside the Tauri app: every call is a Rust command, and these
// tests pin the command name and argument shape of each one.
//
// The argument names are the IPC contract — Tauri maps camelCase keys onto the
// Rust parameters, so `useTor` vs `use_tor`, or `new` vs `next`, is the
// difference between a setting that saves and one that fails at runtime with a
// "missing argument" nobody sees. The kv-backed settings ride `kv_get` / `kv_put`,
// emulated here by a small in-memory store so reads see earlier writes.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { kv, replies, invoke } = vi.hoisted(() => {
  const kv = new Map<string, string>();
  const replies = new Map<string, unknown>();
  const key = (a: Record<string, unknown>) => `${a.ns}|${a.scope}|${a.k}`;
  const invoke = vi.fn(async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    switch (cmd) {
      case "kv_get":
        return kv.get(key(args)) ?? null;
      case "kv_put":
        kv.set(key(args), args.v as string);
        return undefined;
      default:
        return replies.get(cmd);
    }
  });
  return { kv, replies, invoke };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args),
}));

import * as S from "../../src/services/appStorage";

const original = { ...S.getBuildConfig() };
const commands = () => invoke.mock.calls.map(([cmd]) => cmd);

beforeEach(() => {
  kv.clear();
  replies.clear();
  invoke.mockClear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

afterEach(async () => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  await S.initBuildConfig(original);
});

describe("the build config", () => {
  it("comes from the binary, which wins over any browser fallback", async () => {
    const baked = { ...original, app_name: "Enigma Pro", dht_enabled: false };
    replies.set("app_get_build_config", baked);
    expect(await S.initBuildConfig({ app_name: "ignored" })).toEqual(baked);
    expect(S.getBuildConfig().app_name).toBe("Enigma Pro");
  });

  it("keeps the fallback when the binary cannot answer", async () => {
    invoke.mockRejectedValueOnce(new Error("unknown command"));
    expect((await S.initBuildConfig({ app_name: "Fallback" })).app_name).toBe("Fallback");
  });
});

describe("switches that Rust owns", () => {
  it("read and write through their own commands and never touch localStorage", async () => {
    replies.set("app_get_offline", true);
    replies.set("app_get_use_tor", true);
    replies.set("app_get_stable_onion", true);
    expect(await S.getOffline()).toBe(true);
    expect(await S.getUseTor()).toBe(true);
    expect(await S.getStableOnion()).toBe(true);
    await S.setOffline(false);
    await S.setUseTor(false);
    await S.setStableOnion(false);
    expect(invoke.mock.calls.slice(3)).toEqual([
      ["app_set_offline", { offline: false }],
      ["app_set_use_tor", { useTor: false }],
      ["app_set_stable_onion", { stableOnion: false }],
    ]);
    expect(localStorage.length).toBe(0);
  });
});

describe("kv-backed settings", () => {
  it("store the clamped value under the key Rust reads", async () => {
    expect(await S.setConnectTimeoutSecs(1)).toBe(5);
    expect(invoke).toHaveBeenCalledWith("kv_put", {
      ns: "p2p:settings", scope: "default", k: "connect_timeout_secs", v: "5",
    });
    expect(await S.getConnectTimeoutSecs()).toBe(5);
  });

  it("read as their defaults when the store cannot be read", async () => {
    // A locked vault is an ordinary state at boot; settings must not throw then.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "kv_get") throw new Error("vault locked");
      return undefined;
    });
    try {
      expect(await S.getConnectTimeoutSecs()).toBe(60);
      expect(await S.getIdleLockMins()).toBe(15);
      expect(await S.getChatHistoryCapMsgs()).toBe(500);
      expect(await S.getMaxFileSizeMb(25)).toBe(25);
      expect(await S.getMeetingReminderMins()).toBe(15);
      expect(await S.getDhtRoomPublishSecs()).toBe(600);
      expect(await S.getDhtPresencePollSecs()).toBe(300);
      expect(await S.getFileKeyRotationDays()).toBe(0);
      expect(await S.getLockOnHide()).toBe(false);
      expect(await S.getDeleteFilesOnPanic()).toBe(false);
      expect(await S.getHiddenTabs()).toEqual([]);
      expect(await S.getLockedFiles()).toEqual([]);
      expect(await S.getNoteRecents()).toEqual([]);
      expect(await S.getDhtDiscovery()).toBe(false);
      expect(await S.getDhtNickPublish()).toBe(false);
      expect(await S.getDhtNickname()).toBe("");
    } finally {
      invoke.mockReset();
    }
  });

  it("still report the clamped value when the write fails", async () => {
    invoke.mockRejectedValue(new Error("vault locked"));
    try {
      expect(await S.setIdleLockMins(500)).toBe(120);
      expect(await S.setChatHistoryCapMsgs(1)).toBe(50);
      await expect(S.setHiddenTabs(["vox"])).resolves.toBeUndefined();
      await expect(S.setLockOnHide(true)).resolves.toBeUndefined();
    } finally {
      invoke.mockReset();
    }
  });
});

describe("the panic-targets sidecar", () => {
  it("is re-sealed after the knob is written, in that order", async () => {
    await S.setDeleteFilesOnPanic(true);
    expect(commands()).toEqual(["kv_put", "panic_targets_resync"]);
    expect(await S.getDeleteFilesOnPanic()).toBe(true);
  });

  it("is re-sealed whenever the locked-file list changes", async () => {
    await S.addLockedFile({ path: "/a", name: "a", size: 1, lockedAt: 1 });
    await S.removeLockedFile("/a");
    expect(commands().filter((c) => c === "panic_targets_resync")).toHaveLength(2);
  });

  it("does not let a failed re-seal break the change that triggered it", async () => {
    invoke.mockImplementationOnce(async () => undefined); // kv_put
    invoke.mockRejectedValueOnce(new Error("no panic code")); // panic_targets_resync
    await expect(S.setDeleteFilesOnPanic(false)).resolves.toBeUndefined();
  });
});

describe("the DHT", () => {
  it("reports Rust's status, and a disabled triple when it cannot", async () => {
    replies.set("dht_status", { enabled: true, running: true, bootstrapped: false });
    expect(await S.getDhtStatus()).toEqual({ enabled: true, running: true, bootstrapped: false });
    invoke.mockRejectedValueOnce(new Error("DHT_DISABLED"));
    expect(await S.getDhtStatus()).toEqual({ enabled: false, running: false, bootstrapped: false });
  });

  it("applies a flipped toggle and swallows a failure", async () => {
    await S.applyDhtDiscovery();
    expect(invoke).toHaveBeenCalledWith("dht_apply", undefined);
    invoke.mockRejectedValueOnce(new Error("offline"));
    await expect(S.applyDhtDiscovery()).resolves.toBeUndefined();
  });

  it("asks nothing of Rust in a build without the DHT", async () => {
    replies.set("app_get_build_config", { ...original, dht_enabled: false });
    await S.initBuildConfig();
    invoke.mockClear();
    expect(await S.getDhtStatus()).toEqual({ enabled: false, running: false, bootstrapped: false });
    expect(await S.getDhtDiscovery()).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("the vault", () => {
  it("keeps the heartbeat best-effort but lets an unlock failure reach the gate", async () => {
    invoke.mockRejectedValueOnce(new Error("webview gone"));
    await expect(S.vaultTouch()).resolves.toBeUndefined();
    invoke.mockRejectedValueOnce(new Error("wrong passphrase"));
    await expect(S.vaultUnlock("nope")).rejects.toThrow("wrong passphrase");
  });

  it("answers status, PIN status and panic-code presence from Rust", async () => {
    replies.set("vault_status", { exists: true, unlocked: false });
    replies.set("vault_pin_status", { enrolled: true, digits: 8, attemptsLeft: 2 });
    replies.set("vault_has_panic_code", true);
    expect(await S.vaultStatus()).toEqual({ exists: true, unlocked: false });
    expect(await S.vaultPinStatus()).toEqual({ enrolled: true, digits: 8, attemptsLeft: 2 });
    expect(await S.vaultHasPanicCode()).toBe(true);
  });
});

// Every remaining command, with the exact arguments Rust expects, and whether
// it hands Rust's answer back (a query) or resolves to nothing (a command).
const note = { display_name: "Alice", email: "", phone: "", bio: "", date_of_birth: "" };
type Route = [name: string, call: () => Promise<unknown>, cmd: string, args: Record<string, unknown> | undefined, returns: boolean];
const routes: Route[] = [
  ["vaultSetup", () => S.vaultSetup("pw"), "vault_setup", { passphrase: "pw" }, false],
  ["vaultUnlock", () => S.vaultUnlock("pw"), "vault_unlock", { passphrase: "pw" }, false],
  ["vaultLock", () => S.vaultLock(), "vault_lock", undefined, false],
  ["vaultChangePassphrase", () => S.vaultChangePassphrase("old", "new"), "vault_change_passphrase", { current: "old", new: "new" }, false],
  ["vaultPinEnroll", () => S.vaultPinEnroll("pw", "123456", "654321", "duress"), "vault_pin_enroll", { passphrase: "pw", pin: "123456", panicPin: "654321", panicCode: "duress" }, false],
  ["vaultPinUnlock", () => S.vaultPinUnlock("123456"), "vault_pin_unlock", { pin: "123456" }, false],
  ["vaultPinClear", () => S.vaultPinClear(), "vault_pin_clear", undefined, false],
  ["vaultWipe", () => S.vaultWipe(), "vault_wipe", undefined, false],
  ["vaultSetPanicCode", () => S.vaultSetPanicCode("pw", "duress"), "vault_set_panic_code", { current: "pw", code: "duress" }, false],
  ["vaultClearPanicCode", () => S.vaultClearPanicCode("pw"), "vault_clear_panic_code", { current: "pw" }, false],
  ["lockLocalFile", () => S.lockLocalFile("/a", "pw"), "local_lock_file", { path: "/a", passphrase: "pw" }, true],
  ["unlockLocalFile", () => S.unlockLocalFile("/a", "pw"), "local_unlock_file", { path: "/a", passphrase: "pw" }, true],
  ["rotateLocalFile", () => S.rotateLocalFile("/a", "pw", "pw2"), "local_rotate_file", { path: "/a", current: "pw", new: "pw2" }, true],
  ["isLocalFileLocked", () => S.isLocalFileLocked("/a"), "local_is_locked", { path: "/a" }, true],
  ["getKeyringStatus", () => S.getKeyringStatus("r1"), "keyring_status", { ringId: "r1" }, true],
  ["keyringList", () => S.keyringList(), "keyring_list", undefined, true],
  ["keyringCreate", () => S.keyringCreate("Work", "pw"), "keyring_create", { name: "Work", passphrase: "pw" }, true],
  ["keyringRename", () => S.keyringRename("r1", "pw", "Home"), "keyring_rename", { ringId: "r1", passphrase: "pw", name: "Home" }, false],
  ["keyringDelete", () => S.keyringDelete("r1", "pw"), "keyring_delete", { ringId: "r1", passphrase: "pw" }, false],
  ["keyringLock", () => S.keyringLock("r1", "pw", ["/a"]), "keyring_lock", { ringId: "r1", passphrase: "pw", paths: ["/a"] }, true],
  ["keyringUnlock", () => S.keyringUnlock("r1", "pw", ["/a.enigr"]), "keyring_unlock", { ringId: "r1", passphrase: "pw", paths: ["/a.enigr"] }, true],
  ["keyringUnlockAll", () => S.keyringUnlockAll("r1", "pw"), "keyring_unlock_all", { ringId: "r1", passphrase: "pw" }, true],
  ["keyringEntries", () => S.keyringEntries("r1", "pw"), "keyring_entries", { ringId: "r1", passphrase: "pw" }, true],
  ["keyringChangePassphrase", () => S.keyringChangePassphrase("r1", "old", "new"), "keyring_change_passphrase", { ringId: "r1", old: "old", new: "new" }, false],
  ["keyringRotate", () => S.keyringRotate("r1", "old", "new"), "keyring_rotate", { ringId: "r1", old: "old", new: "new" }, true],
  ["readLocalNote (plain)", () => S.readLocalNote("/n.md"), "local_note_read", { path: "/n.md", passphrase: null }, true],
  ["readLocalNote (locked)", () => S.readLocalNote("/n.md", "pw"), "local_note_read", { path: "/n.md", passphrase: "pw" }, true],
  ["writeLocalNote", () => S.writeLocalNote("/n.md", "text"), "local_note_write", { path: "/n.md", content: "text", passphrase: null }, true],
  ["statLocalNote", () => S.statLocalNote("/n.md"), "local_note_stat", { path: "/n.md" }, true],
  ["writeBase64FileToDisk", () => S.writeBase64FileToDisk("/a.png", "AAAA"), "fs_write_base64_file", { path: "/a.png", b64: "AAAA" }, false],
  ["cleanTorKeystore", () => S.cleanTorKeystore(), "tor_clean_keystore", undefined, false],
  ["getRuntimeConfig", () => S.getRuntimeConfig(), "app_get_runtime_config", undefined, true],
  ["setActiveProfile", () => S.setActiveProfile("work", "work-id"), "app_set_active_profile", { profile: "work", identity: "work-id" }, true],
  ["getProfileState", () => S.getProfileState(), "app_get_profile_state", undefined, true],
  ["clearProfileState", () => S.clearProfileState(), "app_clear_profile_state", undefined, true],
  ["getOfflineProfile", () => S.getOfflineProfile(), "app_get_offline_profile", undefined, true],
  ["setOfflineProfile", () => S.setOfflineProfile(note), "app_set_offline_profile", { offlineProfile: note }, false],
  ["clearOfflineProfile", () => S.clearOfflineProfile(), "app_clear_offline_profile", undefined, true],
  ["setSelectedOfflineProfile", () => S.setSelectedOfflineProfile("p1"), "app_set_selected_offline_profile", { selectedOfflineProfileId: "p1" }, true],
  ["loadOfflineProfile", () => S.loadOfflineProfile("Work"), "app_load_offline_profile", { label: "Work" }, true],
  ["upsertOfflineProfile", () => S.upsertOfflineProfile("p1", "Work", note), "app_upsert_offline_profile", { offlineProfileId: "p1", label: "Work", offlineProfile: note }, true],
];
describe.each(routes)("%s", (_name, call, cmd, args, returns) => {
  it(`invokes ${cmd} with exactly its arguments`, async () => {
    replies.set(cmd, { from: cmd });
    const out = await call();
    expect(invoke.mock.calls).toEqual([[cmd, args]]);
    expect(out).toEqual(returns ? { from: cmd } : undefined);
  });
});
