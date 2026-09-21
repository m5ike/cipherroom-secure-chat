import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Same JSX transform as the production build (vite.config.ts), so .tsx
  // tests exercise the automatic React runtime rather than tsconfig's setting.
  plugins: [react()],
  test: {
    // Most tests run in happy-dom (provides crypto.subtle + Web APIs).
    // E2E tests run in node and spawn a real browser via Playwright.
    environment: "happy-dom",
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["test/e2e/**", "node_modules/**"],
    globals: false,
    // Allow a generous timeout for E2E when included explicitly.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": new URL("./client/src", import.meta.url).pathname,
    },
  },
});
