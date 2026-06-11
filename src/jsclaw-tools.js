/**
 * The six jsclaw IPC tools, in-process. Functionally equivalent to
 * jsclaw's container/mcp-server.js, minus the MCP transport: tool calls
 * become atomic JSON file writes that the host's IPC watcher picks up.
 *
 * Environment variables (set by host):
 *   JSCLAW_CHAT_JID     - Chat identifier for this group
 *   JSCLAW_GROUP_FOLDER - Group folder name
 *   JSCLAW_IS_MAIN      - 'true' if this is the admin group
 *   JSCLAW_IPC_BASE     - IPC base dir (default /workspace/ipc)
 */

import { writeFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceDir } from './tools.js';

function ipcBase() {
  return process.env.JSCLAW_IPC_BASE || '/workspace/ipc';
}

function isMain() {
  return process.env.JSCLAW_IS_MAIN === 'true';
}

/**
 * Atomically write a JSON file to an IPC directory (same write-then-rename
 * scheme as jsclaw's mcp-server.js, so the host watcher never sees partial files).
 */
function writeIpcFile(dir, data) {
  mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const tmpPath = join(dir, `.${filename}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data));
  renameSync(tmpPath, join(dir, filename));
}

/**
 * Validate a 5-field cron expression. Accepts *, steps, ranges, and lists
 * per field — structural validation only; the host scheduler is authoritative.
 * @param {string} expr
 * @returns {boolean}
 */
export function isValidCron(expr) {
  if (typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const field = /^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?(,\d+(-\d+)?(\/\d+)?)*)$/;
  return fields.every((f) => field.test(f));
}

export const JSCLAW_TOOL_DEFS = [
  {
    name: 'send_message',
    description: 'Send a message to the chat immediately.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to send' },
        sender: { type: 'string', description: 'Optional sender name for multi-persona' },
        target_jid: { type: 'string', description: 'Target chat JID (main group only, for cross-group messaging)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Schedule a recurring or one-shot task.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to run when the task fires' },
        schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'], description: 'Type of schedule' },
        schedule_value: { type: 'string', description: 'Cron expression, interval in ms, or ISO date' },
        context_mode: { type: 'string', enum: ['fresh', 'resume'], description: 'Whether to resume existing session or start fresh' },
        target_group_jid: { type: 'string', description: 'Target group for the task (main only)' },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all scheduled tasks for this group.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'pause_task',
    description: 'Pause a scheduled task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to pause' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'resume_task',
    description: 'Resume a paused task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to resume' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel and delete a scheduled task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to cancel' },
      },
      required: ['task_id'],
    },
  },
];

export const JSCLAW_TOOL_NAMES = new Set(JSCLAW_TOOL_DEFS.map((t) => t.name));

/**
 * Execute a jsclaw IPC tool. Returns the result as a string.
 * @param {string} name
 * @param {Object} input
 * @returns {string}
 */
export function executeJsclawTool(name, input) {
  const chatJid = process.env.JSCLAW_CHAT_JID || '';
  const groupFolder = process.env.JSCLAW_GROUP_FOLDER || '';

  switch (name) {
    case 'send_message': {
      const { text, sender, target_jid: targetJid } = input;
      if (targetJid && !isMain()) {
        return 'Error: Only the main group can send cross-group messages.';
      }
      writeIpcFile(join(ipcBase(), 'messages'), {
        text,
        sender: sender || undefined,
        targetJid: targetJid || chatJid,
        sourceGroup: groupFolder,
        timestamp: new Date().toISOString(),
      });
      return `Message sent: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`;
    }

    case 'schedule_task': {
      const { prompt, schedule_type: scheduleType, schedule_value: scheduleValue, context_mode: contextMode, target_group_jid: targetGroupJid } = input;
      if (scheduleType === 'cron' && !isValidCron(scheduleValue)) {
        return `Error: Invalid cron expression: ${scheduleValue}`;
      }
      if (targetGroupJid && !isMain()) {
        return 'Error: Only the main group can schedule tasks for other groups.';
      }
      writeIpcFile(join(ipcBase(), 'tasks'), {
        type: 'schedule_task',
        data: {
          prompt,
          schedule_type: scheduleType,
          schedule_value: scheduleValue,
          context_mode: contextMode || 'fresh',
          chat_jid: targetGroupJid || chatJid,
          group_folder: groupFolder,
        },
        sourceGroup: groupFolder,
        timestamp: new Date().toISOString(),
      });
      return `Task scheduled: ${scheduleType} "${prompt.slice(0, 100)}"`;
    }

    case 'list_tasks': {
      let tasks;
      try {
        tasks = JSON.parse(readFileSync(join(workspaceDir(), 'current_tasks.json'), 'utf-8'));
      } catch {
        tasks = [];
      }
      if (tasks.length === 0) return 'No scheduled tasks.';
      return tasks
        .map((t) => `[${t.id}] ${t.status} | ${t.schedule_type}:${t.schedule_value} | ${t.prompt?.slice(0, 60)}`)
        .join('\n');
    }

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task': {
      writeIpcFile(join(ipcBase(), 'tasks'), {
        type: name,
        data: { task_id: input.task_id },
        sourceGroup: groupFolder,
        timestamp: new Date().toISOString(),
      });
      return `Task ${name.replace('_task', '')}: ${input.task_id}`;
    }

    default:
      return `Error: unknown tool ${name}`;
  }
}
