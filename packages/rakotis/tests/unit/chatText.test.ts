// The seam rakotis uses to emit user-visible text without carrying a catalog.
//
// What matters here is the FALLBACK behaviour. rakotis is a library: it can be
// loaded by a headless channel, by a unit test, or by an app whose boot failed
// before it registered anything. In every one of those cases the user must see
// English — never a raw `chat.sys.encrypted` — and that is what these pin.

import { describe, it, expect, beforeEach } from "vitest";
import { setChatTranslator, clearChatTranslator, t } from "../../src/i18n/chatText";

beforeEach(() => clearChatTranslator());

describe("chat text", () => {
  it("uses the app's translation when one is registered", () => {
    setChatTranslator((key) => (key === "chat.sys.disconnected" ? "Rozłączono." : key));
    expect(t("chat.sys.disconnected", "Disconnected.")).toBe("Rozłączono.");
  });

  it("falls back to English when nothing is registered", () => {
    expect(t("chat.sys.disconnected", "Disconnected.")).toBe("Disconnected.");
  });

  it("falls back when the catalog does not know the key", () => {
    // vue-i18n echoes the key back for a missing entry, and showing a key to a
    // user is worse than showing them last release's English.
    setChatTranslator((key) => key);
    expect(t("chat.sys.brandNew", "Something new happened.")).toBe("Something new happened.");
  });

  it("falls back when the translator throws", () => {
    setChatTranslator(() => {
      throw new Error("catalog exploded");
    });
    expect(t("chat.sys.disconnected", "Disconnected.")).toBe("Disconnected.");
  });

  it("falls back on an empty translation", () => {
    setChatTranslator(() => "");
    expect(t("chat.sys.disconnected", "Disconnected.")).toBe("Disconnected.");
  });

  it("passes params through to the translator", () => {
    const seen: unknown[] = [];
    setChatTranslator((key, params) => {
      seen.push([key, params]);
      return "Połączono z Pokój.";
    });
    t("chat.sys.connected", "Connected to {room}.", { room: "Pokój" });
    expect(seen).toEqual([["chat.sys.connected", { room: "Pokój" }]]);
  });

  it("interpolates the fallback itself, so it never shows a raw placeholder", () => {
    // Without this an unregistered translator would render "Connected to {room}."
    expect(t("chat.sys.connected", "Connected to {room}.", { room: "Standup" })).toBe(
      "Connected to Standup.",
    );
  });

  it("leaves an unknown placeholder alone rather than blanking it", () => {
    expect(t("k", "Hello {name}, you have {n} messages.", { name: "Bob" })).toBe(
      "Hello Bob, you have {n} messages.",
    );
  });

  it("can be unregistered again", () => {
    setChatTranslator(() => "Rozłączono.");
    expect(t("chat.sys.disconnected", "Disconnected.")).toBe("Rozłączono.");
    setChatTranslator(null);
    expect(t("chat.sys.disconnected", "Disconnected.")).toBe("Disconnected.");
  });
});
