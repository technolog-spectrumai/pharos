import { test, expect } from "@playwright/test";

test.describe("Devices tab removal", () => {
  test("Files no longer exposes a Devices sub-tab", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Files" }).first().click();

    await expect(page.getByRole("button", { name: "Devices" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Peer-to-peer" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Local" })).toBeVisible();
  });

  test("Settings still has no Devices tab", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();

    await expect(page.getByRole("button", { name: "Devices" })).toHaveCount(0);
  });
});
