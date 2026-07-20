import { JSDOM } from "jsdom";
import fs from "node:fs";
const code = fs.readFileSync(process.env.SP + "/aceprobe/dist/probe.js", "utf8");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", pretendToBeVisual: true });
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
try {
  dom.window.eval(code);
  console.log(JSON.stringify(dom.window.__RESULT, null, 2));
} catch (e) {
  console.log("THREW:", String(e).slice(0, 400));
}
