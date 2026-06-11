import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// Live tier — runs only when E2E_SERVER points at a real toto backend (the
// e2e.py runner sets it after bringing the backend up). Without it, the whole
// describe is skipped and the stubbed smoke tier still covers the built UI.
//
// Encryption note: browser-mode chat is PLAINTEXT — MLS is a desktop/Tauri-only
// feature. So the round-trip below verifies reachability + relay-WebSocket
// delivery end-to-end; MLS ciphertext is covered by Rust tests in rotor-core and
// the Rakotis envelope state machine.

const SERVER = process.env.E2E_SERVER;
const USER = process.env.E2E_USER || "e2e";
const PASS = process.env.E2E_PASS || "e2epass-123";

const authHdr = (token: string) => ({ Authorization: `Bearer ${token}` });

async function loginApi(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${SERVER}/telegraph/api/login/`, {
    data: { username: USER, password: PASS },
  });
  expect(res.ok(), `login should succeed for ${USER}`).toBeTruthy();
  return (await res.json()).token as string;
}

async function useLiveServer(page: Page, token?: string) {
  await page.addInitScript(
    ({ s, t }) => {
      localStorage.setItem("enigma:server_url", s);
      if (t) localStorage.setItem("enigma:auth_token", t);
    },
    { s: SERVER as string, t: token },
  );
}

test.describe("Aurora live (real backend)", () => {
  test.skip(!SERVER, "E2E_SERVER not set — live tier skipped (smoke tier covers the stubbed UI).");

  test("telegraph API is reachable (health)", async ({ request }) => {
    const res = await request.get(`${SERVER}/telegraph/api/health/`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json().catch(() => ({}));
    expect(body.ok ?? true).toBeTruthy();
  });

  test("UI login against the real backend stores an auth token", async ({ page }) => {
    await useLiveServer(page);
    await page.goto("/");
    // The app uses an in-memory router, so reach /login via the nav (not page.goto).
    await page.getByRole("link", { name: /login|zaloguj/i }).first().click();
    await page.locator("#username").fill(USER);
    await page.locator("#password").fill(PASS);
    await page.getByRole("button", { name: /sign in|zaloguj/i }).click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("enigma:auth_token")), { timeout: 15000 })
      .toBeTruthy();
  });

  test("authenticated data workspace + chat load against the live backend", async ({ page, request }) => {
    const token = await loginApi(request);
    await useLiveServer(page, token);
    await page.goto("/");
    // Authenticated data-workspace shell: the Files nav link is present…
    await expect(page.getByRole("link", { name: "Files" }).first()).toBeVisible({ timeout: 15000 });
    // …and the relay chat surface renders. The app uses an in-memory router, so
    // navigate via the nav (not page.goto).
    await page.getByRole("link", { name: "Chat" }).first().click();
    await expect(page.getByText(/select a room|wybierz pokój/i)).toBeVisible({ timeout: 15000 });
  });

  test("relay chat delivers a message over the WebSocket", async ({ page, request }) => {
    const token = await loginApi(request);
    const roomsRes = await request.get(`${SERVER}/telegraph/api/channels/`, { headers: authHdr(token) });
    expect(roomsRes.ok()).toBeTruthy();
    const slug = (await roomsRes.json()).channels?.[0]?.slug as string | undefined;
    test.skip(!slug, "no telegraph rooms seeded — relay round-trip skipped.");

    await request.post(`${SERVER}/telegraph/api/channels/${slug}/join/`, { headers: authHdr(token) });
    await useLiveServer(page, token);
    await page.goto("/"); // need a page origin to open a WebSocket from

    const ping = `e2e-ping-${Date.now()}`;
    const received = await page.evaluate(
      async ({ server, slug, token, ping }) => {
        const wsBase = server.replace(/^http/, "ws");
        const ws = new WebSocket(`${wsBase}/ws/telegraph/${slug}/?token=${encodeURIComponent(token)}`);
        return await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { ws.close(); resolve(false); }, 12000);
          ws.onopen = () => ws.send(JSON.stringify({ type: "chat_message", message: ping }));
          ws.onmessage = (e) => {
            try {
              const d = JSON.parse(e.data as string);
              if (d.type === "chat_message" && d.message === ping) {
                clearTimeout(timer); ws.close(); resolve(true);
              }
            } catch { /* ignore non-JSON frames */ }
          };
          ws.onerror = () => { clearTimeout(timer); resolve(false); };
        });
      },
      { server: SERVER as string, slug: slug as string, token, ping },
    );
    expect(received, "the relay should echo the sent message back to the room").toBeTruthy();
  });
});
