import { test, expect } from "@playwright/test";

// Enigma26 is a serverless P2P chat: "/" redirects to "/chat". There is no backend
// at all — the shell must render fully offline (P2P features themselves need the
// Tauri runtime, so in the plain browser the panel just shows its empty state).

test.describe("Enigma26 shell (serverless P2P)", () => {
  test("redirects / to the chat view and renders the nav in English", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("heading", { name: "Enigma26" })).toBeVisible();
    // Nav: Chat + Settings — and no server-era links (Login is gone).
    await expect(page.getByRole("link", { name: "Chat" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /login|zaloguj/i })).toHaveCount(0);
    // The P2P chat shell is shown: the create-room flow lives behind "New chat"
    // (a modal since the QR-ticket rework), which opens onto the Create button.
    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  });

  test("switches the UI to Polish via the language picker", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("combobox").first().selectOption("pl");
    await expect(page.getByRole("link", { name: "Czat" }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  });
});
