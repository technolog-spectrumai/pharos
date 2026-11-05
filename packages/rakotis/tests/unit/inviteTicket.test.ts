// `isInviteTicket` mirrors the Rust `invite_ticket::is_invite_ticket` sniff: an
// invitation is base32(`0x4E` ('N') ++ version ++ kind ++ body). The join field
// uses it to route a scanned or pasted code to the redemption path instead of the
// ordinary topic join.
//
// It is deliberately a *sniff*. It cannot say whether an invitation is valid, has
// expired, was revoked, or is addressed to this device — a Personal invitation is
// sealed, so only Rust (which holds the identity secret) can answer any of that.

import { describe, it, expect } from "vitest";
import { isInviteTicket } from "../../src/useChatChannel";

/** base32(lowercase, no pad) of a byte sequence — the encoder the tickets use. */
function b32(bytes: number[]): string {
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

const general = () => b32([0x4e, 0x01, 0x47, 0xde, 0xad]);
const personal = () => b32([0x4e, 0x01, 0x50, 0xbe, 0xef]);

describe("isInviteTicket", () => {
  it("accepts both kinds of invitation", () => {
    expect(isInviteTicket(general())).toBe(true);
    expect(isInviteTicket(personal())).toBe(true);
  });

  it("is case-insensitive and trims, like every other ticket sniff", () => {
    expect(isInviteTicket(general().toUpperCase())).toBe(true);
    expect(isInviteTicket(`  ${general()}  `)).toBe(true);
  });

  it("does not claim a blob from a retired tag family", () => {
    // Room tickets (0x49 / 0x54) and DHT room codes (0x44) are gone, so their
    // sniffs are too — but an old QR still exists in the world, and this is the
    // check that decides it gets a plain refusal rather than being mistaken for
    // an invitation and dialled somewhere.
    for (const tag of [0x49, 0x54, 0x44]) {
      expect(isInviteTicket(b32([tag, 0x00, 0x01])), tag.toString(16)).toBe(false);
    }
  });

  it("rejects junk without throwing", () => {
    for (const junk of ["", "a", "!!!!", "not base32 at all", "  "]) {
      expect(isInviteTicket(junk)).toBe(false);
    }
  });
});
