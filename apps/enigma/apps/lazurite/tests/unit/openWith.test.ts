import { describe, expect, it } from "vitest";
import { extensionOf, kindForFile } from "../../src/files/openWith";
import { dumps as dumpDoc, newDocument } from "../../src/formats/document";
import { dumps as dumpDeck, newPresentation } from "../../src/formats/presentation";
import { dumps as dumpSheet, newWorkbook } from "../../src/formats/sheet";

describe("choosing an editor for a file", () => {
  it("routes the unambiguous extensions", () => {
    // By NAME alone a .json is source. The workbook claim is made by the
    // sniffer, which runs first everywhere the bytes are in hand — and every
    // open path has them, so a real workbook still reaches the sheet.
    expect(kindForFile("budget.json")).toBe("code");
    expect(kindForFile("talk.pxml")).toBe("deck");
    expect(kindForFile("script.py")).toBe("code");
    expect(kindForFile("paper.tex")).toBe("code");
    expect(kindForFile("mystyle.sty")).toBe("code");
    expect(kindForFile("notes.txt")).toBe("code");
  });

  it("sends a Univer workbook to the sheet and every other JSON to code", () => {
    // `.json` is the one extension two editors share, so the bytes decide.
    expect(kindForFile("budget.json", dumpSheet(newWorkbook("budget")))).toBe("sheet");
    expect(kindForFile("renamed.txt", dumpSheet(newWorkbook("b")))).toBe("sheet");
    expect(kindForFile("package.json", '{"name":"x"}')).toBe("code");
    expect(kindForFile("broken.json", "{not json")).toBe("code");
  });

  it("routes Markdown to its own editor by either spelling of the extension", () => {
    expect(kindForFile("note.md")).toBe("markdown");
    expect(kindForFile("note.markdown")).toBe("markdown");
    expect(kindForFile("NOTE.MD", "# hi")).toBe("markdown");
    // The name is a claim; the bytes are the fact. A deck renamed .md is a deck.
    expect(kindForFile("talk.md", dumpDeck(newPresentation()))).toBe("deck");
  });

  it("opens a .pxml with no content at all", () => {
    // The whole point of the extension: a listing can route a deck before it
    // has fetched a single byte.
    expect(kindForFile("talk.pxml")).toBe("deck");
  });

  it("still opens a .pxml whose bytes do not sniff", () => {
    // The content-first branch used to end in a bare `return null`, so a deck
    // that failed every sniffer became unopenable precisely when its content
    // WAS available — the one case where the app knows most about it.
    expect(kindForFile("talk.pxml", "")).toBe("deck");
    expect(kindForFile("talk.pxml", "<presentation")).toBe("deck");
  });

  it("does not guess between the two .xml editors without the content", () => {
    // Both the writer and the deck claim .xml, and guessing would open the
    // wrong one about half the time. With no bytes to settle it the honest
    // answer is the plain-text one, never a coin flip between the two.
    expect(kindForFile("thing.xml")).toBe("code");
  });

  it("settles .xml by what is inside it", () => {
    expect(kindForFile("thing.xml", dumpDoc(newDocument()))).toBe("document");
    expect(kindForFile("thing.xml", dumpDeck(newPresentation()))).toBe("deck");
  });

  it("believes the content over the name", () => {
    // A renamed file is still what it is.
    expect(kindForFile("mystery.txt", dumpDeck(newPresentation()))).toBe("deck");
  });

  it("routes an .svg to the drawing editor by its name, which has no sniffer", () => {
    expect(kindForFile("floorplan.svg")).toBe("sketch");
    expect(kindForFile("floorplan.SVG", "<svg xmlns='http://www.w3.org/2000/svg'/>")).toBe("sketch");
    // An SVG the drawing editor cannot open safely is still routed there: it
    // is the editor that refuses, with the offer to open it as text.
    expect(kindForFile("evil.svg", "<svg><script/></svg>")).toBe("sketch");
  });

  it("opens what it does not recognise as plain text", () => {
    // Refusing would be the app deciding a file is none of the user's
    // business. A .png comes out as mojibake, which is a true rendering of
    // what a .png is when you read it as text.
    expect(kindForFile("photo.png", "not a document")).toBe("code");
    expect(kindForFile("server.log", "started")).toBe("code");
    expect(kindForFile("LICENSE", "MIT")).toBe("code");
    expect(kindForFile("noextension")).toBe("code");
  });

  it("keeps opening the legacy .xml decks already on disk", () => {
    // Every deck written before .pxml existed is a .xml. The sniff survives as
    // legacy rescue, not as the router.
    expect(kindForFile("old-talk.xml", dumpDeck(newPresentation()))).toBe("deck");
  });

  it("lets a structured claim beat the code claim when the bytes agree", () => {
    // …and ordinary JSON, which used to be handed to the grid on its extension
    // alone and rendered as garbage, is source.
    expect(kindForFile("package.json", '{"name":"x"}')).toBe("code");
  });

  it("settles a leftover .xml as source once the sniffers pass on it", () => {
    // Neither a cyprian document nor a deck, so it is somebody's config file.
    expect(kindForFile("pom.xml", "<project></project>")).toBe("code");
    // The two that DO claim .xml still win.
    expect(kindForFile("notes.xml", dumpDoc(newDocument()))).toBe("document");
    expect(kindForFile("talk.xml", dumpDeck(newPresentation()))).toBe("deck");
  });

  it("does not resolve inherited object properties as editors", () => {
    // A bracket lookup on an object literal also finds Object.prototype, so a
    // file called `x.constructor` would come back as a truthy non-editor.
    // The guard still matters: without it these would resolve through
    // Object.prototype to a truthy value that is not an editor at all. Falling
    // to "code" is the same answer any other unknown extension gets.
    expect(kindForFile("x.constructor")).toBe("code");
    expect(kindForFile("x.__proto__")).toBe("code");
    expect(kindForFile("x.toString")).toBe("code");
  });

  it("reads extensions the way a filename actually looks", () => {
    expect(extensionOf("a.b.SVG")).toBe("svg");
    expect(extensionOf("noextension")).toBe("");
    expect(extensionOf(".hidden")).toBe("hidden");
  });
});
