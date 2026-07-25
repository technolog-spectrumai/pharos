import { test, expect } from "@playwright/test";

// Mind tab in the browser shell. Unlike Maps, the feature is 100% client-side,
// so everything works here: the cytoscape canvas, the dump inbox, and
// persistence through the localStorage kv fallback.

test.describe("Mind tab — happy path (browser shell)", () => {
  test("renders a real-sized canvas, captures a dump entry, persists across reload", async ({ page }) => {
    await page.goto("/");

    // Nav → Mind (compile-time gated; default build ships it).
    await page.getByRole("link", { name: "Mind", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Mind" })).toBeVisible();

    // The anti-blank-canvas probe: cytoscape silently renders nothing into a
    // 0-height div (the MapLibre lesson from map.spec.ts, cheap insurance here).
    const canvasHeight = await page.getByTestId("mind-canvas").evaluate((el) => el.clientHeight);
    expect(canvasHeight).toBeGreaterThan(0);
    // Cytoscape mounted for real — it stamps its own container div + canvases.
    await expect(page.locator("[data-testid='mind-canvas'] canvas").first()).toBeAttached();

    // Dump sub-tab: capture an entry.
    await page.getByRole("button", { name: "Dump" }).click();
    await page.getByPlaceholder(/Type a thought/).fill("remember the milk");
    await page.getByRole("button", { name: "Capture" }).click();
    await expect(page.getByText("remember the milk")).toBeVisible();

    // Survives a full reload via the localStorage kv fallback (map.spec.ts
    // pattern) — the dump write is immediate, no debounce to wait out.
    await page.reload();
    await page.getByRole("link", { name: "Mind", exact: true }).first().click();
    await page.getByRole("button", { name: "Dump" }).click();
    await expect(page.getByText("remember the milk")).toBeVisible();
  });
});
