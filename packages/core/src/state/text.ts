export const TEXT_EXCERPT_MAX = 280;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+\.(?:com|net|org|io|ru|cn|xyz|top|info|biz|shop|click|link)\b(?:\/[^\s<>"']*)?/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// 7+ digits, allowing common separators. Deliberately loose; over-redaction is fine.
const PHONE_RE = /\+?\(?\d(?:[\s().-]{0,2}\d){6,}/g;
const CARDISH_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

export interface RedactedText {
  excerpt: string;
  length: "short" | "medium" | "long";
  links: number;
  emails: number;
  phones: number;
}

/**
 * Normalises and redacts free text: emails, URLs, phone and card-like numbers
 * are replaced with placeholders (counts are kept as signal), whitespace is
 * collapsed, and the result is truncated.
 */
export function redactText(raw: string, max = TEXT_EXCERPT_MAX): RedactedText {
  // Strip control characters (keeps \t and \n, which the whitespace collapse handles).
  // eslint-disable-next-line no-control-regex
  let text = raw.normalize("NFKC").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ");
  const emails = text.match(EMAIL_RE)?.length ?? 0;
  text = text.replace(EMAIL_RE, "<email>");
  const links = text.match(URL_RE)?.length ?? 0;
  text = text.replace(URL_RE, "<url>");
  text = text.replace(CARDISH_RE, "<number>");
  const phones = text.match(PHONE_RE)?.length ?? 0;
  text = text.replace(PHONE_RE, "<phone>");
  text = text.replace(/\s+/g, " ").trim();

  const length = raw.length < 40 ? "short" : raw.length < 400 ? "medium" : "long";
  const chars = Array.from(text);
  const excerpt = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
  return { excerpt, length, links, emails, phones };
}
