import { test, expect } from "@playwright/test";

// Files → Devices in the browser shell. Everything device-related now lives
// here (Settings no longer has a Devices tab). Pairing and file transfers need
// the Tauri runtime (devlink_* / file_xfer + an iroh endpoint), so what the
// browser build must do is be honest: render the surfaces, show the
// not-linked / desktop-only states, and surface a real error on a pairing
// attempt instead of pretending to work.

async function openDevices(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Files" }).first().click();
  await page.getByRole("button", { name: "Devices" }).click();
}

test.describe("Files → Devices", () => {
  test("shows the device list header and the Files sub-tab by default", async ({ page }) => {
    await openDevices(page);

    await expect(page.getByText("Linked devices").first()).toBeVisible();
    await expect(page.getByTestId("devices-not-linked")).toBeVisible();

    // Files sub-tab: the per-file push/pull surface, honestly degraded.
    await expect(page.getByTestId("fsync-add")).toBeVisible();
    await expect(page.getByTestId("fsync-blocked")).toContainText("desktop or mobile app");
    await expect(page.getByText("No files yet", { exact: false })).toBeVisible();
  });

  test("the Pairing sub-tab carries both pairing flows", async ({ page }) => {
    await openDevices(page);
    await page.getByRole("button", { name: "Pairing" }).click();

    await expect(page.getByRole("button", { name: "Show pairing QR" })).toBeVisible();
    await expect(page.getByText("This is the new device")).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan pairing QR" })).toBeVisible();
    // The device list stays visible above the sub-tabs — it is the context.
    await expect(page.getByText("Linked devices").first()).toBeVisible();
  });

  test("a pairing attempt without the runtime surfaces an error, never a silent success", async ({ page }) => {
    await openDevices(page);
    await page.getByRole("button", { name: "Pairing" }).click();

    await page.getByRole("button", { name: "Show pairing QR" }).click();
    // No Tauri ⇒ devlink_pair_begin cannot run; the panel must stay in the
    // idle state and show an error line (not a fake QR).
    await expect(page.getByRole("button", { name: "Show pairing QR" })).toBeVisible();

    // The join path degrades the same way.
    await page.getByLabel("Or paste the pairing code").fill("lqaafakecode");
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await expect(page.getByRole("button", { name: "Link", exact: true })).toBeVisible();
  });

  test("Settings no longer offers a Devices tab", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.getByRole("button", { name: "Devices" })).toHaveCount(0);
  });
});
