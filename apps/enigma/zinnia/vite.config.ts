import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],

  // Don't let Vite's overlay hide Rust compiler errors during `tauri dev`.
  clearScreen: false,

  server: {
    // Fixed, and NOT enigma's 1420: both apps must be runnable at once. This
    // value is mirrored in tauri.conf.json (devUrl), scripts/tauri-dev-server.mjs
    // and src/config/app.ts — change all four together.
    port: 1430,
    strictPort: true,
    // WebKitGTK disk-caches dev modules between sessions and can replay a stale
    // module graph after a refactor ("Importing binding name 'X' is not found").
    // Forbidding the cache makes a restart always load the current code.
    headers: { "Cache-Control": "no-store" },
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
