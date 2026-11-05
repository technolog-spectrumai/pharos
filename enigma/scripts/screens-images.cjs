// Pictures in Enigma, against the real engine (demo bridge) and the window on
// `npx vite --port 5173`: a real screenshot is shrunk by the webview's canvas,
// previewed, sent whole and delivered; Bob sends one back.
const { chromium, devices } = require("playwright");
const fs = require("fs");
const OUT = process.argv[2], SHOT = process.argv[3], KEY = process.argv[4];
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
async function open(browser, opts, phone) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(2000);
  await page.evaluate(shim, B);
  for (const tab of ["Groups", "Friends"]) {
    if (phone) { await page.getByRole("button", { name: /menu/i }).first().click(); await page.waitForTimeout(300); }
    await page.getByRole("link", { name: tab }).last().click();
    await page.waitForTimeout(400);
  }
  await page.waitForSelector("[data-testid=me-name]:text('Alice')");
  return page;
}
(async () => {
  const browser = await chromium.launch();
  // Pair Alice and Bob, both online.
  const s = await call("bob", "pharos_scan", { text: await call("alice", "pharos_card") });
  await call("alice", "pharos_accept", { text: s.reply });
  for (const n of ["alice", "bob"]) await call(n, "demo_online");
  const bobsAlice = (await call("bob", "pharos_friends"))[0].id;
  await call("bob", "pharos_send", { friend: bobsAlice, text: "Send me a screenshot of your Proteus page?" });
  await new Promise((r) => setTimeout(r, 2500));

  const page = await open(browser, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }, false);
  await page.click("[data-testid=friend-Bob]");
  await page.waitForTimeout(500);
  await page.setInputFiles("[data-testid=picture-input]", SHOT);
  await page.waitForSelector("[data-testid=picture-preview]");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/01-preview.png` });
  console.log("preview:", await page.textContent("[data-testid=picture-size]"));
  await page.click("[data-testid=send-picture]");
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/02-sending.png` });
  await page.waitForSelector("[data-testid=status-Delivered]", { timeout: 15000 });
  await page.waitForTimeout(800);
  // Bob got it whole; he answers with a picture of his own.
  const bobMsgs = await call("bob", "pharos_messages", { friend: bobsAlice });
  const img = bobMsgs.find((m) => m.image);
  console.log("bob received:", img.image);
  const key = fs.readFileSync(KEY).toString("base64");
  await call("bob", "pharos_send_image", { friend: bobsAlice, mime: "image/png", data: key });
  await call("bob", "pharos_send", { friend: bobsAlice, text: "Got it, thanks! Here is our mascot." });
  await page.waitForTimeout(7000);
  await page.evaluate(() => { const m = document.querySelector("[data-testid=messages]"); m && m.scrollTo(0, m.scrollHeight); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/03-conversation.png` });
  await page.locator("[data-testid=friend-image]").first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/04-full-size.png` });

  // The same on a phone.
  const ph = await open(browser, { ...devices["iPhone 13"] }, true);
  await ph.click("[data-testid=friend-Bob]");
  await ph.waitForTimeout(1500);
  await ph.evaluate(() => { const m = document.querySelector("[data-testid=messages]"); m && m.scrollTo(0, m.scrollHeight); window.scrollTo(0, document.body.scrollHeight); });
  await ph.waitForTimeout(600);
  await ph.screenshot({ path: `${OUT}/05-phone.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
