/**
 * The agent loop: send messages + tools to the API, execute tool calls,
 * append results, repeat until the model stops or the iteration cap hits.
 */

import { createMessage } from './api.js';
import { CORE_TOOL_DEFS, executeCoreTool } from './tools.js';
import { JSCLAW_TOOL_DEFS, JSCLAW_TOOL_NAMES, executeJsclawTool } from './jsclaw-tools.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_ITERATIONS = 50;
// ~4 chars/token; keep well under the 200k context window.
const DEFAULT_CONTEXT_CHAR_BUDGET = 600000;
const TRIM_THRESHOLD_CHARS = 2000;

export const ALL_TOOL_DEFS = [...CORE_TOOL_DEFS, ...JSCLAW_TOOL_DEFS];

/**
 * When the conversation outgrows the char budget, blank out large
 * tool_result contents oldest-first. The last two messages are
 * always kept intact.
 * @param {Array} messages
 * @param {number} budget
 */
export function trimContext(messages, budget = DEFAULT_CONTEXT_CHAR_BUDGET) {
  let size = JSON.stringify(messages).length;
  if (size <= budget) return;

  for (let i = 0; i < messages.length - 2 && size > budget; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > TRIM_THRESHOLD_CHARS) {
        size -= block.content.length;
        block.content = '[trimmed: result removed to fit context]';
      }
    }
  }
}

async function executeTool(name, input) {
  if (JSCLAW_TOOL_NAMES.has(name)) return executeJsclawTool(name, input);
  return executeCoreTool(name, input);
}

/**
 * Run one user prompt through the agent loop, mutating and returning
 * the messages array (the caller persists it as the session).
 *
 * @param {Object} params
 * @param {string} params.prompt - The user prompt for this turn
 * @param {Array} [params.messages] - Prior conversation (session resume)
 * @param {string} [params.system] - System prompt
 * @param {string} [params.model]
 * @param {Array} [params.tools] - Tool definitions (default: all built-ins)
 * @param {number} [params.maxIterations]
 * @returns {Promise<{ result: string, messages: Array, usage: { input_tokens: number, output_tokens: number } }>}
 */
export async function runAgentLoop({ prompt, messages = [], system, model, tools = ALL_TOOL_DEFS, maxIterations = DEFAULT_MAX_ITERATIONS }) {
  messages.push({ role: 'user', content: [{ type: 'text', text: prompt }] });

  const effectiveModel = model || process.env.JSCLAW_MICRO_MODEL || DEFAULT_MODEL;
  let lastText = '';
  // Accumulated across iterations; cache reads/writes count as input —
  // they are context the model consumed.
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (let i = 0; i < maxIterations; i++) {
    trimContext(messages);

    const response = await createMessage({ model: effectiveModel, messages, system, tools });
    if (response.usage) {
      usage.input_tokens += (response.usage.input_tokens || 0)
        + (response.usage.cache_read_input_tokens || 0)
        + (response.usage.cache_creation_input_tokens || 0);
      usage.output_tokens += response.usage.output_tokens || 0;
    }

    messages.push({ role: 'assistant', content: response.content });

    const textBlocks = response.content.filter((b) => b.type === 'text').map((b) => b.text);
    if (textBlocks.length > 0) lastText = textBlocks.join('\n');

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { result: lastText, messages, usage };
    }

    const results = [];
    for (const use of toolUses) {
      const output = await executeTool(use.name, use.input || {});
      results.push({ type: 'tool_result', tool_use_id: use.id, content: output });
    }
    messages.push({ role: 'user', content: results });
  }

  return { result: lastText || '[stopped: iteration limit reached]', messages, usage };
}
