/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

// Calendula's own tests. Node, not jsdom: it is date arithmetic, nothing renders.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/unit/**/*.{test,spec}.ts"],
  },
});
