import { describe, it, expect, beforeEach } from "vitest";
import { getOffline, setOffline, getProfileState, getRuntimeConfig } from "../../src/services/appStorage";

// In jsdom there is no Tauri runtime, so appStorage uses its localStorage backend —
// the same path the browser build relies on.
beforeEach(() => localStorage.clear());

describe("appStorage — offline / airplane switch (localStorage backend)", () => {
  it("defaults to off when unset", async () => {
    expect(await getOffline()).toBe(false);
  });

  it("persists on then off", async () => {
    await setOffline(true);
    expect(await getOffline()).toBe(true);
    await setOffline(false);
    expect(await getOffline()).toBe(false);
  });
});

describe("appStorage — browser fallbacks", () => {
  it("getProfileState returns an empty local profile shape", async () => {
    const state = await getProfileState();
    expect(state.offline_profile.display_name).toBe("");
    expect(state.offline_profiles).toEqual([]);
    expect(state.selected_offline_profile_id).toBe("");
  });

  it("getRuntimeConfig degrades to a browser identity", async () => {
    const runtime = await getRuntimeConfig();
    expect(runtime.profile).toBe("browser");
    expect(runtime.identity).toBe("browser");
  });
});
