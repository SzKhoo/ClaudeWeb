import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Vite config for the web client. Root is this package (index.html lives here). exFAT can't symlink
 * workspace members, so `@wcc/shared` resolves through an alias to the shared source (same scheme as
 * the root vitest config). The dev server is what the preview workflow drives.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      "@wcc/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5179,
    strictPort: false,
  },
});
