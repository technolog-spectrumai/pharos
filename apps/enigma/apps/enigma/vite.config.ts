import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), tailwindcss()],

  // The shared rakotis package ships TypeScript/Vue source (no prebuild): alias it
  // to its entry file and keep it out of esbuild dependency pre-bundling so the
  // Vue plugin compiles it like app source.
  resolve: {
    alias: [
      // The drawing engine and the theme it leans on. Raw TS/Vue like rakotis,
      // so the `.vue` rule comes first and both are excluded from prebundling.
      { find: /^wisteria\/(.*\.vue)$/, replacement: fileURLToPath(new URL("../../packages/wisteria/src/components/$1", import.meta.url)) },
      { find: /^wisteria\/(.*)/, replacement: fileURLToPath(new URL("../../packages/wisteria/src/$1", import.meta.url)) },
      { find: /^wisteria$/, replacement: fileURLToPath(new URL("../../packages/wisteria/src/index.ts", import.meta.url)) },
      { find: /^petalite\/(.*\.vue)$/, replacement: fileURLToPath(new URL("../../packages/petalite/src/components/$1", import.meta.url)) },
      { find: /^petalite\/(.*)/, replacement: fileURLToPath(new URL("../../packages/petalite/src/$1", import.meta.url)) },
      { find: /^petalite$/, replacement: fileURLToPath(new URL("../../packages/petalite/src/index.ts", import.meta.url)) },
      { find: /^rakotis\/(.*)/, replacement: fileURLToPath(new URL("../../packages/rakotis/src/$1", import.meta.url)) },
      { find: /^rakotis$/, replacement: fileURLToPath(new URL("../../node_modules/rakotis/src/index.ts", import.meta.url)) },
    ],
  },
  optimizeDeps: {
    exclude: ["rakotis", "wisteria", "petalite"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // The Tauri desktop webview (WebKitGTK) otherwise disk-caches dev modules across
    // sessions and can replay a stale module graph (e.g. a "SyntaxError: Importing
    // binding name '…' is not found" after a refactor). `no-store` forbids caching
    // dev responses so a restart always loads the current code.
    headers: { "Cache-Control": "no-store" },
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));