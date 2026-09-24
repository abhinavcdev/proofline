// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormCollector } from "../src/collector.js";
import { AngleHistogram, Welford } from "../src/stats.js";
import { init, token } from "../src/index.js";

describe("Welford", () => {
  it("matches the two-pass mean and sample variance", () => {
    const xs = [120, 180, 95, 240, 160, 130];
    const w = new Welford();
    xs.forEach((x) => w.push(x));
    const mean = xs.reduce((a, b) => a + b) / xs.length;
    const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1);
    expect(w.mean).toBeCloseTo(mean, 9);
    expect(w.variance).toBeCloseTo(variance, 6);
  });
});

describe("AngleHistogram", () => {
  it("is ~0 for straight lines and high for varied movement", () => {
    const line = new AngleHistogram();
    for (let i = 0; i < 50; i++) line.push(5, 0);
    expect(line.entropy()).toBe(0);
    const varied = new AngleHistogram();
    for (let i = 0; i < 400; i++) varied.push(Math.cos(i * 0.7), Math.sin(i * 1.3));
    expect(varied.entropy()).toBeGreaterThan(0.8);
  });
});

function makeForm() {
  document.body.innerHTML = `
    <form data-proofline-event="signup">
      <input name="zz_login_address" type="email" />
      <input name="zz_login_pw" type="password" />
      <input type="hidden" name="csrf" value="x" />
      <button type="submit">Go</button>
    </form>`;
  return document.querySelector("form")!;
}

function type(el: HTMLElement, text: string) {
  for (const ch of text) el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
}

describe("FormCollector", () => {
  it("aggregates interactions without reading values or names", () => {
    const form = makeForm();
    const c = new FormCollector(form, 0);
    const [email, password] = form.querySelectorAll("input");
    email!.value = "secret@example.com";
    email!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    type(email!, "secret@example.com");
    email!.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    email!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    password!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    password!.dispatchEvent(new Event("paste", { bubbles: true }));
    for (let i = 0; i < 20; i++) {
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: i * 10, clientY: (i % 3) * 7, pointerType: "mouse" }));
    }

    const s = c.snapshot(true);
    expect(s.fields).toHaveLength(2);
    expect(s.fields![0]).toMatchObject({ kind: "email", keys: 19, corrections: 1, pastes: 0, focus: 1 });
    expect(s.fields![1]).toMatchObject({ kind: "password", pastes: 1 });
    expect(s.keys.count).toBe(19);
    expect(s.pastes).toBe(1);
    expect(s.pointer.type).toBe("mouse");
    expect(s.pointer.events).toBe(20);
    const json = JSON.stringify(s);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("zz_login");
    expect(json).not.toContain("csrf");

    const noConsent = c.snapshot(false);
    expect(noConsent.fields).toBeUndefined();
    expect(noConsent.consent).toBe(false);
    c.destroy();
  });

  it("ignores modifier shortcuts and non-typing keys", () => {
    const form = makeForm();
    const c = new FormCollector(form, 0);
    const email = form.querySelector("input")!;
    email.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
    email.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
    email.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(c.snapshot(true).keys.count).toBe(0);
  });
});

describe("token()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null before init and never throws", async () => {
    expect(await token("signup")).toBeNull();
  });

  it("posts text/plain signals and returns the token", async () => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) =>
      String(url).endsWith("/v1/pow") ? new Response(JSON.stringify({ enabled: false })) : new Response(JSON.stringify({ token: "pl1.t.s" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    init({ key: "pl_pk_test_abc", apiUrl: "https://api.test/", autoAttach: false });
    expect(await token("login")).toBe("pl1.t.s");
    const call = fetchMock.mock.calls.find(([u]) => String(u) === "https://api.test/v1/signals")!;
    expect((call[1].headers as Record<string, string>)["content-type"]).toMatch(/^text\/plain/);
    const body = JSON.parse(String(call[1].body));
    expect(body).toMatchObject({ key: "pl_pk_test_abc", event_type: "login", signals: { v: 1 } });
  });

  it("gives up within the budget and resolves null", async () => {
    vi.stubGlobal("fetch", (_u: string, i: RequestInit) => new Promise((_, rej) => i.signal!.addEventListener("abort", () => rej(new Error("abort")))));
    init({ key: "pl_pk_test_abc", apiUrl: "https://api.test", autoAttach: false, pow: false, timeoutMs: 100 });
    const start = performance.now();
    expect(await token("signup")).toBeNull();
    expect(performance.now() - start).toBeLessThan(400);
  });
});
