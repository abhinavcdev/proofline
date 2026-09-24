# Proofline: MVP Plan

> Status: **Approved. M1 and M2 complete.**
> Last updated: 2026-09-24

Proofline answers one question for every sensitive event: **is this a human, a legitimate agent, or a bad bot?** It then applies the lightest check that settles the question.

---

## 0. Decisions and open questions

| # | Topic | Status |
|---|-------|--------|
| Q1 | **Jev wire schema** | **Resolved.** Implemented from the TypeSafe API reference as `TYPESAFE_WIRE`: `POST https://api.typesafe.ai/v1/systemone` with bearer auth and `{ model, state, questions }`. Summary in `docs/vendor/typesafe-jev.md`. `JEV_MODEL` selects the model (default `jev-latest`). |
| Q2 | `noul` confidence | **Resolved.** Jev returns no confidence for nouls, so the adapter derives `confidence = |2p − 1|` and sets `confidence_derived: true`. Choice and score answers use Jev's own confidence. |
| Q3 | Signal-token signing | **Decided:** new `POST /v1/signals` (publishable key) returns an HMAC-signed, 5-minute, one-time token. |
| Q4 | Postgres for Workers | **Decided:** Hyperdrive in front of Postgres (for example Neon) for deploys, Docker Postgres locally, PGlite for tests. |
| Q5 | Latency (400 ms Jev cap vs 300 ms p95) | **Decided:** keep the 400 ms cap and measure in M5. Hard-blocked events skip the Jev call entirely. |
| Q6 | Dashboard auth | **Decided:** Better Auth with the magic-link and passkey plugins. |

---

## 1. Architecture

```
Browser (sdk-browser)                 Edge (packages/edge)              API worker (apps/api, Hono)
─────────────────────                 ────────────────────              ───────────────────────────
aggregates behaviour  ──POST /v1/signals──►  adds network signals  ──►  validate (Zod) → sign token (HMAC, 5 min TTL)
PoW in Web Worker                     hashed IP, ASN, JA4,                     │
hidden <input name=proofline_token>   header order, rate                    token ◄┘
        │
        ▼ form submit
Customer server (sdk-server) ──POST /v1/assess { event_type, signal_token, context }──►
                                                                             │
      ┌──────────────────────────────────────────────────────────────────────┘
      ▼
  1. verify token + deterministic checks (rate limits, bad-IP list, PoW)   ── hard block wins
  2. buildState(browser, edge, server ctx)  → compact JSON (≤ ~600 tokens)
  3. DecisionProvider.decide(state, questions/v1)  (Jev | Mock | RulesOnly; 400 ms cap → fallback)
  4. PolicyEngine.evaluate(answers, checks, projectPolicy[event_type])
        → allow | step_up:<rung> | block | shadow_drop | agent_lane  + reasons[]
  5. mode = shadow ? effective_action = allow : action
  6. ctx.waitUntil(log decision + stage timings)   ← off the hot path
      ▼
  { action, decision_id, risk, reasons, challenge? }
```

**Key design choices**

- **`packages/core` is runtime-agnostic.** It has no Node or Workers APIs, only Web Crypto and pure TypeScript, so the same code runs in Workers, Node, and Vitest.
- **Dependency injection at the edges.** `DecisionProvider`, `RateLimiter`, `EmailSender`, `IdVerifier`, `EventStore`, `Clock`, and `Random` are all interfaces. Tests use in-memory implementations.
- **Shadow mode is enforced in exactly one place.** The final `applyMode()` step can only turn an action into `allow`. The shadow-mode test checks that function and also runs the full pipeline over the bot-sim corpus.
- **Stage timing.** Every request gets a `timings` object (`verify`, `edge`, `state`, `decide`, `policy`, `total`). It goes into the log and the `Server-Timing` header.
- **Fail open.** If Proofline fails, the customer's form still works. `sdk-server.assess()` has its own timeout (default 800 ms) and returns `{ action: "allow", degraded: true }` on any error. The browser SDK never throws into page code, and a missing token is a signal, not an error.

---

## 2. Repo layout

```
apps/
  api/                 Hono on Cloudflare Workers (wrangler)
    src/routes/        signals.ts, assess.ts, challenge.ts, feedback.ts
    src/middleware/    apiKey.ts (publishable vs secret scopes), rateLimit.ts, timing.ts
    src/do/            RateLimiterDO (Durable Object sliding window)
  dashboard/           Next.js App Router + Tailwind + shadcn/ui + Better Auth (magic link + passkey)
  demo-site/           "Crumb & Co. Bakery": a small Hono Node server with plain HTML forms
packages/
  core/
    src/types/         Zod schemas + inferred types (signals, state, answers, actions, policy)
    src/state/         buildState(), bucketing, truncation, token-size estimator
    src/policy/        rule engine, default policies, applyMode(), reasons
    src/decision/      DecisionProvider, JevProvider, MockProvider, RulesOnlyProvider, withFallback()
    src/token/         HMAC sign/verify for signal and challenge tokens (Web Crypto)
    src/pow/           hashcash challenge issue/verify
    src/challenge/     ladder definitions, EmailSender / IdVerifier interfaces
  questions/           v1.ts (versioned question set) + registry + Zod validation of question sets
  db/                  Drizzle schema, migrations, EventStore implementations (Postgres, in-memory)
  sdk-browser/         collectors, PoW worker, token fetch, consent flag; esbuild → IIFE + ESM
  sdk-server/          assess(), verifyToken(), feedback(); fetch-based, fails open
  edge/                network signals, agent detection (Web Bot Auth), enforcement modes;
                       adapters for Cloudflare Workers and Vercel/Next middleware
  config/              shared tsconfig (strict), eslint, vitest presets
tools/
  bot-sim/             Playwright + fetch attack scripts, corpus generator for audit demo
docs/                  architecture notes, vendor/ (Jev reference once available)
PLAN.md  PRIVACY.md  README.md
```

The brief doesn't list `packages/db` or `packages/config`. I've added them so the dashboard and the API can share one schema and one strict tsconfig.

**Tooling:** pnpm workspaces, Turborepo (`build`, `test`, `lint`, `typecheck`, `e2e`), TypeScript `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, Vitest, Playwright (using the pre-installed Chromium), and Changesets later.

---

## 3. Component design

### 3.1 Browser SDK (`packages/sdk-browser`)
- Budget: **under 15 KB gzip**, zero dependencies. A CI check (`size-limit`) fails the build if it goes over.
- Loads async and starts collecting on `DOMContentLoaded`. All listeners are `passive`, and nothing blocks the main thread.
- Collects aggregates only. Values are counters and running statistics kept in memory; no key values or field values are ever read.
  - time from page load to submit; dwell time per field (field *index/type*, not name/value)
  - keystroke inter-arrival mean and variance (Welford), correction count (Backspace/Delete counted by `key` category only)
  - paste count per field, focus and blur count, pointer path entropy (angle histogram → Shannon entropy), pointer event count
  - `navigator.webdriver`, headless hints (plugins length, `languages`, WebGL vendor "SwiftShader", `outerWidth === 0`, and so on), viewport vs screen consistency
- Optional proof-of-work: SHA-256 hashcash (`leading zero bits ≥ d`) solved in an inline Web Worker from a Blob URL. The server issues the challenge.
- Consent: `Proofline.init({ consent: false })` drops any signal the privacy doc classifies as personal (for example the timezone and language fingerprint). It sends only behavioural counters and automation flags.
- Token flow: on `submit`, call `POST /v1/signals` (publishable key) and get back a signed token (HMAC-SHA256, `exp` = 5 min, `jti` for one-time use, bound to `project_id` + `event_type` + origin). The SDK writes it to `<input type="hidden" name="proofline_token">`. If this takes longer than 300 ms or fails, the form submits without a token.

### 3.2 Edge middleware (`packages/edge`)
- `ip_hash = HMAC(daily_salt, ip)`, truncated to 16 bytes, with `daily_salt = HMAC(SALT_SECRET, yyyy-mm-dd)`. This allows correlation within a day but not across days. Raw IPs are never stored.
- `request.cf` provides ASN, country, and JA4 (only when Cloudflare exposes it). The Vercel adapter uses `x-vercel-ip-*` headers.
- Header checks: order fingerprint (hash of lowercased header names in order), UA vs `sec-ch-ua` consistency, missing `accept-language`.
- Rate: sliding-window counters per `ip_hash`, ASN, and fingerprint, stored in a Durable Object (in-memory in tests).
- Declared agents: verify **Web Bot Auth** (HTTP Message Signatures with `Signature-Agent`) against an allowlist of key directories, plus Cloudflare's `verifiedBot` flag when present. Verified agents go to `agent_lane` with separate rate limits. Unverifiable "agent" claims count as a negative signal.
- Modes: `shadow` (annotate only) and `enforce` (short-circuit `block` with 403, or redirect to a challenge).

### 3.3 State builder (`packages/core/state`)
- Pure function: `buildState({ browser?, edge?, server, event }) → State`.
- Buckets numbers (for example `time_to_submit: "<2s" | "2-5s" | "5-30s" | "30s-5m" | ">5m"`), drops defaults and nulls, and uses short keys.
- `event_text`: included only for `comment`/`form_submit`/`contact`, whitespace-normalised, truncated to 280 characters, with emails, URLs, and phone numbers replaced by tokens (`<email>`, `<url>`, `<phone>`).
- Size guard: a token estimator (`chars/4`, conservative) with a unit test asserting ≤ 600 tokens on worst-case inputs. If the state is too big, low-priority fields are dropped in a fixed order.

### 3.4 Decision providers (`packages/core/decision`)
```ts
interface DecisionProvider {
  readonly name: "jev" | "mock" | "rules";
  decide(state: State, questions: QuestionSet, opts: { signal: AbortSignal }): Promise<JevAnswers>;
}
```
- `JevProvider`: `fetch` + `AbortController` (400 ms). The request and response Zod schemas **must be taken from the TypeSafe docs (Q1)**. Its output is mapped into the internal `JevAnswers` type, so the rest of the system never sees wire field names. The API key comes from `env.TYPESAFE_API_KEY`, and a logger redaction list stops it (and any `authorization` header) from being logged.
- `MockProvider`: a deterministic function of the state. Seeded rules produce calibrated-looking probabilities, and fixtures cover each actor type.
- `RulesOnlyProvider`: heuristic answers built from deterministic signals, with low confidence by design so the policy prefers step-up over block.
- `withFallback(primary, fallback, timeoutMs)`: on timeout, error, or a Zod failure it returns `{ answers, decision_source: "fallback", fallback_reason }`.
- `content_is_templated` is only included when `state.event_text` is present.

### 3.5 Questions (`packages/questions`)
- `v1.ts` exports `{ version: "v1", questions: [...] }` with `key`, `type` (`noul | choice | score`), a plain-language `prompt`, `definitions` for each label, a `legend` for score, and an optional `when(state)` predicate. It's validated by a Zod schema at load time.
- Projects pin a question-set version, and every decision stores `questions_version`.

### 3.6 Policy engine (`packages/core/policy`)
- Input: `{ answers, checks: DeterministicChecks, policy: EventPolicy, lane }`.
- Evaluation order:
  1. **Hard checks** (rate limit exceeded, known-bad IP, PoW failed or replayed, token forged or expired): `block`. The model can't override these.
  2. **Agent lane**: a verified declared agent goes to `agent_lane`.
  3. **Threshold rules**, first match wins. They're data (JSON), stored per project and event type, for example:
     - `is_automated.p > 0.9 && conf ≥ 0.9` → `block`
     - `actor_type ∈ {spam_bot} && event ∈ {comment}` → `shadow_drop`
     - `is_automated.p < 0.2 && conf ≥ 0.8` → `allow`
     - `risk_level ≥ 2 && conf < 0.7` → step up one rung above the current baseline
  4. **Default**: step up to the lowest rung that resolves the uncertainty. Rung choice uses `risk_level` and whether a passkey or email is available for the account.
- Output: `{ action, rung?, risk: 0..3, reasons: Reason[] }`. Each reason is `{ code, message, weight, evidence }`. Messages are human-readable, for example "Submitted 1.2 s after page load (typical humans: > 5 s)", and the Jev probabilities are attached.
- `applyMode(decision, mode)`: in shadow mode, `effective_action = "allow"` and the original action is kept as `would_have`.

### 3.7 Step-up ladder
| Rung | id | Mechanism | Accessibility / fallback |
|---|---|---|---|
| 0 | `invisible` | allow | none needed |
| 1 | `pow` | harder hashcash, no UI (a progress `aria-live` region if it takes > 1 s) | fallback → `email_otp` |
| 2 | `passkey` | SimpleWebAuthn assertion (or registration for new accounts) | fallback → `email_otp` |
| 3 | `email_otp` | 6-digit code via `EmailSender` (Resend impl + console impl) | `autocomplete="one-time-code"`, resend with rate limit, fallback → `review` |
| 4 | `id_verify` | `IdVerifier` interface; `StubIdVerifier` returns `unavailable` | falls through → `review` |
| 5 | `review` | queued in the dashboard; user sees "we'll email you" | not applicable |

`/v1/challenge/start` returns `{ challenge_id, rung, payload }`. `/v1/challenge/complete` verifies the answer and returns a signed **pass token**, which the customer server checks with `sdk-server.verifyToken()`. Challenge UIs are plain HTML and ARIA with no visual puzzles, and they get an axe-core check in Playwright.

### 3.8 Data model (`packages/db`, Drizzle / Postgres)
- `organizations`, `users`, `sessions`, `passkeys` (dashboard auth, managed through the Better Auth Drizzle adapter)
- `projects` (mode, retention_days, questions_version, jev_timeout_ms), `api_keys` (prefix, `sha256(key)`, scope `publishable|secret`, revoked_at)
- `policies` (project_id, event_type, rules jsonb, version)
- **`decision_events`**: append-only and denormalised, with no foreign keys and no updates, so it can move to ClickHouse later
  - `id` (UUIDv7, time-sortable), `ts`, `project_id`, `event_type`, `action`, `effective_action`, `mode`, `rung`, `risk`
  - `decision_source` (`jev|mock|rules|fallback`), `questions_version`, `policy_version`
  - flattened answer columns (`p_automated`, `actor_type`, `actor_conf`, `risk_level`, `risk_conf`, `intent`, `p_templated`) plus `answers` jsonb
  - `reasons` jsonb, `state` jsonb (already compact and privacy-safe), `ip_hash`, `asn`, `country`, `ja4`, `ua_family`
  - `t_total_ms` and per-stage timing columns
  - indexes: `(project_id, ts)`, `(project_id, event_type, ts)`, `(project_id, action, ts)`
- `challenges` (mutable state machine), `feedback` (decision_id, label `false_positive|confirmed_bot`, note), `review_items`, `appeals`
- `usage_daily` (rollup built from `decision_events`)
- Retention: a scheduled job (Workers Cron) deletes `decision_events` older than `project.retention_days` (default 30) in batches. Rollups are kept.

### 3.9 API (`apps/api`)
| Route | Key scope | Notes |
|---|---|---|
| `POST /v1/signals` | publishable | origin allowlist, returns signal token; `text/plain` JSON body with `key`, so no CORS preflight |
| `POST /v1/pow` | publishable | PoW challenge when the project has `pow_bits` set |
| `POST /v1/assess` | secret | main pipeline |
| `POST /v1/challenge/start` / `complete` | publishable | browser-facing; bound to `decision_id` |
| `POST /v1/feedback` | secret | training labels |
| `GET /v1/health` | none | not applicable |

- Every body goes through Zod (`@hono/zod-validator`). Errors use a uniform `{ error: { code, message } }` shape.
- Rate limits are per key and per project (Durable Object). Keys are compared by hash, and logs mask everything except the key prefix.

### 3.10 Dashboard (`apps/dashboard`)
- Auth: **Better Auth** with the magic-link plugin (Resend) and passkey plugin (which uses SimpleWebAuthn internally), on the shared Drizzle schema.
- Pages: Onboarding wizard (project → keys → snippet → plugin choice → shadow mode on); **Bot Audit** (automated % per event type, top patterns by `actor_type × intent × ASN`, example sessions with reasons); **Thresholds** (sliders for each event type, with a live preview that replays the last N days of stored answers through the policy engine in a server action, since the engine is pure); **Events** explorer (filters, decision drawer with reasons); **Review queue** and **Appeals**; **Usage** (decision counts from `usage_daily`).
- Reads Postgres through `packages/db` from server components. There's no separate admin API in the MVP.

### 3.11 Demo site and bot-sim
- `apps/demo-site`: Crumb & Co. Bakery, with `/signup`, `/contact`, and `/checkout`. It includes the SDK script, and each POST handler calls `sdk-server.assess()` and follows the action (redirect to a challenge page, reject, or accept).
- `tools/bot-sim` profiles: `naive-curl` (no token), `headless` (Playwright with default fingerprint, instant fill), `humanlike` (randomised delays, mouse paths, text from a local template generator; an LLM-text mode is optional and needs an API key), `swarm` (N parallel, shared ASN), and `polite-agent` (Web Bot Auth signed, low rate).
- Runs against the full stack using `MockProvider` (deterministic in CI) and writes a JSON report plus seeded events for the Bot Audit demo.

---

## 4. Testing strategy
- **Unit (Vitest)**: policy engine (table-driven tests for every rule, hard-block precedence, fallback confidence), state builder (bucketing, truncation, PII redaction, ≤ 600 tokens), token sign/verify/expiry/replay, PoW, `withFallback` timeouts (fake timers), question-set validation, Jev response parsing (from the documented examples once Q1 is resolved).
- **Integration**: the API run in-process through `app.request()`, with PGlite and in-memory rate limiter and email.
- **E2E (Playwright)**: demo site plus the API (`wrangler dev` or Node adapter), bot-sim profiles, and challenge flows with an axe-core accessibility check.
- **Shadow mode guarantee**: a property-style test pushes the full bot-sim corpus plus fuzzed answers through the pipeline with `mode=shadow` and asserts `effective_action === "allow"` every time, plus an E2E test where every bot submission succeeds in shadow mode.
- **Fallback**: a Jev stub that hangs, returns 500, or returns malformed JSON leads to `decision_source: "fallback"` with a total time under 450 ms.

---

## 5. Milestones

### M1: Core ✅
- [x] pnpm + Turborepo monorepo, `packages/config` (strict tsconfig), ESLint (flat config), Prettier, Vitest
- [x] `packages/core/types`: Zod schemas for signals, state, answers, actions, policy
- [x] `packages/questions/v1.ts` + schema + registry
- [x] `DecisionProvider` + `MockProvider` + `RulesOnlyProvider` + `decideWithFallback` (400 ms, aborts the request)
- [x] `JevProvider` with the documented `TYPESAFE_WIRE` adapter (resolved Q1 in M2)
- [x] State builder with bucketing, truncation, PII redaction, 600-token guard
- [x] Policy engine, default per-event policies, `applyMode`, reasons
- [x] Token sign/verify (with key rotation and replay guard), PoW primitives, log redaction
- [x] `decide()` pipeline (hard block → skip model → policy → mode) with stage timings
- [x] 112 unit tests; `pnpm lint && pnpm turbo run typecheck test` green

**M1 notes**
- On `comment` and `form_submit`, spam rules run *before* the confident-automation block, so spam is shadow-dropped instead of the sender learning they were caught.
- The fallback never blocks on heuristics alone: `RulesOnlyProvider` caps confidence at 0.6, so the confidence-gated rules can't fire. Hard checks still block.
- The mock and rules-only providers share one feature extractor (`core/src/features.ts`). The policy engine uses the same features to write its reasons.

### M2: Signals ✅
- [x] `sdk-browser` collectors, PoW worker, consent, token fetch, size budget check (4.1 KB gzip; the build fails over 15 KB)
- [x] `packages/edge` network signals, hashing, header checks, agent detection (Web Bot Auth), rate counters, modes
- [x] `packages/db` schema + migrations + `Store` (Postgres / PGlite / memory, one contract test for all)
- [x] `apps/api`: `/v1/signals`, `/v1/pow`, `/v1/assess`, `/v1/feedback`, API keys + scopes, rate limit, stage timings; Workers entry (Hyperdrive + Durable Object) and Node entry
- [x] `sdk-server`: `assess()`, `feedback()`, fail-open
- [x] `apps/demo-site` wired up in **shadow mode**, plus the shadow-never-blocks tests (bot corpus in Vitest, real Chromium in Playwright)
- [x] 192 unit and integration tests plus 3 Playwright E2E tests; `pnpm lint && pnpm turbo run typecheck test` green, `pnpm e2e` green

**M2 notes**
- **Signal token contents.** The token carries the browser and edge signals, so `/v1/assess` needs no lookup. It's signed, not encrypted, so the end user can read it. It contains aggregates, the daily IP hash, ASN and header fingerprint, but never a raw IP.
- **`/v1/assess` accepts optional `client: { ip, user_agent, accept_language }`.** When there's no valid token (for example curl posting straight to the form), network signals come from these. The IP is hashed immediately. `sdk-server` has `clientFromHeaders()`, which trusts forwarding headers only with `trustProxy`.
- **Tokens are one-time.** A second `/v1/assess` with the same token is a hard block (`replayed`). `sdk-server` never retries `assess()`, for this reason.
- **Header order.** The Fetch `Headers` object sorts header names (Workers, undici), so the fingerprint uses header order only when an adapter supplies raw names (the Node entry does). `unusual_header_order` is not emitted yet.
- **ASN classes** come from a short list of known networks plus AS-organisation keywords. Anything else is `unknown`; we never assume `residential`.
- **Verified agents** (Web Bot Auth against the `TRUSTED_AGENTS` allowlist, or Cloudflare `verifiedBot`) get separate rate-limit counters. Agent-looking user agents and failed signatures count as `unverified_claim`.
- **Enforce mode and spam.** `shadow_drop` looks like success to the sender, but the demo site discards the submission. The enforce-mode corpus test checks this.
- The Worker bundles with `wrangler deploy --dry-run` (229 KB gzip). It hasn't been deployed: that needs a Cloudflare account, a Hyperdrive id and secrets.

### M3: Step-up
- [ ] `/v1/challenge/start|complete`, challenges state machine, pass tokens, `verifyToken()`
- [ ] PoW rung, passkey rung (SimpleWebAuthn), email OTP rung (`EmailSender`: Resend + console), `IdVerifier` stub, review rung
- [ ] Accessible challenge UI in the demo site plus axe checks
- [ ] Enforce mode end to end

### M4: Dashboard
- [ ] Next.js + Tailwind + shadcn/ui, Better Auth magic link + passkey
- [ ] Onboarding, Bot Audit report, Event explorer + decision drawer
- [ ] Threshold sliders with live replay preview
- [ ] Review queue, appeals inbox, usage page

### M5: Hardening
- [ ] Full bot-sim suite + Playwright E2E in CI
- [ ] Latency profiling (per-stage p50/p95 report), fallback tests under load
- [ ] Retention job, PRIVACY.md, README 5-minute quickstart, `.env.example`
- [ ] Security pass (log redaction tests, token replay, key scopes)

After each milestone I'll run `pnpm turbo test typecheck lint`, tick the boxes here, and post a summary.

---

## 6. Environment notes
- Required env (all in `.env.example`, never committed): `TYPESAFE_API_KEY` (optional; without it the API uses `MockProvider`), `TOKEN_SIGNING_SECRET`, `IP_SALT_SECRET`, `DATABASE_URL`, `RESEND_API_KEY` (optional; uses the console sender otherwise), `BETTER_AUTH_SECRET`.
- `DECISION_PROVIDER=jev|mock|rules` overrides the provider choice for local dev.
