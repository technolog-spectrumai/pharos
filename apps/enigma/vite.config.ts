import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { featureDefines } from "./buildFeatures";
import { sourceAliases, tauriDevServer } from "../../scripts/vite-shared.mjs";

const dir = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), tailwindcss()],

  // One literal per build feature (see buildFeatures.ts). The list comes from
  // the root build config through `./build.sh` / `./run_dev.sh`; with nothing
  // set — plain `npm run dev`, Playwright — every feature is on.
  define: featureDefines(process.env.ENIGMA_FEATURES),

  // wisteria, petalite (the repo's) and rakotis (this app's) ship raw TS/Vue
  // (no prebuild): alias each to its source and keep it out of esbuild's
  // dependency pre-bundling, so the Vue plugin compiles it like app source.
  // rakotis exports only its entry, so it takes no `.vue` rule
  // (scripts/vite-shared.mjs).
  resolve: {
    alias: [
      ...sourceAliases("wisteria", dir("../../packages/wisteria/src")),
      ...sourceAliases("petalite", dir("../../packages/petalite/src")),
      ...sourceAliases("rakotis", dir("./packages/rakotis/src"), {
        components: false,
        entry: dir("../../node_modules/rakotis/src/index.ts"),
      }),
    ],
  },
  optimizeDeps: {
    exclude: ["rakotis", "wisteria", "petalite"],
  },

  // Don't let Vite's overlay hide Rust compiler errors during `tauri dev`.
  clearScreen: false,

  // Fixed and strict — Tauri's window opens devUrl. Mirrored in
  // src-tauri/tauri.conf.json (devUrl) and src/config/app.ts; HMR is port + 1.
  server: tauriDevServer({ port: 1420 }),
}));
