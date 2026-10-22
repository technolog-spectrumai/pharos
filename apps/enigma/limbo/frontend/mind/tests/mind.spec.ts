import { test, expect } from "@playwright/test";

// Mind tab in the browser shell. The feature is 100% client-side, so the whole
// flow works here: the cytoscape canvas, the node edit modal, the Topics
// browser, and persistence through the localStorage kv fallback.

test.describe("Mind tab — happy path (browser shell)", () => {
  test("creates a topic on the canvas, adds a note via Topics, persists across reload", async ({ page }) => {
    await page.goto("/");

    // Nav → Notes → Mind sub-tab (compile-time gated; default build ships it).
    // Board/Sketch/Mind live under one Notes tab now; the mind-canvas probe below
    // confirms we're on the Mind sub-tab (there's no longer a "Mind" page heading).
    await page.getByRole("link", { name: "Notes", exact: true }).first().click();
    await page.getByRole("button", { name: "Mind", exact: true }).click();

    // The anti-blank-canvas probe: cytoscape silently renders nothing into a
    // 0-height div (the MapLibre lesson from map.spec.ts, cheap insurance here).
    const host = page.getByTestId("mind-canvas");
    const canvasHeight = await host.evaluate((el) => el.clientHeight);
    expect(canvasHeight).toBeGreaterThan(0);
    await expect(page.locator("[data-testid='mind-canvas'] canvas").first()).toBeAttached();

    // Add-topic tool → tap the canvas → the shared edit modal opens on the
    // fresh node; name it and Save.
    await page.getByRole("button", { name: "Add a topic (tap the canvas)" }).click();
    await host.click({ position: { x: 300, y: 200 } });
    await expect(page.getByTestId("mind-edit-title")).toBeVisible();
    await page.getByTestId("mind-edit-title").fill("Big Plan");
    await page.getByTestId("mind-edit-save").click();

    // Topics sub-tab lists it; details modal offers "Add note", which hands
    // off to the same edit modal (details closes — one modal at a time).
    await page.getByRole("button", { name: "Topics" }).click();
    await page.getByRole("button", { name: /Big Plan/ }).click();
    await page.getByTestId("mind-topic-add-note").click();
    await expect(page.getByTestId("mind-edit-title")).toBeVisible();
    await page.getByTestId("mind-edit-title").fill("first step");
    await page.getByTestId("mind-edit-save").click();

    // Reopen the details — the fresh note is linked.
    await page.getByRole("button", { name: /Big Plan/ }).click();
    await expect(page.getByText("first step")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();

    // Navigating away flushes the debounced doc write (onBeforeUnmount), so a
    // reload right after must still find everything in the localStorage kv.
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.reload();
    await page.getByRole("link", { name: "Notes", exact: true }).first().click();
    await page.getByRole("button", { name: "Mind", exact: true }).click();
    await page.getByRole("button", { name: "Topics" }).click();
    await page.getByRole("button", { name: /Big Plan/ }).click();
    await expect(page.getByText("first step")).toBeVisible();
  });
});
