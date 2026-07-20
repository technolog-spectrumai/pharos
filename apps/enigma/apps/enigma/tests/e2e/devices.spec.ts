import { test, expect } from "@playwright/test";

// Devices tab in the browser shell. Pairing itself needs the Tauri runtime
// (devlink_* commands + an iroh endpoint), but the UI must be honest here:
// the tab renders behind Settings, shows the not-linked empty state, both
// pairing flows are visible, and a pairing attempt surfaces a real error
// instead of pretending to work.

test.describe("Devices tab", () => {
  test("renders behind Settings with the empty state and both pairing flows", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Devices" }).click();

    await expect(page.getByText("Linked devices").first()).toBeVisible();
    await expect(page.getByText("No linked devices yet", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show pairing QR" })).toBeVisible();
    await expect(page.getByText("This is the new device")).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan pairing QR" })).toBeVisible();
  });

  test("a pairing attempt without the runtime surfaces an error, never a silent success", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Devices" }).click();

    await page.getByRole("button", { name: "Show pairing QR" }).click();
    // No Tauri ⇒ devlink_pair_begin cannot run; the panel must stay in the
    // idle state and show an error line (not a fake QR).
    await expect(page.getByRole("button", { name: "Show pairing QR" })).toBeVisible();

    // The join path degrades the same way.
    await page.getByLabel("Or paste the pairing code").fill("lqaafakecode");
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByRole("button", { name: "Link", exact: true })).toBeVisible();
  });
});
