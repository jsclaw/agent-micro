/**
 * Two-layer memory (jsclaw#79 1b): MEMORY.md loaded in full, memory/*.md
 * surfaced as an on-demand index.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMemory } from '../src/memory.js';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'mem-'));
  mkdirSync(join(root, 'memory'), { recursive: true });
  return root;
}

test('empty workspace yields no memory section', () => {
  assert.equal(loadMemory(workspace()), '');
});

test('MEMORY.md is loaded in full; memory/ files are indexed, not dumped', () => {
  const root = workspace();
  writeFileSync(join(root, 'MEMORY.md'), '# Index\nOwner is Melvin. Prefers terse answers.');
  writeFileSync(join(root, 'memory', 'owner.md'), '# Owner\nSECRET-BODY-DETAIL that should NOT be in the prompt.');
  writeFileSync(join(root, 'memory', '2026-06-12.md'), '# Daily\nShipped 1b today.');

  const out = loadMemory(root);
  // curated layer: full content present
  assert.match(out, /Owner is Melvin\. Prefers terse answers\./);
  // index layer: filenames + hints present, bodies absent
  assert.match(out, /- memory\/owner\.md — Owner/);
  assert.match(out, /- memory\/2026-06-12\.md — Daily/);
  assert.ok(!out.includes('SECRET-BODY-DETAIL'), 'note bodies stay out of the prompt');
});

test('MEMORY.md alone, or memory/ alone, both work', () => {
  const a = workspace();
  writeFileSync(join(a, 'MEMORY.md'), 'just curated');
  assert.match(loadMemory(a), /just curated/);

  const b = workspace();
  writeFileSync(join(b, 'memory', 'note.md'), '# Note\nbody');
  const out = loadMemory(b);
  assert.match(out, /- memory\/note\.md — Note/);
  assert.ok(!out.includes('Curated facts'), 'no curated header without MEMORY.md');
});
