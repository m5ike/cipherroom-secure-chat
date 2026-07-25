import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // happy-dom provides crypto.subtle and other Web APIs that we test against.
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    globals: false,
  },
  resolve: {
    alias: {
      "@": new URL("./client/src", import.meta.url).pathname,
      "@shared": new URL("./shared", import.meta.url).pathname,
    },
  },
});
