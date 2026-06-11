/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// A dedicated Vitest config (no Tailwind plugin needed for tests). ace-builds
// subpaths are aliased to a lightweight stub so jsdom never loads the real
// editor — the editor's logic is covered through mocked interactions instead.
const aceStub = new URL("./tests/stubs/ace.ts", import.meta.url).pathname;
const euclidSrc = new URL("../../packages/euclid/src/index.ts", import.meta.url).pathname;
const rakotisSrc = new URL("../../packages/rakotis/src/index.ts", import.meta.url).pathname;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      { find: /^euclid$/, replacement: euclidSrc },
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
