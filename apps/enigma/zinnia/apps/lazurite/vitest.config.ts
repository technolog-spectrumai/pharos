/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Separate from vite.config.ts on purpose: tests need no Tailwind pass and no
// dev server, and keeping them apart stops a server tweak from breaking CI.
// ace-builds subpaths are aliased to a lightweight stub so jsdom never loads
// the real editor — its logic is covered through mocked interactions instead.
const aceStub = new URL("./tests/stubs/ace.ts", import.meta.url).pathname;
// Univer needs canvas + a real measure cycle; jsdom has neither. The editor's
// contract is snapshot-in/snapshot-out, which the stub honours exactly.
const univerStub = new URL("./tests/stubs/univer.ts", import.meta.url).pathname;
const cssStub = new URL("./tests/stubs/empty-css.ts", import.meta.url).pathname;
const rakotisSrc = new URL("../../packages/rakotis/src", import.meta.url).pathname;
const petaliteSrc = new URL("../../packages/petalite/src", import.meta.url).pathname;
const padovaSrc = new URL("../../packages/padova/src", import.meta.url).pathname;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      // Mirrors vite.config.ts, and the ORDER is load-bearing for the same
      // reason: the `.vue` components sit one directory deeper than the
      // subpath exports, and Vite takes the first alias that matches.
      { find: /^petalite\/(.*\.vue)$/, replacement: `${petaliteSrc}/components/$1` },
      { find: /^petalite\/(.*)/, replacement: `${petaliteSrc}/$1` },
      { find: /^petalite$/, replacement: `${petaliteSrc}/index.ts` },
      { find: /^padova\/(.*\.vue)$/, replacement: `${padovaSrc}/components/$1` },
      { find: /^padova\/(.*)/, replacement: `${padovaSrc}/$1` },
      { find: /^padova$/, replacement: `${padovaSrc}/index.ts` },
      // The package ROOT stays real: aceSetup calls ace.config.setModuleUrl,
      // which the stub does not implement — and the root loads fine in jsdom.
      { find: /^rakotis\/(.*)/, replacement: `${rakotisSrc}/$1` },
      { find: /^ace-builds\/src-noconflict\/.*/, replacement: aceStub },
      // Whole-specifier match: a regex alias replaces only the MATCHED part,
      // so /\.css$/ would rewrite "pkg/index.css" to "pkg/index<stub>".
      { find: /^.+\.css$/, replacement: cssStub },
      { find: /^@univerjs\/presets$/, replacement: univerStub },
      { find: /^@univerjs\/preset-sheets-core$/, replacement: univerStub },
      { find: /^@univerjs\/preset-sheets-core\/locales\/.*/, replacement: univerStub },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.ts", "tests/component/**/*.{test,spec}.ts"],
  },
});
