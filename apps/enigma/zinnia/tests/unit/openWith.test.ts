import { describe, expect, it } from "vitest";
import { extensionOf, kindForFile, looksOpenable } from "../../src/files/openWith";
import { dumps as dumpDoc, newDocument } from "../../src/formats/document";
import { dumps as dumpDeck, newPresentation } from "../../src/formats/presentation";
import { dumps as dumpSheet, newWorkbook } from "../../src/formats/sheet";

describe("choosing an editor for a file", () => {
  it("routes the unambiguous extensions", () => {
    expect(kindForFile("drawing.svg")).toBe("sketch");
    expect(kindForFile("budget.json")).toBe("sheet");
    expect(kindForFile("notes.txt")).toBe(null);
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

  it("reads extensions the way a filename actually looks", () => {
    expect(extensionOf("a.b.SVG")).toBe("svg");
    expect(extensionOf("noextension")).toBe("");
    expect(extensionOf(".hidden")).toBe("hidden");
  });
});
