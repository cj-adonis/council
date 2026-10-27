import { expect, test } from 'vitest';
import { buildCodexArgs, createCodexParser } from '../src/adapters/codex.js';
import type { JsonObject } from '../src/adapters/jsonl.js';

const parseCodexLine = (o: JsonObject) => createCodexParser()(o);
import type { AdapterEvent, RunOptions } from '../src/adapters/types.js';
import { fixtureLines } from './helpers/fixtures.js';

const base: RunOptions = {
  cwd: 'C:/w',
  prompt: 'do it',
  model: 'gpt-x',
  purpose: 'work',
  fullAuto: false,
  allowedCommands: [],
};

test('managed configuration fallbacks are warnings while actual errors stay errors', () => {
  const message = 'Configured value for `approval_policy` is disallowed by requirements; falling back to required value OnRequest. Details: enterprise requirements';
  expect(parseCodexLine({ type: 'error', message })).toEqual([{ type: 'error', message, severity: 'warning' }]);
  expect(parseCodexLine({ type: 'item.completed', item: { type: 'error', message } })).toEqual([{ type: 'error', message, severity: 'warning' }]);
  expect(parseCodexLine({ type: 'error', message: 'Authentication failed' })).toEqual([{ type: 'error', message: 'Authentication failed' }]);
  expect(parseCodexLine({ type: 'item.completed', item: { type: 'error', message: 'Authentication failed' } })).toEqual([{ type: 'error', message: 'Authentication failed' }]);
});

test('tool start and completion produce one call and one result', () => {
  const parse = createCodexParser();
  const item = { id: 'cmd1', type: 'command_execution', command: 'npm test' };
  expect(parse({ type: 'item.started', item })).toHaveLength(1);
  expect(parse({ type: 'item.started', item })).toEqual([]);
  expect(parse({ type: 'item.completed', item: { ...item, aggregated_output: 'passed', exit_code: 0 } }))
    .toEqual([{ type: 'tool_result', id: 'cmd1', output: 'passed', isError: false }]);
});

test('file changes keep details populated only in the completed item', () => {
  const parse = createCodexParser();
  expect(parse({ type: 'item.started', item: { id: 'f1', type: 'file_change', changes: [] } })).toEqual([]);
  const changes = [{ path: 'a.ts', kind: 'update' }];
  expect(parse({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes, status: 'completed' } }))
    .toEqual([
      { type: 'tool', id: 'f1', name: 'file_change', input: changes },
      { type: 'tool_result', id: 'f1', output: '', isError: false },
    ]);
});

test('work args: exec with json, cwd, workspace-write sandbox, model, prompt on stdin', () => {
  const s = buildCodexArgs(base);
  expect(s.cmd).toMatch(/codex/);
  expect(s.args).toEqual(['exec', '--json', '-C', 'C:/w', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-m', 'gpt-x', '-']);
  expect(s.stdin).toBe('do it');
});

test('fullAuto bypasses approvals and sandbox', () => {
  const s = buildCodexArgs({ ...base, fullAuto: true });
  expect(s.args).toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(s.args).not.toContain('--sandbox');
});

test('resume targets the thread id and still reads the prompt from stdin', () => {
  const s = buildCodexArgs({ ...base, resumeId: 'thread-1' });
  expect(s.args.slice(-3)).toEqual(['resume', 'thread-1', '-']);
  expect(s.args).toContain('--json');
});

test('vote args use a read-only sandbox and the output schema file', () => {
  const s = buildCodexArgs({ ...base, purpose: 'vote', resumeId: 'ignored' }, 'C:/tmp/schema.json');
  expect(s.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--output-schema', 'C:/tmp/schema.json']));
  expect(s.args).not.toContain('resume');
});

test('null model omits -m', () => {
  expect(buildCodexArgs({ ...base, model: null }).args).not.toContain('-m');
});

test('parses the documented work stream into session, tool, tool_result, text and result', () => {
  const parse = createCodexParser();
  const events = fixtureLines('codex-work.jsonl').flatMap((l) => parse(l));
  expect(events[0]).toEqual({ type: 'session', id: '0199a213-81c0-7800-8f1d-codex0000001' });
  const tools = events.filter((e) => e.type === 'tool') as Extract<AdapterEvent, { type: 'tool' }>[];
  expect(tools.map((t) => t.name)).toEqual(['command_execution', 'file_change']);
  expect(tools[0]).toMatchObject({ id: 'item_1', input: { command: "/bin/bash -lc 'printf hi > hello.txt'" } });
  expect(events.find((e) => e.type === 'tool_result')).toEqual({ type: 'tool_result', id: 'item_1', output: '', isError: false });
  expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'Created hello.txt containing hi.' }]);
  expect(events.at(-1)).toEqual({
    type: 'result',
    usage: { inputTokens: 24763 - 24448, cachedInputTokens: 24448, outputTokens: 122 + 40 },
    costUsd: undefined,
    exitCode: 0,
    isError: false,
    text: 'Created hello.txt containing hi.',
  });
});

test('reasoning stays hidden while tool starts are shown immediately', () => {
  expect(parseCodexLine({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'hmm' } })).toEqual([]);
  expect(parseCodexLine({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'ls' } })).toEqual([
    { type: 'tool', id: 'c', name: 'command_execution', input: { command: 'ls' } },
  ]);
});

test('a failed command execution is an error tool_result', () => {
  const events = parseCodexLine({
    type: 'item.completed',
    item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: 'FAIL', exit_code: 1, status: 'failed' },
  });
  expect(events[1]).toEqual({ type: 'tool_result', id: 'c1', output: 'FAIL', isError: true });
});

test('turn.failed is an error result carrying the message', () => {
  const [r] = parseCodexLine({ type: 'turn.failed', error: { message: 'rate limited' } });
  expect(r).toMatchObject({ type: 'result', isError: true, text: 'rate limited', usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } });
});

test('a rate_limits snapshot becomes a quota event ahead of the result', () => {
  const events = parseCodexLine({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 },
    rate_limits: {
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1792512600 },
      secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1792767600 },
    },
  });
  expect(events.map((e) => e.type)).toEqual(['quota', 'result']);
  expect(events[0]).toEqual({
    type: 'quota',
    windows: [
      { name: '5-hour', usedPct: 0.125, resetsAt: new Date(1792512600 * 1000).toISOString() },
      { name: '7-day', usedPct: 0.4, resetsAt: new Date(1792767600 * 1000).toISOString() },
    ],
  });
});

test('top-level error events map to error', () => {
  expect(parseCodexLine({ type: 'error', message: 'boom' })).toEqual([{ type: 'error', message: 'boom' }]);
});

test('mcp_tool_call parses tool and tool_result events', () => {
  const events = parseCodexLine({
    type: 'item.completed',
    item: {
      id: 'mcp-1',
      type: 'mcp_tool_call',
      server: 'filesystem',
      tool: 'read_file',
      arguments: { path: 'README.md' },
      result: { content: 'hello' },
      status: 'completed',
    },
  });
  expect(events).toEqual([
    { type: 'tool', id: 'mcp-1', name: 'filesystem.read_file', input: { path: 'README.md' } },
    { type: 'tool_result', id: 'mcp-1', output: JSON.stringify({ content: 'hello' }), isError: false },
  ]);
});

test('web_search parses into tool event with query', () => {
  const events = parseCodexLine({
    type: 'item.completed',
    item: {
      id: 'ws-1',
      type: 'web_search',
      query: 'vitest test runner',
    },
  });
  expect(events).toEqual([
    { type: 'tool', id: 'ws-1', name: 'web_search', input: { query: 'vitest test runner' } },
    { type: 'tool_result', id: 'ws-1', output: '', isError: false },
  ]);
});
