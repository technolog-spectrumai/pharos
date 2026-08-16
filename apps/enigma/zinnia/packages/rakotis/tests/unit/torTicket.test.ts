import { describe, it, expect } from "vitest";
import { isTorTicket } from "../../src/useChatChannel";

// `isTorTicket` mirrors the Rust `p2p_tor::ticket_is_tor` sniff: a Tor ticket is
// base32(`0x54` ++ postcard), so it decodes to a leading `0x54` ('T') byte. The
// frontend uses it to route reopening a saved room to the host-vs-dial path.
describe("isTorTicket — routes a ticket to the right transport", () => {
  it("accepts a base32 blob whose first byte is 0x54", () => {
    // base32(lowercase) of the bytes [0x54, 0x00] is "kqaa" (see the Rust encoder).
    expect(isTorTicket("kqaa")).toBe(true);
    expect(isTorTicket("KQAA")).toBe(true); // case-insensitive
    expect(isTorTicket("  kqaa  ")).toBe(true); // trimmed
  });

  it("rejects iroh-style (tagless) tickets and garbage", () => {
    // base32([0x00, 0x01, 0x02, 0x03]) → first byte 0x00, not the tag.
    expect(isTorTicket("aaaqeay")).toBe(false);
    expect(isTorTicket("aaaa")).toBe(false);
    expect(isTorTicket("")).toBe(false);
    expect(isTorTicket("!")).toBe(false);
    expect(isTorTicket("!!")).toBe(false);
  });
});
