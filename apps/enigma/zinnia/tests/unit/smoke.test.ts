import { describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import App from "../../src/App.vue";
import { brand, dev } from "../../src/config";
import { i18n } from "../../src/i18n";

describe("the shell", () => {
  it("mounts the shell with the sketch editor inside", async () => {
    const w = mount(App, { global: { plugins: [i18n] } });
    // The host registers itself through a template ref, so its file name only
    // reaches the header on the following tick.
    await flushPromises();
    // The wordmark gave way to the menu button, which stands in its place and
    // keeps the brand as its tooltip.
    expect(w.find('[data-testid="app-menu"]').exists()).toBe(true);
    expect(w.get('[data-testid="app-menu"]').attributes("title")).toBe("Zinnia");
    // A named file proves a real editor host mounted, not a placeholder.
    expect(w.get('[data-testid="file-name"]').text()).toMatch(/\.\w+$/);
  });

  it("toggles dark mode onto <html> and remembers it", async () => {
    const w = mount(App, { global: { plugins: [i18n] } });
    const before = document.documentElement.classList.contains("dark");
    await w.get('[data-testid="dark-toggle"]').trigger("click");
    expect(document.documentElement.classList.contains("dark")).toBe(!before);
    expect(localStorage.getItem("zinnia:dark")).toBe(before ? "0" : "1");
  });

  it("keeps the dev port in step with the Tauri and Vite configs", async () => {
    // Four files carry this number; a mismatch means `tauri dev` opens a window
    // pointed at nothing, which looks like a broken app rather than a typo.
    const fs = await import("node:fs/promises");
    const conf = JSON.parse(await fs.readFile("src-tauri/tauri.conf.json", "utf8"));
    const vite = await fs.readFile("vite.config.ts", "utf8");
    const shim = await fs.readFile("scripts/tauri-dev-server.mjs", "utf8");
    expect(conf.build.devUrl).toBe(`http://localhost:${dev.vitePort}`);
    expect(vite).toContain(`port: ${dev.vitePort}`);
    expect(shim).toContain(`const port = ${dev.vitePort}`);
  });

  it("ships a Content-Security-Policy, and one that still lets the app work", async () => {
    // The policy's whole job is `script-src 'self'` with no 'unsafe-inline' and
    // no 'unsafe-eval': an injected <script> or onerror= in a deck's HTML block
    // or an opened .svg does not run. Asserted here because a null csp is a
    // one-word change that reverts the entire protection silently.
    const fs = await import("node:fs/promises");
    const conf = JSON.parse(await fs.readFile("src-tauri/tauri.conf.json", "utf8"));
    const csp: string = conf.app.security.csp;
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");

    // …and the four allowances the app genuinely needs. Each is load-bearing:
    // ACE re-wraps its syntax workers through a blob, a sketch embeds its
    // background as data:, the PNG export rasterises through a blob, and every
    // Tauri command goes over the ipc scheme.
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("ipc:");
    // Remote images stay refused — a document that can name one can phone home.
    expect(csp).not.toMatch(/img-src[^;]*https?:\/\/(?!asset\.localhost)/);
  });

  it("keeps the dev policy in step with the dev ports", async () => {
    // devCsp names the Vite and HMR ports, so it is a fifth place that number
    // lives. A drift here shows up as an app that cannot hot-reload.
    const fs = await import("node:fs/promises");
    const conf = JSON.parse(await fs.readFile("src-tauri/tauri.conf.json", "utf8"));
    const devCsp: string = conf.app.security.devCsp;
    expect(devCsp).toContain(`http://localhost:${dev.vitePort}`);
    expect(devCsp).toContain(`ws://localhost:${dev.vitePort + 1}`);
    // Dev relaxes script-src, because Vite injects inline scripts — and nothing
    // else. Every other directive matches production, so a violation surfaces
    // while developing rather than only in a release build.
    const strip = (c: string) => c.split("; ").filter((d) => !d.startsWith("script-src") && !d.startsWith("connect-src"));
    expect(strip(devCsp)).toEqual(strip(conf.app.security.csp));
  });

  it("ships the identity the OS data directory is derived from", async () => {
    const fs = await import("node:fs/promises");
    const conf = JSON.parse(await fs.readFile("src-tauri/tauri.conf.json", "utf8"));
    expect(conf.identifier).toBe(brand.bundleId);
  });
});
