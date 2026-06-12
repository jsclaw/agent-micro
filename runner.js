/**
 * Agent runner - runs inside the container. Drop-in replacement for
 * jsclaw's container/agent-runner.js with zero dependencies: reads
 * ContainerInput from stdin, drives the agent loop against the
 * Anthropic API directly, and writes sentinel-delimited ContainerOutput
 * to stdout.
 *
 * Environment variables (set by host):
 *   JSCLAW_CHAT_JID        - Chat identifier
 *   JSCLAW_AGENT_ID    - Agent folder name
 *   JSCLAW_IS_MAIN         - 'true' if admin agent
 *   JSCLAW_SYSTEM_PROMPT   - Optional additional system prompt
 *   JSCLAW_ALLOWED_TOOLS   - Optional JSON array of allowed tool names
 *   JSCLAW_MICRO_MODEL     - Default model (fallback claude-sonnet-4-6)
 *   ANTHROPIC_API_KEY      - Required for Claude API access
 *
 * Identity files (optional, read from the workspace):
 *   SOUL.md, IDENTITY.md, AGENTS.md, TOOLS.md, USER.md are concatenated
 *   in that order into the system prompt, openclaw-style. Any
 *   JSCLAW_SYSTEM_PROMPT content is appended after them.
 *
 * Not yet supported (logged to stderr, never fatal): extra MCP servers
 * from ContainerInput.mcpServers.
 */

import { readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentLoop, ALL_TOOL_DEFS } from './src/loop.js';
import { connectMcpServers } from './src/mcp.js';
import { workspaceDir } from './src/tools.js';

const OUTPUT_START_MARKER = '---JSCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---JSCLAW_OUTPUT_END---';

// Loaded into the system prompt in this order (openclaw convention):
// identity first, then instructions, then context.
const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'TOOLS.md', 'USER.md'];

const HARNESS_PROMPT = `You are an autonomous agent running headless in a container. Your working directory is the agent workspace; files you write there persist between runs. Use the tools to act; your final text is delivered to the user as your reply. To remember something across sessions, write a markdown file under memory/.`;

function ipcInputDir() {
  return join(process.env.JSCLAW_IPC_BASE || '/workspace/ipc', 'input');
}

/**
 * Read ContainerInput JSON from stdin.
 * @returns {Promise<Object>}
 */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

/**
 * Write a ContainerOutput to stdout with sentinel markers.
 * @param {Object} output
 */
function writeOutput(output) {
  process.stdout.write(`\n${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`);
}

/**
 * Load memory/*.md from the agent workspace, truncated to a character
 * budget (JSCLAW_MEMORY_MAX_CHARS, default 8000 ≈ 2k tokens).
 * @returns {string} Memory section for the system prompt, or ''
 */
function loadMemory() {
  const maxChars = Number(process.env.JSCLAW_MEMORY_MAX_CHARS) || 8000;
  const dir = join(workspaceDir(), 'memory');
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return '';
  }

  const parts = [];
  let used = 0;
  for (const name of names) {
    let content;
    try {
      content = readFileSync(join(dir, name), 'utf-8').trim();
    } catch {
      continue;
    }
    if (!content || /^#[^\n]*$/.test(content)) continue; // empty or heading-only

    const section = `## ${name}\n${content}`;
    if (used + section.length > maxChars) {
      const remaining = maxChars - used;
      if (remaining > 100) parts.push(section.slice(0, remaining) + '\n[...memory truncated]');
      break;
    }
    parts.push(section);
    used += section.length + 2;
  }

  return parts.length > 0
    ? `# Memory\n\nYour persistent memory (read/write these files under memory/ to remember things):\n\n${parts.join('\n\n')}`
    : '';
}

/**
 * Build the system prompt: harness preamble, identity files, memory,
 * then any JSCLAW_SYSTEM_PROMPT.
 * @returns {string}
 */
function buildSystemPrompt() {
  const parts = [HARNESS_PROMPT];
  for (const name of IDENTITY_FILES) {
    try {
      const content = readFileSync(join(workspaceDir(), name), 'utf-8').trim();
      if (content) parts.push(content);
    } catch {
      // file absent — identity files are all optional
    }
  }
  const memory = loadMemory();
  if (memory) parts.push(memory);
  const extra = process.env.JSCLAW_SYSTEM_PROMPT?.trim();
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

/**
 * Check if the close sentinel exists.
 * @returns {boolean}
 */
function shouldClose() {
  try {
    return existsSync(join(ipcInputDir(), '_close'));
  } catch {
    return false;
  }
}

/**
 * Drain pending IPC input messages.
 * @returns {string[]} Array of message texts
 */
function drainIpcInput() {
  const messages = [];
  try {
    const entries = readdirSync(ipcInputDir()).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.')
    ).sort();

    for (const name of entries) {
      const filePath = join(ipcInputDir(), name);
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (data.text) messages.push(data.text);
        unlinkSync(filePath);
      } catch {
        // skip malformed
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return messages;
}

/**
 * Wait for a new IPC message or close sentinel.
 * @param {number} [pollInterval=500] - ms between polls
 * @param {number} [maxWait=0] - max wait in ms (0 = forever)
 * @returns {Promise<string|null>} Message text, or null if closed
 */
async function waitForIpcMessage(pollInterval = 500, maxWait = 0) {
  const start = Date.now();
  while (true) {
    if (shouldClose()) return null;

    const messages = drainIpcInput();
    if (messages.length > 0) {
      return messages.join('\n');
    }

    if (maxWait > 0 && Date.now() - start >= maxWait) return null;
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

/**
 * Resolve the tool definitions for this run from JSCLAW_ALLOWED_TOOLS.
 * @returns {Array}
 */
function resolveTools() {
  if (!process.env.JSCLAW_ALLOWED_TOOLS) return ALL_TOOL_DEFS;
  try {
    const allowed = new Set(JSON.parse(process.env.JSCLAW_ALLOWED_TOOLS));
    const tools = ALL_TOOL_DEFS.filter((t) => allowed.has(t.name));
    return tools.length > 0 ? tools : ALL_TOOL_DEFS;
  } catch {
    return ALL_TOOL_DEFS;
  }
}

// --- Main ---

async function main() {
  let input;
  try {
    input = await readStdin();
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to read stdin: ${err.message}` });
    process.exit(1);
  }

  const {
    prompt,
    sessionId,
    isScheduledTask,
    mcpServers: extraMcpServers,
    providerEnv,
    model,
  } = input;

  // Provider credentials/endpoint arrive via stdin (never argv); apply
  // before any API call so ANTHROPIC_BASE_URL / keys take effect.
  if (providerEnv && typeof providerEnv === 'object') {
    for (const [key, value] of Object.entries(providerEnv)) {
      if (typeof value === 'string') process.env[key] = value;
    }
  }

  // External MCP servers (streamable HTTP): discover tools before the
  // first turn; unreachable servers degrade to a warning.
  let mcp = { tools: [], executors: new Map() };
  if (extraMcpServers && Object.keys(extraMcpServers).length > 0) {
    mcp = await connectMcpServers(extraMcpServers, (msg) => process.stderr.write(`jsclaw-agent-micro: ${msg}\n`));
  }

  // Build initial prompt
  let fullPrompt = prompt;
  if (isScheduledTask) {
    fullPrompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }

  // Drain any pending IPC messages
  const pendingMessages = drainIpcInput();
  if (pendingMessages.length > 0) {
    fullPrompt += '\n\n[Pending messages]\n' + pendingMessages.join('\n');
  }

  let system = buildSystemPrompt();
  // Description-driven skills index from the host (jsclaw#47): names +
  // descriptions + readable paths; bodies are read on demand with tools.
  if (input.skillsIndex) {
    system = system ? `${system}\n\n${input.skillsIndex}` : input.skillsIndex;
  }
  const tools = [...resolveTools(), ...mcp.tools];

  // Host owns session transcripts (jsclaw#79): prior messages arrive in
  // ContainerInput, the updated array is returned in ContainerOutput.
  // The runner persists nothing — keeping the agent workspace clean.
  let messages = Array.isArray(input.messages) ? input.messages : [];

  // Query loop: run query, wait for IPC, run again
  while (true) {
    try {
      const { result, usage } = await runAgentLoop({
        prompt: fullPrompt,
        messages,
        system,
        model,
        tools,
        externalTools: mcp.executors,
      });

      writeOutput({
        status: 'success',
        result,
        messages,
        ...(usage && { usage }),
      });
    } catch (err) {
      writeOutput({
        status: 'error',
        result: null,
        error: err.message,
        messages,
      });
    }

    // Wait for next IPC message or close signal
    const nextMessage = await waitForIpcMessage();
    if (nextMessage === null) {
      // Close sentinel received or no more messages
      break;
    }

    fullPrompt = nextMessage;
  }
}

main().catch((err) => {
  writeOutput({ status: 'error', result: null, error: `Fatal: ${err.message}` });
  process.exit(1);
});
