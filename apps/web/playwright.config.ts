import { defineConfig } from "@playwright/test";

// Runs against a production build (`pnpm --filter @abcrm/web build` first) and a seeded throwaway database.
// Needs DATABASE_URL and APP_DATABASE_URL like the DB tests.
const API = 3100;
const WEB = 3101;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "list" : "line",
  use: { baseURL: `http://localhost:${WEB}`, trace: "retain-on-failure" },
  webServer: [
    {
      command: "tsx e2e/serve-api.ts",
      url: `http://localhost:${API}/healthz`,
      env: { E2E_API_PORT: String(API) },
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `next start -p ${WEB}`,
      url: `http://localhost:${WEB}/login`,
      env: { ABCRM_API_URL: `http://localhost:${API}`, ABCRM_DEV_AUTH: "1", ABCRM_WEB_ALLOW_DEV: "1" },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
