/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

// Petalite's own tests. Node, not jsdom: what lives here that is worth testing
// in isolation is logic — the CSV parser, the palette maths — and a component
// belongs to the app that mounts it.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/unit/**/*.{test,spec}.ts"],
  },
});
