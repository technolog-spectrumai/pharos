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

test.describe("Enigma+ shell (comms + data workspace)", () => {
  test("shows the welcome dashboard at / and reaches the chat view in English", async ({ page }) => {
    await stubApi(page, "en");
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("heading", { name: "Enigma" })).toBeVisible();
    // Combined nav: comms (Chat, Settings) plus the data-workspace "Mission"
    // dropdown — enigma_plus is enigma's comms AND aurora's data workspace.
    await expect(page.getByRole("link", { name: "Chat" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Mission" }).first()).toBeVisible();
    // Unlike enigma, "/" is the welcome dashboard, not a chat redirect.
    await expect(page.getByRole("heading", { name: "Aurora" })).toBeVisible();
    // The router uses memory history, so navigate via the nav link; the chat
    // shell then shows the Forum tab.
    await page.getByRole("link", { name: "Chat" }).first().click();
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
