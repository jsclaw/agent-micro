# jsclaw-agent-micro

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Zero-dependency agent runner for [jsclaw](https://github.com/jsclaw/jsclaw) containers. Pure JavaScript ESM, no `node_modules`, talking to the Anthropic Messages API directly over `fetch`.

A drop-in replacement for jsclaw's default Claude Code runner: same stdin/stdout container contract, same identity files, same memory convention, same six IPC tools — in ~1,000 lines you can read in one sitting.

|                    | default runner (`jsclaw-agent`) | **`jsclaw-agent-micro`** |
|--------------------|-------------------------------|--------------------------|
| Agent harness      | Claude Code (proprietary, 238 MB) | this repo (MIT, ~50 kB) |
| npm dependencies   | claude-code, MCP SDK, cron-parser | **none** |
| Container image    | ~1.5 GB (incl. chromium)      | ~150 MB |
| Open source        | partially                     | **top to bottom** |

## Status

Experimental scaffold. The loop, tools, sessions, and jsclaw IPC integration work and are tested; it has not yet been hardened against long real-world workloads.

## Usage

```bash
# Build the container
docker build -t jsclaw-agent-micro:latest -f container/Dockerfile .

# Point jsclaw at it
npx jsclaw config set containerImage jsclaw-agent-micro:latest
```

Or run it standalone, no container, for development:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export JSCLAW_WORKSPACE=$PWD
echo '{"prompt": "list the files here and summarize"}' | node runner.js
```

Output arrives as sentinel-delimited JSON on stdout (jsclaw's `ContainerOutput` shape):

```
---JSCLAW_OUTPUT_START---
{"status":"success","result":"...","newSessionId":"..."}
---JSCLAW_OUTPUT_END---
```

## What's inside

- `runner.js` — container entrypoint: ContainerInput on stdin, identity files (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `USER.md`), `memory/*.md` loading, IPC input polling, close sentinel
- `src/api.js` — Anthropic Messages API over `fetch`: retries with backoff, prompt caching via `cache_control`
- `src/loop.js` — the agent loop: send, execute tool calls, append results, repeat; naive context trimming
- `src/tools.js` — `bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`
- `src/jsclaw-tools.js` — jsclaw's six IPC tools (`send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`) in-process — no MCP transport needed
- `src/session.js` — sessions are the raw messages array as JSON under `.jsclaw-micro/sessions/`

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Required (or `ANTHROPIC_AUTH_TOKEN`) |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Alternate endpoint/proxy |
| `JSCLAW_MICRO_MODEL` | `claude-sonnet-4-6` | Default model (ContainerInput `model` wins) |
| `JSCLAW_WORKSPACE` | `/workspace/group` | Group workspace dir |
| `JSCLAW_IPC_BASE` | `/workspace/ipc` | IPC base dir |
| `JSCLAW_SYSTEM_PROMPT` | — | Extra system prompt |
| `JSCLAW_ALLOWED_TOOLS` | all | JSON array of allowed tool names |
| `JSCLAW_MEMORY_MAX_CHARS` | `8000` | Memory budget for the system prompt |

## Not yet supported

- External MCP servers (`ContainerInput.mcpServers` is ignored with a stderr warning)
- Web search / web fetch tools
- Sub-agents
- Streaming (responses arrive per-turn, which is fine for headless use)
- Claude subscription auth — bring an API key

## Development

```bash
npm test    # node --test, no network needed
npm run lint
```

## License

MIT
