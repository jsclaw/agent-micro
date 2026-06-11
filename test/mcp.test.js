/**
 * MCP client tests — scripted fetch exchanges, no network: discovery,
 * openclaw tool naming, result/error mapping, SSE and unreachable
 * degradation, and loop integration via externalTools.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectMcpServers } from '../src/mcp.js';
import { runAgentLoop } from '../src/loop.js';

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body, headers: opts.headers });
    return handler(body, calls.length);
  };
  return calls;
}

const json = (obj, status = 200) => ({
  ok: status < 400,
  status,
  headers: new Map([['content-type', 'application/json']]),
  json: async () => obj,
});

function happyServer(body) {
  if (body.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'jss-mcp' }, capabilities: {} } });
  if (body.method === 'notifications/initialized') return { ok: true, status: 202, headers: new Map(), json: async () => ({}) };
  if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: [
    { name: 'read_resource', description: 'Read a pod resource', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ] } });
  if (body.method === 'tools/call') {
    if (body.params.arguments.path === '/missing') {
      return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'not found' }], isError: true } });
    }
    return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `contents of ${body.params.arguments.path}` }], isError: false } });
  }
  return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'unknown' } });
}

test('discovers tools with openclaw naming and maps results', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubFetch(happyServer);

  const { tools, executors } = await connectMcpServers({
    pod: { url: 'http://jss.example/mcp', headers: { authorization: 'Bearer xyz' } },
  });

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'mcp__pod__read_resource');
  assert.equal(tools[0].input_schema.required[0], 'path');
  assert.equal(calls[0].headers.authorization, 'Bearer xyz', 'auth headers ride every request');

  const ok = await executors.get('mcp__pod__read_resource')({ path: '/notes.md' });
  assert.equal(ok, 'contents of /notes.md');
  const err = await executors.get('mcp__pod__read_resource')({ path: '/missing' });
  assert.match(err, /^Error from pod: not found/);
});

test('unreachable, SSE-only, and url-less servers degrade to warnings', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const warnings = [];

  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/event-stream']]), json: async () => ({}) });
  const sse = await connectMcpServers({ s: { url: 'http://x/mcp' } }, (m) => warnings.push(m));
  assert.equal(sse.tools.length, 0);

  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const down = await connectMcpServers({ d: { url: 'http://down/mcp' } }, (m) => warnings.push(m));
  assert.equal(down.tools.length, 0);

  const stdio = await connectMcpServers({ local: { command: 'some-server' } }, (m) => warnings.push(m));
  assert.equal(stdio.tools.length, 0);

  assert.equal(warnings.length, 3);
  assert.match(warnings[2], /stdio transport not yet supported/);
});

test('the agent loop executes MCP tools via externalTools', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  process.env.ANTHROPIC_API_KEY = 'test-key';

  // Stub the LLM: first turn calls the MCP tool, second turn answers
  let llmCall = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/v1/messages')) {
      llmCall++;
      if (llmCall === 1) {
        return json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__pod__read_resource', input: { path: '/notes.md' } }] });
      }
      const lastMsg = JSON.parse(opts.body).messages.at(-1);
      return json({ stop_reason: 'end_turn', content: [{ type: 'text', text: `tool said: ${lastMsg.content[0].content}` }] });
    }
    return happyServer(JSON.parse(opts.body));
  };

  const { tools, executors } = await connectMcpServers({ pod: { url: 'http://jss.example/mcp' } });
  const { result } = await runAgentLoop({
    prompt: 'read my notes',
    model: 'claude-test',
    tools,
    externalTools: executors,
  });
  assert.equal(result, 'tool said: contents of /notes.md');
});
