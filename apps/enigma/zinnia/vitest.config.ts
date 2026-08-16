/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Separate from vite.config.ts on purpose: tests need no Tailwind pass and no
// dev server, and keeping them apart stops a server tweak from breaking CI.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.ts", "tests/component/**/*.{test,spec}.ts"],
  },
});
