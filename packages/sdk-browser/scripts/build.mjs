import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

/** Builds dist/proofline.js (IIFE, global `Proofline`) and dist/proofline.mjs (ESM). */
const common = { bundle: true, minify: true, target: "es2020", legalComments: "none" };
const bundles = [
  { entry: "src/index.ts", name: "proofline", global: "Proofline", limit: 15 * 1024 },
  // Loaded only on challenge pages.
  { entry: "src/challenge.ts", name: "proofline-challenge", global: "ProoflineChallenge", limit: 12 * 1024 },
];

let over = false;
for (const b of bundles) {
  await build({ ...common, entryPoints: [b.entry], format: "iife", globalName: b.global, outfile: `dist/${b.name}.js` });
  await build({ ...common, entryPoints: [b.entry], format: "esm", outfile: `dist/${b.name}.mjs` });
  const size = gzipSync(readFileSync(`dist/${b.name}.js`)).length;
  console.warn(`${b.name}.js: ${(size / 1024).toFixed(2)} KB gzip (budget ${b.limit / 1024} KB)`);
  if (size > b.limit) over = true;
}
if (process.argv.includes("--check-size") && over) {
  console.error("A browser bundle is over its size budget");
  process.exit(1);
}
