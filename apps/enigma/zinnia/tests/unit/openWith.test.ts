import { describe, expect, it } from "vitest";
import { extensionOf, kindForFile, looksOpenable } from "../../src/files/openWith";
import { dumps as dumpDoc, newDocument } from "../../src/formats/document";
import { dumps as dumpDeck, newPresentation } from "../../src/formats/presentation";
import { dumps as dumpSheet, newWorkbook } from "../../src/formats/sheet";

describe("choosing an editor for a file", () => {
  it("routes the unambiguous extensions", () => {
    expect(kindForFile("drawing.svg")).toBe("sketch");
    expect(kindForFile("budget.json")).toBe("sheet");
    expect(kindForFile("talk.pxml")).toBe("deck");
    expect(kindForFile("notes.txt")).toBe(null);
  });

  it("opens a .pxml with no content at all", () => {
    // The whole point of the extension: a listing can route a deck before it
    // has fetched a single byte.
    expect(kindForFile("talk.pxml")).toBe("deck");
    expect(looksOpenable("talk.pxml")).toBe(true);
  });

  it("still opens a .pxml whose bytes do not sniff", () => {
    // The content-first branch used to end in a bare `return null`, so a deck
    // that failed every sniffer became unopenable precisely when its content
    // WAS available — the one case where the app knows most about it.
    expect(kindForFile("talk.pxml", "")).toBe("deck");
    expect(kindForFile("talk.pxml", "<presentation")).toBe("deck");
  });

  it("refuses to guess at .xml without the content", () => {
    // Both the writer and the deck claim .xml. Guessing would open the wrong
    // editor about half the time, and an editor refusing what it was handed is
    // worse than a row that has not decided yet.
    expect(kindForFile("thing.xml")).toBe(null);
    // …but the row still looks clickable, because the bytes will settle it.
    expect(looksOpenable("thing.xml")).toBe(true);
  });

  it("settles .xml by what is inside it", () => {
    expect(kindForFile("thing.xml", dumpDoc(newDocument()))).toBe("document");
    expect(kindForFile("thing.xml", dumpDeck(newPresentation()))).toBe("deck");
  });

  it("believes the content over the name", () => {
    // A renamed file is still what it is.
    expect(kindForFile("mystery.txt", dumpDeck(newPresentation()))).toBe("deck");
    expect(kindForFile("mystery.dat", dumpSheet(newWorkbook()))).toBe("sheet");
  });

  it("falls back to the extension for svg, which has no sniffer", () => {
    expect(kindForFile("a.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>")).toBe("sketch");
  });

  it("opens nothing it does not recognise", () => {
    expect(kindForFile("photo.png", "not a document")).toBe(null);
    expect(looksOpenable("photo.png")).toBe(false);
  });

  it("keeps opening the legacy .xml decks already on disk", () => {
    // Every deck written before .pxml existed is a .xml. The sniff survives as
    // legacy rescue, not as the router.
    expect(kindForFile("old-talk.xml", dumpDeck(newPresentation()))).toBe("deck");
    expect(looksOpenable("old-talk.xml")).toBe(true);
  });

  it("does not resolve inherited object properties as editors", () => {
    // A bracket lookup on an object literal also finds Object.prototype, so a
    // file called `x.constructor` would come back as a truthy non-editor.
    expect(kindForFile("x.constructor")).toBe(null);
    expect(kindForFile("x.__proto__")).toBe(null);
    expect(kindForFile("x.toString")).toBe(null);
    expect(looksOpenable("x.constructor")).toBe(false);
  });

  it("reads extensions the way a filename actually looks", () => {
    expect(extensionOf("a.b.SVG")).toBe("svg");
    expect(extensionOf("noextension")).toBe("");
    expect(extensionOf(".hidden")).toBe("hidden");
  });
});
