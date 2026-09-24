import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Builds the browser bundles in memory (IIFE), once per process. */
const cache = new Map<string, Promise<string>>();

function bundle(entry: string, globalName: string): Promise<string> {
  let p = cache.get(entry);
  if (!p) {
    p = build({
      entryPoints: [fileURLToPath(new URL(`../../../packages/sdk-browser/src/${entry}`, import.meta.url))],
      bundle: true,
      minify: true,
      format: "iife",
      globalName,
      target: "es2020",
      write: false,
    }).then((r) => r.outputFiles[0]!.text);
    cache.set(entry, p);
  }
  return p;
}

export const sdkBundle = () => bundle("index.ts", "Proofline");
export const challengeBundle = () => bundle("challenge.ts", "ProoflineChallenge");
