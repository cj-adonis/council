import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { Adapter, AdapterEvent, Provider, RunOptions } from '../src/adapters/types.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/config/settings.js';
import { DEFAULT_PRICING } from '../src/ledger/pricing.js';
import { readEntries } from '../src/ledger/ledger.js';
import { TaskEngine, hasChoicePrompt } from '../src/tasks/engine.js';
import { TabStore } from '../src/tasks/store.js';
import type { Tab } from '../src/tasks/types.js';
import type { TabStatus } from '../src/tasks/state.js';
import { FakeAdapter, failEvents, registry, voteEvents, workEvents, type FakeScript } from './helpers/fakeAdapter.js';

type Scripts = Partial<Record<'vote' | 'work' | 'summarize', FakeScript>>;

test('a worker reporting Task blocked cannot appear to have completed successfully', async () => {
  const { engine } = setup({ settings: { autoEscalate: false }, adapters: { gemini: scripted('gemini', 'easy', { work: { events: workEvents('blocked-session', 'Task blocked: required tool is unavailable.') } }) } });
  const tab = await engine.createTab('C:/proj', 'blocked output');
  await engine.submit(tab.id, 'do task', { kind: 'manual', provider: 'gemini', model: null });
  const failed = await waitFor(engine, tab.id, ['failed']);
  expect(failed.transcript.find((item) => item.kind === 'result')?.data).toMatchObject({ isError: true });
});

test('answering a model question resumes its session without escalation or a new vote', async () => {
  let turns = 0;
  const gemini = new FakeAdapter('gemini', () => ({ events: workEvents('question-session', ++turns === 1 ? 'Which approach do you prefer?\n1. Add a cache\n2. Query directly' : 'Implemented your selected approach.') }));
  const { engine } = setup({ adapters: { gemini } });
  const tab = await engine.createTab('C:/proj', 'question');
  await engine.submit(tab.id, 'implement lookup', { kind: 'manual', provider: 'gemini', model: null });
  await waitFor(engine, tab.id, ['idle']);
  expect(engine.getTab(tab.id)?.escalations).toBe(0);
  expect(gemini.calls).toHaveLength(1);
  await engine.send(tab.id, 'Add a cache');
  const done = await waitFor(engine, tab.id, ['idle']);
  expect(gemini.calls).toHaveLength(2);
  expect(gemini.calls[1]).toMatchObject({ purpose: 'work', resumeId: 'question-session', prompt: expect.stringContaining('Add a cache') });
  expect(done.escalations).toBe(0);
});

test('failed votes pause automatic start and require an explicit worker pick', async () => {
  const noVote = { events: failEvents('v', 'model unavailable') };
  const { engine, adapters } = setup({ settings: { autoStart: true }, adapters: { gemini: scripted('gemini', 'easy', { vote: noVote }), codex: scripted('codex', 'easy', { vote: noVote }), claude: scripted('claude', 'hard', { vote: noVote }) } });
  const tab = await engine.createTab('C:/proj', 'no votes');
  await engine.submit(tab.id, 'fix this', { kind: 'auto' });
  const paused = await waitFor(engine, tab.id, ['awaiting-start']);
  expect(paused.vote?.requiresConfirmation).toBe(true);
  expect(Object.values(adapters).flatMap((a) => a.calls).filter((c) => c.purpose === 'work')).toHaveLength(0);
  await expect(engine.start(tab.id)).rejects.toThrow(/Choose a worker/);
  await engine.start(tab.id, { provider: 'codex', model: null });
  await waitFor(engine, tab.id, ['idle']);
});

test('permission-blocked tools cannot finish successfully or auto-escalate', async () => {
  const events: AdapterEvent[] = [
    { type: 'tool', id: 'write', name: 'Write', input: {} },
    { type: 'tool_result', id: 'write', output: 'Claude requested permissions to write, but you have not granted them.', isError: true },
    { type: 'result', usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 4 }, costUsd: 0.001, exitCode: 0, isError: false, text: "I couldn't edit the file because I need your permission." },
  ];
  const { engine, ledgerFile } = setup({ adapters: { gemini: scripted('gemini', 'easy', { work: { events } }) } });
  const tab = await engine.createTab('C:/proj', 'blocked');
  await engine.submit(tab.id, 'edit file', { kind: 'manual', provider: 'gemini', model: null });
  const failed = await waitFor(engine, tab.id, ['failed']);
  expect(failed.escalations).toBe(0);
  expect(failed.transcript.find((i) => i.kind === 'result')?.data).toMatchObject({ isError: true });
  expect(failed.transcript.some((i) => i.kind === 'error' && i.text?.includes('permissions blocked'))).toBe(true);
  expect((await readEntries(ledgerFile)).filter((e) => e.purpose === 'work')).toHaveLength(1);
});

test('successful recovery from a denied tool can still complete the task', async () => {
  const events: AdapterEvent[] = [
    { type: 'tool_result', id: 'denied', output: 'permission denied', isError: true },
    { type: 'tool_result', id: 'allowed', output: 'file updated', isError: false },
    ...workEvents('recovered', 'Updated the file and verified the result.'),
  ];
  const { engine } = setup({ adapters: { gemini: scripted('gemini', 'easy', { work: { events } }) } });
  const tab = await engine.createTab('C:/proj', 'recovered');
  await engine.submit(tab.id, 'edit file', { kind: 'manual', provider: 'gemini', model: null });
  await waitFor(engine, tab.id, ['idle']);
});

test('fatal stream errors cannot be masked by a nominally successful result', async () => {
  const events: AdapterEvent[] = [{ type: 'error', message: 'Authentication failed' }, ...workEvents()];
  const { engine } = setup({ settings: { autoEscalate: false }, adapters: { gemini: scripted('gemini', 'easy', { work: { events } }) } });
  const tab = await engine.createTab('C:/proj', 'fatal');
  await engine.submit(tab.id, 'edit', { kind: 'manual', provider: 'gemini', model: null });
  const failed = await waitFor(engine, tab.id, ['failed']);
  expect(failed.transcript.find((i) => i.kind === 'result')?.data).toMatchObject({ isError: true });
});

test('closing an unresponsive adapter finishes without waiting for its iterator', async () => {
  const hanging = scripted('gemini', 'easy');
  hanging.run = async function* () { yield { type: 'session', id: 'hanging' }; await new Promise(() => {}); };
  const { engine } = setup({ adapters: { gemini: hanging } });
  const tab = await engine.createTab('C:/proj', 'hang');
  await engine.submit(tab.id, 'edit', { kind: 'manual', provider: 'gemini', model: null });
  const started = Date.now();
  await engine.close(tab.id);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(engine.getTab(tab.id)?.status).toBe('closed');
  await engine.delete(tab.id);
});

test('streamed Markdown is assembled into one message and bursts are batched', async () => {
  const text = '```ts\nconst answer = 42;\n```';
  const gemini = scripted('gemini', 'easy', { work: { events: [
    ...Array.from(text, (part): AdapterEvent => ({ type: 'text', text: part, delta: true })),
    { type: 'result', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, exitCode: 0, isError: false, text },
  ] } });
  const { engine } = setup({ adapters: { gemini } });
  const tab = await engine.createTab('C:/proj', 'stream');
  const updates: { id: string; text: string }[] = [];
  engine.on('item', ({ item }) => {
    if (item.kind === 'assistant') updates.push({ id: item.id, text: item.text });
  });
  await engine.submit(tab.id, 'write code', { kind: 'manual', provider: 'gemini', model: null });
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(idle.transcript.filter((item) => item.kind === 'assistant').map((item) => item.text)).toEqual([text]);
  expect(updates).toHaveLength(2);
  expect(updates[0]?.text).toBe('`');
  expect(updates[1]).toEqual({ id: updates[0]?.id, text });
});

test('successful final-only answers are displayed on every turn', async () => {
  const gemini = scripted('gemini', 'easy', { work: { events: [
    { type: 'result', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, exitCode: 0, isError: false, text: 'Final answer' },
  ] } });
  const { engine } = setup({ adapters: { gemini } });
  const tab = await engine.createTab('C:/proj', 'final');
  await engine.submit(tab.id, 'answer', { kind: 'manual', provider: 'gemini', model: null });
  await waitFor(engine, tab.id, ['idle']);
  await engine.send(tab.id, 'answer again');
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(idle.transcript.filter((item) => item.kind === 'assistant').map((item) => item.text))
    .toEqual(['Final answer', 'Final answer']);
});

test('final text completes a truncated stream without duplicating the reply', async () => {
  const gemini = scripted('gemini', 'easy', { work: { events: [
    { type: 'text', text: 'Partial', delta: true },
    { type: 'result', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, exitCode: 0, isError: false, text: 'Partial answer completed' },
  ] } });
  const { engine } = setup({ adapters: { gemini } });
  const tab = await engine.createTab('C:/proj', 'partial');
  await engine.submit(tab.id, 'answer', { kind: 'manual', provider: 'gemini', model: null });
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(idle.transcript.filter((item) => item.kind === 'assistant').map((item) => item.text))
    .toEqual(['Partial answer completed']);
});

test('delta text stays separated by tools and follow-up turns', async () => {
  const gemini = scripted('gemini', 'easy', { work: { events: [
    { type: 'text', text: 'Before', delta: true },
    { type: 'tool', id: 't1', name: 'Read', input: {} },
    { type: 'tool_result', id: 't1', output: 'ok' },
    { type: 'text', text: 'After', delta: true },
    { type: 'result', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, exitCode: 0, isError: false, text: 'BeforeAfter' },
  ] } });
  const { engine } = setup({ adapters: { gemini } });
  const tab = await engine.createTab('C:/proj', 'tools');
  await engine.submit(tab.id, 'answer', { kind: 'manual', provider: 'gemini', model: null });
  await waitFor(engine, tab.id, ['idle']);
  await engine.send(tab.id, 'continue');
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(idle.transcript.filter((item) => item.kind === 'assistant').map((item) => item.text))
    .toEqual(['Before', 'After', 'Before', 'After']);
});

function summaryEvents(text: string): AdapterEvent[] {
  return [
    { type: 'text', text },
    { type: 'result', usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 20 }, costUsd: 0.0005, exitCode: 0, isError: false, text },
  ];
}

function scripted(provider: Provider, tier: string, scripts: Scripts = {}): FakeAdapter {
  return new FakeAdapter(provider, (opts: RunOptions) => {
    if (opts.purpose === 'vote') return scripts.vote ?? { events: voteEvents(tier) };
    if (opts.purpose === 'summarize') return scripts.summarize ?? { events: summaryEvents('SUMMARY TEXT') };
    return scripts.work ?? { events: workEvents(`${provider}-session`, `${provider} did it`) };
  });
}

interface Setup {
  engine: TaskEngine;
  ledgerFile: string;
  adapters: Record<Provider, FakeAdapter>;
}

function setup(opts: { settings?: Partial<Settings>; adapters?: Partial<Record<Provider, FakeAdapter>>; health?: Partial<Record<Provider, boolean>> } = {}): Setup {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'council-engine-'));
  const ledgerFile = path.join(home, 'ledger.jsonl');
  const adapters: Record<Provider, FakeAdapter> = {
    gemini: opts.adapters?.gemini ?? scripted('gemini', 'easy'),
    codex: opts.adapters?.codex ?? scripted('codex', 'easy'),
    claude: opts.adapters?.claude ?? scripted('claude', 'hard'),
  };
  const settings: Settings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const engine = new TaskEngine({
    adapters: registry(adapters.claude, adapters.codex, adapters.gemini) as Record<Provider, Adapter>,
    diffStat: async () => ' a.txt | 1 +',
    store: new TabStore(path.join(home, 'projects')),
    ledgerFile,
    settings: () => settings,
    pricing: () => DEFAULT_PRICING,
    snapshot: async () => 'Top-level: src/',
    health: () =>
      Object.fromEntries(
        (['claude', 'codex', 'gemini'] as Provider[]).map((p) => [p, { installed: opts.health?.[p] ?? true, authed: true }]),
      ),
  });
  engine.on('engine-error', () => {});
  return { engine, ledgerFile, adapters };
}

function waitFor(engine: TaskEngine, tabId: string, statuses: TabStatus[], timeoutMs = 5000): Promise<Tab> {
  return new Promise((resolve, reject) => {
    const current = engine.getTab(tabId);
    if (current && statuses.includes(current.status)) return resolve(current);
    const timer = setTimeout(() => {
      engine.off('tab', onTab);
      reject(new Error(`timed out waiting for ${statuses.join('|')}; tab is ${engine.getTab(tabId)?.status}`));
    }, timeoutMs);
    const onTab = (tab: Tab) => {
      if (tab.id === tabId && statuses.includes(tab.status)) {
        clearTimeout(timer);
        engine.off('tab', onTab);
        resolve(tab);
      }
    };
    engine.on('tab', onTab);
  });
}

test('auto submit: council votes, tab waits for start, then the worker streams to idle and everything is ledgered', async () => {
  const { engine, ledgerFile, adapters } = setup();
  const tab = await engine.createTab('C:/proj', 'Rename foo');
  await engine.submit(tab.id, 'Rename foo to bar in src/a.ts', { kind: 'auto' });
  const voted = await waitFor(engine, tab.id, ['awaiting-start']);
  expect(voted.complexity).toBe(2);
  expect(voted.vote?.seats).toHaveLength(3);
  expect(voted.worker).toEqual({ provider: 'gemini', model: 'flash-lite', sessionId: null });
  expect(voted.transcript.map((i) => i.kind)).toEqual(['user', 'vote']);
  const votes = await readEntries(ledgerFile);
  expect(votes).toHaveLength(3);
  expect(votes.every((e) => e.purpose === 'vote' && e.tabId === tab.id && e.projectId === tab.projectId)).toBe(true);

  await engine.start(tab.id);
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(idle.worker?.sessionId).toBe('gemini-session');
  const kinds = idle.transcript.map((i) => i.kind);
  expect(kinds).toEqual(['user', 'vote', 'assistant', 'tool', 'result']);
  const toolItem = idle.transcript.find((i) => i.kind === 'tool');
  expect(toolItem?.tool).toMatchObject({ name: 'Write', output: 'ok' });
  const all = await readEntries(ledgerFile);
  expect(all.filter((e) => e.purpose === 'work')).toHaveLength(1);
  expect(idle.costUsd).toBeCloseTo(0.001 * 3 + 0.01, 6);
  const workCall = adapters.gemini.calls.find((c) => c.purpose === 'work');
  expect(workCall).toMatchObject({ cwd: 'C:/proj', model: 'flash-lite', prompt: expect.stringContaining('Rename foo to bar in src/a.ts'), fullAuto: false });
  expect(workCall?.prompt).toContain('Do not repeat a denied action unchanged');
  expect(workCall?.resumeId).toBeUndefined();
  expect(workCall?.allowedCommands).toEqual(DEFAULT_SETTINGS.allowedCommands);
});

test('autoStart skips the pause and runs straight after the vote', async () => {
  const { engine } = setup({ settings: { autoStart: true } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'do it', { kind: 'auto' });
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(idle.worker?.provider).toBe('gemini');
  expect(idle.transcript.some((i) => i.kind === 'result')).toBe(true);
});

test('recoverable provider warnings remain visible without displaying worker errors', async () => {
  const gemini = scripted('gemini', 'easy', { work: { events: [
    { type: 'error', message: 'Using required managed permissions', severity: 'warning' },
    ...workEvents('warning-session', 'PROMPT_OK'),
  ] } });
  const { engine } = setup({ adapters: { gemini } });
  const tab = await engine.createTab('C:/proj', 'warning');
  await engine.submit(tab.id, 'Reply PROMPT_OK', { kind: 'manual', provider: 'gemini', model: null });
  const done = await waitFor(engine, tab.id, ['idle']);
  expect(done.transcript.filter((item) => item.kind === 'error')).toEqual([]);
  expect(done.transcript.some((item) => item.kind === 'system' && item.text === 'Warning: Using required managed permissions')).toBe(true);
  expect(done.transcript.some((item) => item.kind === 'assistant' && item.text === 'PROMPT_OK')).toBe(true);
});

test('manual submit skips the council and derives the tier from the chosen provider', async () => {
  const { engine, ledgerFile } = setup();
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'do it', { kind: 'manual', provider: 'claude', model: 'claude-sonnet-5-5' }, { fullAuto: true });
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(idle.vote).toBeNull();
  expect(idle.worker).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', sessionId: 'claude-session' });
  expect(idle.fullAuto).toBe(false);
  expect(idle.permissionMode).toBe('auto');
  const entries = await readEntries(ledgerFile);
  expect(entries.map((e) => e.purpose)).toEqual(['work']);
});

test('a follow-up message resumes the worker session', async () => {
  const { engine, adapters } = setup({ settings: { autoStart: true } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'first', { kind: 'auto' });
  await waitFor(engine, tab.id, ['idle']);
  await engine.send(tab.id, 'and also this');
  await waitFor(engine, tab.id, ['running']);
  const idle = await waitFor(engine, tab.id, ['idle']);
  const calls = adapters.gemini.calls.filter((c) => c.purpose === 'work');
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ prompt: expect.stringContaining('and also this'), resumeId: 'gemini-session', model: 'flash-lite' });
  expect(idle.transcript.filter((i) => i.kind === 'user').map((i) => i.text)).toEqual(['first', 'and also this']);
});

test('a worker failure auto-escalates once with a summary hand-off, and a second failure stops', async () => {
  const gemini = scripted('gemini', 'easy', { work: { events: failEvents('g-sess', 'gemini exploded') } });
  const codex = scripted('codex', 'easy', { work: { events: failEvents('c-sess', 'codex exploded') } });
  const { engine, ledgerFile } = setup({ settings: { autoStart: true }, adapters: { gemini, codex } });
  const tab = await engine.createTab('C:/proj', 'Hard thing');
  await engine.submit(tab.id, 'Hard thing please', { kind: 'auto' });
  const failed = await waitFor(engine, tab.id, ['failed'], 8000);
  expect(failed.worker?.provider).toBe('codex');
  expect(failed.escalations).toBe(1);
  expect(failed.previousWorkers).toEqual([{ provider: 'gemini', model: 'flash-lite', sessionId: 'g-sess' }]);
  const handoff = codex.calls.find((c) => c.purpose === 'work');
  expect(handoff?.prompt).toContain('SUMMARY TEXT');
  expect(handoff?.prompt).toContain(' a.txt | 1 +');
  expect(handoff?.prompt).toContain('Hard thing please');
  expect(handoff?.resumeId).toBeUndefined();
  const purposes = (await readEntries(ledgerFile)).map((e) => e.purpose);
  expect(purposes.filter((p) => p === 'summarize')).toHaveLength(1);
  expect(purposes.filter((p) => p === 'work')).toHaveLength(2);
  expect(failed.transcript.filter((i) => i.kind === 'system').length).toBeGreaterThan(0);
});

test('a worker failure does not auto-escalate if the assistant output presents a choice to the user', async () => {
  const choiceText = 'Found two possible migrations. Which option would you like to run?\n1. Reset database\n2. Skip migration';
  const gemini = scripted('gemini', 'easy', {
    work: {
      events: [
        { type: 'session', id: 'g-choice-sess' },
        { type: 'text', text: choiceText },
        { type: 'result', usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 }, costUsd: 0.001, exitCode: 1, isError: true, text: choiceText },
      ],
    },
  });
  const codex = scripted('codex', 'easy', { work: { events: workEvents('c-sess', 'codex did it') } });
  const { engine } = setup({ settings: { autoStart: true }, adapters: { gemini, codex } });
  const tab = await engine.createTab('C:/proj', 'Migration task');
  await engine.submit(tab.id, 'Run migrations', { kind: 'auto' });
  const failed = await waitFor(engine, tab.id, ['failed'], 5000);
  expect(failed.worker?.provider).toBe('gemini');
  expect(failed.escalations).toBe(0);
  expect(codex.calls.filter((c) => c.purpose === 'work')).toHaveLength(0);
});

test('send on a failed tab without a worker recovers by assigning an available seat', async () => {
  const { engine } = setup();
  const tab = await engine.createTab('C:/proj', 'No worker task');
  tab.status = 'failed';
  tab.worker = null;
  await engine.send(tab.id, 'Try again with fallback');
  const running = await waitFor(engine, tab.id, ['running', 'idle']);
  expect(running.worker).not.toBeNull();
  expect(running.worker?.provider).toBe('gemini');
});


test('autoEscalate off leaves the tab failed on the first worker', async () => {
  const gemini = scripted('gemini', 'easy', { work: { events: failEvents() } });
  const { engine } = setup({ settings: { autoStart: true, autoEscalate: false }, adapters: { gemini } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'x', { kind: 'auto' });
  const failed = await waitFor(engine, tab.id, ['failed']);
  expect(failed.worker?.provider).toBe('gemini');
  expect(failed.escalations).toBe(0);
});

test('switching provider hands off with a summary and keeps the old session for switching back', async () => {
  const { engine, adapters } = setup({ settings: { autoStart: true } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'start', { kind: 'auto' });
  await waitFor(engine, tab.id, ['idle']);

  await engine.switchWorker(tab.id, 'claude', 'claude-sonnet-5-5');
  const onClaude = await waitFor(engine, tab.id, ['idle']);
  expect(onClaude.worker).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5', sessionId: 'claude-session' });
  expect(onClaude.previousWorkers).toEqual([{ provider: 'gemini', model: 'flash-lite', sessionId: 'gemini-session' }]);
  expect(onClaude.escalations).toBe(0);
  const claudeCall = adapters.claude.calls.find((c) => c.purpose === 'work');
  expect(claudeCall?.prompt).toContain('SUMMARY TEXT');
  expect(claudeCall?.resumeId).toBeUndefined();

  await engine.switchWorker(tab.id, 'gemini', 'flash');
  await waitFor(engine, tab.id, ['running']);
  const back = await waitFor(engine, tab.id, ['idle']);
  const geminiWork = adapters.gemini.calls.filter((c) => c.purpose === 'work');
  expect(geminiWork[1]?.resumeId).toBe('gemini-session');
  expect(back.worker?.provider).toBe('gemini');
});

test('changing only the model keeps the session and takes effect on the next message', async () => {
  const { engine, adapters } = setup({ settings: { autoStart: true } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'start', { kind: 'auto' });
  await waitFor(engine, tab.id, ['idle']);
  const changed = await engine.switchWorker(tab.id, 'gemini', 'pro');
  expect(changed.status).toBe('idle');
  expect(changed.worker).toEqual({ provider: 'gemini', model: 'pro', sessionId: 'gemini-session' });
  expect(changed.previousWorkers).toEqual([]);
  await engine.send(tab.id, 'next');
  await waitFor(engine, tab.id, ['running']);
  await waitFor(engine, tab.id, ['idle']);
  const calls = adapters.gemini.calls.filter((c) => c.purpose === 'work');
  expect(calls[1]).toMatchObject({ model: 'pro', resumeId: 'gemini-session' });
});

test('clearContext resets worker session and resets chat transcript to a single system notice', async () => {
  const { engine, adapters } = setup({ settings: { autoStart: true } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'start', { kind: 'auto' });
  await waitFor(engine, tab.id, ['idle']);
  expect(tab.transcript.length).toBeGreaterThan(1);
  expect(tab.worker?.sessionId).toBe('gemini-session');
  expect(tab.vote).not.toBeNull();

  const cleared = await engine.clearContext(tab.id);
  expect(cleared.status).toBe('drafting');
  expect(cleared.worker).toBeNull();
  expect(cleared.tier).toBeNull();
  expect(cleared.transcript.length).toBe(1);
  expect(cleared.transcript[0]?.kind).toBe('system');
  expect(cleared.transcript[0]?.text).toContain('Context cleared');
  expect(cleared.vote).toBeNull();
  expect(cleared.routing).toBeNull();

  // Next message in auto mode triggers council vote again
  await engine.submit(tab.id, 'brand new task', { kind: 'auto' });
  await waitFor(engine, tab.id, ['idle']);
  expect(tab.vote).not.toBeNull();
  const voteCalls = adapters.gemini.calls.filter((c) => c.purpose === 'vote');
  expect(voteCalls.length).toBe(2);
});

test('clearContext can be called on a drafting tab or awaiting-start tab', async () => {
  const { engine } = setup({ settings: { autoStart: false } });
  const tab = await engine.createTab('C:/proj', 't');
  expect(tab.status).toBe('drafting');

  // Can clear drafting tab
  const cleared1 = await engine.clearContext(tab.id);
  expect(cleared1.status).toBe('drafting');
  expect(cleared1.transcript.length).toBe(1);

  // Submit task with autoStart: false -> lands in awaiting-start
  await engine.submit(tab.id, 'do something', { kind: 'auto' });
  await waitFor(engine, tab.id, ['awaiting-start']);

  // Can clear awaiting-start tab
  const cleared2 = await engine.clearContext(tab.id);
  expect(cleared2.status).toBe('drafting');
  expect(cleared2.vote).toBeNull();
  expect(cleared2.transcript.length).toBe(1);
});

test('hasChoicePrompt identifies choice prompts correctly', () => {
  expect(hasChoicePrompt(undefined)).toBe(false);
  expect(hasChoicePrompt('')).toBe(false);
  expect(hasChoicePrompt('Failed with exit code 1')).toBe(false);
  expect(hasChoicePrompt('Error: syntax error at line 42')).toBe(false);

  // Numbered list
  expect(hasChoicePrompt('Found two options:\n1. Reset database\n2. Skip migration')).toBe(true);

  // Choice keywords with question mark
  expect(hasChoicePrompt('Which option do you prefer?')).toBe(true);
  expect(hasChoicePrompt('Please choose one: A or B')).toBe(true);
  expect(hasChoicePrompt('Would you like to continue?')).toBe(true);
  expect(hasChoicePrompt('Should I delete the existing file?')).toBe(true);
});

test('engine.send updates fullAuto flag and passes it to worker', async () => {
  const { engine, adapters } = setup({ settings: { autoStart: true } });
  const tab = await engine.createTab('C:/proj', 'Full auto test');
  await engine.submit(tab.id, 'first step', { kind: 'auto' });
  await waitFor(engine, tab.id, ['idle']);
  expect(tab.fullAuto).toBe(false);

  await engine.send(tab.id, 'run in full auto', { fullAuto: true });
  expect(tab.fullAuto).toBe(true);
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(idle.fullAuto).toBe(true);
  const workCalls = adapters.gemini.calls.filter((c) => c.purpose === 'work');
  expect(workCalls[1]?.fullAuto).toBe(true);
});

test('engine.delete removes closed tab and throws for non-closed tabs', async () => {
  const { engine } = setup();
  const tab = await engine.createTab('C:/proj', 'Delete test');

  // Cannot delete drafting tab
  await expect(engine.delete(tab.id)).rejects.toThrow(/closed/);

  // Close tab first
  await engine.close(tab.id);

  let deletedEventTabId: string | null = null;
  engine.on('deleted', ({ tabId }: { tabId: string }) => {
    deletedEventTabId = tabId;
  });

  await engine.delete(tab.id);
  expect(deletedEventTabId).toBe(tab.id);
  expect(engine.getTab(tab.id)).toBeUndefined();
});

test('closing a running tab aborts the worker and applies no further events', async () => {
  const slow = new FakeAdapter('gemini', (opts: RunOptions) =>
    opts.purpose === 'vote' ? { events: voteEvents('easy') } : { events: workEvents(), delayMs: 150 },
  );
  const { engine } = setup({ settings: { autoStart: true }, adapters: { gemini: slow } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'go', { kind: 'auto' });
  await waitFor(engine, tab.id, ['running']);
  for (let i = 0; i < 50 && !slow.calls.some((c) => c.purpose === 'work'); i++) await new Promise((r) => setTimeout(r, 20));
  const closed = await engine.close(tab.id);
  expect(closed.status).toBe('closed');
  const workCall = slow.calls.find((c) => c.purpose === 'work');
  expect(workCall?.signal?.aborted).toBe(true);
  const count = closed.transcript.length;
  await new Promise((r) => setTimeout(r, 500));
  expect(engine.getTab(tab.id)?.transcript.length).toBe(count);
  expect(engine.getTab(tab.id)?.status).toBe('closed');
});

test('closing a tab mid-vote stops the seats instead of letting them finish and bill', async () => {
  const slowVote = (provider: 'claude' | 'codex' | 'gemini') =>
    new FakeAdapter(provider, (opts: RunOptions) =>
      opts.purpose === 'vote' ? { events: voteEvents('easy'), delayMs: 2_000 } : { events: workEvents() },
    );
  const seats = { gemini: slowVote('gemini'), codex: slowVote('codex'), claude: slowVote('claude') };
  const { engine, ledgerFile } = setup({ adapters: seats });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'go', { kind: 'auto' });
  await waitFor(engine, tab.id, ['voting']);
  for (let i = 0; i < 50 && !seats.gemini.calls.some((c) => c.purpose === 'vote'); i++) await new Promise((r) => setTimeout(r, 20));

  const started = Date.now();
  const closed = await engine.close(tab.id);
  expect(closed.status).toBe('closed');
  expect(Date.now() - started).toBeLessThan(1_500);
  for (const seat of Object.values(seats)) {
    expect(seat.calls.find((c) => c.purpose === 'vote')?.signal?.aborted).toBe(true);
  }
  expect(await readEntries(ledgerFile)).toEqual([]);
});

test('workers run in the project checkout itself; tabs carry no worktree', async () => {
  const { engine, adapters } = setup({ settings: { autoStart: true } });
  const tab = await engine.createTab('C:/proj', 'Add thing');
  await engine.submit(tab.id, 'add', { kind: 'auto' });
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect('worktree' in idle).toBe(false);
  expect(adapters.gemini.calls.every((c) => c.cwd === 'C:/proj')).toBe(true);
});

test('a silent worker trips the stall flag once, and output clears it', async () => {
  const slow = new FakeAdapter('gemini', (opts: RunOptions) =>
    opts.purpose === 'vote' ? { events: voteEvents('easy') } : { events: workEvents(), delayMs: 120 },
  );
  const { engine } = setup({ settings: { autoStart: true, stallMinutes: 0.001 }, adapters: { gemini: slow } });
  const stalls: string[] = [];
  engine.on('stall', ({ tabId }: { tabId: string }) => stalls.push(tabId));
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'x', { kind: 'auto' });
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(stalls.length).toBeGreaterThanOrEqual(1);
  expect(idle.stalled).toBe(false);
});

test('an unavailable provider drops out of the council and its tier is served by the nearest one', async () => {
  const { engine } = setup({ health: { gemini: false }, adapters: { claude: scripted('claude', 'easy') } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'tiny change', { kind: 'auto' });
  const voted = await waitFor(engine, tab.id, ['awaiting-start']);
  expect(voted.vote?.seats.map((s) => s.seat.provider)).toEqual(['codex', 'claude']);
  expect(voted.vote?.selectedSeat.provider).toBe('codex');
  expect(voted.worker).toMatchObject({ provider: 'codex', model: null });
  expect(voted.routing?.notes?.join(' ')).toMatch(/gemini/i);
});

test('an exhausted budget still shifts the tier even when every CLI is set up', async () => {
  const { engine } = setup({ settings: { budgets: { claude: 40, codex: 30, gemini: 0.0001 } } });
  const first = await engine.createTab('C:/proj', 'warm-up');
  await engine.submit(first.id, 'x', { kind: 'auto' });
  await waitFor(engine, first.id, ['awaiting-start']);
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'tiny change', { kind: 'auto' });
  const voted = await waitFor(engine, tab.id, ['awaiting-start']);
  expect(voted.worker).toMatchObject({ provider: 'codex' });
  expect(voted.routing?.reason).toMatch(/gemini/i);
});

test('a worker that exits 0 but reports failure in-band still fails the tab and is ledgered', async () => {
  const text = JSON.stringify({ tier: 'easy', confidence: 0.9, reason: 'r' });
  const inBand = new FakeAdapter('gemini', (opts: RunOptions) =>
    opts.purpose === 'vote'
      ? { events: voteEvents('easy') }
      : {
          events: [
            { type: 'session', id: 's' },
            { type: 'result', usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 1 }, costUsd: 0.002, exitCode: 0, isError: true, text: 'quota exceeded' },
          ],
        },
  );
  void text;
  const { engine, ledgerFile } = setup({ settings: { autoStart: true, autoEscalate: false }, adapters: { gemini: inBand } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'x', { kind: 'auto' });
  const failed = await waitFor(engine, tab.id, ['failed']);
  expect(failed.status).toBe('failed');
  const work = (await readEntries(ledgerFile)).filter((e) => e.purpose === 'work');
  expect(work).toHaveLength(1);
  expect(work[0]?.costUsd).toBe(0.002);
});

test('streaming many events emits few full-tab updates and clips oversized tool output', async () => {
  const events: AdapterEvent[] = [{ type: 'session', id: 's' }];
  for (let i = 0; i < 40; i++) events.push({ type: 'text', text: `chunk ${i}` });
  events.push({ type: 'tool', id: 't1', name: 'Read', input: { file_path: 'big.txt' } });
  events.push({ type: 'tool_result', id: 't1', output: 'x'.repeat(100_000) });
  events.push({ type: 'result', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }, costUsd: 0.001, exitCode: 0, isError: false, text: 'done' });
  const chatty = new FakeAdapter('gemini', (opts: RunOptions) => (opts.purpose === 'vote' ? { events: voteEvents('easy') } : { events }));
  const { engine } = setup({ settings: { autoStart: true }, adapters: { gemini: chatty } });
  let tabEmits = 0;
  let itemEmits = 0;
  engine.on('tab', () => tabEmits++);
  engine.on('item', () => itemEmits++);
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'x', { kind: 'auto' });
  const idle = await waitFor(engine, tab.id, ['idle']);
  expect(itemEmits).toBeGreaterThanOrEqual(43);
  expect(tabEmits).toBeLessThan(12);
  const toolItem = idle.transcript.find((i) => i.kind === 'tool');
  expect((toolItem?.tool?.output ?? '').length).toBeLessThan(25_000);
  expect(idle.transcript.filter((i) => i.kind === 'assistant')).toHaveLength(41);
  expect(idle.transcript.filter((i) => i.kind === 'assistant').at(-1)?.text).toBe('done');
});

test('usage windows reported by a CLI are kept per provider and exposed with the budgets', async () => {
  const windows = [{ name: '5-hour', usedPct: 0.59, resetsAt: '2026-10-21T04:30:00.000Z' }];
  const events: AdapterEvent[] = [{ type: 'session', id: 's' }, { type: 'quota', windows }, ...workEvents().slice(1)];
  const claude = new FakeAdapter('claude', (opts: RunOptions) => (opts.purpose === 'vote' ? { events: voteEvents('hard') } : { events }));
  const { engine } = setup({ settings: { autoStart: true }, adapters: { claude } });
  const seen: string[] = [];
  engine.on('quota', ({ provider }: { provider: Provider }) => seen.push(provider));
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'x', { kind: 'manual', provider: 'claude', model: null });
  await waitFor(engine, tab.id, ['idle']);
  expect(seen).toEqual(['claude']);
  expect(engine.usage().claude).toMatchObject({ windows, observedAt: expect.any(String) });
  const b = await engine.budgets();
  expect(b.claude.usage?.windows).toEqual(windows);
  expect(b.gemini.usage).toBeUndefined();
});

test('with only Claude set up, the council climbs Claude models on escalation', async () => {
  const claude = scripted('claude', 'easy');
  const { engine } = setup({ health: { gemini: false, codex: false }, adapters: { claude } });
  expect(engine.routing()).toMatchObject({ available: ['claude'] });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'small thing', { kind: 'auto' });
  const voted = await waitFor(engine, tab.id, ['awaiting-start']);
  expect(voted.worker).toMatchObject({ provider: 'claude', model: 'claude-haiku-5-5' });
  expect(voted.routing?.notes?.join(' ')).toMatch(/only claude/i);
  await engine.start(tab.id);
  await waitFor(engine, tab.id, ['idle']);
  await engine.escalate(tab.id);
  const escalated = await waitFor(engine, tab.id, ['idle']);
  expect(escalated.worker).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5' });
  const calls = claude.calls.filter((c) => c.purpose === 'work');
  expect(calls.map((c) => c.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
});

test('budgets reflect the ledger against the configured limits', async () => {
  const { engine } = setup({ settings: { autoStart: true, budgets: { claude: 40, codex: 30, gemini: 0.01 } } });
  const tab = await engine.createTab('C:/proj', 't');
  await engine.submit(tab.id, 'x', { kind: 'auto' });
  await waitFor(engine, tab.id, ['idle']);
  const b = await engine.budgets();
  expect(b.gemini.spent).toBeCloseTo(0.011, 6);
  expect(b.gemini.routingSpent).toBeCloseTo(0.001, 6);
  expect(b.gemini.exhausted).toBe(true);
  expect(b.claude.spent).toBeCloseTo(0.001, 6);
});
