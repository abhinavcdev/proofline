import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** Builds the browser SDK in memory (IIFE), once per process. */
let bundle: Promise<string> | undefined;

export function sdkBundle(): Promise<string> {
  bundle ??= build({
    entryPoints: [fileURLToPath(new URL("../../../packages/sdk-browser/src/index.ts", import.meta.url))],
    bundle: true,
    minify: true,
    format: "iife",
    globalName: "Proofline",
    target: "es2020",
    write: false,
  }).then((r) => r.outputFiles[0]!.text);
  return bundle;
}
