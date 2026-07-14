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
    await expect(
      page.getByText("Enable DHT discovery in Settings to see who's recently online."),
    ).toBeVisible();
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

  test("find people: search is gated on the DHT toggle, then usable with honest claim copy", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Contacts" }).first().click();

    // DHT off ⇒ search disabled with the pointer at Settings; publish toggle inert.
    await expect(page.getByPlaceholder("Search a nickname (exact spelling)")).toBeDisabled();
    await expect(
      page.getByText("Enable DHT discovery in Settings", { exact: false }).first(),
    ).toBeVisible();

    // Turn DHT on in Settings, come back.
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("switch", { name: "DHT discovery" }).click();
    await page.getByRole("link", { name: "Contacts" }).first().click();

    const search = page.getByPlaceholder("Search a nickname (exact spelling)");
    await expect(search).toBeEnabled();
    // Honest-claims warning is shown with the search.
    await expect(page.getByText("Results are claims, not verified identities", { exact: false })).toBeVisible();
    // In the browser shell the search degrades to no results (no Tauri runtime).
    await search.fill("alice-dev");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByText("No one is currently publishing that nickname.")).toBeVisible();

    // Publishing is an explicit button with real feedback: in the browser
    // shell the DHT write can't run, so the error state must surface (never a
    // silent success), while the nickname itself is saved.
    await page.getByPlaceholder("Your public nickname").fill("Alice-Dev");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Couldn't publish the name.")).toBeVisible();

    // Nickname persists across reload (kv → localStorage fallback).
    await page.reload();
    await page.getByRole("link", { name: "Contacts" }).first().click();
    await expect(page.getByPlaceholder("Your public nickname")).toHaveValue("Alice-Dev");
  });

  test("direct invite: contact row opens the room picker (empty in the browser shell)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Contacts" }).first().click();
    // Direct invites are per-contact — add one to get a row.
    await page.getByRole("button", { name: "Add contact" }).click();
    await page.getByPlaceholder("Paste a contact code (node ID)").fill("cd".repeat(32));
    await page.getByPlaceholder("Display name").fill("Bob");
    await page.getByRole("button", { name: "Add contact" }).last().click();

    await page.getByRole("button", { name: "Send room invite" }).click();
    await expect(page.getByText("Invite Bob to a room")).toBeVisible();
    await expect(page.getByText("No shareable rooms yet", { exact: false })).toBeVisible();
  });
});
