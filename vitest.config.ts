import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // No functional test in the roadmap requires cross-file concurrency.
    // All concurrency proofs (M3, M8) run intra-test via Promise.all
    // against one live app instance. Serializing files removes the
    // shared-singleton race entirely without sharding infrastructure.
    fileParallelism: false,
    setupFiles: ["./src/__tests__/helpers/setup.ts"],
    hookTimeout: 15_000,
  },
});