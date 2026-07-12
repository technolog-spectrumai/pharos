import { describe, it, expect, beforeEach } from "vitest";
import {
  getServerIsOnion,
  setServerIsOnion,
  getServerData,
  setServerData,
} from "../../src/services/appStorage";

// In jsdom there is no Tauri runtime, so appStorage uses its localStorage backend —
// the same path the browser build relies on.
beforeEach(() => localStorage.clear());

describe("appStorage — server_is_onion switch (localStorage backend)", () => {
  it("defaults to off when unset", async () => {
    expect(await getServerIsOnion()).toBe(false);
  });

  it("persists on then off", async () => {
    await setServerIsOnion(true);
    expect(await getServerIsOnion()).toBe(true);
    await setServerIsOnion(false);
    expect(await getServerIsOnion()).toBe(false);
  });

  it("is independent of the server-data switch", async () => {
    await setServerIsOnion(true);
    await setServerData(false);
    expect(await getServerIsOnion()).toBe(true);
    expect(await getServerData()).toBe(false);
  });
});
