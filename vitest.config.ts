import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Most tests run in happy-dom (provides crypto.subtle + Web APIs).
    // E2E tests run in node and spawn a real browser via Playwright.
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**"],
    globals: false,
    // Allow a generous timeout for E2E when included explicitly.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": new URL("./client/src", import.meta.url).pathname,
      "@shared": new URL("./shared", import.meta.url).pathname,
    },
  },
});
