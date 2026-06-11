/**
 * Anthropic Messages API client. Zero dependencies — global fetch only.
 *
 * Environment variables (read at call time so providerEnv from the host
 * can be applied after import):
 *   ANTHROPIC_API_KEY   - API key
 *   ANTHROPIC_BASE_URL  - Override API endpoint (proxies, alt providers)
 *   ANTHROPIC_AUTH_TOKEN - Bearer token (alternative to API key)
 */

const API_VERSION = '2023-06-01';
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * Call the Messages API once per agent turn. Retries transient failures
 * with exponential backoff, honoring Retry-After when present.
 *
 * @param {Object} params
 * @param {string} params.model
 * @param {Array} params.messages - Messages API message array
 * @param {string} [params.system] - System prompt (cached via cache_control)
 * @param {Array} [params.tools] - Tool definitions
 * @param {number} [params.maxTokens=8192]
 * @param {number} [params.maxRetries=5]
 * @returns {Promise<Object>} The API response body
 */
export async function createMessage({ model, messages, system, tools, maxTokens = 8192, maxRetries = 5 }) {
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/messages`;

  const headers = {
    'content-type': 'application/json',
    'anthropic-version': API_VERSION,
  };
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    headers['authorization'] = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
  } else if (process.env.ANTHROPIC_API_KEY) {
    headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
  } else {
    throw new Error('No ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN set');
  }

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    // System prompt and tools are stable across turns — one cache breakpoint
    // after the system block covers both (tools are cached implicitly before it).
    ...(system && { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }),
    ...(tools?.length && { tools }),
  };

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(1000 * 2 ** attempt, 30000);
      await new Promise((r) => setTimeout(r, backoff));
    }

    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (err) {
      lastError = err; // network error — retry
      continue;
    }

    if (res.ok) return res.json();

    const text = await res.text().catch(() => '');
    lastError = new Error(`API ${res.status}: ${text.slice(0, 500)}`);
    if (!RETRYABLE_STATUS.has(res.status)) throw lastError;

    const retryAfter = Number(res.headers.get('retry-after'));
    if (retryAfter > 0 && retryAfter <= 60) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
    }
  }

  throw lastError;
}
