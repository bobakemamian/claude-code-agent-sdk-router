# Prompt Caching & Cost Transparency — Findings and Issues

**Status:** verified by live probes — see §7 addendum (2026-09-09)
**Baseline:** commit `47e06284` (what ally prod pods run via `Dockerfile` `CCASR_REF`)
**Date:** 2026-09-09
**Consumer context:** ally cloud path is `Claude CLI → auth-sidecar → ccasr → OpenRouter`.
The sidecar meters the Anthropic-shaped stream ccasr emits (`message_start` /
`message_delta` usage) and prices tokens × catalog. Desktop path is
`Claude CLI → ccasr → OpenRouter`, priced by the same Anthropic-shape usage.

---

## 0. TL;DR

| # | Finding | Impact | Effort |
|---|---------|--------|--------|
| F1 | `usage: {include: true}` is **deprecated** on OpenRouter — usage is always returned | Handoff "Fix 1" is not the root cause of `cached_tokens = 0` | — |
| F2 | `cache_write_tokens` never mapped to `cache_creation_input_tokens` | Cache writes (1.25× on Claude) invisible → cost under-reported | S |
| F3 | Stream loop `break`s on `finish_reason`, drops trailing usage chunk in same read | Zero usage on direct OpenAI-compatible providers | S |
| F4 | No `stream_options.include_usage` on direct OpenAI/Groq/Ollama | Direct OpenAI streaming has **no usage at all** | S |
| F5 | OpenRouter usage chunk clobbers `finish_reason` → `length` becomes `stop` | Truncation reported as `end_turn` | S |
| F6 | No root-level `cache_control` for Claude-via-OpenRouter | Missed automatic caching mode | S |
| F7 | `cache_control` stripped for Gemini-via-OpenRouter | Explicit Gemini caching lost | S |
| F8 | tool_result breakpoint emitted at message level on string content | Likely ignored by OpenRouter; last-message breakpoint is usually a tool_result | M |
| F9 | `metadata.user_id` dropped → no `user` / `prompt_cache_key` | OpenAI-family cache routing unstable | S |
| F10 | Synthetic message id instead of OpenRouter `gen-…` id | No reconciliation handle | S |
| F11 | `cost` / `is_byok` / `cost_details` / `reasoning_tokens` / `provider` dropped | No audit trail | S |
| F12 | No offline unit tests for the stream state machine | Every fix above is unverifiable without live keys | M |

Handoff asks: Fix 1 keep as harmless belt-and-braces; Fix 2 audit-only (sidecar
distrusts ccasr-reported cost by design); Fix 3 (assistant `cache_control`) is a
near no-op — Claude Code places breakpoints on system + last user message, not
assistant.

> **Update 2026-09-09 (live probes, §7):** F1/F2/F5/F10/F11 confirmed;
> **F8 refuted** (message-level `cache_control` on `tool` messages works);
> **F6 not recommended** (writes every turn at 1.25×, no benefit over the
> already-working explicit breakpoints); F9 deprioritized (OpenAI auto-caching
> hits without `user`). Open question resolved: **`prompt_tokens` includes
> `cache_write_tokens`** — so F2 is a live 25% under-billing on write turns,
> not just a visibility gap. Revised priority: F2 → F5 → F4+F3 → F12.

---

## 1. Research: OpenRouter capabilities as of 2026-09

`openrouter.ai` was egress-blocked from the research sandbox. Claims below come
from two independent search-engine renderings of the docs pages plus GitHub
issues and ally's sidecar fixtures (`services/auth-sidecar/tests/fixtures/openai/`).
**Verify with a `LOG=true` capture before relying on any of them.**

### 1.1 Usage accounting

- `usage: {include: true}` and `stream_options: {include_usage: true}` are
  **deprecated, no effect**. Full usage is always included: last SSE chunk when
  streaming, response body otherwise.
- Usage object fields:
  - `prompt_tokens`, `completion_tokens`, `total_tokens`
  - `prompt_tokens_details: { cached_tokens, cache_write_tokens, audio_tokens }`
  - `completion_tokens_details: { reasoning_tokens, image_tokens }`
  - `cost` (credits charged; on BYOK = OpenRouter fee only)
  - `is_byok`
  - `cost_details: { upstream_inference_cost, upstream_inference_prompt_cost, upstream_inference_completions_cost }`
  - `cache_discount` (older field, still referenced in blog posts)
- `cache_write_tokens` only appears for models with explicit caching + write pricing.
- Open question: does `prompt_tokens` include `cache_write_tokens`? Anthropic
  native `input_tokens` excludes both read and write. Check on capture.

### 1.2 Streaming shape

- Final chunk carries `usage` and is sent just before `[DONE]`.
- **Deviation from OpenAI spec:** OpenRouter's usage chunk has **one choice**
  with a content-free `delta` that **repeats `finish_reason`** (and
  `native_finish_reason`). OpenAI sends `choices: []`. So `finish_reason`
  appears twice: last content chunk, then usage chunk.
- Stream starts with `: OPENROUTER PROCESSING` comment lines.
- Mid-stream error: `choices[0].error` with `finish_reason: "error"`.

### 1.3 Prompt caching

| Provider via OpenRouter | Mechanism | Notes |
|---|---|---|
| Anthropic | Explicit `cache_control` per block **or** automatic: top-level `"cache_control": {"type": "ephemeral"}` on the request body | Automatic mode supported on Anthropic, Vertex, Azure, Bedrock providers. `ttl: "1h"` supported. |
| Gemini | Implicit (automatic on 2.5+, min ~1028–2048 tokens) **plus** explicit `cache_control` breakpoints | Explicit breakpoints need to reach OpenRouter — we strip them today (F7). |
| OpenAI | Automatic prefix caching ≥1024 tokens; `prompt_cache_key` for shard affinity; block-level `cache_control` markers are interchangeable with OpenAI breakpoints | Reads 0.25×–0.5×. |
| DeepSeek, Grok, Groq, Moonshot | Automatic | `cached_tokens` reported. |

- **Sticky routing:** after a cached request OpenRouter routes subsequent
  requests to the same provider endpoint to maximise hits. Keyed on a stable
  identifier (`user`).
- OpenRouter also serves an **Anthropic-compatible `/api/v1/messages`**
  endpoint. Claude models could be passed through untouched (native
  `cache_control` on tools/system/messages, native `cache_creation_input_tokens`).
  Unproven for tools / thinking / `count_tokens`. Strategic option, not a fix.

---

## 2. Issues in ccasr (file:line against `47e06284`)

### F1 — Handoff Fix 1 premise is stale

`openrouter.ts:57` — adding `usage.include` / `stream_options` is harmless but
does not unlock anything (§1.1). If prod shows `cached_tokens = 0`, cause is
elsewhere: F2–F9, prompt-prefix churn, or provider routing.

**Action:** add it anyway (cheap, ally's sidecar does the same for path B),
but do not expect it to change the capture.

### F2 — `cache_write_tokens` not mapped (cost under-reporting)

`anthropic.ts:288-292` (stream, usage-only chunk), `:410-414` (stream, finish
chunk), `:491-495` (JSON). All three compute:

```ts
input_tokens: prompt_tokens - cached_tokens,
output_tokens: completion_tokens,
cache_read_input_tokens: cached_tokens,
```

Missing: `cache_creation_input_tokens: prompt_tokens_details.cache_write_tokens`.
Cache writes on Claude cost 1.25× (5m) / 2× (1h) input; today they are billed
as plain input or not at all (see open question §1.1).

Consumer side already handles it: ally sidecar reads flat
`cache_creation_input_tokens` (`usage_tee.py:168-177`, treated as 5m) and the
calculator prices `cache_write` from the OpenRouter catalog
(`calculator.py:458`). **No ally change needed.**

**Action:** one shared `mapOpenAIUsage(usage)` helper used at all three call
sites; emit `cache_creation_input_tokens`; subtract write tokens from
`input_tokens` iff capture shows `prompt_tokens` includes them.

### F3 — Stream loop `break`s on `finish_reason`

`anthropic.ts:403-421`: on `choice.finish_reason` the code builds
`stopReasonMessageDelta` from **that chunk's** usage (often absent → zeros) and
`break`s out of the `for (const line of lines)` loop. Any remaining lines in the
same `reader.read()` batch — including the trailing usage chunk — are dropped.
The outer `while` continues, so a usage chunk in a *later* read is still
picked up (`:287-298`). Result is timing-dependent.

Why it does not bite on OpenRouter today: `openrouter.ts` re-chunks the stream
per line (`processLine` → one `enqueue` per SSE line), so `lines` never holds
more than one data line. Direct OpenAI/Groq/Mistral/Ollama have **no**
`transformResponseOut` and receive raw network chunks → the bug is live there
once F4 enables usage chunks.

**Action:** remove the `break`; keep consuming until `[DONE]` / stream end.
`hasFinished` is declared but never set — either set it and use it to suppress
content after finish, or delete it.

### F4 — No `stream_options.include_usage` on direct OpenAI-compatible providers

`openai.ts:23-53`, `groq.ts:66-90`, `ollama.ts` — none set
`stream_options: {include_usage: true}`. OpenAI streaming returns **no usage
chunk** without it → direct OpenAI turns emit `message_delta.usage` all zeros.

- OpenAI: required.
- Groq: supports it (also returns `x_groq.usage`); harmless to send.
- Ollama: supported on `/v1/chat/completions` in recent versions.
- Mistral: **rejects unknown params with 422** — test before adding; Mistral
  already includes usage in the final chunk by default.

**Action:** set it in openai/groq/ollama `transformRequestIn` when
`request.stream`; leave mistral unless verified.

### F5 — OpenRouter usage chunk clobbers `finish_reason`

`openrouter.ts:150-152`:

```ts
if (data.usage) {
  data.choices[0].finish_reason = hasToolCall ? 'tool_calls' : 'stop';
}
```

OpenRouter's usage chunk repeats the real `finish_reason` (§1.2). Forcing
`stop` turns `length` into `end_turn` on the Anthropic side
(`anthropic.ts:409,417`) — the *last* finish_reason wins. Truncated responses
are reported as clean stops. Also throws (caught, line passed raw) if a
provider ever sends `choices: []`.

**Action:** only set when `finish_reason` is null/undefined; guard
`choices?.[0]`.

### F6 — No root-level `cache_control` for Claude via OpenRouter

`openrouter.ts:18-57` preserves per-block `cache_control` for `isClaude` but
never sets OpenRouter's automatic mode
`body.cache_control = { type: 'ephemeral' }`. Per-block breakpoints from
Claude Code should still work, but automatic mode is a one-line safety net and
covers cases where breakpoints were lost in translation (F8).

**Action:** set root-level `cache_control` when `isClaude`.

### F7 — `cache_control` stripped for Gemini via OpenRouter

`openrouter.ts:42-53` deletes `cache_control` for every non-Claude model.
OpenRouter now accepts explicit breakpoints for Gemini and treats block markers
as interchangeable across Anthropic/OpenAI/Gemini (§1.3). Stripping was a
defence against 400s from providers that reject unknown fields; OpenRouter
normalises upstream now.

**Action:** allowlist `claude | gemini | openai/*` (keep strip for the rest),
or drop the strip entirely and let OpenRouter normalise — verify with a
non-caching model first.

### F8 — tool_result breakpoint at message level on string content

`anthropic.ts:67-75`:

```ts
messages.push({
  role: 'tool',
  content: typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content),
  tool_call_id: tool.tool_use_id,
  cache_control: tool.cache_control,   // message-level, string content
});
```

OpenRouter documents `cache_control` **inside content parts**. In agent loops
the last user message — where Claude Code puts its moving breakpoint — is
almost always a `tool_result`, so this is likely the main reason the
conversation-tail breakpoint never lands. Message-level markers on `tool`
messages may be silently ignored.

**Action:** when `tool.cache_control` is set, emit
`content: [{ type: 'text', text, cache_control }]` (OpenAI allows array
content on `tool` role). Verify OpenRouter → Anthropic mapping via capture
(`cache_creation_input_tokens > 0` on turn N, `cached_tokens > 0` on N+1).

### F9 — `metadata.user_id` dropped, no `prompt_cache_key`

`anthropic.ts:126-134` builds `UnifiedChatRequest` without `metadata`. Claude
Code sends `metadata.user_id = "user_<hash>_account_<uuid>_session_<uuid>"`.
OpenAI automatic caching hits depend on landing on the same shard; `user` /
`prompt_cache_key` give that affinity. OpenRouter's sticky routing keys on the
same identifier.

**Action:** map `metadata.user_id` → `user`; derive `prompt_cache_key` from the
`session_` segment for OpenAI-family targets (openai direct + OpenRouter).

### F10 — Synthetic message id

`anthropic.ts:190` `generateMessageId()`. OpenRouter returns its generation id
in every chunk (`chunk.id = "gen-…"`), usable with `GET /generation?id=` for
cost reconciliation. Also `chunk.provider` (which upstream actually served).

**Action:** use `chunk.id` when present as `message_start.message.id`; fall
back to synthetic.

### F11 — Cost / BYOK / reasoning fields dropped

`usage.cost`, `is_byok`, `cost_details.upstream_inference_cost`,
`completion_tokens_details.reasoning_tokens`, `provider` never reach the
Anthropic-shape stream. Anthropic usage has no slot for them.

Consumer reality: ally's sidecar **deliberately distrusts** cost reported
through a ccasr context (`manager.py:315-325`, `usage_tee.py:134-146` — a
pod-local process could fake it) and prices tokens × catalog. So this is
**audit-only**, not billing. Desktop `_openrouter_fallback` likewise prices
from tokens.

**Action (low priority):** attach a non-standard sub-object on
`message_delta.usage`, e.g.

```json
"usage": {
  "input_tokens": 1200, "output_tokens": 80,
  "cache_read_input_tokens": 9000, "cache_creation_input_tokens": 0,
  "openrouter": { "cost": 0.0123, "is_byok": false,
                  "upstream_inference_cost": 0.011,
                  "reasoning_tokens": 0, "provider": "Anthropic",
                  "generation_id": "gen-…" }
}
```

Unknown keys are ignored by the Anthropic SDK accumulator and by the sidecar
parser. Contract change only if MyAlly wants to *read* it.

### F12 — No offline tests for the stream state machine

`tests/` runs against live providers only (`TESTING.md`). None of F2–F5 can be
regression-tested without keys. ally already has hand-written OpenRouter
fixtures (`services/auth-sidecar/tests/fixtures/openai/chat_stream_usage.txt`
etc.) in exactly the wire shape ccasr consumes.

**Action:** add `tests/unit/` with fixture-driven tests that feed SSE text
through `OpenRouterTransformer.transformResponseOut` →
`AnthropicTransformer.transformResponseIn` and assert the emitted
`message_delta.usage`, `stop_reason`, and block sequence. Cases: usage chunk
in same read as finish chunk; usage chunk in separate read; `choices: []`
usage chunk (OpenAI spec); `finish_reason: length`; `cache_write_tokens > 0`.

---

## 3. Non-OpenRouter providers — state of cost transparency

| Provider | Request-side caching | Usage → Anthropic mapping | Gap |
|---|---|---|---|
| anthropic (direct) | Passthrough, untouched | Passthrough | none |
| openrouter | See F6–F9 | `cached_tokens` only (F2) | F2, F5, F10, F11 |
| openai (direct) | Auto ≥1024 tokens; no `prompt_cache_key` (F9) | `cached_tokens` mapped | **F4** (no usage at all when streaming), F3 |
| gemini (direct) | Implicit caching automatic | `cachedContentTokenCount` → `cached_tokens` (`gemini.ts:266,300`) | none known |
| groq | Auto (provider-side) | via OpenAI shape | F4, F3 |
| mistral | none | usage in final chunk by default | F3 |
| ollama | n/a (local) | via OpenAI shape | F4 (verify version), F3 |

---

## 4. Verification protocol

1. `LOG=true`, route to an OpenRouter model. Send a ≥1024-token stable prefix
   twice, then a third turn with a tool_result as the last message.
2. `provider_in` capture, final chunk:
   - `usage.prompt_tokens_details.cached_tokens > 0` on turn 2 → caching fires
     upstream.
   - `cache_write_tokens > 0` on turn 1 (Claude) → explicit breakpoints landed.
   - `cost`, `is_byok`, `cost_details` present → §1.1 confirmed, F1 moot.
   - Compare `prompt_tokens` vs `cached_tokens + cache_write_tokens + expected
     fresh` → resolves the §1.1 open question.
3. `claude_out` capture, `message_delta.usage`: same numbers, plus
   `cache_creation_input_tokens` after F2.
4. Repeat with a direct OpenAI key → confirms F4 (no usage chunk before fix).
5. Force `max_tokens: 5` → `stop_reason` must be `max_tokens` (F5).

If `cached_tokens` is still 0 after F6–F9: prompt-prefix churn or provider
routing — separate investigation, but now observable.

---

## 5. Release into ally

After tagging ccasr: bump `Dockerfile` `ARG CCASR_REF=master` → new tag/SHA
(tracked as ROUT-20 / A12 in `DOCS/plans/openrouter-billing-and-models.md`;
still `master` today). `/opt/ccasr/COMMIT` reflects it. No ally code change
needed for F2–F10; F11 optional consumer wiring.

---

## 6. Sources

- OpenRouter docs: usage accounting (`/docs/cookbook/administration/usage-accounting`),
  prompt caching (`/docs/guides/best-practices/prompt-caching`),
  streaming (`/docs/api_reference/streaming`),
  blog "Prompt Caching: What Cached Tokens Cost / sticky routing".
- anomalyco/opencode #18440 — `cache_write_tokens` under-costing on OpenRouter.
- BerriAI/litellm #16021, #11626, #16112 — cost / usage chunk shape in streaming.
- ally: `DOCS/decisions/0012-openrouter-provider-dispatched-pricing.md`,
  `DOCS/plans/openrouter-billing-and-models.md` (D4, P0-B, A12, A19),
  `services/auth-sidecar/app/billing/usage_tee.py`, `manager.py`, `proxy.py`,
  `packages/ally-platform/ally_platform/billing/calculator.py`.

---

## 7. Verification addendum — live probes (2026-09-09)

Six probe sets run **directly against `openrouter.ai/api/v1/chat/completions`**
(no proxy in between), using the desktop OpenRouter key. Models:
`anthropic/claude-haiku-4.5` (served by **Amazon Bedrock**) and
`openai/gpt-5.1-codex-mini` (served by **Azure** — the prod route family).
Total cost ≈ $0.03. The §1 "verify before relying" caveat is now discharged
for everything below.

### 7.1 Probe results

| Probe | Setup | Result |
|---|---|---|
| A | stream, **no** usage flags, natural stop | Full usage object in final chunk anyway: `prompt_tokens`, `prompt_tokens_details.{cached_tokens, cache_write_tokens, audio_tokens, video_tokens}`, `completion_tokens_details.{reasoning_tokens, image_tokens, audio_tokens}`, `cost`, `is_byok`, `cost_details.{upstream_inference_cost, …prompt_cost, …completions_cost}`. Every chunk carries `id: "gen-…"` and `provider`. Usage chunk has **one choice** with content-free delta **repeating** `finish_reason` + `native_finish_reason` (not `choices: []`). `: OPENROUTER PROCESSING` comment lines observed. |
| B | stream, `max_tokens: 5` | Usage chunk repeats the real `finish_reason: "length"` / `native_finish_reason: "max_tokens"` — exactly the chunk `openrouter.ts:153` rewrites to `"stop"`. **F5 confirmed live.** |
| C | block-level `cache_control` on system (≈4.5k tok), 2 turns | Turn 1: `prompt_tokens: 4517`, `cache_write_tokens: 4508`, cost matches 1.25× write pricing. Turn 2: `cached_tokens: 4508`, cost ÷12. **Explicit caching works end-to-end via OpenRouter; `prompt_tokens` INCLUDES `cache_write_tokens`** (4517 = 4508 written + 9 fresh). |
| D | root-level `cache_control: {type:"ephemeral"}`, no block markers | Accepted (no 400). Wrote 4516 tokens **on both turns**, zero reads (probe replaced the tail; breakpoint sits at end of prompt). Automatic mode = pay 1.25× on the whole prompt every turn, only pays off in strictly append-only loops. |
| E | `role:"tool"` message, ≈5k tok content, breakpoint variants | **Message-level `cache_control` with string content — ccasr's current emission — works**: wrote 5095, repeat read 5095. Content-part form behaved identically. **F8 refuted.** |
| F | `openai/gpt-5.1-codex-mini`, ≈4k tok stable prefix, ± `user` | Automatic caching hit **without** `user`: turn 2 `cached_tokens: 3968` of 4071. Provider routing sticky (Azure all 4 calls). `user` made no observable difference. |

### 7.2 Verdicts per finding

| # | Verdict | Notes |
|---|---|---|
| F1 | **Confirmed** | Usage always returned streaming + non-streaming, no flags needed. Do not bother adding `usage.include`. |
| F2 | **Confirmed + sharpened** | `prompt_tokens` includes write tokens → current mapping bills cache writes as plain 1× input. Fix must be `input_tokens = prompt_tokens − cached_tokens − cache_write_tokens` AND emit `cache_creation_input_tokens`. |
| F3 | **Confirmed (code)** | `break` at `anthropic.ts:420` drops rest of the read batch; `hasFinished` is dead. Live on direct providers once F4 lands. |
| F4 | **Confirmed (code)** | No `stream_options.include_usage` in openai/groq/ollama/mistral transformers. Not live-probed (no direct OpenAI key on this machine). |
| F5 | **Confirmed live** | Probe B. Truncations reported as `end_turn` today. |
| F6 | **Works, but DROP** | Probe D: accepted, but writes every turn at 1.25× while explicit breakpoints already work (probes C, E). Net cost increase, no benefit. |
| F7 | Unverified | Gemini-via-OpenRouter not probed. Optional. |
| F8 | **REFUTED** | Probe E. Current message-level emission lands. No change needed. |
| F9 | **Deprioritized** | Probe F: OpenAI auto-caching hits without `user`; routing already sticky. Nice-to-have only. |
| F10 | **Confirmed** | `gen-…` id on every chunk. Low priority (audit). |
| F11 | **Confirmed** | `cost` / `is_byok` / `cost_details` / `provider` / `reasoning_tokens` all present. Low priority (audit). |
| F12 | Valid | Still no offline tests. |

### 7.3 Prod implication

Both caching paths work upstream out of the box: Claude-model explicit
breakpoints flow through ccasr correctly (C, E), and OpenAI-model automatic
caching hits with no request-side changes (F). If prod observes
`cached_tokens = 0`, the cause is prompt-prefix churn or consumer-side reading
of the mapped usage — not breakpoint emission and not OpenRouter.

### 7.4 Revised plan

1. **F2** — shared `mapOpenAIUsage()` helper at the three `anthropic.ts` call
   sites; the only actual billing error (writes under-billed 25%).
2. **F5** — only set `finish_reason` when null/undefined; guard `choices?.[0]`.
3. **F4 + F3** — `stream_options: {include_usage: true}` for openai/groq/ollama
   (skip mistral pending its 422 check); remove the `break`; delete `hasFinished`.
4. **F12** — offline fixture tests for the above.
5. F10/F11 audit fields — later, if MyAlly wants them. **F6, F8: no action.**
   F7, F9: optional.
