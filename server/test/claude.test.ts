import { expect, test } from 'vitest';
import { buildClaudeArgs, createClaudeParser, parseClaudeLine } from '../src/adapters/claude.js';
import type { AdapterEvent, RunOptions } from '../src/adapters/types.js';
import { fixtureLines } from './helpers/fixtures.js';

const base: RunOptions = {
  cwd: 'C:/w',
  prompt: 'do it',
  model: 'claude-sonnet-5-5',
  purpose: 'work',
  fullAuto: false,
  allowedCommands: ['Bash(npm test*)'],
};

test('partial text arrives before completion and the complete message is not repeated', () => {
  const parse = createClaudeParser();
  parse({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  const delta = (text: string) => parse({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  expect(delta('Hello ')).toEqual([{ type: 'text', text: 'Hello ', delta: false }]);
  expect(delta('world')).toEqual([{ type: 'text', text: 'world', delta: true }]);
  expect(parse({ type: 'assistant', message: { id: 'm1', content: [
    { type: 'text', text: 'Hello world' },
    { type: 'tool_use', id: 'tool1', name: 'Read', input: { file_path: 'a.ts' } },
  ] } })).toEqual([{ type: 'tool', id: 'tool1', name: 'Read', input: { file_path: 'a.ts' } }]);
  parse({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2' } } });
  expect(delta('Next message')).toEqual([{ type: 'text', text: 'Next message', delta: false }]);
});

test('stream parser supports complete-only output and recovers missing final deltas', () => {
  const parse = createClaudeParser();
  expect(parse({ type: 'assistant', message: { content: [{ type: 'text', text: 'Complete' }] } }))
    .toEqual([{ type: 'text', text: 'Complete' }]);
  parse({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  parse({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } });
  expect(parse({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Hello' }] } }))
    .toEqual([{ type: 'text', text: 'lo', delta: true }]);
});

test('Claude result errors are retained when there is no result string', () => {
  expect(parseClaudeLine({ type: 'result', is_error: true, errors: ['Request timed out', 'Retry exhausted'] })[0])
    .toMatchObject({ type: 'result', isError: true, text: 'Request timed out\nRetry exhausted' });
});

test('work args: print mode, stream-json, model, resume, acceptEdits and allowed tools', () => {
  const s = buildClaudeArgs({ ...base, resumeId: 'abc' });
  expect(s.cmd).toMatch(/(?:^|[\\/])claude(?:\.exe|\.cmd)?$/i);
  expect(s.args).toEqual(
    expect.arrayContaining([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'claude-sonnet-5-5',
      '--resume',
      'abc',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(npm test*)',
    ]),
  );
  expect(s.args).not.toContain('--dangerously-skip-permissions');
  expect(s.stdin).toBe('do it');
});

test('legacy Claude fullAuto requests native Auto review without bypass flags', () => {
  const s = buildClaudeArgs({ ...base, fullAuto: true });
  expect(s.args).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
  expect(s.args).not.toContain('--dangerously-skip-permissions');
  expect(s.args).not.toContain('--allow-dangerously-skip-permissions');
});

test('vote args disable tools, cap budget, pass the json schema and skip persistence', () => {
  const s = buildClaudeArgs({ ...base, purpose: 'vote', model: 'claude-haiku-5-5', jsonSchema: { type: 'object' } });
  expect(s.args).toEqual(
    expect.arrayContaining(['--tools', '', '--no-session-persistence', '--max-budget-usd', '0.05', '--json-schema', '{"type":"object"}']),
  );
  expect(s.args).not.toContain('--permission-mode');
  expect(s.args).not.toContain('--resume');
});

test('null model omits --model', () => {
  const s = buildClaudeArgs({ ...base, model: null });
  expect(s.args).not.toContain('--model');
});

test('no allowed commands omits --allowedTools', () => {
  const s = buildClaudeArgs({ ...base, allowedCommands: [] });
  expect(s.args).not.toContain('--allowedTools');
});

test('parses the recorded work stream into session, tool, tool_result, text and result events', () => {
  const events = fixtureLines('claude-work.jsonl').flatMap(parseClaudeLine);
  expect(events[0]).toEqual({ type: 'session', id: 'd679c65c-7956-4f6b-933b-9ae9a3fe31a8' });
  const tool = events.find((e) => e.type === 'tool');
  expect(tool).toMatchObject({ type: 'tool', name: 'Write', id: 'toolu_01HhZMCYHaiYhvHPqnHpyi1a' });
  expect((tool as Extract<AdapterEvent, { type: 'tool' }>).input).toMatchObject({ content: 'hi' });
  const toolResult = events.find((e) => e.type === 'tool_result');
  expect(toolResult).toMatchObject({ type: 'tool_result', id: 'toolu_01HhZMCYHaiYhvHPqnHpyi1a' });
  expect((toolResult as Extract<AdapterEvent, { type: 'tool_result' }>).output).toContain('File created successfully');
  const text = events.find((e) => e.type === 'text');
  expect(text).toMatchObject({ type: 'text', text: expect.stringContaining('hello.txt') });
  const result = events.at(-1);
  expect(result).toEqual({
    type: 'result',
    usage: { inputTokens: 4, cachedInputTokens: 16941 + 49877, outputTokens: 298 },
    costUsd: 0.00403637,
    exitCode: 0,
    isError: false,
    text: 'I created `hello.txt` in the working directory (`scratchpad\\fx-claude`), containing `hi`.',
  });
});

test('parses the recorded vote stream: text pong and a priced result', () => {
  const events = fixtureLines('claude-vote.jsonl').flatMap(parseClaudeLine);
  expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'pong' }]);
  const result = events.at(-1);
  expect(result).toMatchObject({ type: 'result', text: 'pong', isError: false });
  expect((result as Extract<AdapterEvent, { type: 'result' }>).costUsd).toBeCloseTo(0.00114282, 8);
});

test('result with is_error=true maps to isError', () => {
  const [ev] = parseClaudeLine({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 2 },
    result: 'boom',
  });
  expect(ev).toMatchObject({ type: 'result', isError: true, costUsd: 0.01, text: 'boom' });
});

test('structured_output is surfaced as result text when present', () => {
  const [ev] = parseClaudeLine({ type: 'result', is_error: false, structured_output: { tier: 'easy' }, usage: {}, total_cost_usd: 0 });
  expect(ev).toMatchObject({ type: 'result', text: '{"tier":"easy"}', usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } });
});

test('a rate_limit_event with plan windows becomes a quota event', () => {
  const line = fixtureLines('claude-vote.jsonl').find((o) => o.type === 'rate_limit_event');
  expect(line).toBeDefined();
  expect(parseClaudeLine(line as Record<string, unknown>)).toEqual([
    {
      type: 'quota',
      windows: [
        { name: '5-hour', usedPct: 0.59, resetsAt: new Date(1792512600 * 1000).toISOString() },
        { name: '7-day', usedPct: 0.51, resetsAt: new Date(1792767600 * 1000).toISOString() },
      ],
    },
  ]);
});

test('hook, thinking and bare rate-limit events produce nothing', () => {
  expect(parseClaudeLine({ type: 'rate_limit_event' })).toEqual([]);
  expect(parseClaudeLine({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
  expect(parseClaudeLine({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } })).toEqual([]);
});
