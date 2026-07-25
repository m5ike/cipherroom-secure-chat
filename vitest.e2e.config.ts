import { defineConfig } from "vitest/config";

/**
 * E2E test config for Playwright + sandboxed browser.
 *
 * Run with: `npm run test:e2e`.
 *
 * Notes:
 *  - The browser process is spawned inside the test (Node environment)
 *    so we don't share state with the rest of the suite.
 *  - Network is locked to 127.0.0.1 inside the test setup so the test
 *    cannot leak the user's local network.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Playwright spawns its own browser binaries; we do not want the
    // happy-dom env to interfere.
    environmentOptions: {
      happyDOM: { /* noop */ },
    },
  },
});
