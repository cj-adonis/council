import type { JsonObject } from './jsonl.js';
import { runCli, runCliJson } from './run.js';
import { resolveCommand } from './spawn.js';
import { runGeminiInteractive } from './interactive.js';
import { num, ZERO_USAGE, type AdapterEvent, type CliSpec, type RunOptions, type Usage } from './types.js';

/**
 * Gemini CLI headless mode. The prompt is fed on stdin (headless is implied by a
 * non-TTY stdin), work runs stream JSONL with edits auto-approved, votes and
 * summaries return one JSON object.
 */
export function buildGeminiArgs(o: RunOptions): CliSpec {
  const args: string[] = ['-o', o.purpose === 'summarize' ? 'json' : 'stream-json'];
  if (o.model) args.push('-m', o.model);
  if (o.purpose === 'work') {
    args.push('--approval-mode', o.fullAuto ? 'yolo' : 'auto_edit');
    if (o.resumeId) args.push('--resume', o.resumeId);
  }
  return { cmd: resolveCommand('gemini'), args, stdin: o.prompt };
}

/**
 * Token usage from the CLI's `stats`. Newer CLIs emit the SessionMetrics shape
 * (`models[<name>].tokens`); older ones emit flat `input_tokens` / `output_tokens`.
 */
export function usageFromGeminiStats(stats: unknown): Usage {
  if (!stats || typeof stats !== 'object') return ZERO_USAGE;
  const s = stats as JsonObject;
  if (s.models && typeof s.models === 'object') {
    let prompt = 0;
    let cached = 0;
    let candidates = 0;
    let thoughts = 0;
    for (const model of Object.values(s.models as Record<string, unknown>)) {
      const tokens = (model && typeof model === 'object' ? (model as JsonObject).tokens : undefined) as JsonObject | undefined;
      if (!tokens) continue;
      prompt += num(tokens.prompt);
      cached += num(tokens.cached);
      candidates += num(tokens.candidates);
      thoughts += num(tokens.thoughts);
    }
    return { inputTokens: Math.max(0, prompt - cached), cachedInputTokens: cached, outputTokens: candidates + thoughts };
  }
  const cached = num(s.cached ?? s.cached_tokens);
  return {
    inputTokens: Math.max(0, num(s.input_tokens) - cached),
    cachedInputTokens: cached,
    outputTokens: num(s.output_tokens),
  };
}

/** Stateful per-run parser for `-o stream-json`; remembers assistant text for the final result. */
export function createGeminiParser(): (o: JsonObject) => AdapterEvent[] {
  let lastText = '';
  return (o) => {
    switch (o.type) {
      case 'init':
        return typeof o.session_id === 'string' ? [{ type: 'session', id: o.session_id }] : [];

      case 'message':
        if (o.role === 'assistant' && typeof o.content === 'string' && o.content !== '') {
          lastText += o.content;
          return [{ type: 'text', text: o.content, delta: o.delta === true }];
        }
        return [];

      case 'tool_use':
        return [
          {
            type: 'tool',
            id: typeof o.tool_id === 'string' ? o.tool_id : undefined,
            name: typeof o.tool_name === 'string' ? o.tool_name : 'tool',
            input: o.parameters,
          },
        ];

      case 'tool_result':
        return [
          {
            type: 'tool_result',
            id: typeof o.tool_id === 'string' ? o.tool_id : undefined,
            output: o.output === undefined || o.output === null ? '' : typeof o.output === 'string' ? o.output : JSON.stringify(o.output),
            isError: o.status !== undefined && o.status !== 'success',
          },
        ];

      case 'error':
        return [{ type: 'error', message: typeof o.message === 'string' ? o.message : JSON.stringify(o) }];

      case 'result': {
        const isError = o.status !== 'success';
        const errObj = o.error && typeof o.error === 'object' ? (o.error as JsonObject) : undefined;
        const errMessage =
          errObj && typeof errObj.message === 'string'
            ? errObj.message
            : typeof o.message === 'string'
              ? o.message
              : undefined;
        const text = isError ? errMessage ?? (lastText || undefined) : lastText || undefined;
        return [
          {
            type: 'result',
            usage: usageFromGeminiStats(o.stats),
            costUsd: undefined,
            exitCode: 0,
            isError,
            text,
          },
        ];
      }

      default:
        return [];
    }
  };
}

/** Parser for `-o json`: `{ response, stats, error? }`. */
export function parseGeminiJson(o: JsonObject): AdapterEvent[] {
  const response = typeof o.response === 'string' ? o.response : '';
  const error = o.error && typeof o.error === 'object' ? (o.error as JsonObject) : undefined;
  const out: AdapterEvent[] = [];
  if (response !== '') out.push({ type: 'text', text: response });
  out.push({
    type: 'result',
    usage: usageFromGeminiStats(o.stats),
    costUsd: undefined,
    exitCode: 0,
    isError: error !== undefined,
    text: error ? (typeof error.message === 'string' ? error.message : JSON.stringify(error)) : response || undefined,
  });
  return out;
}

export function runGemini(opts: RunOptions): AsyncIterable<AdapterEvent> {
  if (opts.purpose === 'work' && opts.requestInput) return runGeminiInteractive(opts);
  const spec = buildGeminiArgs(opts);
  const runOpts = { cwd: opts.cwd, env: opts.env, signal: opts.signal, stopAtResult: opts.purpose === 'vote' };
  return opts.purpose === 'summarize' ? runCliJson(spec, runOpts, parseGeminiJson) : runCli(spec, runOpts, createGeminiParser());
}
