// E2E pin crypto (relay/"Forum" tab).
//
// Pinned messages are encrypted on the client under a per-channel symmetric "pin key"
// held only by members and distributed over MLS (see useChatChannel). The server only
// ever stores the opaque {iv, ciphertext} produced here — it holds no key and cannot
// read a pin. AES-256-GCM via WebCrypto (available in the webview and in Node/vitest).
//
// This module is pure (no Vue/transport deps) so it can be unit-tested directly.

import { bytesToBase64, base64ToBytes } from "./crypto";

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce

function subtle(): SubtleCrypto {
  const c = (globalThis as any).crypto;
  if (!c?.subtle) throw new Error("WebCrypto unavailable");
  return c.subtle;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  (globalThis as any).crypto.getRandomValues(b);
  return b;
}

/** A fresh 32-byte pin key (raw). */
export function randomPinKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/** A short opaque label for a pin key (lets the server/clients agree which key encrypted a pin). */
export function newPinKeyId(): string {
  return Array.from(randomBytes(8))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new Error("pin key must be 32 bytes");
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a plaintext string under the pin key → base64 {iv, ciphertext} for upload. */
export async function encryptPin(
  rawKey: Uint8Array,
  plaintext: string,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomBytes(IV_BYTES);
  const key = await importKey(rawKey);
  const ctBuf = await subtle().encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ctBuf)) };
}

/** Decrypt a stored pin (base64 iv/ciphertext) back to plaintext. Throws on wrong key/tamper. */
export async function decryptPin(
  rawKey: Uint8Array,
  ivB64: string,
  ciphertextB64: string,
): Promise<string> {
  const key = await importKey(rawKey);
  const ptBuf = await subtle().decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ciphertextB64),
  );
  return new TextDecoder().decode(ptBuf);
}

export { bytesToBase64 as pinKeyToB64, base64ToBytes as b64ToPinKey };
