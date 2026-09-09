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

  it("refuses everything that is not a drawing", () => {
    // These all opened as source text until the Code tab was removed. With no
    // text editor of its own, this app says so rather than routing a `.py`
    // into a drawing canvas — the panel shows "cannot open that kind of file",
    // which is true, and Lazurite is where those belong.
    for (const name of ["notes.txt", "server.log", "main.py", "data.json", "README.md", "noext"]) {
      expect(kindForFile(name, "anything"), name).toBeNull();
    }
  });

  it("does not claim a document or a deck — those are Lazurite's", () => {
    // Unchanged in spirit and now stricter: this app has no writer, so it
    // declines rather than offering to show the source.
    expect(kindForFile("talk.pxml", "<presentation/>")).toBeNull();
    expect(kindForFile("paper.xml", "<document/>")).toBeNull();
  });

  it("still claims a drawing, by name and with bytes", () => {
    // The one thing that must keep working.
    expect(kindForFile("plan.svg")).toBe("sketch");
    expect(kindForFile("plan.svg", "<svg/>")).toBe("sketch");
  });
});
