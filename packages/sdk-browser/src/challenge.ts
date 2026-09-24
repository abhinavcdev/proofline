/* eslint-disable @typescript-eslint/no-explicit-any -- API view JSON is rung-specific */
import { solveInWorker } from "./pow.js";
import { createPasskey, getPasskey, webauthnSupported } from "./webauthn.js";

/**
 * Proofline challenge UI: an accessible, framework-free step-up flow.
 *
 *   <div data-proofline-challenge="ch_…" data-key="pl_pk_…" data-api="https://…"
 *        data-complete-url="/verify/complete"></div>
 *   <script async src="proofline-challenge.js"></script>
 *
 * - Plain HTML controls with labels; no visual puzzles.
 * - Every state change moves focus to the new heading, and status text is
 *   announced through a polite live region.
 * - Every rung offers "Use another way" until the last one (review).
 * On success the pass token is posted to `data-complete-url` as `proofline_pass`
 * (or handed to `onPass` when mounted from code).
 */

export interface MountOptions {
  key: string;
  apiUrl: string;
  challengeId: string;
  /** Called with the pass token. Default: POST it to `completeUrl`. */
  onPass?: (passToken: string, challengeId: string) => void;
  completeUrl?: string;
}

type View = Record<string, any>;

const TEXT = {
  pow: ["Checking your browser", "This happens automatically and takes a few seconds. You don't need to do anything."],
  email_otp: ["Enter your verification code", ""],
  passkey: ["Confirm with a passkey", "Use your device's fingerprint, face, PIN or security key."],
  id_verify: ["Verify your identity", "You'll continue on our verification partner's page."],
  review: ["We'll get back to you", ""],
} as const;

let seq = 0;

export function mount(root: HTMLElement, opts: MountOptions): void {
  const id = `plc${++seq}`;
  const api = opts.apiUrl.replace(/\/+$/, "");
  root.innerHTML = "";
  root.classList.add("proofline-challenge");

  const heading = el("h2", { tabindex: "-1", id: `${id}-h` });
  const intro = el("p", { id: `${id}-intro` });
  const body = el("div");
  const status = el("p", { role: "status", "aria-live": "polite", id: `${id}-status` });
  const actions = el("div", { class: "proofline-actions" });
  root.append(heading, intro, body, status, actions);

  const say = (msg: string) => {
    status.textContent = msg;
  };

  const request = async (path: string, extra: Record<string, unknown> = {}, retries = 2): Promise<View | null> => {
    try {
      const res = await fetch(`${api}/v1/challenge/${path}`, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8" },
        credentials: "omit",
        body: JSON.stringify({ key: opts.key, challenge_id: opts.challengeId, ...extra }),
      });
      // 409: a concurrent update (e.g. a double click); retry a couple of times.
      if (res.status === 409 && retries > 0) return request(path, extra, retries - 1);
      return res.ok ? ((await res.json()) as View) : null;
    } catch {
      return null;
    }
  };

  const pass = (token: string) => {
    if (opts.onPass) return opts.onPass(token, opts.challengeId);
    if (!opts.completeUrl) return;
    const f = el("form", { method: "post", action: opts.completeUrl }) as HTMLFormElement;
    f.hidden = true;
    f.append(hidden("proofline_pass", token), hidden("challenge_id", opts.challengeId));
    document.body.append(f);
    f.submit();
  };

  const setHeading = (text: string, sub: string) => {
    heading.textContent = text;
    intro.textContent = sub;
    intro.hidden = !sub;
    body.innerHTML = "";
    actions.innerHTML = "";
    heading.focus();
  };

  const anotherWay = (v: View) => {
    if (!v.can_fallback) return;
    const b = button("Use another way", "secondary");
    b.addEventListener("click", async () => {
      b.disabled = true;
      say("Switching to another way to confirm…");
      render(await request("fallback"));
    });
    actions.append(b);
  };

  const render = (v: View | null): void => {
    if (!v) {
      setHeading("Something went wrong", "We couldn't reach the verification service. Please reload the page to try again.");
      return;
    }
    if (v.state === "passed") {
      setHeading("Thanks, you're verified", "");
      say("Verified. Continuing…");
      pass(String(v.pass_token));
      return;
    }
    if (v.state === "review") {
      setHeading(TEXT.review[0], String(v.payload?.message ?? "We'll email you."));
      say("");
      return;
    }
    if (v.state === "expired" || v.state === "failed" || v.state === "used") {
      setHeading(
        v.state === "used" ? "Already verified" : "This check has ended",
        v.state === "used" ? "This verification was already used." : "Please go back and submit the form again.",
      );
      return;
    }
    const [title, sub] = TEXT[v.rung as keyof typeof TEXT] ?? ["Verify it's you", ""];
    setHeading(title, sub);
    if (v.error) say(v.error === "wrong_answer" ? "That didn't work. Please try again." : "We couldn't verify that. Please try again.");
    else say("");

    switch (v.rung) {
      case "pow":
        return renderPow(v);
      case "email_otp":
        return renderOtp(v);
      case "passkey":
        return renderPasskey(v);
      case "id_verify": {
        const a = el("a", { href: String(v.payload.url), class: "proofline-button" });
        a.textContent = "Continue to identity verification";
        body.append(a);
        return anotherWay(v);
      }
    }
  };

  const renderPow = (v: View) => {
    const progress = el("progress", { "aria-labelledby": `${id}-h` });
    body.append(progress);
    anotherWay(v);
    const slow = setTimeout(() => say("Still checking… almost done."), 1000);
    void solveInWorker(String(v.payload.salt), Number(v.payload.bits)).then(async (nonce) => {
      clearTimeout(slow);
      if (nonce === null) {
        say("Your browser couldn't run the automatic check.");
        return render(await request("fallback"));
      }
      render(await request("complete", { response: { nonce } }));
    });
  };

  const renderOtp = (v: View) => {
    const p = v.payload;
    intro.textContent = `We sent a ${p.code_length}-digit code to ${p.sent_to}. It expires in ${Math.max(1, Math.round(p.expires_in_s / 60))} minutes.`;
    intro.hidden = false;
    const form = el("form", { novalidate: "" }) as HTMLFormElement;
    const label = el("label", { for: `${id}-code` });
    label.textContent = "Verification code";
    const input = el("input", {
      id: `${id}-code`,
      name: "code",
      inputmode: "numeric",
      autocomplete: "one-time-code",
      pattern: "[0-9]*",
      maxlength: String(p.code_length),
      "aria-describedby": `${id}-intro ${id}-status`,
      required: "",
    }) as HTMLInputElement;
    if (v.error) input.setAttribute("aria-invalid", "true");
    const submit = button("Verify", "primary", "submit");
    form.append(label, input, submit);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = input.value.replace(/\s+/g, "");
      if (!/^\d{6}$/.test(code)) {
        input.setAttribute("aria-invalid", "true");
        say(`Enter the ${p.code_length}-digit code from the email.`);
        input.focus();
        return;
      }
      submit.disabled = true;
      say("Checking the code…");
      const next = await request("complete", { response: { code } });
      render(next);
      if (next?.rung === "email_otp" && next.state === "issued") document.getElementById(`${id}-code`)?.focus();
    });
    body.append(form);

    const resend = button("Send a new code", "secondary");
    let wait = Number(p.resend_after_s);
    const tick = () => {
      if (!resend.isConnected) return;
      if (wait < 0) {
        resend.disabled = true;
        resend.textContent = "No more codes can be sent";
        return;
      }
      resend.disabled = wait > 0;
      resend.textContent = wait > 0 ? `Send a new code (available in ${wait}s)` : "Send a new code";
      if (wait-- > 0) setTimeout(tick, 1000);
    };
    tick();
    resend.addEventListener("click", async () => {
      resend.disabled = true;
      const next = await request("start");
      render(next);
      if (next?.payload?.sent) say(`A new code is on its way to ${next.payload.sent_to}.`);
    });
    actions.append(resend);
    anotherWay(v);
    if (p.sent) say(`Code sent to ${p.sent_to}.`);
  };

  const renderPasskey = (v: View) => {
    const register = v.payload.mode === "register";
    if (!webauthnSupported()) {
      say("This browser doesn't support passkeys.");
      anotherWay(v);
      return;
    }
    const b = button(register ? "Create a passkey" : "Continue with passkey", "primary");
    b.addEventListener("click", async () => {
      b.disabled = true;
      say("Follow the prompt from your device…");
      try {
        const credential = register ? await createPasskey(v.payload.options) : await getPasskey(v.payload.options);
        render(await request("complete", { response: { credential } }));
      } catch {
        b.disabled = false;
        say("The passkey prompt was closed or didn't work. You can try again or use another way.");
      }
    });
    body.append(b);
    anotherWay(v);
  };

  heading.textContent = "Verifying…";
  void request("start").then(render);
}

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function button(text: string, kind: "primary" | "secondary", type: "button" | "submit" = "button"): HTMLButtonElement {
  const b = el("button", { type, class: `proofline-button proofline-${kind}` }) as HTMLButtonElement;
  b.textContent = text;
  return b;
}

function hidden(name: string, value: string): HTMLInputElement {
  const i = el("input", { type: "hidden", name }) as HTMLInputElement;
  i.value = value;
  return i;
}

function autoMount() {
  document.querySelectorAll<HTMLElement>("[data-proofline-challenge]").forEach((root) => {
    const d = root.dataset;
    if (!d.prooflineChallenge || !d.key || !d.api) return;
    mount(root, {
      key: d.key,
      apiUrl: d.api,
      challengeId: d.prooflineChallenge,
      ...(d.completeUrl ? { completeUrl: d.completeUrl } : {}),
    });
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount, { once: true });
  else autoMount();
}
