import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

/** Builds dist/proofline.js (IIFE, global `Proofline`) and dist/proofline.mjs (ESM). */
const LIMIT = 15 * 1024;
const common = { entryPoints: ["src/index.ts"], bundle: true, minify: true, target: "es2020", legalComments: "none" };
await build({ ...common, format: "iife", globalName: "Proofline", outfile: "dist/proofline.js" });
await build({ ...common, format: "esm", outfile: "dist/proofline.mjs" });

const size = gzipSync(readFileSync("dist/proofline.js")).length;
console.warn(`proofline.js: ${(size / 1024).toFixed(2)} KB gzip (budget ${LIMIT / 1024} KB)`);
if (process.argv.includes("--check-size") && size > LIMIT) {
  console.error("Browser SDK is over its size budget");
  process.exit(1);
}
