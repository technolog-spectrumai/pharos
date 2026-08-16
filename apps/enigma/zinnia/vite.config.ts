import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],

  // rakotis is a git subtree shipping raw TS/Vue (no prebuild): alias it to its
  // entry file and keep it out of esbuild's dependency pre-bundling so the Vue
  // plugin compiles it like app source. Same arrangement enigma uses.
  //
  // Deep imports only ("rakotis/components/primitives/OyaButton.vue"), never the
  // barrel: rakotis/src/index.ts re-exports the whole P2P/MLS/chat surface plus
  // OyaQrCode, which needs `qrcode` — a dependency that lives in enigma's app,
  // not in the package. Taking pieces keeps zinnia's graph to what it uses.
  resolve: {
    alias: [
      { find: /^rakotis\/(.*)/, replacement: fileURLToPath(new URL("./packages/rakotis/src/$1", import.meta.url)) },
    ],
  },
  optimizeDeps: { exclude: ["rakotis"] },

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
