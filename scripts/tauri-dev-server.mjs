// `beforeDevCommand` shim, shared by every app: start Vite only if it is not
// already up.
//
// Without this, running the Tauri app while `npm run dev` is already serving
// would fail on the strict port. Exiting 0 lets Tauri attach to the running
// server instead — which is also what makes two windows share one Vite.
//
// Run from the app's directory (`npm run dev:tauri` does that). The port is
// READ from the app's tauri.conf.json rather than repeated here: it already
// lives in vite.config.ts and devUrl, and a third copy is one more to drift.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const conf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const port = Number(new URL(conf.build.devUrl).port);
const host = "127.0.0.1";

function isPortOpen() {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

if (await isPortOpen()) {
  console.log(`[tauri-dev] Reusing the Vite server already on http://localhost:${port}`);
  process.exit(0);
}

const vite = spawn("npm", ["run", "dev"], { stdio: "inherit", shell: process.platform === "win32" });
// Pass Vite's fate on: a dev server that died should take `tauri dev` with it.
vite.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
