import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
const port = Number(process.env.PLAYWRIGHT_PORT || 3100);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid PLAYWRIGHT_PORT");
const args = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
];
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:" + port,
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { args } },
    },
    {
      name: "chrome",
      testMatch: /demo\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        launchOptions: { args },
      },
    },
    {
      name: "edge",
      testMatch: /demo\.spec\.ts/,
      use: {
        ...devices["Desktop Edge"],
        channel: "msedge",
        launchOptions: { args },
      },
    },
  ],
  webServer: {
    command:
      "npm run " +
      (process.env.PLAYWRIGHT_PRODUCTION === "1" ? "start" : "dev") +
      " -- --port " +
      port,
    url: "http://127.0.0.1:" + port,
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      BOSON_API_KEY: "",
      BOSON_DATA_DIR: resolve(".data/e2e/" + randomUUID()),
    },
  },
});
