import { test, expect, type Page } from "@playwright/test";

// The app uses an in-memory router, so e2e drives it from "/" and navigates via
// the UI. The backend is stubbed: a catch-all returns {} and /me returns the
// identity (including the profile language we want the UI to adopt).
async function stubApi(page: Page, language: string) {
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

test.describe("Enigma shell", () => {
  test("renders the header and English navigation by default", async ({ page }) => {
    await stubApi(page, "en");
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("heading", { name: "Enigma" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Storage" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Tasks" }).first()).toBeVisible();
  });

  test("adopts the toto profile language (Polish) for the UI", async ({ page }) => {
    await stubApi(page, "pl");
    await page.goto("/");
    // Once /me resolves, the nav should switch to Polish (Storage → Pliki).
    await expect(page.getByRole("link", { name: "Pliki" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Zadania" }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "pl");
  });
});
