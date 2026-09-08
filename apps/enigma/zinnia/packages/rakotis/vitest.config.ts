import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // The barrel re-exports the Oya UI components, so the Vue plugin is needed to
  // parse them whenever a test pulls in the package entry point.
  plugins: [vue()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.ts"],
  },
});
