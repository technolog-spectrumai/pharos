// Relay' page as Tor Browser at "Safest" would show it (no JavaScript), and
// Enigma connecting with the code from it. Needs the demo bridge (its Relay
// page on 127.0.0.1:8978) and Enigma's window on `npx vite --port 5173`.
const { chromium, devices } = require("playwright");
const OUT = process.argv[2];
const PAGE = "http://127.0.0.1:8978";
const B = "http://127.0.0.1:8977";
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
};
(async () => {
  const browser = await chromium.launch();
  // 1. The page, JavaScript off (Tor Browser "Safest").
  for (const [name, opts, path] of [
    ["01-page-desktop", { viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 }, "/"],
    ["02-page-phone", { ...devices["iPhone 13"] }, "/"],
    ["03-page-polish-phone", { ...devices["iPhone 13"] }, "/pl"],
    ["04-page-dark-phone", { ...devices["iPhone 13"], colorScheme: "dark" }, "/"],
  ]) {
    const ctx = await browser.newContext({ ...opts, javaScriptEnabled: false });
    const p = await ctx.newPage();
    await p.goto(PAGE + path);
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    await ctx.close();
  }
  // 2. Enigma on a phone: paste the code, save, connected.
  const code = (await (await fetch(`${PAGE}/relay.txt`)).text()).trim();
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/");
  await page.waitForTimeout(2000);
  await page.evaluate(shim, B);
  // Remount Friends now that the bridge is in place: away to Groups and back.
  for (const tab of ["Groups", "Friends"]) {
    await page.getByRole("button", { name: /menu/i }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole("link", { name: tab }).last().click();
    await page.waitForTimeout(400);
  }
  await page.waitForSelector("[data-testid=me-name]:text('Alice')");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/05-enigma-no-relay.png` });
  await page.getByRole("button", { name: "You and your Relay" }).click();
  await page.fill("[data-testid=relay-field] input, input[data-testid=relay-field]", code);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/06-enigma-code-pasted.png` });
  await page.click("[data-testid=save-settings]");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/07-enigma-connected.png` });
  // A typo in a bare address: refused by its checksum, with the reason.
  await page.getByRole("button", { name: "You and your Relay" }).click();
  const onion = code && (await (await fetch(`${B}/call/alice/pharos_me`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).ok.relay;
  await page.fill("[data-testid=relay-field] input, input[data-testid=relay-field]", onion.replace(/^k/, "q"));
  await page.click("[data-testid=save-settings]");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/08-enigma-typo-refused.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
