import { describe, it, expect } from "vitest";
import {
  getDhtDiscovery,
  setDhtDiscovery,
  applyDhtDiscovery,
  getDhtStatus,
  clampDhtRoomPublishSecs,
  getDhtRoomPublishSecs,
  setDhtRoomPublishSecs,
  DHT_ROOM_PUBLISH_DEFAULT_SECS,
  DHT_ROOM_PUBLISH_MIN_SECS,
  DHT_ROOM_PUBLISH_MAX_SECS,
  clampDhtPresencePollSecs,
  getDhtPresencePollSecs,
  setDhtPresencePollSecs,
  DHT_PRESENCE_POLL_DEFAULT_SECS,
  DHT_PRESENCE_POLL_MIN_SECS,
  DHT_PRESENCE_POLL_MAX_SECS,
} from "../../src/services/appStorage";

// DHT settings live in the kv (`p2p:settings`) that the Rust side reads
// directly at endpoint-bind time — these tests pin the defaults and clamps the
// two layers must agree on (mirrored in p2p_dht.rs `setting_secs`). Under
// vitest the kv falls back to localStorage.

describe("DHT discovery toggle", () => {
  it("defaults to OFF — the feature is strictly opt-in", async () => {
    expect(await getDhtDiscovery()).toBe(false);
  });

  it("round-trips on/off through the kv", async () => {
    await setDhtDiscovery(true);
    expect(await getDhtDiscovery()).toBe(true);
    await setDhtDiscovery(false);
    expect(await getDhtDiscovery()).toBe(false);
  });

  it("apply + status degrade gracefully without the Tauri runtime", async () => {
    await expect(applyDhtDiscovery()).resolves.toBeUndefined();
    expect(await getDhtStatus()).toEqual({ enabled: false, running: false, bootstrapped: false });
  });
});

describe("DHT cadences — defaults and clamps (must match p2p_dht.rs)", () => {
  it("room publish: default 600 s, clamped to 60–3600", async () => {
    expect(await getDhtRoomPublishSecs()).toBe(DHT_ROOM_PUBLISH_DEFAULT_SECS);
    expect(clampDhtRoomPublishSecs(1)).toBe(DHT_ROOM_PUBLISH_MIN_SECS);
    expect(clampDhtRoomPublishSecs(999999)).toBe(DHT_ROOM_PUBLISH_MAX_SECS);
    expect(clampDhtRoomPublishSecs(NaN)).toBe(DHT_ROOM_PUBLISH_DEFAULT_SECS);
    expect(await setDhtRoomPublishSecs(120)).toBe(120);
    expect(await getDhtRoomPublishSecs()).toBe(120);
    // Setter clamps before storing.
    expect(await setDhtRoomPublishSecs(5)).toBe(DHT_ROOM_PUBLISH_MIN_SECS);
  });

  it("presence poll: default 300 s, clamped to 60–3600", async () => {
    expect(await getDhtPresencePollSecs()).toBe(DHT_PRESENCE_POLL_DEFAULT_SECS);
    expect(clampDhtPresencePollSecs(0)).toBe(DHT_PRESENCE_POLL_MIN_SECS);
    expect(clampDhtPresencePollSecs(1e9)).toBe(DHT_PRESENCE_POLL_MAX_SECS);
    expect(clampDhtPresencePollSecs(Infinity)).toBe(DHT_PRESENCE_POLL_DEFAULT_SECS);
    expect(await setDhtPresencePollSecs(90)).toBe(90);
    expect(await getDhtPresencePollSecs()).toBe(90);
  });

  it("a garbage stored value falls back to the default", async () => {
    localStorage.setItem("enigma:db:p2p:settings:default:dht_room_publish_secs", "banana");
    expect(await getDhtRoomPublishSecs()).toBe(DHT_ROOM_PUBLISH_DEFAULT_SECS);
  });
});
