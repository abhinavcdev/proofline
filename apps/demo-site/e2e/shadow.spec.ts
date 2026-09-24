import { expect, test, type Page } from "@playwright/test";
import { startDemo } from "../src/main.js";

/**
 * Real browser, real SDK, real API (in-process, PGlite, mock decisions),
 * project in shadow mode. Playwright's Chromium is automation by definition
 * (navigator.webdriver = true), so these submissions are bots in the API's eyes,
 * and all of them must still succeed.
 */

let demo: Awaited<ReturnType<typeof startDemo>>;

test.beforeAll(async () => {
  demo = await startDemo({ port: 0, apiPort: 0, mode: "shadow" });
});
test.afterAll(async () => {
  await demo?.close();
});

async function typeLikeAPerson(page: Page, selector: string, text: string) {
  await page.click(selector);
  await page.keyboard.type(text, { delay: 60 + Math.random() * 60 });
}

test("a human-paced signup gets a valid token and succeeds", async ({ page }) => {
  await page.goto(`${demo.url}/signup`);
  await page.waitForFunction(() => "Proofline" in window);
  for (let i = 0; i < 25; i++) await page.mouse.move(100 + i * 13 + (i % 4) * 9, 200 + Math.sin(i) * 40, { steps: 3 });
  await typeLikeAPerson(page, "#name", "Ada Lovelace");
  await typeLikeAPerson(page, "#email", "ada@gmail.com");
  await typeLikeAPerson(page, "#password", "correct horse battery");
  await page.click("button[type=submit]");

  await expect(page.getByTestId("result")).toHaveText("Welcome to the bread club!");
  await expect(page.getByTestId("action")).toHaveText("allow");

  const [decision] = await demo.store!.listDecisions(demo.projectId!, { limit: 1 });
  expect(decision).toMatchObject({ token_status: "valid", mode: "shadow", effective_action: "allow", ua_family: expect.any(String) });
  const state = decision!.state as { behavior?: { typing?: unknown; pointer?: string }; automation?: { webdriver?: boolean } };
  expect(state.behavior?.typing).toBeTruthy();
  expect(state.automation?.webdriver).toBe(true);
});

test("instant bot fills succeed in shadow mode, with what enforce would have done", async ({ page }) => {
  for (const [path, fill] of [
    ["/signup", { "#name": "x", "#email": "bot1@mailinator.com", "#password": "password123" }],
    ["/contact", { "#email": "seo@mailinator.com", "#message": "Cheap backlinks!!! https://a.example https://b.example https://c.example" }],
    ["/checkout", { "#email": "carder@mailinator.com", "#card": "4111111111111111" }],
  ] as const) {
    await page.goto(`${demo.url}${path}`);
    await page.waitForFunction(() => "Proofline" in window);
    for (const [sel, v] of Object.entries(fill)) await page.fill(sel, v);
    await page.click("button[type=submit]");
    await expect(page.getByTestId("action")).toHaveText("allow");
    await expect(page.getByTestId("result")).not.toHaveText(/couldn't|One more step/);
  }
  const decisions = await demo.store!.listDecisions(demo.projectId!, { limit: 10 });
  expect(decisions.some((d) => d.action !== "allow")).toBe(true);
  expect(decisions.every((d) => d.effective_action === "allow")).toBe(true);
});

test("a submission with JavaScript disabled (no token) still succeeds", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(`${demo.url}/signup`);
  await page.fill("#name", "No JS");
  await page.fill("#email", "nojs@example.com");
  await page.fill("#password", "password123");
  await page.click("button[type=submit]");
  await expect(page.getByTestId("result")).toHaveText("Welcome to the bread club!");
  await ctx.close();
});
