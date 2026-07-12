import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Pixi's WebGL renderer and the two-context multiplayer flows contend for
  // the same software-GPU process in headless Chromium. Running spec files in
  // separate workers can starve page tasks long enough to create false UI
  // timeouts even while the simulation Worker keeps advancing normally.
  workers: 1,
  retries: 0,
  reporter: [["line"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: [
    {
      command: "npm run dev",
      url: "http://localhost:3000",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "npm run dev:edge",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "e2e",
      testMatch: /e2e\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "visual",
      testMatch: /visual\/.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
