import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop, trimContext } from '../src/loop.js';

/**
 * Stub global fetch with a scripted sequence of API responses.
 * Returns the list of request bodies for assertions.
 */
function stubFetch(responses) {
  const requests = [];
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    requests.push(JSON.parse(opts.body));
    const body = responses[Math.min(call++, responses.length - 1)];
    return {
      ok: true,
      json: async () => body,
    };
  };
  return requests;
}

test('agent loop executes a tool call and returns the final text', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const dir = mkdtempSync(join(tmpdir(), 'micro-loop-'));
  process.env.JSCLAW_WORKSPACE = dir;
  process.env.ANTHROPIC_API_KEY = 'test-key';

  const requests = stubFetch([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Writing the file now.' },
        { type: 'tool_use', id: 'tu_1', name: 'write_file', input: { path: 'out.txt', content: 'done' } },
      ],
      usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 },
    },
    {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'File written.' }],
      usage: { input_tokens: 200, output_tokens: 10 },
    },
  ]);

  const { result, messages, usage } = await runAgentLoop({
    prompt: 'write a file',
    system: 'test system',
    model: 'claude-test',
  });

  assert.equal(result, 'File written.');
  // Usage accumulates across iterations; cache reads count as input
  assert.deepEqual(usage, { input_tokens: 350, output_tokens: 30 });
  assert.equal(readFileSync(join(dir, 'out.txt'), 'utf-8'), 'done');

  // Two API calls: initial, then with the tool result appended
  assert.equal(requests.length, 2);
  const toolResult = requests[1].messages.at(-1);
  assert.equal(toolResult.role, 'user');
  assert.equal(toolResult.content[0].type, 'tool_result');
  assert.equal(toolResult.content[0].tool_use_id, 'tu_1');
  assert.match(toolResult.content[0].content, /Wrote 4 bytes/);

  // Conversation shape: user, assistant, user(tool_result), assistant
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
});

test('agent loop respects the iteration cap', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.JSCLAW_WORKSPACE = mkdtempSync(join(tmpdir(), 'micro-cap-'));

  stubFetch([
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_x', name: 'bash', input: { command: 'true' } }],
    },
  ]);

  const { result } = await runAgentLoop({ prompt: 'loop forever', maxIterations: 3 });
  assert.match(result, /iteration limit/);
});

test('trimContext blanks old large tool results but keeps recent ones', () => {
  const big = 'x'.repeat(5000);
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: big }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: '2', name: 'bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '2', content: big }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ];

  trimContext(messages, 8000);

  assert.match(messages[2].content[0].content, /trimmed/);
  // The last two exchanges are never trimmed
  assert.equal(messages[4].content[0].content, big);
});
