/**
 * Core agent tools: bash, read_file, write_file, edit_file, glob, grep.
 * The container is the sandbox — tools run unrestricted inside it.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const MAX_OUTPUT_CHARS = 30000;
const MAX_GREP_MATCHES = 100;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export const CORE_TOOL_DEFS = [
  {
    name: 'bash',
    description: 'Run a shell command. Returns stdout and stderr. Working directory persists only within a single command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file. Returns the full content, or a slice when offset/limit are given (1-based line offset).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the workspace)' },
        offset: { type: 'number', description: 'Line number to start from (1-based)' },
        limit: { type: 'number', description: 'Maximum number of lines to return' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file, creating parent directories as needed. Overwrites existing content.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the workspace)' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Include enough surrounding context to make the match unique.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the workspace)' },
        old_string: { type: 'string', description: 'Exact text to replace' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern (supports *, **, ?). Returns relative paths.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.js"' },
        dir: { type: 'string', description: 'Directory to search (default: workspace)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a JavaScript regular expression. Returns file:line: matched text.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for' },
        dir: { type: 'string', description: 'Directory to search (default: workspace)' },
        glob: { type: 'string', description: 'Only search files matching this glob pattern' },
      },
      required: ['pattern'],
    },
  },
];

/**
 * Convert a glob pattern to a RegExp. Supports *, **, ? and literal text.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Recursively list files under dir, skipping VCS/dependency directories
 * and symlinks. Returns paths relative to dir.
 * @param {string} dir
 * @returns {string[]}
 */
export function walkFiles(dir) {
  const results = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(entryRel);
      } else if (entry.isFile()) {
        results.push(entryRel);
      }
    }
  }
  return results.sort();
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
  return text.length > max ? `${text.slice(0, max)}\n[...output truncated at ${max} chars]` : text;
}

function runBash(command, timeoutMs) {
  const timeout = Math.min(Math.max(timeoutMs || 120000, 1000), 600000);
  return new Promise((resolvePromise) => {
    const child = spawn('bash', ['-c', command], { cwd: workspaceDir(), env: process.env });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = truncate(out);
      if (killed) result += `\n[command timed out after ${timeout}ms]`;
      else if (code !== 0) result += `\n[exit code ${code}]`;
      resolvePromise(result || '(no output)');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise(`Error spawning command: ${err.message}`);
    });
  });
}

function workspaceDir() {
  return process.env.JSCLAW_WORKSPACE || '/workspace/agent';
}

function resolvePath(p) {
  return resolve(workspaceDir(), p);
}

/**
 * Execute a core tool by name. Returns the tool result as a string;
 * errors are returned as strings prefixed with "Error:" so the model
 * can react rather than the loop crashing.
 *
 * @param {string} name
 * @param {Object} input
 * @returns {Promise<string>}
 */
export async function executeCoreTool(name, input) {
  try {
    switch (name) {
      case 'bash':
        return await runBash(input.command, input.timeout_ms);

      case 'read_file': {
        const content = readFileSync(resolvePath(input.path), 'utf-8');
        if (input.offset || input.limit) {
          const lines = content.split('\n');
          const start = Math.max((input.offset || 1) - 1, 0);
          const slice = lines.slice(start, input.limit ? start + input.limit : undefined);
          return truncate(slice.join('\n'));
        }
        return truncate(content);
      }

      case 'write_file': {
        const path = resolvePath(input.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, input.content);
        return `Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`;
      }

      case 'edit_file': {
        const path = resolvePath(input.path);
        const content = readFileSync(path, 'utf-8');
        const { old_string: oldStr, new_string: newStr, replace_all: replaceAll } = input;
        if (oldStr === newStr) return 'Error: old_string and new_string are identical';
        const count = content.split(oldStr).length - 1;
        if (count === 0) return 'Error: old_string not found in file';
        if (count > 1 && !replaceAll) {
          return `Error: old_string matches ${count} times; add surrounding context to make it unique, or set replace_all`;
        }
        writeFileSync(path, replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr));
        return `Replaced ${replaceAll ? count : 1} occurrence(s) in ${input.path}`;
      }

      case 'glob': {
        const dir = input.dir ? resolvePath(input.dir) : workspaceDir();
        const regex = globToRegex(input.pattern);
        const matches = walkFiles(dir).filter((f) => regex.test(f));
        if (matches.length === 0) return 'No files matched';
        const shown = matches.slice(0, MAX_GLOB_RESULTS);
        let result = shown.join('\n');
        if (matches.length > shown.length) result += `\n[...${matches.length - shown.length} more matches]`;
        return result;
      }

      case 'grep': {
        const dir = input.dir ? resolvePath(input.dir) : workspaceDir();
        const regex = new RegExp(input.pattern);
        const fileFilter = input.glob ? globToRegex(input.glob) : null;
        const matches = [];
        for (const file of walkFiles(dir)) {
          if (fileFilter && !fileFilter.test(file)) continue;
          const path = join(dir, file);
          try {
            if (statSync(path).size > MAX_GREP_FILE_BYTES) continue;
            const lines = readFileSync(path, 'utf-8').split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (regex.test(lines[i])) {
                matches.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (matches.length >= MAX_GREP_MATCHES) break;
              }
            }
          } catch {
            // unreadable or binary — skip
          }
          if (matches.length >= MAX_GREP_MATCHES) break;
        }
        if (matches.length === 0) return 'No matches';
        let result = matches.join('\n');
        if (matches.length >= MAX_GREP_MATCHES) result += `\n[...stopped at ${MAX_GREP_MATCHES} matches]`;
        return result;
      }

      default:
        return `Error: unknown tool ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

export { workspaceDir };
