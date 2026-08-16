import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import App from "../../src/App.vue";
import { brand, dev } from "../../src/config";
import { i18n } from "../../src/i18n";
import { createPinia } from "pinia";

describe("the shell", () => {
  it("mounts the shell with the sketch editor inside", () => {
    const w = mount(App, { global: { plugins: [i18n, createPinia()] } });
    expect(w.text()).toContain("Zinnia");
    // The file bar proves SketchView mounted, not a placeholder.
    expect(w.find('[data-testid="file-save"]').exists()).toBe(true);
  });

  it("toggles dark mode onto <html> and remembers it", async () => {
    const w = mount(App, { global: { plugins: [i18n, createPinia()] } });
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

  it("ships the identity the OS data directory is derived from", async () => {
    const fs = await import("node:fs/promises");
    const conf = JSON.parse(await fs.readFile("src-tauri/tauri.conf.json", "utf8"));
    expect(conf.identifier).toBe(brand.bundleId);
  });
});
