/**
 * MCP client — Streamable HTTP transport only (#9). Zero dependencies:
 * JSON-RPC 2.0 over fetch POSTs, spec 2025-03-26. Discovered tools are
 * exposed to the loop as mcp__<server>__<tool> (the openclaw naming);
 * results map onto the errors-as-strings tool contract.
 *
 * Server config arrives via ContainerInput.mcpServers; entries with a
 * `url` are HTTP servers ({ url, headers? }). stdio entries (command)
 * are not yet supported and are skipped with a warning.
 */

export const MCP_PROTOCOL_VERSION = '2025-03-26';
const RPC_TIMEOUT_MS = 30000;

let nextId = 1;

/**
 * One JSON-RPC exchange with an HTTP MCP server.
 * @param {{ name: string, url: string, headers: Object }} server
 * @param {string} method
 * @param {Object} [params]
 * @param {boolean} [notification] - No id, expect no response body
 * @returns {Promise<Object|null>} result, or null for notifications
 */
async function rpc(server, method, params, notification = false) {
  const body = { jsonrpc: '2.0', method, ...(params && { params }), ...(notification ? {} : { id: nextId++ }) };
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...server.headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  if (res.status === 202 || res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    throw new Error('SSE responses are not supported yet');
  }
  if (notification) return null;

  const reply = await res.json();
  if (reply.error) throw new Error(reply.error.message || `RPC error ${reply.error.code}`);
  return reply.result;
}

/**
 * Connect every HTTP MCP server and discover its tools.
 *
 * @param {Record<string, Object>} mcpServers - ContainerInput.mcpServers
 * @param {(msg: string) => void} [warn] - Non-fatal problem reporter
 * @returns {Promise<{ tools: Array, executors: Map<string, Function> }>}
 *   tools: Anthropic-format tool definitions to add to the loop.
 *   executors: tool name -> async (input) => string.
 */
export async function connectMcpServers(mcpServers, warn = () => {}) {
  const tools = [];
  const executors = new Map();

  for (const [name, cfg] of Object.entries(mcpServers || {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (!cfg.url) {
      warn(`mcp: server '${name}' has no url (stdio transport not yet supported) — skipping`);
      continue;
    }
    const server = { name, url: cfg.url, headers: cfg.headers || {} };

    try {
      await rpc(server, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo: { name: 'jsclaw-agent-micro', version: '0.0.1' },
        capabilities: {},
      });
      await rpc(server, 'notifications/initialized', undefined, true).catch(() => {});
      const listed = await rpc(server, 'tools/list', {});

      for (const tool of listed?.tools || []) {
        const fullName = `mcp__${name}__${tool.name}`;
        tools.push({
          name: fullName,
          description: tool.description || `${tool.name} on ${name}`,
          input_schema: tool.inputSchema || { type: 'object', properties: {} },
        });
        executors.set(fullName, async (input) => {
          const result = await rpc(server, 'tools/call', { name: tool.name, arguments: input || {} });
          const text = (result?.content || [])
            .filter((c) => c?.type === 'text')
            .map((c) => c.text)
            .join('\n');
          return result?.isError ? `Error from ${name}: ${text || 'tool failed'}` : (text || '(empty result)');
        });
      }
    } catch (err) {
      warn(`mcp: server '${name}' unavailable (${err.message}) — its tools are skipped`);
    }
  }

  return { tools, executors };
}
