/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// The engine's own tests live beside the engine, not inside one consumer.
// They used to sit in apps/sketch (and, duplicated and diverged, in enigma) —
// which meant the shared code's coverage belonged to whichever app happened to
// import it, and enigma's copy pinned an API the fork had already outgrown.
const petaliteSrc = new URL("../petalite/src", import.meta.url).pathname;
const rakotisSrc = new URL("../rakotis/src", import.meta.url).pathname;
const cssStub = new URL("./tests/stubs/empty-css.ts", import.meta.url).pathname;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      // Order is load-bearing, as in every app config here: the `.vue` rule
      // first, because components sit one directory deeper than the subpaths.
      { find: /^petalite\/(.*\.vue)$/, replacement: `${petaliteSrc}/components/$1` },
      { find: /^petalite\/(.*)/, replacement: `${petaliteSrc}/$1` },
      { find: /^petalite$/, replacement: `${petaliteSrc}/index.ts` },
      { find: /^rakotis\/(.*)/, replacement: `${rakotisSrc}/$1` },
      { find: /^wisteria\/(.*\.vue)$/, replacement: new URL("./src/components/$1", import.meta.url).pathname },
      { find: /^wisteria\/(.*)/, replacement: new URL("./src/$1", import.meta.url).pathname },
      // Whole-specifier match: a regex alias replaces only the MATCHED part,
      // so /\.css$/ would rewrite "pkg/index.css" to "pkg/index<stub>".
      { find: /^.+\.css$/, replacement: cssStub },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.ts", "tests/component/**/*.{test,spec}.ts"],
  },
});
