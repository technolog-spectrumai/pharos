/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

// Node, not jsdom, and that is the point of this package existing separately:
// everything here is logic over a `fetchImpl` the test supplies, so the whole
// client is exercised without a browser, without Tauri and without a server.
// A component that renders any of it belongs to the app that mounts it.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/unit/**/*.{test,spec}.ts"],
  },
});
