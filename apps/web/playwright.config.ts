import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: Number(process.env.E2E_TIMEOUT_MS ?? 180_000),
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    channel: "chrome",
    extraHTTPHeaders: { "X-Steno-Test-Template": "true" },
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
});
