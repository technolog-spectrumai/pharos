const { chromium, devices } = require("playwright");
// Phone screens (iPhone 13) against the real engine. Needs the demo bridge
// (`cargo run -p pharos-node --example demo_bridge`), this window on
// `npx vite --port 5173`, and Vesper (belisario apps/vesper) on port 5182.
// Then: node scripts/screens-phone.cjs ../docs/screens/phone
const OUT = process.argv[2];
const B = "http://127.0.0.1:8977";
const call = async (who, cmd, args = {}) => {
  const r = await (await fetch(`${B}/call/${who}/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) })).json();
  if (r.error) throw new Error(`${who} ${cmd}: ${r.error}`);
  return r.ok;
};
const shim = (bridge) => {
  let seq = 1; const cbs = {}; const subs = [];
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const id = seq++; cbs[id] = cb; return id; },
    unregisterCallback(id) { delete cbs[id]; },
    async invoke(cmd, args) {
      if (cmd === "plugin:event|listen") { subs.push({ event: args.event, id: args.handler }); return seq++; }
      if (cmd === "plugin:event|unlisten") return null;
      const r = await (await fetch(`${bridge}/call/alice/${cmd}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args ?? {}) })).json();
      if (r.error) throw r.error;
      return r.ok;
    },
  };
  let since = 0;
  setInterval(async () => {
    const r = await (await fetch(`${bridge}/events/alice?since=${since}`)).json();
    since = r.next;
    for (const e of r.events) for (const s of subs) if (s.event === e.event) cbs[s.id]?.({ event: e.event, payload: e.payload, id: 0 });
  }, 300);
};
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  const shot = async (n) => { await page.waitForTimeout(600); await page.screenshot({ path: `${OUT}/${n}.png` }); };
  const menu = async (label) => {
    await page.getByRole("button", { name: /menu/i }).first().click();
    await page.waitForTimeout(400);
    await page.getByRole("link", { name: label }).last().click();
    await page.waitForTimeout(600);
  };

  // Vesper: welcome and menu.
  await page.goto("http://localhost:5182/");
  await page.waitForTimeout(2500);
  await page.getByRole("link").first().click();
  await shot("01-vesper-welcome");
  await page.getByRole("button", { name: /menu/i }).first().click();
  await shot("02-vesper-menu");

  // Enigma.
  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(2000);
  await page.evaluate(shim, B);
  await page.getByRole("link").first().click();
  await shot("03-enigma-welcome");
  await page.getByRole("button", { name: /menu/i }).first().click();
  await shot("04-enigma-menu");
  await page.getByRole("link", { name: "Friends" }).last().click();
  await page.waitForSelector("[data-testid=me-name]:text('Alice')");
  await shot("05-friends-empty");

  await page.click("[data-testid=add-friend]");
  await shot("06-add-friend-card");
  const s = await call("bob", "pharos_scan", { text: await call("alice", "pharos_card") });
  await page.fill("[data-testid=paste] input, input[data-testid=paste]", s.reply);
  await page.click("[data-testid=use-paste]");
  await page.waitForTimeout(600);
  const carol = await call("carol", "pharos_card");
  await page.click("[data-testid=back]");
  await page.click("[data-testid=add-friend]");
  await page.waitForTimeout(400);
  await page.fill("[data-testid=paste] input, input[data-testid=paste]", carol);
  await page.click("[data-testid=use-paste]");
  await page.waitForTimeout(800);
  await shot("07-reply-qr");
  await call("carol", "pharos_accept", { text: await page.locator("[data-testid=pairing] input").first().inputValue() });
  await page.getByRole("button", { name: "Done" }).click();
  if (await page.locator("[data-testid=back]").isVisible()) await page.click("[data-testid=back]");

  for (const n of ["alice", "bob", "carol"]) await call(n, "demo_online");
  await shot("08-friends-list");
  await page.click("[data-testid=friend-Bob]");
  const bob = (await call("bob", "pharos_friends")).find((f) => f.name === "Alice").id;
  await call("bob", "pharos_send", { friend: bob, text: "Hi Alice! Scanned your card at the café — this is Bob." });
  await page.waitForTimeout(2500);
  await page.fill("textarea", "Hi Bob 👋 fingerprints match.");
  await page.click("[data-testid=send]");
  await page.waitForTimeout(2500);
  await call("bob", "pharos_send", { friend: bob, text: "Everything goes over Tor now, no server in between." });
  await page.waitForTimeout(2500);
  await call("bob", "demo_offline");
  await page.fill("textarea", "Still there? (Bob is offline: this one waits)");
  await page.click("[data-testid=send]");
  await page.waitForTimeout(2500);
  await page.locator("[data-testid=messages]").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot("09-conversation");
  await page.screenshot({ path: `${OUT}/11-conversation-full-page.png`, fullPage: true });

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click("[data-testid=back]");
  await page.getByRole("button", { name: "You and your Relay" }).click();
  await shot("10-settings");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
