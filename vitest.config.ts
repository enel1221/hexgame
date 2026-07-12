import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "tests/visual/**", "node_modules/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/core/**/*.ts", "src/shared/**/*.ts", "src/edge/**/*.ts"],
    },
  },
});
