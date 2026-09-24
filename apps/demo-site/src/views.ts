/** Plain HTML views for Crumb & Co. Bakery. No framework, no client JS besides the Proofline SDK. */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface PageOpts {
  publishableKey: string;
  apiUrl: string;
}

function layout(title: string, body: string, opts: PageOpts, scripts?: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Crumb &amp; Co.</title>
<style>
  :root { color-scheme: light dark; --accent: #b5542d; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; }
  header a { color: inherit; text-decoration: none; font-weight: 700; }
  nav a { margin-right: 1rem; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input, textarea, select { width: 100%; padding: .5rem; font: inherit; box-sizing: border-box; }
  button { margin-top: 1.25rem; padding: .6rem 1.2rem; font: inherit; background: var(--accent); color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .note { font-size: .875rem; opacity: .8; }
  .decision { margin-top: 2rem; padding: .75rem; border: 1px dashed currentColor; font-size: .875rem; }
  .proofline-challenge h2 { margin-top: 1.5rem; }
  .proofline-challenge progress { width: 100%; }
  .proofline-actions { display: flex; gap: .75rem; flex-wrap: wrap; }
  .proofline-button { margin-top: 1.25rem; padding: .6rem 1.2rem; font: inherit; border-radius: 6px; cursor: pointer; }
  .proofline-primary { background: var(--accent); color: #fff; border: 0; }
  .proofline-secondary { background: transparent; color: inherit; border: 1px solid currentColor; }
  button:disabled { opacity: .6; cursor: not-allowed; }
</style>
${scripts ?? `<script async src="/proofline.js" data-key="${esc(opts.publishableKey)}" data-api="${esc(opts.apiUrl)}"></script>`}
</head>
<body>
<header><a href="/">🥐 Crumb &amp; Co. Bakery</a></header>
<nav aria-label="Main"><a href="/signup">Sign up</a><a href="/login">Log in</a><a href="/contact">Contact</a><a href="/checkout">Order</a></nav>
<main>
${body}
</main>
</body>
</html>`;
}

export const home = (o: PageOpts) =>
  layout("Home", `<h1>Fresh bread, every morning</h1><p>Sourdough, croissants and cinnamon buns from our ovens on Mill Street.</p>`, o);

export const signup = (o: PageOpts) =>
  layout(
    "Sign up",
    `<h1>Join the bread club</h1>
<form method="post" action="/signup" data-proofline-event="signup">
  <label for="name">Name</label><input id="name" name="name" autocomplete="name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
  <button type="submit">Create account</button>
</form>`,
    o,
  );

export const login = (o: PageOpts) =>
  layout(
    "Log in",
    `<h1>Welcome back</h1>
<form method="post" action="/login" data-proofline-event="login">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Log in</button>
</form>`,
    o,
  );

export const challenge = (o: PageOpts, challengeId: string) =>
  layout(
    "Quick check",
    `<h1>Just checking it's you</h1>
<p>To keep accounts safe, we sometimes ask for one extra step.</p>
<div data-proofline-challenge="${esc(challengeId)}" data-key="${esc(o.publishableKey)}" data-api="${esc(o.apiUrl)}" data-complete-url="/verify/complete"></div>
<noscript><p>This check needs JavaScript. Please email hello@crumb.example and we'll help you finish.</p></noscript>`,
    o,
    `<script async src="/proofline-challenge.js"></script>`,
  );

export const contact = (o: PageOpts) =>
  layout(
    "Contact",
    `<h1>Get in touch</h1>
<form method="post" action="/contact" data-proofline-event="form_submit">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
  <label for="message">Message</label><textarea id="message" name="message" rows="5" required></textarea>
  <button type="submit">Send</button>
</form>`,
    o,
  );

export const checkout = (o: PageOpts) =>
  layout(
    "Order",
    `<h1>Order for pickup</h1>
<form method="post" action="/checkout" data-proofline-event="checkout">
  <label for="item">Item</label>
  <select id="item" name="item"><option>Sourdough loaf</option><option>Box of 6 croissants</option><option>Cinnamon buns</option></select>
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
  <label for="card">Card number</label><input id="card" name="card" inputmode="numeric" autocomplete="cc-number" required>
  <button type="submit">Place order</button>
</form>
<p class="note">Demo only: no payment is taken.</p>`,
    o,
  );

export interface DecisionView {
  action: string;
  would_have?: string | undefined;
  mode?: string | undefined;
  decision_id?: string | undefined;
  degraded?: boolean | undefined;
}

function decisionBox(d: DecisionView) {
  return `<aside class="decision" aria-label="Proofline decision (demo)">
  <strong>Proofline</strong>: <span data-testid="action">${esc(d.action)}</span>${
    d.would_have ? ` · shadow mode, would have: <span data-testid="would-have">${esc(d.would_have)}</span>` : ""
  }${d.degraded ? " · degraded (fail-open)" : ""}${d.decision_id ? `<br><span class="note">decision ${esc(d.decision_id)}</span>` : ""}
</aside>`;
}

export const result = (o: PageOpts, title: string, message: string, d: DecisionView) =>
  layout(title, `<h1 data-testid="result">${esc(title)}</h1><p>${esc(message)}</p>${decisionBox(d)}`, o);
