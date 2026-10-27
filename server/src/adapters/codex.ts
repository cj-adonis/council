import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JsonObject } from './jsonl.js';
import { runCli } from './run.js';
import { resolveCommand } from './spawn.js';
import { runCodexInteractive } from './interactive.js';
import { isoFromEpoch, num, windowName, ZERO_USAGE, type AdapterEvent, type CliSpec, type QuotaWindow, type RunOptions } from './types.js';

/** Codex attaches `rate_limits` snapshots ({primary, secondary}) to some events. */
function quotaFromRateLimits(o: JsonObject): AdapterEvent[] {
  const limits = o.rate_limits;
  if (!limits || typeof limits !== 'object') return [];
  const windows: QuotaWindow[] = [];
  for (const value of Object.values(limits as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const w = value as JsonObject;
    if (typeof w.used_percent !== 'number') continue;
    const minutes = num(w.window_minutes);
    windows.push({
      name: minutes > 0 ? windowName(minutes) : 'window',
      usedPct: Math.min(1, Math.max(0, w.used_percent / 100)),
      resetsAt: isoFromEpoch(w.resets_at),
    });
  }
  return windows.length > 0 ? [{ type: 'quota', windows }] : [];
}

/**
 * Codex CLI `exec` in JSONL mode. Work runs get a workspace-write sandbox (or no
 * sandbox under fullAuto); votes run read-only with an output schema file.
 */
export function buildCodexArgs(o: RunOptions, schemaPath?: string): CliSpec {
  const args = ['exec', '--json', '-C', o.cwd, '--skip-git-repo-check'];
  if (o.purpose === 'work') {
    if (o.fullAuto) args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('--sandbox', 'workspace-write');
  } else {
    args.push('--sandbox', 'read-only');
    if (schemaPath) args.push('--output-schema', schemaPath);
  }
  if (o.model) args.push('-m', o.model);
  if (o.purpose === 'work' && o.resumeId) args.push('resume', o.resumeId);
  args.push('-');
  return { cmd: resolveCommand('codex'), args, stdin: o.prompt };
}

function itemId(item: JsonObject): string | undefined {
  return typeof item.id === 'string' ? item.id : undefined;
}

function errorEvent(o: JsonObject): AdapterEvent {
  const message = typeof o.message === 'string' ? o.message : JSON.stringify(o);
  // The CLI continues with the required permissions after these notices.
  const fallback = /^Configured value for `[^`]+` is disallowed by requirements; falling back to required value /.test(message);
  return { type: 'error', message, ...(fallback ? { severity: 'warning' as const } : {}) };
}

function completedItem(item: JsonObject, remember: (text: string) => void): AdapterEvent[] {
  const id = itemId(item);
  switch (item.type) {
    case 'agent_message':
      if (typeof item.text === 'string' && item.text !== '') {
        remember(item.text);
        return [{ type: 'text', text: item.text }];
      }
      return [];

    case 'command_execution': {
      const exitCode = item.exit_code;
      const isError = typeof exitCode === 'number' ? exitCode !== 0 : item.status === 'failed';
      return [
        { type: 'tool', id, name: 'command_execution', input: { command: item.command } },
        {
          type: 'tool_result',
          id,
          output: item.aggregated_output === undefined || item.aggregated_output === null ? '' : String(item.aggregated_output),
          isError,
        },
      ];
    }

    case 'file_change':
      return [{ type: 'tool', id, name: 'file_change', input: item.changes }];

    case 'mcp_tool_call':
      return [
        { type: 'tool', id, name: `${String(item.server ?? 'mcp')}.${String(item.tool ?? 'tool')}`, input: item.arguments },
        {
          type: 'tool_result',
          id,
          output: JSON.stringify(item.result ?? item.error ?? ''),
          isError: item.status === 'failed',
        },
      ];

    case 'web_search':
      return [{ type: 'tool', id, name: 'web_search', input: { query: item.query } }];

    case 'error':
      return [errorEvent(item)];

    default:
      return [];
  }
}

/** Stateful per-run parser for `codex exec --json`. */
export function createCodexParser(): (o: JsonObject) => AdapterEvent[] {
  let lastText: string | undefined;
  const startedTools = new Set<string>();
  return (o) => [...quotaFromRateLimits(o), ...parseTyped(o)];

  function parseTyped(o: JsonObject): AdapterEvent[] {
    switch (o.type) {
      case 'thread.started':
        return typeof o.thread_id === 'string' ? [{ type: 'session', id: o.thread_id }] : [];

      case 'item.started': {
        const item = o.item as JsonObject | undefined;
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || startedTools.has(item.id)) return [];
        // File changes and search queries can be populated only at completion.
        if (item.type !== 'command_execution' && item.type !== 'mcp_tool_call') return [];
        const events = completedItem(item, () => {}).filter((event) => event.type === 'tool');
        if (events.length > 0) startedTools.add(item.id);
        return events;
      }

      case 'item.completed': {
        const item = o.item;
        if (!item || typeof item !== 'object') return [];
        const typed = item as JsonObject;
        let events = completedItem(typed, (t) => {
          lastText = t;
        });
        if (typeof typed.id === 'string' && startedTools.delete(typed.id)) {
          events = events.filter((event) => event.type !== 'tool');
        }
        if (typed.type === 'file_change' || typed.type === 'web_search') {
          events.push({ type: 'tool_result', id: itemId(typed), output: '', isError: typed.status === 'failed' });
        }
        return events;
      }

      case 'turn.completed': {
        const usage = (o.usage && typeof o.usage === 'object' ? o.usage : {}) as JsonObject;
        const cached = num(usage.cached_input_tokens);
        return [
          {
            type: 'result',
            usage: {
              inputTokens: Math.max(0, num(usage.input_tokens) - cached),
              cachedInputTokens: cached,
              outputTokens: num(usage.output_tokens) + num(usage.reasoning_output_tokens),
            },
            costUsd: undefined,
            exitCode: 0,
            isError: false,
            text: lastText,
          },
        ];
      }

      case 'turn.failed': {
        const error = o.error && typeof o.error === 'object' ? (o.error as JsonObject) : undefined;
        return [
          {
            type: 'result',
            usage: ZERO_USAGE,
            costUsd: undefined,
            exitCode: 0,
            isError: true,
            text: error && typeof error.message === 'string' ? error.message : 'turn failed',
          },
        ];
      }

      case 'error':
        return [errorEvent(o)];

      default:
        return [];
    }
  }
}

export async function* runCodex(opts: RunOptions): AsyncGenerator<AdapterEvent> {
  if (opts.purpose === 'work' && opts.requestInput) { yield* runCodexInteractive(opts); return; }
  let schemaPath: string | undefined;
  if (opts.purpose !== 'work' && opts.jsonSchema) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'council-codex-'));
    schemaPath = path.join(dir, 'schema.json');
    await fs.writeFile(schemaPath, JSON.stringify(opts.jsonSchema), 'utf8');
  }
  try {
    yield* runCli(buildCodexArgs(opts, schemaPath), { cwd: opts.cwd, env: opts.env, signal: opts.signal, stopAtResult: opts.purpose === 'vote' }, createCodexParser());
  } finally {
    if (schemaPath) await fs.rm(path.dirname(schemaPath), { recursive: true, force: true });
  }
}
