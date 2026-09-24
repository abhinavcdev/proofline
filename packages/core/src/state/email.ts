import type { EmailDomainType } from "../types/signals.js";

// Small built-in lists; projects can extend these later.
const FREE = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com",
  "msn.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de",
  "mail.com", "yandex.ru", "yandex.com", "zoho.com", "fastmail.com", "qq.com", "163.com", "web.de",
]);

const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org",
  "throwawaymail.com", "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com",
  "dispostable.com", "maildrop.cc", "fakeinbox.com", "mintemail.com", "mohmal.com", "emailondeck.com",
]);

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function classifyEmailDomain(input: string | undefined): EmailDomainType {
  if (!input) return "unknown";
  const domain = input.trim().toLowerCase().replace(/^.*@/, "");
  if (!DOMAIN_RE.test(domain)) return "unknown";
  if (DISPOSABLE.has(domain)) return "disposable";
  if (FREE.has(domain)) return "free";
  if (/\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/.test(domain)) return "edu";
  return "corporate";
}
