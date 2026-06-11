import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

const euclidSrc = new URL("../euclid/src/index.ts", import.meta.url).pathname;

export default defineConfig({
  // Euclid's barrel re-exports its UI components, so the Vue plugin is needed to
  // parse them when Rakotis pulls in `euclid` (Rakotis itself ships no .vue).
  plugins: [vue()],
  resolve: {
    alias: [{ find: /^euclid$/, replacement: euclidSrc }],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.ts"],
  },
});
