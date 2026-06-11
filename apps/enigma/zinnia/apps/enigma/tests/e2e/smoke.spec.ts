import { test, expect, type Page } from "@playwright/test";

// Enigma is the secure-communication app: "/" redirects to "/chat". The backend is
// stubbed (no toto server) — a catch-all returns {}, channels returns an empty list,
// and /me returns the identity (incl. the profile language the UI should adopt).
async function stubApi(page: Page, language: string) {
  // Playwright matches routes in reverse registration order, so register the
  // catch-all FIRST and the specific endpoints AFTER (they take precedence).
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/telegraph/api/channels/", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ channels: [] }) }),
  );
  await page.route("**/telegraph/api/me/", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 1,
        username: "tester",
        full_name: "Tester",
        avatar_url: null,
        profile_url: null,
        language,
      }),
    }),
  );
}

test.describe("Enigma shell (comms-only)", () => {
  test("redirects / to the chat view and renders the comms nav in English", async ({ page }) => {
    await stubApi(page, "en");
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("heading", { name: "Enigma" })).toBeVisible();
    // Comms-only nav: Chat + Settings, and NO data-workspace links.
    await expect(page.getByRole("link", { name: "Chat" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Storage" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Mission" })).toHaveCount(0);
    // The chat shell is shown (Forum tab present).
    await expect(page.getByRole("button", { name: "Forum" })).toBeVisible();
  });

  test("adopts the toto profile language (Polish) for the UI", async ({ page }) => {
    await stubApi(page, "pl");
    await page.goto("/");
    // Once /me resolves, the nav switches to Polish (Chat → Czat, Settings → Ustawienia).
    await expect(page.getByRole("link", { name: "Czat" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Ustawienia" }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  });
});
