import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.COMFYUI_URL || "http://localhost:8188";
// Optional: reuse a preinstalled Chromium instead of the version pinned by @playwright/test.
const launchOptions = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 120_000,
  use: {
    baseURL,
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], launchOptions } }],
});
