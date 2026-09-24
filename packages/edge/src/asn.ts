import type { AsnClass } from "@proofline/core";

/**
 * Coarse ASN classification. A short list of large hosting and mobile
 * networks, then keywords in the AS organisation name when the platform
 * provides one (Cloudflare's `request.cf.asOrganization`). Anything else is
 * `unknown`; we never guess "residential" from an ASN number alone.
 */

const DATACENTER_ASNS = new Set([
  16509, 14618, 8987, // Amazon
  15169, 396982, 19527, // Google
  8075, 8068, // Microsoft
  14061, // DigitalOcean
  16276, // OVH
  24940, 213230, // Hetzner
  63949, // Linode / Akamai
  20473, // Vultr / Choopa
  31898, // Oracle
  45102, 37963, // Alibaba
  132203, 45090, // Tencent
  51167, // Contabo
  12876, // Scaleway
  9009, // M247
  60781, 28753, // Leaseweb
  36352, // ColoCrossing
  62567, 46606, // DigitalOcean (legacy) / Unified Layer
  212238, // Datacamp
]);

const MOBILE_ASNS = new Set([
  21928, // T-Mobile US
  22394, // Verizon Wireless
  20057, // AT&T Mobility
  6167, // Verizon (cellular)
  12576, // EE
  25135, // Vodafone UK
  3320, // Deutsche Telekom (mixed; mobile egress)
  45609, // Bharti Airtel mobile
  55836, // Reliance Jio
]);

const DC_WORDS = /\b(hosting|host|cloud|data ?cent(er|re)|server|vps|colo|amazon|aws|google|microsoft|azure|digitalocean|ovh|hetzner|linode|akamai|vultr|oracle|alibaba|tencent|contabo|scaleway|leaseweb|m247|datacamp)\b/i;
const MOBILE_WORDS = /\b(mobile|wireless|cellular|lte|5g)\b/i;
const RESIDENTIAL_WORDS = /\b(broadband|cable|fiber|fibre|dsl|residential|comcast|charter|spectrum|cox|telecom|telekom|communications)\b/i;

export function classifyAsn(asn: number | undefined, org?: string): AsnClass {
  if (asn !== undefined) {
    if (DATACENTER_ASNS.has(asn)) return "datacenter";
    if (MOBILE_ASNS.has(asn)) return "mobile";
  }
  if (org) {
    if (DC_WORDS.test(org)) return "datacenter";
    if (MOBILE_WORDS.test(org)) return "mobile";
    if (RESIDENTIAL_WORDS.test(org)) return "residential";
  }
  return "unknown";
}
