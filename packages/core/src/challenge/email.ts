import { maskEmail } from "./otp.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  send(msg: EmailMessage): Promise<void>;
}

/** Sends through Resend's HTTP API (fetch only, so it runs in Workers). */
export class ResendEmailSender implements EmailSender {
  readonly #apiKey: string;
  constructor(
    apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.#apiKey = apiKey;
  }

  async send(msg: EmailMessage): Promise<void> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) }),
    });
    if (!res.ok) throw new Error(`Resend returned HTTP ${res.status}`);
  }

  toJSON() {
    return { provider: "resend", from: this.from };
  }
}

/**
 * Development sender: prints the message to the console (including the code,
 * so you can complete challenges locally). Never use it in production.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(msg: EmailMessage): Promise<void> {
    console.warn(`[proofline dev email] to ${maskEmail(msg.to)}: ${msg.subject}\n${msg.text}`);
  }
}

/** Test sender that keeps an outbox. */
export class MemoryEmailSender implements EmailSender {
  readonly outbox: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<void> {
    this.outbox.push(msg);
  }
  /** Latest code sent to an address. */
  lastCode(to: string): string | undefined {
    const m = [...this.outbox].reverse().find((x) => x.to === to);
    return m ? /\b(\d{6})\b/.exec(m.text)?.[1] : undefined;
  }
}

export function otpEmail(code: string, siteName: string): Omit<EmailMessage, "to"> {
  return {
    subject: `${code} is your ${siteName} verification code`,
    text: `Your verification code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
  };
}
