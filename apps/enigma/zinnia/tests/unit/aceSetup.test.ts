import { describe, it, expect } from "vitest";
import {
  languageForFilename, LANGUAGES, modeForFilename, THEME_DARK, THEME_LIGHT,
} from "../../src/editors/aceSetup";

// Scope note: these cover the mode mapping and the fact that importing aceSetup runs
// its worker/theme registration without throwing. They deliberately don't assert that
// ACE's registry actually resolved the modes, themes, or worker URLs — ace-builds ships
// UMD files that register against a browser global, and vitest's transform doesn't wire
// them the way a real bundle does, so any such assertion fails here even when the built
// app is fine (verified separately against a production bundle: modes resolve, themes
// apply, and workers point at bundled /assets/ URLs rather than a CDN). Check that in
// the running app instead — open a .json with a syntax error and look for the marker.

describe("ACE offline setup", () => {
  it("imports cleanly, so its worker and theme registration ran", () => {
    expect(THEME_LIGHT).toBe("ace/theme/github");
    expect(THEME_DARK).toBe("ace/theme/github_dark");
  });

  it("maps file extensions to the modes we bundle", () => {
    const cases: Record<string, string> = {
      "notes.txt": "plain_text",
      "README.md": "markdown",
      "tauri.conf.json": "json",
      "docker-compose.yml": "yaml",
      "Cargo.toml": "toml",
      "settings.ini": "ini",
      "feed.xml": "xml",
      // The fallback when a deck is opened as text: without this it lands in
      // plain_text and silently loses XML highlighting.
      "talk.pxml": "xml",
      "main.js": "javascript",
      "main.ts": "typescript",
      "script.py": "python",
      "lib.rs": "rust",
      "build.sh": "sh",
      "index.html": "html",
      "style.css": "css",
    };
    for (const [name, mode] of Object.entries(cases)) {
      expect(modeForFilename(name), `wrong mode for ${name}`).toBe(`ace/mode/${mode}`);
    }
  });

  it("falls back to plain text for unknown, extensionless, and dotfile names", () => {
    expect(modeForFilename("mystery.xyz")).toBe("ace/mode/plain_text");
    expect(modeForFilename("LICENSE")).toBe("ace/mode/plain_text");
    expect(modeForFilename(".gitignore")).toBe("ace/mode/plain_text");
  });

  it("ignores case in the extension and uses only the last one", () => {
    expect(modeForFilename("NOTES.MD")).toBe("ace/mode/markdown");
    expect(modeForFilename("Data.JSON")).toBe("ace/mode/json");
    expect(modeForFilename("archive.tar.md")).toBe("ace/mode/markdown");
  });
});

describe("the language catalogue", () => {
  it("puts plain text first, with an empty label", () => {
    // The empty label is the seam: SelectMenu renders `emptyLabel` for it, which
    // is where the one translatable name ("Plain text") comes from. A label here
    // would hard-code English into a module that has no i18n.
    expect(LANGUAGES[0].id).toBe("text");
    expect(LANGUAGES[0].mode).toBe("plain_text");
    expect(LANGUAGES[0].label).toBe("");
  });

  it("offers each language once, and every one of them is bundled", () => {
    const ids = LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "text", "css", "html", "javascript", "json", "markdown",
      "python", "sh", "typescript", "xml", "yaml",
    ]);
    // Every offered mode must be one modeForFilename can also produce, or the
    // picker could name a mode nothing detects.
    const detectable = new Set([
      "a.txt", "a.css", "a.html", "a.js", "a.json", "a.md",
      "a.py", "a.sh", "a.ts", "a.xml", "a.yml",
    ].map(modeForFilename));
    for (const l of LANGUAGES) {
      expect(detectable.has(`ace/mode/${l.mode}`), l.id).toBe(true);
    }
  });

  it("labels are proper nouns, left untranslated", () => {
    const labels = LANGUAGES.filter((l) => l.label).map((l) => l.label);
    expect(labels).toEqual([
      "CSS", "HTML", "JavaScript", "JSON", "Markdown",
      "Python", "Shell", "TypeScript", "XML", "YAML",
    ]);
  });

  it("detects the offered language from a file name", () => {
    expect(languageForFilename("script.py").id).toBe("python");
    expect(languageForFilename("conf.yml").id).toBe("yaml");
    expect(languageForFilename("page.HTM").id).toBe("html");
    expect(languageForFilename("notes.txt").id).toBe("text");
  });

  it("falls back to plain text for a mode that is bundled but not offered", () => {
    // Display only. The SESSION still gets rust highlighting from
    // modeForFilename — it is the picker's label that has nothing to show.
    expect(modeForFilename("lib.rs")).toBe("ace/mode/rust");
    expect(languageForFilename("lib.rs").id).toBe("text");
    expect(languageForFilename("mystery.xyz").id).toBe("text");
  });
});
