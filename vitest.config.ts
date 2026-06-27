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
  },
});
