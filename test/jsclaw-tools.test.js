import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidCron, executeJsclawTool } from '../src/jsclaw-tools.js';

function makeIpc() {
  const dir = mkdtempSync(join(tmpdir(), 'micro-ipc-'));
  process.env.JSCLAW_IPC_BASE = dir;
  process.env.JSCLAW_CHAT_JID = 'chat-1';
  process.env.JSCLAW_GROUP_FOLDER = 'main';
  process.env.JSCLAW_IS_MAIN = 'false';
  return dir;
}

function readIpcFiles(dir, sub) {
  const files = readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json'));
  return files.map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf-8')));
}

test('isValidCron accepts standard expressions', () => {
  assert.ok(isValidCron('* * * * *'));
  assert.ok(isValidCron('0 9 * * 1-5'));
  assert.ok(isValidCron('*/15 0,12 1-7 * *'));
  assert.ok(!isValidCron('* * * *'));
  assert.ok(!isValidCron('not a cron'));
  assert.ok(!isValidCron('60 24 * * groucho'));
  assert.ok(!isValidCron(''));
});

test('send_message writes an IPC message file', () => {
  const dir = makeIpc();
  const result = executeJsclawTool('send_message', { text: 'hello there' });
  assert.match(result, /Message sent/);

  const [msg] = readIpcFiles(dir, 'messages');
  assert.equal(msg.text, 'hello there');
  assert.equal(msg.targetJid, 'chat-1');
  assert.equal(msg.sourceGroup, 'main');
});

test('cross-group send is rejected for non-main groups', () => {
  makeIpc();
  const result = executeJsclawTool('send_message', { text: 'x', target_jid: 'other-chat' });
  assert.match(result, /^Error: Only the main group/);
});

test('schedule_task validates cron and writes an IPC task file', () => {
  const dir = makeIpc();
  const bad = executeJsclawTool('schedule_task', {
    prompt: 'p',
    schedule_type: 'cron',
    schedule_value: 'nonsense',
  });
  assert.match(bad, /^Error: Invalid cron/);

  const ok = executeJsclawTool('schedule_task', {
    prompt: 'daily summary',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
  });
  assert.match(ok, /Task scheduled: cron/);

  const [task] = readIpcFiles(dir, 'tasks');
  assert.equal(task.type, 'schedule_task');
  assert.equal(task.data.prompt, 'daily summary');
  assert.equal(task.data.context_mode, 'fresh');
});

test('pause/resume/cancel write typed IPC task files', () => {
  const dir = makeIpc();
  executeJsclawTool('pause_task', { task_id: 't-1' });
  executeJsclawTool('resume_task', { task_id: 't-1' });
  executeJsclawTool('cancel_task', { task_id: 't-1' });

  const types = readIpcFiles(dir, 'tasks').map((t) => t.type).sort();
  assert.deepEqual(types, ['cancel_task', 'pause_task', 'resume_task']);
});

test('list_tasks reads current_tasks.json from the workspace', () => {
  makeIpc();
  const ws = mkdtempSync(join(tmpdir(), 'micro-ws-'));
  process.env.JSCLAW_WORKSPACE = ws;

  assert.equal(executeJsclawTool('list_tasks', {}), 'No scheduled tasks.');

  writeFileSync(join(ws, 'current_tasks.json'), JSON.stringify([
    { id: 't-1', status: 'active', schedule_type: 'cron', schedule_value: '0 9 * * *', prompt: 'daily summary' },
  ]));
  const result = executeJsclawTool('list_tasks', {});
  assert.match(result, /\[t-1\] active \| cron:0 9 \* \* \* \| daily summary/);
});
