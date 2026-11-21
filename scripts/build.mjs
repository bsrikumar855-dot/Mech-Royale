// Bundles src/index.ts into a single dist/index.js (no runtime deps, no runtime transpilation).
import { build } from "esbuild"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
await build({
  entryPoints: [resolve(root, "src/index.ts")],
  outfile: resolve(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  minify: false, // readable stack traces on stderr matter more than bytes
  legalComments: "none",
  logLevel: "info",
})

// dist/ is copied on its own into the runtime image (no root package.json there): make "node dist/index.js" ESM everywhere.
import { writeFileSync } from "node:fs"
writeFileSync(resolve(root, "dist/package.json"), '{ "type": "module" }\n')
