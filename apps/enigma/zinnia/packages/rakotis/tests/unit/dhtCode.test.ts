import { describe, it, expect } from "vitest";
import { isDhtCode, isTorTicket } from "../../src/useChatChannel";

// `isDhtCode` mirrors the Rust `p2p_iroh::code_is_dht` sniff: a DHT room code is
// base32(`0x44` ('D') ++ postcard), so it decodes to a leading `0x44` byte. The
// join field routes any pasted/scanned blob by this tag — DHT code vs Tor ticket
// (0x54) vs tagless iroh ticket — so the sniffs must never overlap.
describe("isDhtCode — routes a room code to the ticketless join path", () => {
  it("accepts a base32 blob whose first byte is 0x44", () => {
    // base32(lowercase) of the bytes [0x44, 0x00] is "iqaa" (see the Rust encoder).
    expect(isDhtCode("iqaa")).toBe(true);
    expect(isDhtCode("IQAA")).toBe(true); // case-insensitive
    expect(isDhtCode("  iqaa  ")).toBe(true); // trimmed
  });

  it("rejects Tor tickets, tagless iroh tickets, and garbage", () => {
    expect(isDhtCode("kqaa")).toBe(false); // Tor tag 0x54
    expect(isDhtCode("aaaqeay")).toBe(false); // tagless iroh
    expect(isDhtCode("")).toBe(false);
    expect(isDhtCode("!")).toBe(false);
    expect(isDhtCode("!!")).toBe(false);
  });

  it("never overlaps with the Tor sniff on the same input", () => {
    for (const blob of ["iqaa", "kqaa", "aaaqeay", "", "!!"]) {
      expect(isDhtCode(blob) && isTorTicket(blob)).toBe(false);
    }
    expect(isTorTicket("iqaa")).toBe(false);
  });
});
