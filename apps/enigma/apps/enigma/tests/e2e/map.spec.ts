import { test, expect } from "@playwright/test";

// Maps in the browser shell. Tiles/regions need the Tauri runtime, so the view
// must render its honest degraded state; the Settings card persists through the
// localStorage kv fallback exactly like the DHT toggle (dht.spec.ts).

test.describe("Map tab — happy path (browser shell)", () => {
  test("navigates to Maps, shows tabs + honest degraded state, settings persist", async ({ page }) => {
    await page.goto("/");

    // Nav → Map (compile-time gated; default build ships it).
    await page.getByRole("link", { name: "Map", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Map" })).toBeVisible();

    // Sub-tabs render; no Tauri runtime ⇒ the honest desktop-only state.
    await expect(page.getByText("Maps require the desktop or mobile app").first()).toBeVisible();
    await page.getByRole("button", { name: "Regions" }).click();
    await expect(page.getByText("Maps require the desktop or mobile app").first()).toBeVisible();

    // Settings → Maps card: the storage limit edits and persists across a
    // reload via the localStorage kv fallback (dht.spec.ts pattern).
    await page.getByRole("link", { name: "Settings" }).first().click();
    const storageLimit = page.getByRole("spinbutton", { name: "Map storage limit" });
    await expect(storageLimit).toBeVisible();
    await storageLimit.fill("1024");
    await storageLimit.press("Enter");
    await expect(storageLimit).toHaveValue("1024");

    await page.reload();
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.getByRole("spinbutton", { name: "Map storage limit" })).toHaveValue("1024");
  });
});

// Regression guard for a silent blank map (2026-07-21).
//
// Tailwind v4 emits utilities inside `@layer utilities`, while maplibre-gl.css
// is imported unlayered from JS — and unlayered author rules beat layered ones
// regardless of specificity. So when MapLibre stamps `maplibregl-map` on our
// container, its `position: relative` overrode `.absolute`, `inset-0` stopped
// stretching the box, the div collapsed to 0 height, and its `overflow: hidden`
// clipped the canvas away. Nothing errored (MapLibre falls back to a 400x300
// backing store when clientHeight is 0), so the map was blank AND silent.
// `.map-canvas-host.maplibregl-map` in style.css is the unlayered counter-rule.
test.describe("Map container vs MapLibre's own CSS", () => {
  test("keeps its box when MapLibre adds .maplibregl-map", async ({ page }) => {
    await page.goto("/");

    const probe = await page.evaluate(() => {
      const measure = (cls: string) => {
        const wrapper = document.createElement("div");
        wrapper.className = "relative min-h-[24rem] overflow-hidden";
        const host = document.createElement("div");
        host.className = cls;
        wrapper.appendChild(host);
        document.body.appendChild(wrapper);
        const before = host.clientHeight;
        host.classList.add("maplibregl-map"); // exactly what MapLibre does to it
        const result = {
          before,
          after: host.clientHeight,
          position: getComputedStyle(host).position,
        };
        wrapper.remove();
        return result;
      };
      return {
        // The real container's classes, kept in sync with MapPanel.vue.
        host: measure("map-canvas-host absolute inset-0 h-full w-full"),
        // Control: without the counter-rule the box must collapse — if this
        // ever stops collapsing the layer conflict is gone and the guard is moot.
        unprotected: measure("absolute inset-0"),
      };
    });

    expect(probe.host.position).toBe("absolute");
    expect(probe.host.after).toBeGreaterThan(0);
    expect(probe.host.after).toBe(probe.host.before);
    expect(probe.unprotected.after).toBe(0);
  });
});

// The basemap follows the app theme (dark mode -> protomaps "dark" flavor).
// Both flavors' sprite sheets are BUNDLED — the map never fetches from a CDN —
// so a missing dark sprite would only show up as broken icons at runtime.
test.describe("Offline basemap assets", () => {
  test("ships sprites for both theme flavors and the glyph stack", async ({ page }) => {
    await page.goto("/");

    const status = await page.evaluate(async () => {
      const out: Record<string, number> = {};
      for (const flavor of ["light", "dark"]) {
        for (const ext of [".json", ".png", "@2x.json", "@2x.png"]) {
          out[flavor + ext] = (await fetch(`/map/sprites/v4/${flavor}${ext}`)).status;
        }
      }
      out.glyph = (await fetch("/map/glyphs/Noto%20Sans%20Regular/0-255.pbf")).status;
      return out;
    });

    for (const [asset, code] of Object.entries(status)) {
      expect(code, `${asset} must be bundled`).toBe(200);
    }
  });
});

// The app promises "no geolocation, no tracking" (technology.md §10).
// Location SHARING deliberately does not change that: the user taps a point,
// the app never asks the device where it is. This makes the promise executable
// rather than a sentence in a doc — a stray navigator.geolocation call, from
// this feature or any future one, fails the suite.
test.describe("The map never asks the device for a position", () => {
  test("navigator.geolocation is never called anywhere in the app", async ({ page }) => {
    await page.addInitScript(() => {
      const flag = { called: [] as string[] };
      (window as unknown as { __geoCalls: typeof flag }).__geoCalls = flag;
      const trap = (name: string) => () => {
        flag.called.push(name);
        throw new Error(`navigator.geolocation.${name} must never be called`);
      };
      Object.defineProperty(navigator, "geolocation", {
        configurable: true,
        value: {
          getCurrentPosition: trap("getCurrentPosition"),
          watchPosition: trap("watchPosition"),
          clearWatch: trap("clearWatch"),
        },
      });
    });

    await page.goto("/");
    await page.getByRole("link", { name: "Map" }).first().click();
    await expect(page.getByRole("heading", { name: "Map" })).toBeVisible();
    // Walk the tabs too — region handling must stay just as quiet.
    await page.getByRole("button", { name: "Regions" }).click();
    await page.getByRole("button", { name: "Map", exact: true }).click();

    const calls = await page.evaluate(
      () => (window as unknown as { __geoCalls: { called: string[] } }).__geoCalls.called,
    );
    expect(calls).toEqual([]);
  });
});
