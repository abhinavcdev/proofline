import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { MemoryEmailSender, defaultPolicy, type EventType, type Rung } from "@proofline/core";
import { startDemo } from "../src/main.js";

/**
 * Enforce mode end to end: real Chromium, the challenge UI, the real API.
 * Each test pins the rung with a project policy so every rung is exercised,
 * and every challenge screen is scanned with axe.
 */

const email = new MemoryEmailSender();
let demo: Awaited<ReturnType<typeof startDemo>>;
let policyVersion = 10;

test.beforeAll(async () => {
  demo = await startDemo({ port: 0, apiPort: 0, mode: "enforce", apiDeps: { emailSender: email } });
});
test.afterAll(async () => {
  await demo?.close();
});

async function forceRung(event: EventType, rung: Rung) {
  await demo.store!.putPolicy(demo.projectId!, {
    ...defaultPolicy(event),
    version: ++policyVersion,
    rules: [{ id: "e2e_force", when: [{ type: "prob", q: "is_automated", op: "gte", value: 0 }], then: { action: "step_up", rung }, explain: "e2e" }],
  });
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function fillForm(page: Page, path: string, fields: Record<string, string>) {
  await page.goto(`${demo.url}${path}`);
  await page.waitForFunction(() => "Proofline" in window);
  for (const [sel, v] of Object.entries(fields)) await page.fill(sel, v);
  await page.click("button[type=submit]");
}

test("forms are accessible", async ({ page }) => {
  for (const path of ["/signup", "/login", "/contact", "/checkout"]) {
    await page.goto(`${demo.url}${path}`);
    await expectAccessible(page);
  }
});

test("pow rung: solves automatically, then the submission completes", async ({ page }) => {
  await forceRung("signup", "pow");
  // The solve is fast; hold the answer until the accessibility scan of this screen is done.
  let release!: () => void;
  const scanned = new Promise<void>((r) => (release = r));
  await page.route("**/v1/challenge/complete", async (route) => {
    await scanned;
    await route.continue();
  });
  await fillForm(page, "/signup", { "#name": "Pat", "#email": "pat@example.com", "#password": "password123" });
  await expect(page).toHaveURL(/\/verify\?c=ch_/);
  await expect(page.getByRole("heading", { name: "Checking your browser" })).toBeVisible();
  await expectAccessible(page);
  release();
  await expect(page.getByTestId("result")).toHaveText("Welcome to the bread club!", { timeout: 30_000 });
  await expect(page.getByTestId("action")).toHaveText("passed pow");
});

test("email_otp rung: wrong code is announced, right code completes, pass can't be replayed", async ({ page }) => {
  await forceRung("signup", "email_otp");
  await fillForm(page, "/signup", { "#name": "Ada", "#email": "ada.otp@example.com", "#password": "password123" });
  const heading = page.getByRole("heading", { name: "Enter your verification code" });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByText(/sent a 6-digit code to a•+@example\.com/)).toBeVisible();
  await expectAccessible(page);

  const code = email.lastCode("ada.otp@example.com")!;
  await page.getByLabel("Verification code").fill(code === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("status")).toHaveText("That didn't work. Please try again.");
  await expect(page.getByLabel("Verification code")).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page);

  // Capture the pass token the UI posts, to try replaying it afterwards.
  const posted = page.waitForRequest((r) => r.url().endsWith("/verify/complete"));
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByTestId("result")).toHaveText("Welcome to the bread club!");
  const replay = await page.request.post(`${demo.url}/verify/complete`, { form: Object.fromEntries(new URLSearchParams((await posted).postData() ?? "")) });
  expect(replay.status()).toBe(403);
});

test("passkey rung: register at signup, then sign in with it", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await forceRung("signup", "passkey");
  await fillForm(page, "/signup", { "#name": "Kay", "#email": "kay@example.com", "#password": "password123" });
  await expect(page.getByRole("heading", { name: "Confirm with a passkey" })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByTestId("result")).toHaveText("Welcome to the bread club!");
  await expect(page.getByTestId("action")).toHaveText("passed passkey");

  await forceRung("login", "passkey");
  await fillForm(page, "/login", { "#email": "kay@example.com", "#password": "password123" });
  await page.getByRole("button", { name: "Continue with passkey" }).click();
  await expect(page.getByTestId("result")).toHaveText("You're logged in");
});

test("'Use another way' moves from passkey to an emailed code", async ({ page }) => {
  await forceRung("signup", "passkey");
  await fillForm(page, "/signup", { "#name": "Lee", "#email": "lee@example.com", "#password": "password123" });
  await page.getByRole("button", { name: "Use another way" }).click();
  await expect(page.getByRole("heading", { name: "Enter your verification code" })).toBeFocused();
  await page.getByLabel("Verification code").fill(email.lastCode("lee@example.com")!);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByTestId("result")).toHaveText("Welcome to the bread club!");
});

test("review rung: explains what happens next, without a dead end", async ({ page }) => {
  await forceRung("checkout", "review");
  await fillForm(page, "/checkout", { "#email": "rev@example.com", "#card": "4111111111111111" });
  await expect(page.getByRole("heading", { name: "We'll get back to you" })).toBeVisible();
  await expect(page.getByText(/review this and email you/)).toBeVisible();
  await expectAccessible(page);
  expect(await demo.store!.listReviewItems(demo.projectId!, "open")).not.toHaveLength(0);
});
