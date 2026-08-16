import { describe, it, expect } from "vitest";
import {
  clampDhtNickname,
  getDhtNickname,
  setDhtNickname,
  getDhtNickPublish,
  setDhtNickPublish,
  DHT_NICKNAME_MAX_LEN,
} from "../../src/services/appStorage";
import { dhtFindNick } from "../../src/services/contacts";

// The nickname-directory settings ride the same kv the Rust announcer re-reads
// every round (`p2p_dht.rs` nickname()/nick_publish_enabled()). These tests pin
// the trim/cap contract and the browser degradation of the search itself.

describe("nickname directory settings", () => {
  it("publish toggle defaults to OFF and round-trips", async () => {
    expect(await getDhtNickPublish()).toBe(false);
    await setDhtNickPublish(true);
    expect(await getDhtNickPublish()).toBe(true);
    await setDhtNickPublish(false);
    expect(await getDhtNickPublish()).toBe(false);
  });

  it("nickname is trimmed, capped, and round-trips", async () => {
    expect(clampDhtNickname("  Alice-Dev  ")).toBe("Alice-Dev");
    expect(clampDhtNickname("x".repeat(200))).toHaveLength(DHT_NICKNAME_MAX_LEN);
    expect(clampDhtNickname("   ")).toBe("");

    expect(await setDhtNickname("  Alice-Dev  ")).toBe("Alice-Dev");
    expect(await getDhtNickname()).toBe("Alice-Dev");
  });
});

describe("nickname search — browser degradation", () => {
  it("resolves to [] without the Tauri runtime, and for blank input", async () => {
    expect(await dhtFindNick("alice")).toEqual([]);
    expect(await dhtFindNick("   ")).toEqual([]);
  });
});
