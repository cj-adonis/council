import { expect, test, vi } from 'vitest';
import { makeEngine } from './helpers/engineSetup.js';
import { failEvents, workEvents } from './helpers/fakeAdapter.js';
import type { InputPrompt, InputReply, Provider } from '../src/adapters/types.js';
import path from 'node:path';
import { TabStore } from '../src/tasks/store.js';

const cases: { name: string; prompt: InputPrompt; reply: InputReply }[] = [
  {
    name: 'yes/no',
    prompt: {
      kind: 'question',
      title: 'Proceed?',
      questions: [{ id: 'proceed', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    },
    reply: { decision: 'answer', answers: { proceed: ['No'] } },
  },
  {
    name: 'single choice',
    prompt: {
      kind: 'question',
      title: 'Format',
      questions: [{ id: 'format', question: 'Which format?', options: [{ label: 'JSON' }, { label: 'Text' }] }],
    },
    reply: { decision: 'answer', answers: { format: ['JSON'] } },
  },
  {
    name: 'multiple selections',
    prompt: {
      kind: 'question',
      title: 'Targets',
      questions: [
        {
          id: 'targets',
          question: 'Which targets?',
          multiSelect: true,
          options: [{ label: 'Server' }, { label: 'Client' }, { label: 'Docs' }],
        },
      ],
    },
    reply: { decision: 'answer', answers: { targets: ['Server', 'Client'] } },
  },
  {
    name: 'custom text',
    prompt: { kind: 'question', title: 'Name', questions: [{ id: 'name', question: 'Project name?', options: [] }] },
    reply: { decision: 'answer', answers: { name: ['Custom & Unicode 日本語'] } },
  },
  {
    name: 'multiple questions',
    prompt: {
      kind: 'question',
      title: 'Setup',
      questions: [
        { id: 'one', question: 'First?', options: [{ label: 'Yes' }, { label: 'No' }] },
        { id: 'two', question: 'Second?', options: [] },
      ],
    },
    reply: { decision: 'answer', answers: { one: ['Yes'], two: ['Another answer'] } },
  },
];

test('concurrent questions are correlated by request id even when answered in reverse order', async () => {
  const { engine, adapters } = makeEngine({ stallMinutes: 0.0001 });
  const received: (InputReply | undefined)[] = [];
  adapters.claude.run = async function* (opts) {
    await Promise.all(
      ['First', 'Second'].map((title, index) =>
        opts.requestInput!({
          kind: 'question',
          title,
          questions: [{ id: 'same-id', question: title, options: [] }],
        }).then((reply) => {
          received[index] = reply;
        }),
      ),
    );
    yield* workEvents('parallel-session');
  };
  const tab = await engine.createTab('C:/proj', 'parallel');
  await engine.submit(tab.id, 'ask two questions', { kind: 'manual', provider: 'claude', model: null });
  await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(2));
  const first = tab.pendingInputs!.find((request) => request.title === 'First')!.id;
  const second = tab.pendingInputs!.find((request) => request.title === 'Second')!.id;
  await engine.answerInput(tab.id, second, { decision: 'answer', answers: { 'same-id': ['second answer'] } });
  expect(tab.pendingInputs).toHaveLength(1);
  expect(received[0]).toBeUndefined();
  expect(tab.stalled).toBe(false);
  await engine.answerInput(tab.id, first, { decision: 'answer', answers: { 'same-id': ['first answer'] } });
  await vi.waitFor(() => expect(tab.status).toBe('idle'));
  expect(received.map((reply) => reply?.answers?.['same-id'])).toEqual([['first answer'], ['second answer']]);
});

test('persisted requests from a stopped server cannot be approved after restart', async () => {
  const fixture = makeEngine();
  const tab = await fixture.engine.createTab('C:/proj', 'restart');
  tab.status = 'running';
  tab.pendingInputs = [
    {
      id: 'old-request',
      createdAt: new Date().toISOString(),
      kind: 'approval',
      title: 'Old approval',
      options: [{ id: 'once', label: 'Once', decision: 'allow' }],
    },
  ];
  await new TabStore(path.join(fixture.home, 'projects')).save(tab);
  // A fresh engine can share the same store without inheriting any live callbacks.
  const { TaskEngine } = await import('../src/tasks/engine.js');
  const { DEFAULT_PRICING } = await import('../src/ledger/pricing.js');
  const restarted = new TaskEngine({
    adapters: fixture.adapters,
    store: new TabStore(path.join(fixture.home, 'projects')),
    ledgerFile: fixture.ledgerFile,
    settings: () => fixture.settings,
    pricing: () => DEFAULT_PRICING,
  });
  const loaded = await restarted.loadProject('C:/proj');
  expect(loaded[0]?.status).toBe('failed');
  expect(loaded[0]?.pendingInputs).toEqual([]);
  await expect(restarted.answerInput(tab.id, 'old-request', { decision: 'allow', optionId: 'once' })).rejects.toThrow(
    /no longer pending/,
  );
});

for (const provider of ['claude', 'codex', 'gemini'] as Provider[]) {
  for (const scenario of cases)
    test(`${provider}: ${scenario.name} pauses, validates, and resumes the same run`, async () => {
      const { engine, adapters } = makeEngine({ stallMinutes: 0.0001 });
      let received: InputReply | undefined;
      let turns = 0;
      adapters[provider].run = async function* (opts) {
        turns++;
        yield { type: 'session', id: 'same-live-session' };
        received = await opts.requestInput!(scenario.prompt);
        yield* workEvents('same-live-session');
      };
      const tab = await engine.createTab('C:/proj', 'questions');
      await engine.submit(tab.id, 'Ask the user first', { kind: 'manual', provider, model: null });
      await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
      const requestId = tab.pendingInputs![0]!.id;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(tab.status).toBe('running');
      expect(tab.stalled).toBe(false);
      expect(received).toBeUndefined();
      await expect(engine.answerInput(tab.id, requestId, { decision: 'answer', answers: {} })).rejects.toThrow(
        /Answer required/,
      );
      await engine.answerInput(tab.id, requestId, scenario.reply);
      await vi.waitFor(() => expect(tab.status).toBe('idle'));
      expect(received).toEqual(scenario.reply);
      expect(
        tab.transcript.some((item) => item.kind === 'user' && item.text?.includes('Answers to worker questions:')),
      ).toBe(true);
      expect(turns).toBe(1);
      expect(tab.worker?.sessionId).toBe('same-live-session');
      expect(tab.pendingInputs).toEqual([]);
      await expect(engine.answerInput(tab.id, requestId, scenario.reply)).rejects.toThrow(/no longer pending/);
      expect(tab.fullAuto).toBe(false);
    });

  test(`${provider}: explicit denial is not escalated to another worker`, async () => {
    const { engine, adapters } = makeEngine({ autoEscalate: true });
    let received: InputReply | undefined;
    adapters[provider].run = async function* (opts) {
      received = await opts.requestInput!({
        kind: 'approval',
        title: 'Run command?',
        options: [{ id: 'once', label: 'Allow once', decision: 'allow' }],
      });
      yield* failEvents('denied', 'The user denied the request.');
    };
    const tab = await engine.createTab('C:/proj', 'denied');
    await engine.submit(tab.id, 'test', { kind: 'manual', provider, model: null });
    await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
    const id = tab.pendingInputs![0]!.id;
    await expect(engine.answerInput(tab.id, id, { decision: 'allow', optionId: 'always' })).rejects.toThrow(
      /Invalid approval/,
    );
    await engine.answerInput(tab.id, id, { decision: 'deny' });
    await vi.waitFor(() => expect(tab.status).toBe('failed'));
    expect(received?.decision).toBe('deny');
    expect(tab.escalations).toBe(0);
  });

  test(`${provider}: closing a pending request cancels it and rejects stale approvals`, async () => {
    const { engine, adapters } = makeEngine();
    adapters[provider].run = async function* (opts) {
      await opts.requestInput!({
        kind: 'approval',
        title: 'Approve?',
        options: [{ id: 'once', label: 'Once', decision: 'allow' }],
      });
      yield* workEvents();
    };
    const tab = await engine.createTab('C:/proj', 'close');
    await engine.submit(tab.id, 'test', { kind: 'manual', provider, model: null });
    await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
    const id = tab.pendingInputs![0]!.id;
    const other = await engine.createTab('C:/proj', 'other');
    await expect(engine.answerInput(other.id, id, { decision: 'allow', optionId: 'once' })).rejects.toThrow(
      /no longer pending/,
    );
    await engine.close(tab.id);
    expect(tab.pendingInputs).toEqual([]);
    await expect(engine.answerInput(tab.id, id, { decision: 'allow', optionId: 'once' })).rejects.toThrow(
      /no longer pending/,
    );
    await engine.delete(tab.id);
  });
}

test('secret answers reach the worker but are redacted from streamed text and tool output', async () => {
  const { engine, adapters } = makeEngine();
  let actual: InputReply | undefined;
  adapters.codex.run = async function* (opts) {
    actual = await opts.requestInput!({
      kind: 'question',
      title: 'Secret',
      questions: [{ id: 'secret', question: 'Secret?', options: [], isSecret: true }],
    });
    yield { type: 'tool_result', id: 'private-output', output: 'echo private-password-123' };
    yield* workEvents('private-session', 'Received private-password-123');
  };
  const tab = await engine.createTab('C:/proj', 'secret');
  await engine.submit(tab.id, 'test', { kind: 'manual', provider: 'codex', model: null });
  await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
  await engine.answerInput(tab.id, tab.pendingInputs![0]!.id, {
    decision: 'answer',
    answers: { secret: ['private-password-123'] },
  });
  await vi.waitFor(() => expect(tab.status).toBe('idle'));
  expect(actual?.answers?.secret).toEqual(['private-password-123']);
  expect(JSON.stringify(tab.transcript)).not.toContain('private-password-123');
  expect(JSON.stringify(tab.transcript)).toContain('[redacted]');
});
