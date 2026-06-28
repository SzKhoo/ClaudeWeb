/**
 * Build runtime bundles for the relay + daemon. exFAT can't symlink workspace members, so we resolve
 * `@wcc/shared` via an esbuild alias (ISSUES #8) and emit single ESM files under dist/. `ws` stays
 * external (resolved from the root node_modules at runtime).
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const shared = fileURLToPath(new URL("../packages/shared/src/index.ts", import.meta.url));

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  alias: { "@wcc/shared": shared },
  external: ["ws"],
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [`${root}packages/relay/src/index.ts`],
  outfile: `${root}dist/relay.mjs`,
});
await build({
  ...common,
  entryPoints: [`${root}packages/daemon/src/index.ts`],
  outfile: `${root}dist/daemon.mjs`,
});

console.log("[bundle] wrote dist/relay.mjs and dist/daemon.mjs");
