// Offline fixture tests for the stream state machine (no live keys needed).
// Covers CACHING-COST-TRANSPARENCY.md F2/F3/F5 fixes:
//   - cache_write_tokens → cache_creation_input_tokens mapping
//   - usage chunk in the same read batch as the finish chunk (no dropped lines)
//   - OpenRouter usage chunk must not have its finish_reason overwritten
// Run: npx tsx tests/unit/streamUsage.test.ts

import assert from 'node:assert/strict';
import { AnthropicTransformer } from '../../src/core/transformers/anthropic';
import { OpenRouterTransformer } from '../../src/core/transformers/openrouter';
import { mapOpenAIUsage } from '../../src/core/utils/openaiToAnthropic';

// Build an SSE stream where each batch is delivered as ONE read() result,
// so multiple data lines can land in the same batch (the F3 trigger).
function sseStream(batches: string[][]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= batches.length) return controller.close();
      controller.enqueue(enc.encode(batches[i++].map((l) => l + '\n').join('')));
    },
  });
}

function sseResponse(batches: string[][]): Response {
  return new Response(sseStream(batches), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function collectEvents(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  const events: Array<{ event: string; data: any }> = [];
  for (const block of text.split('\n\n')) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
  }
  return events;
}

function messageDelta(events: Array<{ event: string; data: any }>): any {
  const deltas = events.filter((e) => e.event === 'message_delta');
  assert.equal(deltas.length, 1, `expected exactly one message_delta, got ${deltas.length}`);
  return deltas[0].data;
}

const usageWithCache = {
  prompt_tokens: 4517,
  completion_tokens: 5,
  total_tokens: 4522,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4508 },
};

const tests: Array<[string, () => Promise<void>]> = [
  ['mapOpenAIUsage: prompt_tokens includes cached + written', async () => {
    const u = mapOpenAIUsage({
      prompt_tokens: 100, completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
    });
    assert.deepEqual(u, { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 60, cache_creation_input_tokens: 30 });
    assert.deepEqual(mapOpenAIUsage(undefined), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  }],

  // F3: OpenAI spec shape — finish chunk, then usage chunk with choices: [],
  // BOTH in the same read batch. Pre-fix, the `break` dropped the usage line.
  ['F3: usage chunk in same read batch as finish chunk survives', async () => {
    const t = new AnthropicTransformer();
    const res = await t.transformResponseIn(sseResponse([
      ['data: {"id":"x","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}'],
      [
        'data: {"id":"x","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
        'data: {"id":"x","model":"gpt-test","choices":[],"usage":{"prompt_tokens":1500,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":1024,"cache_write_tokens":0}}}',
        'data: [DONE]',
      ],
    ]));
    const md = messageDelta(await collectEvents(res));
    assert.equal(md.delta.stop_reason, 'max_tokens');
    assert.deepEqual(md.usage, { input_tokens: 476, output_tokens: 5, cache_read_input_tokens: 1024, cache_creation_input_tokens: 0 });
  }],

  ['F3: usage chunk in a later read batch also works', async () => {
    const t = new AnthropicTransformer();
    const res = await t.transformResponseIn(sseResponse([
      ['data: {"id":"x","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}'],
      ['data: {"id":"x","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'],
      ['data: {"id":"x","model":"gpt-test","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":3}}', 'data: [DONE]'],
    ]));
    const md = messageDelta(await collectEvents(res));
    assert.equal(md.delta.stop_reason, 'end_turn');
    assert.equal(md.usage.input_tokens, 20);
    assert.equal(md.usage.output_tokens, 3);
  }],

  // F5 + F2: OpenRouter shape — usage chunk repeats finish_reason "length"
  // and carries cache_write_tokens. Full pipeline: OpenRouterTransformer →
  // AnthropicTransformer.
  ['F5+F2: OpenRouter truncation + cache write reach Claude Code intact', async () => {
    const or = new OpenRouterTransformer();
    const at = new AnthropicTransformer();
    const upstream = sseResponse([
      [': OPENROUTER PROCESSING'],
      ['data: {"id":"gen-1","model":"anthropic/claude-haiku-4.5","choices":[{"index":0,"delta":{"role":"assistant","content":"Once"}}]}'],
      ['data: {"id":"gen-1","model":"anthropic/claude-haiku-4.5","choices":[{"index":0,"delta":{"content":""},"finish_reason":"length","native_finish_reason":"max_tokens"}]}'],
      [`data: {"id":"gen-1","model":"anthropic/claude-haiku-4.5","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"length","native_finish_reason":"max_tokens"}],"usage":${JSON.stringify(usageWithCache)}}`, 'data: [DONE]'],
    ]);
    const res = await at.transformResponseIn(await or.transformResponseOut(upstream));
    const md = messageDelta(await collectEvents(res));
    assert.equal(md.delta.stop_reason, 'max_tokens', 'finish_reason must not be clobbered to stop');
    assert.deepEqual(md.usage, { input_tokens: 9, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 4508 });
  }],

  ['F5: usage chunk without finish_reason still gets one filled in', async () => {
    const or = new OpenRouterTransformer();
    const at = new AnthropicTransformer();
    const upstream = sseResponse([
      ['data: {"id":"gen-2","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}'],
      ['data: {"id":"gen-2","model":"m","choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}', 'data: [DONE]'],
    ]);
    const res = await at.transformResponseIn(await or.transformResponseOut(upstream));
    const md = messageDelta(await collectEvents(res));
    assert.equal(md.delta.stop_reason, 'end_turn');
    assert.equal(md.usage.input_tokens, 10);
  }],

  ['F5: usage chunk with empty choices does not crash OpenRouter transformer', async () => {
    const or = new OpenRouterTransformer();
    const at = new AnthropicTransformer();
    const upstream = sseResponse([
      ['data: {"id":"gen-3","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":"stop"}]}'],
      ['data: {"id":"gen-3","model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}', 'data: [DONE]'],
    ]);
    const res = await at.transformResponseIn(await or.transformResponseOut(upstream));
    const md = messageDelta(await collectEvents(res));
    assert.equal(md.delta.stop_reason, 'end_turn');
    assert.equal(md.usage.output_tokens, 2);
  }],

  ['F2: JSON (non-streaming) path maps cache_write_tokens', async () => {
    const t = new AnthropicTransformer();
    const res = await t.transformResponseIn(new Response(JSON.stringify({
      id: 'gen-4', model: 'anthropic/claude-haiku-4.5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: usageWithCache,
    }), { headers: { 'Content-Type': 'application/json' } }));
    const body: any = await res.json();
    assert.equal(body.stop_reason, 'end_turn');
    assert.deepEqual(body.usage, { input_tokens: 9, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 4508 });
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}
console.log(failed ? `\n${failed}/${tests.length} FAILED` : `\nAll ${tests.length} passed`);
process.exit(failed ? 1 : 0);
