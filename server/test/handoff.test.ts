import { expect, test } from 'vitest';
import { buildHandoffPrompt, buildSummaryPrompt, mechanicalSummary } from '../src/tasks/handoff.js';
import type { TranscriptItem } from '../src/tasks/types.js';

const items: TranscriptItem[] = [
  { id: '1', ts: 't', kind: 'user', text: 'Add a login page' },
  { id: '2', ts: 't', kind: 'assistant', text: 'I will start by reading the router.' },
  { id: '3', ts: 't', kind: 'tool', tool: { name: 'Edit', input: { file_path: 'src/router.ts' }, output: 'ok' } },
  { id: '4', ts: 't', kind: 'result', text: 'Done', data: { isError: true } },
];

test('the hand-off prompt carries task, summary, diff stat, previous worker and reason, with fences', () => {
  const p = buildHandoffPrompt({
    task: 'Add a login page',
    summary: 'Edited the router; tests failed on auth.',
    diffStat: ' src/router.ts | 4 ++--',
    fromWorker: 'gemini (flash)',
    reason: 'escalate',
  });
  expect(p).toContain('Add a login page');
  expect(p).toContain('Edited the router; tests failed on auth.');
  expect(p).toContain('src/router.ts | 4 ++--');
  expect(p).toContain('gemini (flash)');
  expect(p).toMatch(/escalat/i);
  expect(p).toContain('<task>');
  expect(p).toContain('</task>');
  expect(p).toMatch(/same workspace/i);
  expect(p).toMatch(/do not commit/i);
  expect(p).toMatch(/CLAUDE\.md|AGENTS\.md|GEMINI\.md/);
});

test('a switch reads as a hand-over rather than a failure', () => {
  const p = buildHandoffPrompt({ task: 't', summary: 's', diffStat: '', fromWorker: 'codex', reason: 'switch' });
  expect(p).not.toMatch(/failed|stalled/i);
  expect(p).toMatch(/taking over|continue/i);
});

test('the summary prompt includes the transcript and asks for a short hand-off summary', () => {
  const p = buildSummaryPrompt(items);
  expect(p).toContain('Add a login page');
  expect(p).toContain('I will start by reading the router.');
  expect(p).toContain('Edit');
  expect(p).toMatch(/summar/i);
  expect(p).toContain('<transcript>');
});

test('mechanicalSummary lists what happened when no model is available to summarise', () => {
  const s = mechanicalSummary(items);
  expect(s).toContain('I will start by reading the router.');
  expect(s).toContain('Edit');
  expect(s).toMatch(/failed|error/i);
});
