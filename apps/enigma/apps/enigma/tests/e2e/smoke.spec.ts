import { test, expect } from "@playwright/test";

// Enigma is a serverless P2P chat: "/" redirects to "/chat". There is no backend
// at all — the shell must render fully offline (P2P features themselves need the
// Tauri runtime, so in the plain browser the panel just shows its empty state).

test.describe("Enigma shell (serverless P2P)", () => {
  test("redirects / to the chat view and renders the nav in English", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("heading", { name: "Enigma" })).toBeVisible();
    // Nav: Chat + Settings — and no server-era links (Login is gone).
    await expect(page.getByRole("link", { name: "Chat" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /login|zaloguj/i })).toHaveCount(0);
    // The P2P chat shell is shown: the create-room flow lives behind "New chat"
    // (a modal since the QR-ticket rework), which opens onto the Create button.
    await page.getByRole("button", { name: "New chat" }).first().click();
    await expect(page.getByRole("button", { name: "Create", exact: true })).toBeVisible();
  });

  test("Cloud tab starts switched off: explanation only, switch lives in Settings", async ({ page }) => {
    // Browser-fallback build is cloud-capable, but the runtime master switch
    // defaults OFF — no login form, no file browser, nothing server-shaped.
    await page.goto("/");
    await page.getByRole("link", { name: "Cloud" }).first().click();
    await expect(page.getByTestId("cloud-off-card")).toBeVisible();
    await expect(page.getByTestId("cloud-settings-link")).toBeVisible();
    await expect(page.getByTestId("cloud-knob")).toHaveCount(0);
    await expect(page.getByPlaceholder("Username")).toHaveCount(0);
    // The switch is in Settings → Connections, off, beside the network toggles.
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("button", { name: "Connections" }).first().click();
    const knob = page.getByTestId("cloud-knob");
    await expect(knob).toBeVisible();
    await expect(knob).toHaveAttribute("aria-checked", "false");
  });

  test("switches the UI to Polish via the language picker", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("combobox").first().selectOption("pl");
    await expect(page.getByRole("link", { name: "Czat" }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  });
});
