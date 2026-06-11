import { defineConfig, devices } from "@playwright/test";

// E2E runs against the real production build served by `vite preview`. The
// backend is never contacted — specs stub the API with route fulfilment — so
// these tests exercise the built bundle (router, i18n, profile-language guess)
// in a real browser without needing a toto server.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
