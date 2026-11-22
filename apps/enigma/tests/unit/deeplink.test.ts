// Belisario step 12: enigma:// links from Teutates open the co-op's room.
import { describe, expect, it, vi } from "vitest";
import { draftOf, openLink, parseEnigmaLink } from "../../src/deeplink";

describe("enigma:// links", () => {
  it("name a room, a #tag, a member and a quote", () => {
    const l = parseEnigmaLink("enigma://room/teutates-ab/roofs-panels?to=Ewa+Lewandowska&quote=see+this")!;
    expect(l).toEqual({ room: "teutates-ab", tag: "roofs-panels", to: "Ewa Lewandowska", quote: "see this" });
    expect(draftOf(l)).toBe("#roofs-panels @Ewa Lewandowska see this");
    expect(parseEnigmaLink("enigma://room/teutates-ab")).toEqual({ room: "teutates-ab", tag: null, to: null, quote: null });
    expect(parseEnigmaLink("morion://open?bucket=x&key=y")).toBeNull();
    expect(parseEnigmaLink("enigma://other/x")).toBeNull();
  });

  it("open the saved room of that name and show the chat; a room not here is said", async () => {
    const entry = { room: "slug1", name: "teutates-ab" };
    const open = vi.fn(async () => {});
    const show = vi.fn();
    expect(await openLink("enigma://room/teutates-ab/finance", { rooms: () => [entry], open, show })).toBe(true);
    expect(open).toHaveBeenCalledWith(entry);
    expect(show).toHaveBeenCalledWith("#finance", null);
    open.mockClear();
    expect(await openLink("enigma://room/teutates-zz", { rooms: () => [entry], open, show })).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(show).toHaveBeenLastCalledWith("", "teutates-zz");
    expect(await openLink("https://x", { rooms: () => [], open, show })).toBe(false);
  });
});
