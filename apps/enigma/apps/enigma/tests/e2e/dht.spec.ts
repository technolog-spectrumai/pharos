import { test, expect } from "@playwright/test";

// DHT discovery + Contacts in the browser shell. P2P itself needs the Tauri
// runtime, but everything UI-side must work here: the Settings toggle persists
// through the localStorage kv fallback, the status row degrades to the honest
// "not active" state (no node to probe), and the Contacts tab does full CRUD
// against the same local kv.

test.describe("DHT discovery — Settings card", () => {
  test("toggle reveals the controls, status degrades honestly, and persists across reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Settings" }).first().click();

    const dhtSwitch = page.getByRole("switch", { name: "DHT discovery" });
    await expect(dhtSwitch).toBeVisible();
    await expect(dhtSwitch).toHaveAttribute("aria-checked", "false");
    // Off ⇒ the dependent controls are hidden.
    await expect(page.getByRole("button", { name: "Test DHT" })).toHaveCount(0);

    await dhtSwitch.click();
    await expect(dhtSwitch).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("button", { name: "Test DHT" })).toBeVisible();
    await expect(page.getByText("Room announce interval").first()).toBeVisible();
    await expect(page.getByText("Presence refresh").first()).toBeVisible();
    // No Tauri runtime in the browser ⇒ the probe reports the node not running.
    await expect(page.getByText(/Not active/)).toBeVisible();

    // The setting rides the localStorage kv fallback — survives a reload.
    await page.reload();
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.getByRole("switch", { name: "DHT discovery" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

test.describe("Contacts tab", () => {
  const NODE_ID = "ab".repeat(32); // hex-shaped 64-char stable NodeId

  test("navigates from the header and shows the empty state", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Contacts" }).first().click();
    await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
    await expect(page.getByText("No contacts yet", { exact: false })).toBeVisible();
    // DHT off ⇒ the presence hint points at Settings instead of showing dots.
    await expect(page.getByText("Enable DHT discovery in Settings", { exact: false })).toBeVisible();
  });

  test("adds, renames, deletes a contact — persisted locally", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Contacts" }).first().click();

    // Add (the modal's submit shares the opener's label — take the last match).
    await page.getByRole("button", { name: "Add contact" }).click();
    await page.getByPlaceholder("Paste a contact code (node ID)").fill(NODE_ID);
    await page.getByPlaceholder("Display name").fill("Alice");
    await page.getByRole("button", { name: "Add contact" }).last().click();
    await expect(page.getByText("Alice")).toBeVisible();
    await expect(page.getByText(NODE_ID)).toBeVisible();

    // Survives a reload (kv → localStorage in the browser).
    await page.reload();
    await page.getByRole("link", { name: "Contacts" }).first().click();
    await expect(page.getByText("Alice")).toBeVisible();

    // Rename.
    await page.getByRole("button", { name: "Rename contact" }).click();
    await page.getByPlaceholder("Display name").fill("Alicja");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Alicja")).toBeVisible();

    // Delete brings the empty state back.
    await page.getByRole("button", { name: "Delete contact" }).click();
    await expect(page.getByText("No contacts yet", { exact: false })).toBeVisible();
  });

  test("rejects a malformed contact code", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Contacts" }).first().click();
    await page.getByRole("button", { name: "Add contact" }).click();
    await page.getByPlaceholder("Paste a contact code (node ID)").fill("not-a-node-id");
    await page.getByRole("button", { name: "Add contact" }).last().click();
    await expect(page.getByText("That doesn't look like a contact code.")).toBeVisible();
  });

  test("invite modal shows the no-rooms empty state in the browser shell", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Contacts" }).first().click();
    await page.getByRole("button", { name: "Invite to a room" }).click();
    await expect(page.getByText("No shareable rooms yet", { exact: false })).toBeVisible();
  });
});
