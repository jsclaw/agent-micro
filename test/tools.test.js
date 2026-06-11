import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRegex, executeCoreTool } from '../src/tools.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'micro-test-'));
  process.env.JSCLAW_WORKSPACE = dir;
  return dir;
}

test('globToRegex matches basic patterns', () => {
  assert.ok(globToRegex('*.js').test('index.js'));
  assert.ok(!globToRegex('*.js').test('src/index.js'));
  assert.ok(globToRegex('src/**/*.js').test('src/a/b/c.js'));
  assert.ok(globToRegex('src/**/*.js').test('src/c.js'));
  assert.ok(!globToRegex('src/**/*.js').test('test/c.js'));
  assert.ok(globToRegex('file.?s').test('file.js'));
  assert.ok(!globToRegex('file.?s').test('file.mjs'));
  assert.ok(globToRegex('a.b').test('a.b'));
  assert.ok(!globToRegex('a.b').test('aXb'));
});

test('edit_file replaces a unique string', async () => {
  const dir = makeWorkspace();
  writeFileSync(join(dir, 'f.txt'), 'hello world\ngoodbye world\n');
  const result = await executeCoreTool('edit_file', {
    path: 'f.txt',
    old_string: 'hello world',
    new_string: 'hi world',
  });
  assert.match(result, /Replaced 1/);
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf-8'), 'hi world\ngoodbye world\n');
});

test('edit_file rejects ambiguous matches without replace_all', async () => {
  const dir = makeWorkspace();
  writeFileSync(join(dir, 'f.txt'), 'aaa\naaa\n');
  const result = await executeCoreTool('edit_file', {
    path: 'f.txt',
    old_string: 'aaa',
    new_string: 'bbb',
  });
  assert.match(result, /^Error: old_string matches 2 times/);

  const all = await executeCoreTool('edit_file', {
    path: 'f.txt',
    old_string: 'aaa',
    new_string: 'bbb',
    replace_all: true,
  });
  assert.match(all, /Replaced 2/);
  assert.equal(readFileSync(join(dir, 'f.txt'), 'utf-8'), 'bbb\nbbb\n');
});

test('edit_file reports missing old_string', async () => {
  const dir = makeWorkspace();
  writeFileSync(join(dir, 'f.txt'), 'content\n');
  const result = await executeCoreTool('edit_file', {
    path: 'f.txt',
    old_string: 'absent',
    new_string: 'x',
  });
  assert.match(result, /^Error: old_string not found/);
});

test('write_file creates parent directories', async () => {
  const dir = makeWorkspace();
  await executeCoreTool('write_file', { path: 'a/b/c.txt', content: 'nested' });
  assert.equal(readFileSync(join(dir, 'a/b/c.txt'), 'utf-8'), 'nested');
});

test('read_file supports offset and limit', async () => {
  makeWorkspace();
  await executeCoreTool('write_file', { path: 'lines.txt', content: 'one\ntwo\nthree\nfour' });
  const result = await executeCoreTool('read_file', { path: 'lines.txt', offset: 2, limit: 2 });
  assert.equal(result, 'two\nthree');
});

test('glob and grep find files and content', async () => {
  const dir = makeWorkspace();
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/app.js'), 'const magicToken = 42;\n');
  writeFileSync(join(dir, 'readme.md'), '# readme\n');

  const globResult = await executeCoreTool('glob', { pattern: '**/*.js' });
  assert.equal(globResult, 'src/app.js');

  const grepResult = await executeCoreTool('grep', { pattern: 'magicToken' });
  assert.match(grepResult, /^src\/app\.js:1: const magicToken = 42;/);

  const noMatch = await executeCoreTool('grep', { pattern: 'absentXYZ' });
  assert.equal(noMatch, 'No matches');
});

test('bash runs commands in the workspace and reports exit codes', async () => {
  const dir = makeWorkspace();
  writeFileSync(join(dir, 'marker.txt'), 'x');
  const result = await executeCoreTool('bash', { command: 'ls && pwd' });
  assert.match(result, /marker\.txt/);
  assert.match(result, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const failed = await executeCoreTool('bash', { command: 'exit 3' });
  assert.match(failed, /exit code 3/);
});

test('tool errors are returned as strings, not thrown', async () => {
  makeWorkspace();
  const result = await executeCoreTool('read_file', { path: 'does-not-exist.txt' });
  assert.match(result, /^Error:/);
});
