import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Root Vitest config. exFAT can't symlink workspace members, so cross-package imports of `@wcc/shared`
 * resolve through this alias (not node_modules). All package tests run from here.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@wcc/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // This dev machine's pagefile lives on the nearly-full C: (ISSUES #7), so spawning a full
    // CPU-count fleet of fork workers occasionally gets one OOM-killed ("Worker exited
    // unexpectedly", ISSUES #13 investigation). Cap the pool: plenty of parallelism for 15 files,
    // small enough to stay under the machine's commit limit.
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
  },
});
