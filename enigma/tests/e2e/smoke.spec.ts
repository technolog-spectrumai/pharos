import { test, expect } from "@playwright/test";

// Enigma is a serverless chat: "/" opens Friends. There is no backend at all —
// the shell must render fully offline (the engine needs the Tauri runtime, so
// in the plain browser the views show their empty or error states).

test.describe("Enigma shell (serverless)", () => {
  test("opens on Friends and renders the nav in English", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("heading", { name: "Enigma" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Friends" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Groups" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /login|zaloguj/i })).toHaveCount(0);
    await expect(page.getByTestId("add-friend")).toBeVisible();
  });

  test("Groups: New chat and Join a chat open dialogs from the chat header", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Groups" }).first().click();
    // Not in the rooms side panel: in the header, the same place on a phone and a desktop.
    await page.getByTestId("new-chat").click();
    await expect(page.getByTestId("create-room")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByTestId("join-chat").click();
    await expect(page.getByRole("dialog").or(page.getByTestId("oya-modal-overlay"))).toBeVisible();
  });

  test("switches the UI to Polish via the language picker", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("combobox").first().selectOption("pl");
    await expect(page.getByRole("link", { name: "Znajomi" }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  });
});
