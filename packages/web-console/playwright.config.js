import { defineConfig, devices } from "@playwright/test";

const baseURL = String(process.env.HEDGELING_E2E_BASE_URL || "").replace(/\/$/, "");
if (!baseURL) {
  throw new Error("HEDGELING_E2E_BASE_URL is required for the PKCE browser smoke test");
}
const parsedBaseUrl = new URL(baseURL);
if (parsedBaseUrl.protocol !== "https:") {
  throw new Error("HEDGELING_E2E_BASE_URL must identify an approved HTTPS environment");
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{
    name: "chromium",
    use: { ...devices["Desktop Chrome"] },
  }],
});
