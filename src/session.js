/**
 * Session persistence: a session is the raw messages array stored as JSON
 * under the group workspace, so containers can resume conversations the
 * same way the Claude Code runner does with its session IDs.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceDir } from './tools.js';

function sessionsDir() {
  return join(workspaceDir(), '.jsclaw-micro', 'sessions');
}

/**
 * Load a session's messages. Returns [] for unknown/corrupt sessions
 * rather than failing the run.
 * @param {string} sessionId
 * @returns {Array}
 */
export function loadSession(sessionId) {
  if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return [];
  try {
    const messages = JSON.parse(readFileSync(join(sessionsDir(), `${sessionId}.json`), 'utf-8'));
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

/**
 * Save a session's messages. Returns the session ID (newly minted when
 * none was given).
 * @param {string|undefined} sessionId
 * @param {Array} messages
 * @returns {string}
 */
export function saveSession(sessionId, messages) {
  const id = sessionId && /^[a-zA-Z0-9-]+$/.test(sessionId) ? sessionId : randomUUID();
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(join(sessionsDir(), `${id}.json`), JSON.stringify(messages));
  return id;
}
