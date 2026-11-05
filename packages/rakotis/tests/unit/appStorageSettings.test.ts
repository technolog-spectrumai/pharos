// Device settings and the browser-mode fallbacks of appStorage.
//
// Every tunable setting has the same shape: a default and bounds from the build
// config, a clamp, and a kv-backed value that may be missing or garbage. The
// clamp is the part that matters — Rust reads several of these keys directly, so
// a value the UI stored without clamping would be one the backend never agreed
// to. A stored value that does not parse falls back to the default rather than
// becoming NaN somewhere downstream.
//
// The desktop-only operations (PIN unlock among them) refuse plainly in a
// browser instead of pretending to succeed.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as S from "../../src/services/appStorage";
import { kvPut } from "../../src/services/localDb";

const original = { ...S.getBuildConfig() };
const putSetting = (k: string, v: string) => kvPut("p2p:settings", "default", k, v);

beforeEach(() => localStorage.clear());
afterEach(async () => {
  // initBuildConfig merges into module state; put the stock table back.
  await S.initBuildConfig(original);
});

// ── build config ────────────────────────────────────────────────────────────

describe("the build config in a browser", () => {
  it("is the stock table until patched, and a patch only touches what it names", async () => {
    expect(S.getBuildConfig().connect_timeout_secs).toEqual({ default: 60, min: 5, max: 600 });
    const patched = await S.initBuildConfig({ app_name: "Enigma Lite" });
    expect(patched.app_name).toBe("Enigma Lite");
    expect(S.getBuildConfig()).toBe(patched);
  });

  it("bounds every clamp, so a build can narrow what the user may pick", async () => {
    await S.initBuildConfig({ connect_timeout_secs: { default: 30, min: 10, max: 20 } });
    expect(S.clampConnectTimeoutSecs(5)).toBe(10);
    expect(S.clampConnectTimeoutSecs(99)).toBe(20);
    expect(await S.getConnectTimeoutSecs()).toBe(30);
  });
});

// ── tunable numbers ─────────────────────────────────────────────────────────

describe("numeric settings", () => {
  it.each([
    // [name, get, set, default, [input, clamped]...]
    ["connect timeout", S.getConnectTimeoutSecs, S.setConnectTimeoutSecs, 60, [[1, 5], [12.6, 13], [1e6, 600]]],
    ["idle lock", S.getIdleLockMins, S.setIdleLockMins, 15, [[0, 0], [-5, 0], [500, 120]]],
    ["chat history cap", S.getChatHistoryCapMsgs, S.setChatHistoryCapMsgs, 500, [[1, 50], [1e9, 5000]]],
  ] as const)("%s: defaults, clamps on write, and reads back what was stored", async (_name, get, set, dflt, cases) => {
    expect(await get()).toBe(dflt);
    for (const [input, clamped] of cases) {
      expect(await set(input)).toBe(clamped);
      expect(await get()).toBe(clamped);
    }
    expect(await set(Number.NaN)).toBe(dflt);
  });

  it.each([
    ["connect_timeout_secs", S.getConnectTimeoutSecs, 60],
    ["idle_lock_mins", S.getIdleLockMins, 15],
    ["chat_history_cap_msgs", S.getChatHistoryCapMsgs, 500],
  ] as const)("%s: a stored value that does not parse reads as the default", async (key, get, dflt) => {
    await putSetting(key, "banana");
    expect(await get()).toBe(dflt);
  });

  it("clamps a stored value that is out of range on the way out, too", async () => {
    // Written by an older build, or by hand: the reader must not trust it.
    await putSetting("connect_timeout_secs", "3");
    await putSetting("chat_history_cap_msgs", "999999");
    expect(await S.getConnectTimeoutSecs()).toBe(5);
    expect(await S.getChatHistoryCapMsgs()).toBe(5000);
  });

});

// ── switches and strings ────────────────────────────────────────────────────

describe("switches", () => {
  it.each([
    ["stable onion", S.getStableOnion, S.setStableOnion],
    ["lock on hide", S.getLockOnHide, S.setLockOnHide],
  ] as const)("%s: starts in its safe position and round-trips", async (_name, get, set) => {
    expect(await get()).toBe(false);
    await set(true);
    expect(await get()).toBe(true);
    await set(false);
    expect(await get()).toBe(false);
  });

});

describe("hidden tabs", () => {
  it("default to none hidden, so every tab the build has is shown", async () => {
    expect(await S.getHiddenTabs()).toEqual([]);
  });

  it("round-trip, keeping ids this build does not know", async () => {
    await S.setHiddenTabs(["calendar", "from-a-newer-build"]);
    expect(await S.getHiddenTabs()).toEqual(["calendar", "from-a-newer-build"]);
  });

  it("survive a corrupt or wrongly-typed stored value", async () => {
    await putSetting("hidden_tabs", "{oops");
    expect(await S.getHiddenTabs()).toEqual([]);
    await putSetting("hidden_tabs", JSON.stringify({ calendar: true }));
    expect(await S.getHiddenTabs()).toEqual([]);
    await putSetting("hidden_tabs", JSON.stringify(["calendar", 7, null, "vox"]));
    expect(await S.getHiddenTabs()).toEqual(["calendar", "vox"]);
  });
});

// ── browser fallbacks ───────────────────────────────────────────────────────

describe("desktop-only operations in a browser", () => {
  it.each([
    ["vaultPinEnroll", () => S.vaultPinEnroll("pw", "123456")],
    ["vaultPinUnlock", () => S.vaultPinUnlock("123456")],
  ])("%s refuses, naming the desktop app", async (_name, call) => {
    await expect(call()).rejects.toThrow(/only available in the desktop app/);
  });

  it("reports the things that need Rust as absent rather than failing", async () => {
    expect(await S.vaultHasPanicCode()).toBe(false);
    expect(await S.vaultPinStatus()).toEqual({ enrolled: false, digits: 6, attemptsLeft: 5 });
  });

  it("treats the vault as open, so the app is explorable without one", async () => {
    expect(await S.vaultStatus()).toEqual({ exists: true, unlocked: true });
    // None of these has anything to act on, and none of them throws.
    for (const op of [
      () => S.vaultSetup("pw"), () => S.vaultUnlock("pw"), () => S.vaultLock(), () => S.vaultTouch(),
      () => S.vaultChangePassphrase("a", "b"), () => S.vaultPinClear(), () => S.vaultWipe(),
      () => S.vaultSetPanicCode("pw", "code"), () => S.vaultClearPanicCode("pw"),
      () => S.cleanTorKeystore(),
    ]) {
      await expect(op()).resolves.toBeUndefined();
    }
  });

  it("switches profile by name, using it as the identity unless one is given", async () => {
    expect(await S.setActiveProfile("work")).toEqual({ profile: "work", identity: "work", profile_state_path: "" });
    expect(await S.setActiveProfile("work", "work-id")).toMatchObject({ identity: "work-id" });
  });

  it("answers every profile-state call with the local state, flags included", async () => {
    await S.setOffline(true);
    const blank = { display_name: "", email: "", phone: "", bio: "", date_of_birth: "" };
    const expected = {
      offline_profile: blank, offline_profiles: [], selected_offline_profile_id: "",
      offline: true, use_tor: true,
    };
    expect(await S.clearProfileState()).toEqual(expected);
    expect(await S.clearOfflineProfile()).toEqual(expected);
    expect(await S.setSelectedOfflineProfile("p1")).toEqual(expected);
    expect(await S.loadOfflineProfile("Work")).toEqual(expected);
    expect(await S.upsertOfflineProfile("p1", "Work", blank)).toEqual(expected);
    expect(await S.getOfflineProfile()).toEqual(blank);
    await expect(S.setOfflineProfile({ ...blank, display_name: "Alice" })).resolves.toBeUndefined();
  });
});
