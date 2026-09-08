import { describe, expect, it } from "vitest";
import { kindForFile } from "../../src/files/openWith";

// Sketch ships two editors, so its routing is nearly all fallback: `.svg` is
// the drawing board and everything else is code. What is worth pinning is that
// the .svg claim still rests on the EXTENSION — there is no sniffer for it, and
// there must not be one, because an SVG is markup and sniffing markup is how a
// deck's XML would end up on the canvas.

describe("choosing an editor for a file", () => {
  it("routes .svg to the drawing board, by name alone", () => {
    expect(kindForFile("drawing.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>")).toBe("sketch");
    // Even when the bytes are not really an SVG: the editor refuses it itself
    // and offers `open-as-text`, which is a better answer than a silent reroute.
    expect(kindForFile("drawing.svg", "not markup at all")).toBe("sketch");
  });

  it("opens everything else as code rather than refusing it", () => {
    // Refusing would be the app deciding a file is none of the user's business.
    for (const name of ["notes.txt", "server.log", "main.py", "data.json", "README.md", "noext"]) {
      expect(kindForFile(name, "anything"), name).toBe("code");
    }
  });

  it("does not claim a document or a deck — those are Lazurite's", () => {
    // The split's point: this app has no writer, so an .xml opens as source
    // text here instead of being routed to an editor that does not exist.
    expect(kindForFile("talk.pxml", "<presentation/>")).toBe("code");
    expect(kindForFile("paper.xml", "<document/>")).toBe("code");
  });
});
