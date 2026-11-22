import { test, expect } from "@playwright/test";

test.describe("Devices tab removal", () => {
  test("Files no longer exposes a Devices sub-tab", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Files" }).first().click();

    await expect(page.getByRole("button", { name: "Devices" })).toHaveCount(0);
    // File sharing needs the Tauri runtime; the browser shell says so instead
    // of showing the Peer-to-peer and Local sub-tabs.
    await expect(page.getByText("File sharing is available in the desktop app only.")).toBeVisible();
  });

  test("Settings still has no Devices tab", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();

    await expect(page.getByRole("button", { name: "Devices" })).toHaveCount(0);
  });
});
