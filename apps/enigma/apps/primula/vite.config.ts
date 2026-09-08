import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],

  // petalite and rakotis both ship raw TS/Vue (no prebuild): alias them to
  // source and keep them out of esbuild's dependency pre-bundling, so the Vue
  // plugin compiles them like app source. Same arrangement enigma uses.
  //
  // The app imports PETALITE; only petalite imports rakotis. The rakotis alias
  // is still needed because it is petalite's own specifier, but nothing under
  // src/ should name it — `npm run lint:imports` is not a thing here, so the
  // guard is tests/unit/imports.test.ts.
  //
  // Deep imports only ("rakotis/components/primitives/OyaButton.vue"), never the
  // barrel: rakotis/src/index.ts re-exports the whole P2P/MLS/chat surface plus
  // OyaQrCode, which needs `qrcode` — a dependency that lives in enigma's app,
  // not in the package. Taking pieces keeps zinnia's graph to what it uses.
  resolve: {
    alias: [
      // Order matters — Vite takes the first match. The `.vue` rule is first
      // because the components live one directory deeper than the subpaths:
      // "petalite/ModalPanel.vue" is src/components/ModalPanel.vue, while
      // "petalite/theme" is src/theme/. Both mirror package.json's `exports`.
      { find: /^petalite\/(.*\.vue)$/, replacement: fileURLToPath(new URL("../../packages/petalite/src/components/$1", import.meta.url)) },
      { find: /^petalite\/(.*)/, replacement: fileURLToPath(new URL("../../packages/petalite/src/$1", import.meta.url)) },
      { find: /^petalite$/, replacement: fileURLToPath(new URL("../../packages/petalite/src/index.ts", import.meta.url)) },
      { find: /^padova\/(.*\.vue)$/, replacement: fileURLToPath(new URL("../../packages/padova/src/components/$1", import.meta.url)) },
      { find: /^padova\/(.*)/, replacement: fileURLToPath(new URL("../../packages/padova/src/$1", import.meta.url)) },
      { find: /^padova$/, replacement: fileURLToPath(new URL("../../packages/padova/src/index.ts", import.meta.url)) },
      { find: /^rakotis\/(.*)/, replacement: fileURLToPath(new URL("../../packages/rakotis/src/$1", import.meta.url)) },
    ],
  },
  optimizeDeps: { exclude: ["rakotis", "petalite", "padova"] },

  // Don't let Vite's overlay hide Rust compiler errors during `tauri dev`.
  clearScreen: false,

  server: {
    // Fixed, and NOT enigma's 1420: both apps must be runnable at once. This
    // value is mirrored in tauri.conf.json (devUrl), scripts/tauri-dev-server.mjs
    // and src/config/app.ts — change all four together.
    port: 1432,
    strictPort: true,
    // WebKitGTK disk-caches dev modules between sessions and can replay a stale
    // module graph after a refactor ("Importing binding name 'X' is not found").
    // Forbidding the cache makes a restart always load the current code.
    headers: { "Cache-Control": "no-store" },
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1433 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
