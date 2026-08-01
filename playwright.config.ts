import { defineConfig } from "@playwright/test";

// 4190 triggers a Wrangler 4.116/Windows Miniflare `bad port` proxy-control
// failure in this runtime even though the public listener itself opens.
const PORT = 4192;
const baseURL = `http://127.0.0.1:${PORT}`;
// Deliberately public, test-only material. Keeping this at exactly 32 ASCII
// bytes proves the minimum HMAC contract without borrowing any developer or
// deployment secret from the parent process.
const E2E_SESSION_SIGNING_KEY = "ieoga-ci-only-session-key-000001";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL,
    browserName: "chromium",
    colorScheme: "light",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "mobile-360", use: { viewport: { width: 360, height: 800 } } },
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 } } },
    { name: "tablet-768", use: { viewport: { width: 768, height: 1024 } } },
    { name: "desktop-1280", use: { viewport: { width: 1280, height: 900 } } },
  ],
  webServer: {
    command: `npm run start -- --port ${PORT} --ip 127.0.0.1`,
    url: baseURL,
    env: {
      IEOGA_PLAYWRIGHT_SERVER: "true",
      SESSION_SIGNING_KEY: E2E_SESSION_SIGNING_KEY,
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
