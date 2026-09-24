import type { HeadlessHint } from "./types.js";

/** Automation flags. Reads only well-known browser properties; nothing identifying is kept. */
export function automationSignals(): { webdriver: boolean; headless_hints: HeadlessHint[]; viewport_consistent: boolean } {
  const hints: HeadlessHint[] = [];
  const nav = navigator as Navigator & { webdriver?: boolean };
  const ua = nav.userAgent || "";
  const chromeLike = /Chrome\//.test(ua) && !/Mobile|Android/.test(ua);
  try {
    if (/HeadlessChrome|PhantomJS/.test(ua)) hints.push("headless_ua");
    if (chromeLike && nav.plugins && nav.plugins.length === 0) hints.push("no_plugins");
    if (!nav.languages || nav.languages.length === 0) hints.push("no_languages");
    if (window.outerWidth === 0 && window.outerHeight === 0) hints.push("zero_outer_size");
    if (chromeLike && !(window as Window & { chrome?: unknown }).chrome) hints.push("missing_chrome_runtime");
    if (webglRenderer().includes("SwiftShader")) hints.push("swiftshader_webgl");
  } catch {
    // Hardened browsers may throw on some of these; missing hints are fine.
  }
  let viewport = true;
  try {
    const s = window.screen;
    viewport =
      window.innerWidth <= s.width + 1 &&
      window.innerHeight <= s.height + 1 &&
      (window.outerWidth === 0 || window.outerWidth >= window.innerWidth - 1);
  } catch {
    // leave as consistent
  }
  return { webdriver: nav.webdriver === true, headless_hints: hints, viewport_consistent: viewport };
}

/** Adds `permissions_mismatch` (headless Chrome reports "denied" notifications but a "prompt" permission). */
export async function permissionsHint(): Promise<HeadlessHint | null> {
  try {
    if (typeof Notification === "undefined" || !navigator.permissions) return null;
    const p = await navigator.permissions.query({ name: "notifications" as PermissionName });
    return Notification.permission === "denied" && p.state === "prompt" ? "permissions_mismatch" : null;
  } catch {
    return null;
  }
}

function webglRenderer(): string {
  const canvas = document.createElement("canvas");
  const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
  if (!gl) return "";
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
}
