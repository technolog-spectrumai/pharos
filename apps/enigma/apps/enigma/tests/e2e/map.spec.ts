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
