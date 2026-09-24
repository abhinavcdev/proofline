import { describe, expect, it, vi } from "vitest";
import {
  FALLBACK,
  LADDER,
  MemoryEmailSender,
  ResendEmailSender,
  generateOtp,
  hashOtp,
  maskEmail,
  nextAvailableRung,
  otpEmail,
  timingSafeEqual,
} from "../src/index.js";

describe("ladder", () => {
  it("every rung's fallback chain ends at review without cycles", () => {
    for (const r of LADDER) {
      const seen = new Set([r]);
      let cur = FALLBACK[r];
      while (cur) {
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
        cur = FALLBACK[cur];
      }
      expect(r === "review" || seen.has("review")).toBe(true);
    }
  });

  it("skips rungs the user can't complete", () => {
    expect(nextAvailableRung("passkey", () => true)).toBe("email_otp");
    expect(nextAvailableRung("passkey", (r) => r !== "email_otp")).toBe("review");
    expect(nextAvailableRung("review", () => true)).toBe("review");
  });
});

describe("otp", () => {
  it("generates 6-digit codes with digits spread evenly", () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 2000; i++) {
      const c = generateOtp();
      expect(c).toMatch(/^\d{6}$/);
      counts[Number(c[0])]++;
    }
    for (const n of counts) expect(n).toBeGreaterThan(120);
  });

  it("hashes per challenge and compares in constant time", async () => {
    const a = await hashOtp("c1", "123456");
    expect(a).not.toBe(await hashOtp("c2", "123456"));
    expect(timingSafeEqual(a, await hashOtp("c1", "123456"))).toBe(true);
    expect(timingSafeEqual(a, await hashOtp("c1", "123457"))).toBe(false);
    expect(timingSafeEqual("ab", "abc")).toBe(false);
  });

  it("masks addresses", () => {
    expect(maskEmail("ada@gmail.com")).toBe("a••@gmail.com");
    expect(maskEmail("x@y.io")).toBe("x••@y.io");
  });
});

describe("email senders", () => {
  it("Resend sends the documented request and keeps the key out of JSON", async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}", { status: 200 }));
    const s = new ResendEmailSender("re_secret_key", "Crumb <noreply@crumb.example>", f as unknown as typeof fetch);
    await s.send({ to: "ada@gmail.com", ...otpEmail("123456", "Crumb & Co.") });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer re_secret_key");
    expect(JSON.parse(String(init.body))).toMatchObject({ to: ["ada@gmail.com"], subject: "123456 is your Crumb & Co. verification code" });
    expect(JSON.stringify(s)).not.toContain("re_secret_key");
  });

  it("memory sender exposes the last code", async () => {
    const m = new MemoryEmailSender();
    await m.send({ to: "a@b.co", ...otpEmail("654321", "X") });
    expect(m.lastCode("a@b.co")).toBe("654321");
  });
});
