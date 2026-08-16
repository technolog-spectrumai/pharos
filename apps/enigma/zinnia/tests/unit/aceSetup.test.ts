import { describe, it, expect } from "vitest";
import { modeForFilename, THEME_DARK, THEME_LIGHT } from "../../src/editors/aceSetup";

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
