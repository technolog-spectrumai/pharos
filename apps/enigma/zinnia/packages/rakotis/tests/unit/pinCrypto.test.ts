import { describe, it, expect } from "vitest";
import {
  randomPinKey,
  newPinKeyId,
  encryptPin,
  decryptPin,
  pinKeyToB64,
  b64ToPinKey,
} from "../../src/pinCrypto";

// WebCrypto is available in Node 18+/vitest's environment.

describe("pinCrypto — E2E pin encryption (AES-256-GCM)", () => {
  it("generates a 32-byte key and unique ids", () => {
    expect(randomPinKey().length).toBe(32);
    const a = newPinKeyId();
    const b = newPinKeyId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it("round-trips plaintext under the same key", async () => {
    const key = randomPinKey();
    const { iv, ciphertext } = await encryptPin(key, "launch is friday");
    expect(ciphertext).not.toContain("launch"); // base64, opaque
    expect(await decryptPin(key, iv, ciphertext)).toBe("launch is friday");
  });

  it("uses a fresh iv each time (probabilistic)", async () => {
    const key = randomPinKey();
    const a = await encryptPin(key, "x");
    const b = await encryptPin(key, "x");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("fails to decrypt under a different key", async () => {
    const { iv, ciphertext } = await encryptPin(randomPinKey(), "secret");
    await expect(decryptPin(randomPinKey(), iv, ciphertext)).rejects.toBeDefined();
  });

  it("fails on a tampered ciphertext", async () => {
    const key = randomPinKey();
    const { iv, ciphertext } = await encryptPin(key, "secret");
    const bytes = b64ToPinKey(ciphertext);
    bytes[0] ^= 0xff;
    await expect(decryptPin(key, iv, pinKeyToB64(bytes))).rejects.toBeDefined();
  });

  it("a key survives base64 serialization (KV persistence)", async () => {
    const key = randomPinKey();
    const restored = b64ToPinKey(pinKeyToB64(key));
    const { iv, ciphertext } = await encryptPin(key, "persisted");
    expect(await decryptPin(restored, iv, ciphertext)).toBe("persisted");
  });

  it("round-trips a JSON payload (how pins are actually stored)", async () => {
    const key = randomPinKey();
    const payload = JSON.stringify({ type: "chat_message", content: "hi", image_data: null });
    const { iv, ciphertext } = await encryptPin(key, payload);
    expect(JSON.parse(await decryptPin(key, iv, ciphertext))).toEqual({
      type: "chat_message",
      content: "hi",
      image_data: null,
    });
  });
});
