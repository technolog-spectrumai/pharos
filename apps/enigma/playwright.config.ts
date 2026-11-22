import { defineConfig, devices } from "@playwright/test";

// E2E runs against the real production build served by `vite preview`. The app
// is serverless, so no network is contacted at all — these tests exercise the
// built bundle (router, i18n, the P2P chat shell) in a real browser.
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
