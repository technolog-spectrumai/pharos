import { test, expect } from "@playwright/test";

test.describe("Devices tab removal", () => {
  test("Settings still has no Devices tab", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();

    await expect(page.getByRole("button", { name: "Devices" })).toHaveCount(0);
  });
});
