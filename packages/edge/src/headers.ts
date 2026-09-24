import type { HeaderAnomaly } from "@proofline/core";

/**
 * Header checks. Only header *names* and a few well-known values are read.
 *
 * Header order: the Fetch `Headers` object (Workers, browsers, undici) iterates
 * names in sorted order, so real order is only known when an adapter passes the
 * raw list (Node's `req.rawHeaders`). Without it the fingerprint describes which
 * headers are present, which is still useful for grouping clients.
 */

/** Infrastructure headers added by CDNs and proxies, excluded from the fingerprint. */
const INFRA = /^(cf-|x-forwarded-|x-real-ip|x-vercel-|x-amzn-|cdn-loop|true-client-ip|forwarded|via|x-request-id|traceparent|tracestate|content-length|cookie)/;

export type UaFamily =
  | "chrome"
  | "edge"
  | "firefox"
  | "safari"
  | "opera"
  | "samsung"
  | "headless_chrome"
  | "curl"
  | "wget"
  | "python"
  | "go"
  | "node"
  | "java"
  | "bot"
  | "none"
  | "other";

export function uaFamily(ua: string | null | undefined): UaFamily {
  if (!ua) return "none";
  if (/HeadlessChrome|PhantomJS|Puppeteer|Playwright/i.test(ua)) return "headless_chrome";
  if (/^curl\//i.test(ua)) return "curl";
  if (/^Wget\//i.test(ua)) return "wget";
  if (/python-requests|aiohttp|httpx|python-urllib|Scrapy/i.test(ua)) return "python";
  if (/Go-http-client/i.test(ua)) return "go";
  if (/node-fetch|undici|axios|got \(|^node$/i.test(ua)) return "node";
  if (/^Java\/|okhttp|Apache-HttpClient/i.test(ua)) return "java";
  if (/bot|crawler|spider|GPT|Claude|Perplexity|facebookexternalhit/i.test(ua)) return "bot";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/SamsungBrowser/.test(ua)) return "samsung";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return "safari";
  return "other";
}

const BROWSERS = new Set<UaFamily>(["chrome", "edge", "firefox", "safari", "opera", "samsung"]);
const CHROMIUM = new Set<UaFamily>(["chrome", "edge", "opera", "samsung"]);

export function isBrowserUa(family: UaFamily): boolean {
  return BROWSERS.has(family);
}

function chromiumMajor(ua: string): number | undefined {
  const m = /Chrome\/(\d+)/.exec(ua);
  return m ? Number(m[1]) : undefined;
}

/** A browser recent enough that it always sends Fetch Metadata (`sec-fetch-*`). */
function sendsFetchMetadata(ua: string, family: UaFamily): boolean {
  if (CHROMIUM.has(family)) return (chromiumMajor(ua) ?? 0) >= 80;
  if (family === "firefox") return Number(/Firefox\/(\d+)/.exec(ua)?.[1] ?? 0) >= 90;
  if (family === "safari") return Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0) >= 17;
  return false;
}

export interface HeaderCheckInput {
  headers: Headers;
  /** HTTP protocol when known, e.g. "HTTP/1.1", "HTTP/2". */
  httpProtocol?: string | undefined;
  /**
   * Whether this request came straight from the end user's browser. Headers
   * forwarded by a customer server lack fetch metadata, so only
   * the checks that still make sense run.
   */
  direct: boolean;
}

export function headerAnomalies({ headers, httpProtocol, direct }: HeaderCheckInput): HeaderAnomaly[] {
  const ua = headers.get("user-agent") ?? "";
  const family = uaFamily(ua);
  const out: HeaderAnomaly[] = [];

  if (!headers.get("accept-language")) out.push("missing_accept_language");

  const chUa = headers.get("sec-ch-ua");
  if (chUa !== null) {
    const major = chromiumMajor(ua);
    const chMajor = /"Chromium";v="(\d+)"/.exec(chUa)?.[1];
    const mobileHint = headers.get("sec-ch-ua-mobile");
    const platform = headers.get("sec-ch-ua-platform")?.replace(/"/g, "");
    if (
      !CHROMIUM.has(family) ||
      (chMajor !== undefined && major !== undefined && Number(chMajor) !== major) ||
      (mobileHint === "?1" && !/Mobile|Android/.test(ua)) ||
      (platform === "Windows" && !/Windows/.test(ua)) ||
      (platform === "macOS" && !/Mac OS X|Macintosh/.test(ua))
    ) {
      out.push("ua_client_hints_mismatch");
    }
  }

  if (direct && isBrowserUa(family) && sendsFetchMetadata(ua, family) && !headers.get("sec-fetch-mode")) {
    out.push("missing_sec_fetch");
  }

  if (direct && httpProtocol && /^HTTP\/1/i.test(httpProtocol) && isBrowserUa(family) && sendsFetchMetadata(ua, family)) {
    out.push("http1_modern_ua");
  }
  return out;
}

/** Stable fingerprint of the client's header set (and order, when known). */
export async function headerFingerprint(headers: Headers, rawNames?: readonly string[]): Promise<string> {
  const names = (rawNames ?? [...headers.keys()]).map((n) => n.toLowerCase()).filter((n) => !INFRA.test(n));
  const input = `${uaFamily(headers.get("user-agent"))}|${names.join(",")}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
  return Array.from(digest.slice(0, 8), (x) => x.toString(16).padStart(2, "0")).join("");
}
