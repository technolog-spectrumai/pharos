import { test, expect, type Page } from "@playwright/test";

// Aurora is the data-workspace app: "/" is the dashboard. The backend is stubbed
// (no toto server) — a catch-all returns {} and /me returns the identity (incl. the
// profile language the UI should adopt).
async function stubApi(page: Page, language: string) {
  // Playwright matches routes in reverse registration order, so register the
  // catch-all FIRST and the specific /me endpoint AFTER (it takes precedence).
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
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

test.describe("Aurora shell (data workspace + relay chat)", () => {
  test("renders the header and data-workspace nav in English", async ({ page }) => {
    await stubApi(page, "en");
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("heading", { name: "Aurora" })).toBeVisible();
    // Data-workspace nav: Chat, Mission (dropdown), and Files (the /vault label).
    await expect(page.getByRole("link", { name: "Chat" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Files" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Mission" }).first()).toBeVisible();
  });

  test("adopts the toto profile language (Polish) for the UI", async ({ page }) => {
    await stubApi(page, "pl");
    await page.goto("/");
    // Once /me resolves, the nav switches to Polish (Files → Pliki, Chat → Czat).
    await expect(page.getByRole("link", { name: "Pliki" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Czat" }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  });
});
