import { describe, it, expect, beforeEach } from "vitest";
import {
  getOffline,
  setOffline,
  getUseTor,
  setUseTor,
  getProfileState,
  getRuntimeConfig,
  getMapActiveRegion,
  setMapActiveRegion,
} from "../../src/services/appStorage";

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

describe("appStorage — use Tor switch (localStorage backend)", () => {
  it("defaults to off when unset", async () => {
    expect(await getUseTor()).toBe(false);
  });

  it("persists on then off, independently of the offline flag", async () => {
    await setUseTor(true);
    expect(await getUseTor()).toBe(true);
    expect(await getOffline()).toBe(false);
    await setUseTor(false);
    expect(await getUseTor()).toBe(false);
  });
});

describe("appStorage — browser fallbacks", () => {
  it("getProfileState returns an empty local profile shape", async () => {
    const state = await getProfileState();
    expect(state.offline_profile.display_name).toBe("");
    expect(state.offline_profiles).toEqual([]);
    expect(state.selected_offline_profile_id).toBe("");
    expect(state.use_tor).toBe(false);
  });

  it("getRuntimeConfig degrades to a browser identity", async () => {
    const runtime = await getRuntimeConfig();
    expect(runtime.profile).toBe("browser");
    expect(runtime.identity).toBe("browser");
  });
});

describe("appStorage — active map region (localStorage backend)", () => {
  it("defaults to none when unset", async () => {
    expect(await getMapActiveRegion()).toBe("");
  });

  it("round-trips an id and clears via the empty string", async () => {
    await setMapActiveRegion("region-1");
    expect(await getMapActiveRegion()).toBe("region-1");
    await setMapActiveRegion("");
    expect(await getMapActiveRegion()).toBe("");
  });

  it("pins the exact kv coordinates Rust reads (maps.rs KEY_ACTIVE_REGION)", async () => {
    // Drift in ns/scope/key silently breaks tile priority — the Rust side
    // reads this same triple raw.
    await setMapActiveRegion("region-1");
    expect(localStorage.getItem("enigma:db:p2p:settings:default:map_active_region")).toBe(
      "region-1",
    );
  });
});
