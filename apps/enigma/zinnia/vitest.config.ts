/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Separate from vite.config.ts on purpose: tests need no Tailwind pass and no
// dev server, and keeping them apart stops a server tweak from breaking CI.
// ace-builds subpaths are aliased to a lightweight stub so jsdom never loads
// the real editor — its logic is covered through mocked interactions instead.
const aceStub = new URL("./tests/stubs/ace.ts", import.meta.url).pathname;
const rakotisSrc = new URL("./packages/rakotis/src", import.meta.url).pathname;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      // The package ROOT stays real: aceSetup calls ace.config.setModuleUrl,
      // which the stub does not implement — and the root loads fine in jsdom.
      { find: /^rakotis\/(.*)/, replacement: `${rakotisSrc}/$1` },
      { find: /^ace-builds\/src-noconflict\/.*/, replacement: aceStub },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.ts", "tests/component/**/*.{test,spec}.ts"],
  },
});
