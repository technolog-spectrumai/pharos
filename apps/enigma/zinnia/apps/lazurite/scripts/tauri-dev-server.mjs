// `beforeDevCommand` shim: start Vite only if it is not already up.
//
// Without this, running the Tauri app while `npm run dev` is already serving
// would fail on the strict port. Exiting 0 lets Tauri attach to the running
// server instead — which is also what makes two windows share one Vite.
import { spawn } from "node:child_process";
import net from "node:net";

const host = "127.0.0.1";
const port = 1430; // must match vite.config.ts and tauri.conf.json devUrl

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
spawn("npm", ["run", "dev"], { stdio: "inherit", shell: process.platform === "win32" });
