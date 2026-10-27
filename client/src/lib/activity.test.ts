import { expect, test } from 'vitest';
import type { TranscriptItem } from '../types';
import { groupActivity, isThinking, runLabel, summarizeRun } from './activity';

const t = (id: string, name: string, input: unknown, output?: string, isError?: boolean): TranscriptItem => ({ id, ts: 't', kind: 'tool', tool: { name, input, output, isError } });

test('consecutive tool calls fold into one run between other items', () => {
  const items: TranscriptItem[] = [
    { id: 'u', ts: 't', kind: 'user', text: 'go' },
    t('1', 'Read', { file_path: 'a.ts' }, 'x'),
    t('2', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b\nc' }, 'ok'),
    { id: 'a', ts: 't', kind: 'assistant', text: 'done' },
    t('3', 'Bash', { command: 'npm test' }),
  ];
  const blocks = groupActivity(items);
  expect(blocks.map((b) => b.kind)).toEqual(['item', 'run', 'item', 'run']);
  const run = blocks[1];
  expect(run?.kind === 'run' && run.id).toBe('1');
  expect(run?.kind === 'run' && run.items.map((i) => i.id)).toEqual(['1', '2']);
  expect(run?.kind === 'run' && run.summary).toEqual({ calls: 2, files: ['a.ts'], commands: 0, reads: 1, failed: 0, running: 0, added: 2, removed: 1 });
  const last = blocks[3];
  expect(last?.kind === 'run' && last.summary.running).toBe(1);
});

test('summarizeRun counts commands, failures and codex file changes', () => {
  const s = summarizeRun([t('1', 'command_execution', { command: 'ls' }, '', true), t('2', 'file_change', [{ path: 'x', kind: 'add' }, { path: 'y', kind: 'update' }], 'ok'), t('3', 'Write', { file_path: 'x', content: 'l1\nl2' }, 'ok')]);
  expect(s).toMatchObject({ calls: 3, files: ['x', 'y'], commands: 1, failed: 1, added: 2 });
});

test('runLabel reads naturally', () => {
  expect(runLabel({ calls: 4, files: ['a', 'b'], commands: 1, reads: 1, failed: 0, running: 0, added: 1, removed: 0 })).toBe('4 tool calls · 2 files edited · 1 command');
  expect(runLabel({ calls: 1, files: [], commands: 0, reads: 1, failed: 0, running: 0, added: 0, removed: 0 })).toBe('1 tool call · read 1 file');
  expect(runLabel({ calls: 2, files: [], commands: 2, reads: 0, failed: 1, running: 0, added: 0, removed: 0 })).toBe('2 tool calls · 2 commands · 1 failed');
});

test('an empty transcript has no blocks', () => {
  expect(groupActivity([])).toEqual([]);
});

test('isThinking indicates worker activity when running unless tool is active', () => {
  const userItems: TranscriptItem[] = [{ id: 'u', ts: 't', kind: 'user', text: 'hello' }];
  expect(isThinking(false, userItems)).toBe(false);
  expect(isThinking(true, userItems)).toBe(true);
  expect(isThinking(true, [])).toBe(true);

  // When a tool call is actively running, isThinking is false because ActivityRun handles progress
  const runningToolItems: TranscriptItem[] = [...userItems, t('tool-1', 'Bash', { command: 'ls' })];
  expect(isThinking(true, runningToolItems)).toBe(false);

  // Once tool finishes, isThinking becomes true while worker processes next step
  const completedToolItems: TranscriptItem[] = [...userItems, t('tool-1', 'Bash', { command: 'ls' }, 'output')];
  expect(isThinking(true, completedToolItems)).toBe(true);
});
