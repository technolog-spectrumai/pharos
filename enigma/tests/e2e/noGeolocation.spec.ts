import { test, expect } from "@playwright/test";

// The app promises "no geolocation, no tracking" (technology.md §8). This
// makes the promise executable rather than a sentence in a doc: a stray
// navigator.geolocation call, from any feature present or future, fails the
// suite. It used to live with the Map tab's tests; the promise is the app's,
// and stayed when the Map tab left.
test.describe("The app never asks the device for a position", () => {
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
    // Every tab the build has: each view is loaded on demand, so a call
    // hiding in one would not run until it is opened.
    for (const tab of ["Friends", "Groups", "Settings"]) {
      await page.getByRole("link", { name: tab, exact: true }).first().click();
      await expect(page.getByRole("link", { name: tab, exact: true }).first()).toBeVisible();
    }

    const calls = await page.evaluate(
      () => (window as unknown as { __geoCalls: { called: string[] } }).__geoCalls.called,
    );
    expect(calls).toEqual([]);
  });

  test("there is no Map tab", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Map", exact: true })).toHaveCount(0);
  });
});
