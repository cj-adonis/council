import { expect, test, vi } from 'vitest';
import { makeEngine } from './helpers/engineSetup.js';
import { voteEvents, workEvents } from './helpers/fakeAdapter.js';
import type { RunOptions } from '../src/adapters/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const provider of ['claude', 'codex', 'gemini'] as const)
  test(`${provider}: Stop releases a stuck worker and stale output cannot affect the next turn`, async () => {
    const { engine, adapters } = makeEngine({ autoEscalate: true });
    const old = deferred();
    const oldFinished = deferred();
    const next = deferred();
    const calls: RunOptions[] = [];
    adapters[provider].run = async function* (opts) {
      calls.push(opts);
      if (calls.length === 1) {
        try {
          yield { type: 'session', id: 'stopped-session' };
          yield { type: 'text', text: 'Partial work' };
          await old.promise; // Deliberately ignores the abort signal.
          yield* workEvents('stale-session', 'stale output');
        } finally { oldFinished.resolve(); }
      } else {
        expect(opts.resumeId).toBe('stopped-session');
        yield { type: 'session', id: 'continued-session' };
        await next.promise;
        yield* workEvents('continued-session', 'New turn done');
      }
    };
    const tab = await engine.createTab('C:/proj', 'stuck worker');
    try {
      await engine.submit(tab.id, 'start', { kind: 'manual', provider, model: null });
      await vi.waitFor(() => expect(tab.transcript.some(item => item.text === 'Partial work')).toBe(true));
      tab.stalled = true;
      const started = Date.now();
      await engine.stop(tab.id);
      expect(Date.now() - started).toBeLessThan(1500);
      expect(calls[0]!.signal?.aborted).toBe(true);
      expect(tab.status).toBe('idle');
      expect(tab.stalled).toBe(false);
      expect(tab.escalations).toBe(0);
      expect(tab.transcript.some(item => item.text === 'Partial work')).toBe(true);
      await engine.send(tab.id, 'Try a different approach');
      await vi.waitFor(() => expect(tab.worker?.sessionId).toBe('continued-session'));
      old.resolve();
      await oldFinished.promise;
      expect(tab.status).toBe('running');
      expect(tab.activePermissionMode).toBe('accept-edits');
      expect(tab.transcript.some(item => item.text === 'stale output')).toBe(false);
      next.resolve();
      await vi.waitFor(() => expect(tab.status).toBe('idle'));
      expect(tab.worker?.sessionId).toBe('continued-session');
      expect(calls).toHaveLength(2);
    } finally {
      old.resolve(); next.resolve();
      await engine.close(tab.id);
    }
  });

test('Stop cancels pending approvals and questions and rejects obsolete answers', async () => {
  const { engine, adapters } = makeEngine();
  const replies: unknown[] = [];
  adapters.claude.run = async function* (opts) {
    replies.push(...await Promise.all([
      opts.requestInput!({ kind: 'approval', title: 'Bash', options: [{ id: 'once', label: 'Allow once', decision: 'allow' }] }),
      opts.requestInput!({ kind: 'question', title: 'Which?', questions: [{ id: 'q', question: 'Which?', options: [] }] }),
    ]));
    yield* workEvents('obsolete-session');
  };
  const tab = await engine.createTab('C:/proj', 'pending');
  await engine.submit(tab.id, 'start', { kind: 'manual', provider: 'claude', model: null });
  await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(2));
  const ids = tab.pendingInputs!.map(request => request.id);
  await engine.stop(tab.id);
  expect(tab.pendingInputs).toEqual([]);
  await vi.waitFor(() => expect(replies).toEqual([{ decision: 'deny' }, { decision: 'deny' }]));
  for (const id of ids)
    await expect(engine.answerInput(tab.id, id, { decision: 'allow', optionId: 'once' })).rejects.toThrow('no longer pending');
  expect((await engine.stop(tab.id)).status).toBe('idle');
  await engine.close(tab.id);
});

test('Stop cancels every council seat and a cancelled vote cannot auto-start after a follow-up', async () => {
  const { engine, adapters, settings } = makeEngine({ autoStart: true });
  const vote = deferred();
  const calls: RunOptions[] = [];
  let workCalls = 0;
  for (const provider of ['claude', 'codex', 'gemini'] as const) {
    adapters[provider].run = async function* (opts) {
      if (opts.purpose === 'vote') {
        calls.push(opts);
        await vote.promise;
        yield* voteEvents();
      } else { workCalls++; yield* workEvents('follow-up-session'); }
    };
  }
  const tab = await engine.createTab('C:/proj', 'stuck vote');
  try {
    await engine.submit(tab.id, 'vote', { kind: 'auto' });
    await vi.waitFor(() => expect(calls).toHaveLength(settings.seats.length));
    await engine.stop(tab.id);
    expect(calls.every(opts => opts.signal?.aborted)).toBe(true);
    await engine.send(tab.id, 'Work directly');
    vote.resolve();
    await vi.waitFor(() => expect(tab.status).toBe('idle'));
    expect(tab.vote).toBeNull();
    expect(tab.transcript.filter(item => item.kind === 'vote')).toHaveLength(0);
    expect(workCalls).toBe(1);
  } finally { vote.resolve(); await engine.close(tab.id); }
});

test('Stop cancels a handoff summary without launching the replacement worker', async () => {
  const { engine, adapters } = makeEngine();
  const summary = deferred();
  let summaryCall: RunOptions | undefined;
  let workCalls = 0;
  for (const provider of ['claude', 'codex', 'gemini'] as const) {
    adapters[provider].run = async function* (opts) {
      if (opts.purpose === 'summarize') {
        summaryCall = opts;
        await summary.promise;
        yield* workEvents('old-summary');
      } else { workCalls++; yield* workEvents(`${provider}-session`); }
    };
  }
  const tab = await engine.createTab('C:/proj', 'handoff');
  try {
    await engine.submit(tab.id, 'start', { kind: 'manual', provider: 'claude', model: null });
    await vi.waitFor(() => expect(tab.status).toBe('idle'));
    await engine.switchWorker(tab.id, 'codex', null);
    await vi.waitFor(() => expect(summaryCall).toBeDefined());
    await engine.stop(tab.id);
    expect(summaryCall!.signal?.aborted).toBe(true);
    await engine.send(tab.id, 'Use this new instruction');
    summary.resolve();
    await vi.waitFor(() => expect(tab.status).toBe('idle'));
    expect(workCalls).toBe(2);
    expect(tab.worker?.sessionId).toBe('codex-session');
  } finally { summary.resolve(); await engine.close(tab.id); }
});
