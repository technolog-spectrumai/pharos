// The branding assets resolve. This is a real regression: `logoDir` names a
// directory under src/assets, and when those files were moved to `bkp/` the
// glob stopped matching — every export silently became `undefined`, so the app
// bar and the unlock gate rendered an empty box with no build error at all.
import { describe, expect, it } from "vitest";

import { appIcon, barIcon } from "../../src/assets/logos";
import { logoDir } from "../../package.json";

describe("branding assets", () => {
  it("resolves both marks rather than undefined", () => {
    expect(typeof appIcon).toBe("string");
    expect(appIcon).toBeTruthy();
    expect(typeof barIcon).toBe("string");
    expect(barIcon).toBeTruthy();
  });

  it("resolves them from the configured logoDir", () => {
    // If logoDir and the assets ever drift apart again, this fails here
    // instead of showing an empty box at runtime.
    expect(appIcon).toContain("app_icon");
    expect(barIcon).toContain("bar_icon");
    expect(logoDir).toBeTruthy();
  });

  it("uses two different renders, not one image twice", () => {
    // The bar shows the mark at 36px and the gate much larger; sharing one
    // file would mean either a blurry bar or a needlessly heavy download.
    expect(appIcon).not.toBe(barIcon);
  });
});
