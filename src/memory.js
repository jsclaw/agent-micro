/**
 * Two-layer memory (jsclaw#79 1b), openclaw's model:
 *   MEMORY.md        — curated facts, loaded in full every run
 *   memory/<name>.md — detailed/dated notes, surfaced as an index and
 *                      read on demand (like the skills index)
 *
 * Keeps the prompt small without losing recall: the agent always sees
 * the curated layer plus a list of what else exists, and pulls bodies
 * with its file tools when relevant.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** First non-empty line of a file, heading markers stripped, for the index. */
function firstLine(path) {
  try {
    const line = readFileSync(path, 'utf-8')
      .split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
    return line ? line.slice(0, 60) : '';
  } catch {
    return '';
  }
}

/**
 * Build the memory section of the system prompt.
 * @param {string} root - The agent workspace directory
 * @returns {string} Memory section, or '' when there is none
 */
export function loadMemory(root) {
  const parts = [];

  // Layer 1 — curated MEMORY.md, in full
  try {
    const curated = readFileSync(join(root, 'MEMORY.md'), 'utf-8').trim();
    if (curated) parts.push(`Curated facts you always know (MEMORY.md):\n\n${curated}`);
  } catch { /* no MEMORY.md */ }

  // Layer 2 — memory/<name>.md as an on-demand index (newest dated first)
  let names = [];
  try {
    names = readdirSync(join(root, 'memory')).filter((n) => n.endsWith('.md')).sort().reverse();
  } catch { /* no memory/ */ }
  if (names.length) {
    const index = names.map((n) => {
      const hint = firstLine(join(root, 'memory', n));
      return `- memory/${n}${hint ? ` — ${hint}` : ''}`;
    });
    parts.push(`Detailed notes — read with your file tools when relevant:\n${index.join('\n')}`);
  }

  return parts.length ? `# Memory\n\n${parts.join('\n\n')}` : '';
}
