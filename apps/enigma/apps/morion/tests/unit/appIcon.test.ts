// The app icon: one artwork, every size generated from it.
//
// Nothing here decodes pixels — the generator (scripts/make_icons.py) checks
// the Android safe zone when it runs. What is pinned is the shape of the set:
// the artwork is a usable square PNG, every icon the Linux packages name
// exists at the size its name promises, and the Android launcher tree the
// first Android build copies in is complete. A missing or mis-sized file here
// is an installer with a blank or blurry icon, which no other test would see.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname, "../..");
const ICONS = join(APP, "src-tauri/icons");

/** Width and height from a PNG's IHDR chunk, or null if it is not a PNG. */
function pngSize(path: string): [number, number] | null {
  const head = readFileSync(path).subarray(0, 24);
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!magic.every((b, i) => head[i] === b) || head.toString("ascii", 12, 16) !== "IHDR") return null;
  return [head.readUInt32BE(16), head.readUInt32BE(20)];
}

describe("the app icon", () => {
  it("has one artwork: a square PNG of at least 512 px", () => {
    const size = pngSize(join(APP, "app-icon.png"));
    expect(size).not.toBeNull();
    const [w, h] = size!;
    expect(w).toBe(h);
    expect(w).toBeGreaterThanOrEqual(512);
  });

  it("ships every icon the desktop bundles name, at the size each name says", () => {
    const conf = JSON.parse(readFileSync(join(APP, "src-tauri/tauri.conf.json"), "utf8"));
    const listed: string[] = conf.bundle.icon;
    expect(listed.length).toBeGreaterThan(0);
    for (const entry of listed) {
      expect(existsSync(join(APP, "src-tauri", entry)), entry).toBe(true);
    }
    const expected: Record<string, number> = {
      "32x32.png": 32, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512,
    };
    for (const [name, side] of Object.entries(expected)) {
      expect(pngSize(join(ICONS, name)), name).toEqual([side, side]);
    }
  });

  it("ships a complete Android launcher tree", () => {
    const densities: Record<string, [number, number]> = {
      // [adaptive foreground, legacy launcher] in px, as the Tauri CLI writes
      // them. Its hdpi legacy icon is 49 px where Android's table says 72;
      // Enigma's committed set has the same, and only Android 7 and older
      // hdpi phones ever show that file.
      mdpi: [108, 48], hdpi: [162, 49], xhdpi: [216, 96], xxhdpi: [324, 144], xxxhdpi: [432, 192],
    };
    for (const [density, [foreground, legacy]] of Object.entries(densities)) {
      const dir = join(ICONS, "android", `mipmap-${density}`);
      expect(pngSize(join(dir, "ic_launcher_foreground.png")), density).toEqual([foreground, foreground]);
      expect(pngSize(join(dir, "ic_launcher.png")), density).toEqual([legacy, legacy]);
      expect(pngSize(join(dir, "ic_launcher_round.png")), density).toEqual([legacy, legacy]);
    }
    const adaptive = readFileSync(join(ICONS, "android/mipmap-anydpi-v26/ic_launcher.xml"), "utf8");
    expect(adaptive).toContain("@mipmap/ic_launcher_foreground");
    expect(adaptive).toContain("@color/ic_launcher_background");
    // The helmet is blue, so the adaptive background must not be blue too.
    const background = readFileSync(join(ICONS, "android/values/ic_launcher_background.xml"), "utf8");
    expect(background).toMatch(/<color name="ic_launcher_background">#fff/i);
  });
});
