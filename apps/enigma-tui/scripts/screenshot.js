// Screenshots of the TUI: docs/screens/tui/*.html (from `cargo run -p enigma-tui --example screens`)
// -> *.png, with Playwright's Chromium at deviceScaleFactor 2.
//
//   node apps/enigma-tui/scripts/screenshot.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

(async () => {
  const dir = path.resolve(__dirname, "../../../docs/screens/tui");
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".html"));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  for (const f of pages) {
    await page.goto("file://" + path.join(dir, f));
    const el = await page.$(".win");
    const out = path.join(dir, f.replace(/\.html$/, ".png"));
    await el.screenshot({ path: out });
    console.log(out);
  }
  await browser.close();
})();
