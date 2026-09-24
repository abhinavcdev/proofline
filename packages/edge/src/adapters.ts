import type { EdgeContext } from "./collect.js";

/** Subset of Cloudflare's `request.cf` that we read. */
interface CfProperties {
  asn?: number;
  asOrganization?: string;
  country?: string;
  httpProtocol?: string;
  verifiedBotCategory?: string;
  botManagement?: { ja4?: string; verifiedBot?: boolean };
}

/** Cloudflare Workers: `request.cf` plus `CF-Connecting-IP`. */
export function cloudflareContext(request: Request, direct = true): EdgeContext {
  const cf = (request as Request & { cf?: CfProperties }).cf;
  return {
    request,
    direct,
    ip: request.headers.get("cf-connecting-ip") ?? undefined,
    asn: cf?.asn,
    asOrganization: cf?.asOrganization,
    country: cf?.country,
    httpProtocol: cf?.httpProtocol,
    ja4: cf?.botManagement?.ja4,
    verifiedBot: cf?.botManagement?.verifiedBot ?? (cf?.verifiedBotCategory ? true : undefined),
  };
}

/** Vercel (Edge or Node middleware): `x-real-ip` and `x-vercel-ip-*` headers. Vercel exposes no ASN. */
export function vercelContext(request: Request, direct = true): EdgeContext {
  const h = request.headers;
  return {
    request,
    direct,
    ip: h.get("x-real-ip") ?? firstForwarded(h.get("x-forwarded-for")),
    country: h.get("x-vercel-ip-country") ?? undefined,
  };
}

/**
 * Generic: IP supplied by the caller (for example Node's socket address behind
 * a trusted proxy). Pass `rawHeaderNames` from Node's `req.rawHeaders` to keep order.
 */
export function genericContext(
  request: Request,
  opts: { ip?: string | undefined; direct: boolean; rawHeaderNames?: readonly string[] },
): EdgeContext {
  return { request, direct: opts.direct, ip: opts.ip, rawHeaderNames: opts.rawHeaderNames };
}

function firstForwarded(v: string | null): string | undefined {
  return v?.split(",")[0]?.trim() || undefined;
}
