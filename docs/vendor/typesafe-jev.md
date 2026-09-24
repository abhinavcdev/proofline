# TypeSafe Jev: the parts Proofline uses

Summarised from https://docs.typesafe.ai (API reference, Primitives, Confidence, Models, Jev 1.13 jaggedness), read 2026-09-24.
Implementation: `packages/core/src/decision/jev.ts` (`TYPESAFE_WIRE`).

## Endpoint

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json
```

Request: `{ model, state, questions }`

- `model`: `jev-latest` (alias, currently `jev-1.13.0`) or a pinned version id. Set with `JEV_MODEL`. Pin a version once thresholds are tuned, because the alias moves when a new release ships.
- `state`: string, object or array. We send the compact `State` object.
- `questions`: a map from our question key to a question. The key is not seen by the model.
  - noul: `{ type: "noul", instructions, criteria?: { true, false } }`
  - choice: `{ type: "choice", instructions, criteria: { <option>: description | null } }` (up to 255 options)
  - score: `{ type: "score", instructions, criteria: [level0, level1, …] }` (2 to 10 levels, ordered)

Response: `{ model, answers, usage: { input_tokens, output_tokens } }`

- noul: `{ type: "noul", noul: p }`. **No confidence.** We derive `|2p − 1|` and set `confidence_derived: true` (Q2).
- choice: `{ type: "choice", choice, probabilities: { <option>: p }, confidence }`
- score: `{ type: "score", score, legend: { "0": … }, probabilities: { "0": p, … }, confidence }`. `score` is the probability-weighted expectation. Internally, `value` is the most likely level (the argmax of `probabilities`).

Errors: 401 (bad key), 422 (validation), 429 (rate limit), 529 (overloaded). We don't retry because of the 400 ms budget. Any non-2xx response goes to the rules fallback.

## Limits (jev-1.13)

- 1,200 requests/min and 250k tokens/s per account; these are adjusted dynamically.
- 64k tokens per request. Our state is under 600 tokens.
- Priced per input token; output tokens are free.

## Design notes that affect Proofline

- Keep arithmetic in code, because Jev is weak at numbers and comparisons. The state builder already buckets every number into named ranges.
- Keep state small and relevant. Irrelevant detail lowers accuracy.
- Adversarial content in `state` can move answers. User text is limited to a redacted 280-character excerpt, and hard checks and confidence gates never depend on the model alone.
- Don't carry thresholds across question types (noul vs choice). The policy rules threshold each question separately.
