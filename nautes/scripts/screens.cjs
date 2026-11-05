const { chromium } = require("playwright");
// Screens of Friends against the real engine: run `cargo run -p pharos-node --example demo_bridge`
// and `npx vite --port 5173` (in nautes/), then `node scripts/screens.cjs ../docs/screens`.
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(1500);
  await page.evaluate(shim, B);
  // Remount the Friends view now that the bridge is in place.
  await page.evaluate(() => (window.__nautesRouter ?? null));
  const nav = async (label) => page.getByRole("link", { name: label }).first().click();
  await nav("Groups"); await page.waitForTimeout(400); await nav("Friends");
  await page.waitForSelector("[data-testid=me-name]:text('Alice')");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/01-friends-empty.png` });

  // Pairing: Alice shows her card; Bob scans it (no Proteus → a reply to show).
  await page.click("[data-testid=add-friend]");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/02-pair-show-card.png` });
  const card = await page.locator("[data-testid=pairing] input[readonly], [data-testid=pairing] code, [data-testid=pairing] input").first().inputValue().catch(() => null);
  const aliceCard = card && card.startsWith("pharos-card:") ? card : await call("alice", "pharos_card");
  const s = await call("bob", "pharos_scan", { text: aliceCard });
  await page.fill("[data-testid=paste] input, input[data-testid=paste]", s.reply);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/03-pair-paste-reply.png` });
  await page.click("[data-testid=use-paste]");
  await page.waitForTimeout(800);

  // Carol: Alice scans Carol's card; the reply goes back as a QR.
  const carolCard = await call("carol", "pharos_card");
  await page.click("[data-testid=add-friend]");
  await page.waitForTimeout(500);
  await page.fill("[data-testid=paste] input, input[data-testid=paste]", carolCard);
  await page.click("[data-testid=use-paste]");
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/04-pair-reply-qr.png` });
  const reply = await page.locator("[data-testid=pairing] input").first().inputValue();
  await call("carol", "pharos_accept", { text: reply });
  await page.getByRole("button", { name: "Done" }).click();

  // A conversation with Bob, both online.
  for (const n of ["alice", "bob", "carol"]) await call(n, "demo_online");
  await page.click("[data-testid=friend-Bob]");
  const bobFriend = (await call("bob", "pharos_friends"))[0].id;
  await call("bob", "pharos_send", { friend: bobFriend, text: "Hi Alice! Scanned your card at the café — this is Bob." });
  await page.waitForTimeout(2500);
  await page.fill("[data-testid=compose] textarea, textarea[data-testid=compose]", "Hi Bob 👋 got it. The fingerprints matched: ZFX3 PEXO…");
  await page.click("[data-testid=send]");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/05-sending.png` });
  await page.waitForTimeout(2500);
  await call("bob", "pharos_send", { friend: bobFriend, text: "Perfect. Everything goes over Tor now, no server in between." });
  await page.waitForTimeout(2500);
  await page.fill("textarea", "Short messages only — up to 1000 characters.");
  await page.click("[data-testid=send]");
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${OUT}/06-conversation-delivered.png` });

  // Bob goes offline: the message waits in the outbox.
  await call("bob", "demo_offline");
  await page.fill("textarea", "Are you still there? (Bob closed his laptop)");
  await page.click("[data-testid=send]");
  await page.waitForTimeout(3000);
  await page.fill("textarea", "x".repeat(1012));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/07-offline-queued-and-too-long.png` });
  await page.fill("textarea", "");

  // Settings: name and Proteus.
  await page.getByRole("button", { name: "You and your Proteus" }).click();
  await page.waitForTimeout(300);
  await page.locator("input").nth(1).fill("proteusdemo4k2q7m3xv5nb6wz8yc9h2dj4lf7rt3ga5ek6pq2sum3wd.onion");
  await page.screenshot({ path: `${OUT}/08-settings-proteus.png` });
  await page.click("[data-testid=save-settings]");
  await page.waitForTimeout(800);

  // Carol is offline; with... Alice's message to Carol, then Bob back online: the queued one goes.
  await call("bob", "demo_online");
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${OUT}/09-back-online-delivered.png` });

  // Phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/10-phone.png`, fullPage: true });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
