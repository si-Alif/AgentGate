// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./src/__tests__/helpers/setup.ts"],
    // Conditionally exclude directories based on the TEST_TYPE env variable
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(process.env.TEST_TYPE === "load" ? [] : ["src/__tests__/load/**"]),
      ...(process.env.TEST_TYPE === "resilience" ? [] : ["src/__tests__/resilience/**"])
    ],
    hookTimeout: 15_000,
    pool: "forks",
    maxWorkers: 1,
  },
});