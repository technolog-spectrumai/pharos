/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { featureDefines } from "./buildFeatures";

// A dedicated Vitest config (no Tailwind plugin needed for tests). ace-builds
// subpaths are aliased to a lightweight stub so jsdom never loads the real
// editor — the editor's logic is covered through mocked interactions instead.
const aceStub = new URL("./tests/stubs/ace.ts", import.meta.url).pathname;
const cssStub = new URL("./tests/stubs/empty-css.ts", import.meta.url).pathname;
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
      { find: /^wisteria\/(.*\.vue)$/, replacement: `${wisteriaSrc}/components/$1` },
      { find: /^wisteria\/(.*)/, replacement: `${wisteriaSrc}/$1` },
      { find: /^wisteria$/, replacement: `${wisteriaSrc}/index.ts` },
      { find: /^petalite\/(.*\.vue)$/, replacement: `${petaliteSrc}/components/$1` },
      { find: /^petalite\/(.*)/, replacement: `${petaliteSrc}/$1` },
      { find: /^petalite$/, replacement: `${petaliteSrc}/index.ts` },
      { find: /^rakotis\/(.*)/, replacement: `${rakotisDir}/$1` },
      { find: /^rakotis$/, replacement: rakotisSrc },
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
