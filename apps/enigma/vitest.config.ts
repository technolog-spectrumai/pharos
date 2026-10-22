/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { featureDefines } from "./buildFeatures";
import { sourceAliases } from "../../scripts/vite-shared.mjs";

// A dedicated Vitest config (no Tailwind plugin needed for tests). ace-builds
// subpaths are aliased to a lightweight stub so jsdom never loads the real
// editor — the editor's logic is covered through mocked interactions instead.
const aceStub = new URL("./tests/stubs/ace.ts", import.meta.url).pathname;
const wisteriaSrc = new URL("../../packages/wisteria/src", import.meta.url).pathname;
const petaliteSrc = new URL("../../packages/petalite/src", import.meta.url).pathname;
// The DIRECTORY, not index.ts: the deep alias below appends a subpath, and
// "…/index.ts/components/…" resolves to nothing.
const rakotisDir = new URL("./packages/rakotis/src", import.meta.url).pathname;
const rakotisSrc = new URL("../../node_modules/rakotis/src/index.ts", import.meta.url).pathname;

export default defineConfig({
  plugins: [vue()],
  // The suite always runs with EVERY build feature compiled in, whatever
  // ENIGMA_FEATURES says: the tests cover the whole app, and they exercise the
  // gates by flipping the runtime build config instead.
  define: featureDefines(undefined),
  resolve: {
    alias: [
      // The same source aliases as vite.config.ts.
      ...sourceAliases("wisteria", wisteriaSrc),
      ...sourceAliases("petalite", petaliteSrc),
      ...sourceAliases("rakotis", rakotisDir, { components: false, entry: rakotisSrc }),
      { find: /^ace-builds\/src-noconflict\/ace$/, replacement: aceStub },
      { find: /^ace-builds\/src-noconflict\/.*/, replacement: aceStub },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.ts", "tests/component/**/*.{test,spec}.ts", "tests/integration/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      include: ["src/**/*.{ts,vue}"],
      exclude: ["src/main.ts", "src/**/*.d.ts", "src/vite-env.d.ts"],
    },
  },
});
