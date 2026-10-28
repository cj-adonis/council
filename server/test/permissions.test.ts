import { expect, test, vi } from 'vitest';
import {
  PERMISSION_MODES,
  claudePermission,
  codexPermissions,
  geminiPermission,
  geminiAcpMode,
  permissionMode,
  selectedPermission,
  validatePermissionMode,
} from '../src/adapters/permissions.js';
import { makeEngine } from './helpers/engineSetup.js';
import { failEvents, workEvents } from './helpers/fakeAdapter.js';
import type { PermissionMode } from '../src/adapters/types.js';

test('native mode mappings keep planning and automatic review distinct from full access', () => {
  expect(claudePermission('default')).toBe('default');
  expect(claudePermission('plan')).toBe('plan');
  expect(claudePermission('accept-edits')).toBe('acceptEdits');
  expect(claudePermission('auto')).toBe('auto');
  expect(claudePermission('full-auto')).toBe('auto');
  expect(selectedPermission({ fullAuto: true }, 'claude')).toBe('auto');
  expect(codexPermissions('plan')).toEqual({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
  });
  expect(codexPermissions('auto')).toEqual({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  });
  expect(codexPermissions('accept-edits').approvalsReviewer).toBe('user');
  expect(codexPermissions('full-auto')).toEqual({
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'danger-full-access',
  });
  expect(geminiPermission('default')).toBe('default');
  expect(geminiPermission('plan')).toBe('plan');
  expect(geminiPermission('accept-edits')).toBe('auto_edit');
  expect(geminiAcpMode('accept-edits')).toBe('autoEdit');
  expect(geminiPermission('full-auto')).toBe('yolo');
  expect(() => geminiPermission('auto')).toThrow('explicit Claude or Codex');
  expect(() => permissionMode('yolo')).toThrow('Invalid');
  expect(() => validatePermissionMode('auto')).toThrow('explicit');
  expect(selectedPermission({ fullAuto: true, permissionMode: 'plan' })).toBe('plan');
});

for (const provider of ['claude', 'codex', 'gemini'] as const) {
  for (const mode of PERMISSION_MODES.filter((mode) => provider !== 'gemini' || mode !== 'auto')) {
    test(`${provider} ${mode}: mode reaches the worker, persists, and resumes on the same session`, async () => {
      const { engine, adapters } = makeEngine({ autoEscalate: false });
      const tab = await engine.createTab('C:/proj', 'permissions');
      await engine.submit(tab.id, 'start', { kind: 'manual', provider, model: null }, { permissionMode: mode });
      await vi.waitFor(() => expect(tab.status).toBe('idle'));
      const expectedMode = selectedPermission({ permissionMode: mode, fullAuto: false }, provider);
      expect(adapters[provider].calls[0]).toMatchObject({ permissionMode: expectedMode, fullAuto: expectedMode === 'full-auto' });
      const session = tab.worker!.sessionId;
      await engine.setPermissionMode(tab.id, 'default');
      const count = adapters[provider].calls.length;
      expect(tab.status).toBe('idle');
      await engine.send(tab.id, 'follow-up');
      await vi.waitFor(() => expect(tab.status).toBe('idle'));
      expect(adapters[provider].calls[count]).toMatchObject({
        permissionMode: 'default',
        resumeId: session,
        fullAuto: false,
      });
      await engine.close(tab.id);
    });
  }
}

test('a running mode change queues the next turn when the adapter has no live control', async () => {
  const { engine, adapters } = makeEngine();
  let received: unknown;
  const original = adapters.codex.run.bind(adapters.codex);
  adapters.codex.run = async function* (opts) {
    received = opts;
    await opts.requestInput!({
      kind: 'approval',
      title: 'Write a file',
      options: [{ id: 'allow', label: 'Allow once', decision: 'allow' }],
    });
    yield* workEvents('pending-session');
  };
  const tab = await engine.createTab('C:/proj', 'pending');
  await engine.submit(
    tab.id,
    'start',
    { kind: 'manual', provider: 'codex', model: null },
    { permissionMode: 'default' },
  );
  await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
  const requestId = tab.pendingInputs![0]!.id;
  await engine.setPermissionMode(tab.id, 'full-auto');
  expect(tab.status).toBe('running');
  expect(tab.pendingInputs![0]!.id).toBe(requestId);
  expect(tab.activePermissionMode).toBe('default');
  expect(received).toMatchObject({ permissionMode: 'default', fullAuto: false });
  await engine.answerInput(tab.id, requestId, { decision: 'deny' });
  await vi.waitFor(() => expect(tab.status).toBe('idle'));
  adapters.codex.run = original;
  await engine.send(tab.id, 'next');
  await vi.waitFor(() => expect(tab.status).toBe('idle'));
  expect(adapters.codex.calls.at(-1)).toMatchObject({
    permissionMode: 'full-auto',
    fullAuto: true,
    resumeId: 'pending-session',
  });
  await engine.close(tab.id);
});

test('live Full auto updates the same run, releases approvals, and keeps questions pending', async () => {
  const { engine, adapters } = makeEngine({ autoEscalate: false });
  const apply = vi.fn(async (_mode: PermissionMode) => {});
  const approval = { kind: 'approval' as const, title: 'Run command', options: [{ id: 'once', label: 'Allow once', decision: 'allow' as const }] };
  adapters.gemini.run = async function* (opts) {
    await opts.registerPermissionMode!(apply);
    yield { type: 'session', id: 'live-session' };
    expect(await opts.requestInput!(approval)).toMatchObject({ decision: 'allow', optionId: 'once' });
    expect(await opts.requestInput!(approval)).toMatchObject({ decision: 'allow', optionId: 'once' });
    await opts.requestInput!({ kind: 'question', title: 'Choose', questions: [{ id: 'q', question: 'Which?', options: [] }] });
    yield* workEvents('live-session');
  };
  const tab = await engine.createTab('C:/proj', 'live permissions');
  await engine.submit(tab.id, 'start', { kind: 'manual', provider: 'gemini', model: null }, { permissionMode: 'default' });
  await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
  apply.mockRejectedValueOnce(new Error('Mode change rejected'));
  await expect(engine.setPermissionMode(tab.id, 'full-auto')).rejects.toThrow('Mode change rejected');
  expect(tab.permissionMode).toBe('default');
  expect(tab.pendingInputs![0]!.kind).toBe('approval');
  await engine.setPermissionMode(tab.id, 'full-auto');
  expect(tab.activePermissionMode).toBe('full-auto');
  expect(tab.worker!.sessionId).toBe('live-session');
  await vi.waitFor(() => expect(tab.pendingInputs![0]?.kind).toBe('question'));
  await engine.answerInput(tab.id, tab.pendingInputs![0]!.id, { decision: 'answer', answers: { q: ['A'] } });
  await vi.waitFor(() => expect(tab.status).toBe('idle'));
  expect(apply).toHaveBeenLastCalledWith('full-auto');
  await engine.close(tab.id);
});

test('Gemini question server session approval enables live Full auto without answering questions', async () => {
  const { engine, adapters } = makeEngine({ autoEscalate: false });
  const apply = vi.fn(async (_mode: PermissionMode) => {});
  adapters.gemini.run = async function* (opts) {
    await opts.registerPermissionMode!(apply);
    await opts.requestInput!({ kind: 'approval', title: 'Allow Gemini to ask you questions', options: [
      { id: 'once', label: 'Allow once', decision: 'allow' },
      { id: 'server', label: 'Allow all server tools for this session', decision: 'allow' },
    ] });
    await opts.requestInput!({ kind: 'question', title: 'Choose', questions: [{ id: 'q', question: 'Which?', options: [] }] });
    yield* workEvents('session');
  };
  const tab = await engine.createTab('C:/proj', 'approval');
  await engine.submit(tab.id, 'start', { kind: 'manual', provider: 'gemini', model: null }, { permissionMode: 'default' });
  await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
  await engine.answerInput(tab.id, tab.pendingInputs![0]!.id, { decision: 'allow', optionId: 'server' });
  expect(apply).toHaveBeenCalledWith('full-auto');
  expect(tab.permissionMode).toBe('full-auto');
  expect(tab.activePermissionMode).toBe('full-auto');
  await vi.waitFor(() => expect(tab.pendingInputs?.[0]?.kind).toBe('question'));
  await engine.answerInput(tab.id, tab.pendingInputs![0]!.id, { decision: 'answer', answers: { q: ['A'] } });
  await vi.waitFor(() => expect(tab.status).toBe('idle'));
});

test('worker and model choices are remembered without spreading full auto to another model', async () => {
  const { engine } = makeEngine();
  const tab = await engine.createTab('C:/proj', 'models');
  await engine.submit(
    tab.id,
    'start',
    { kind: 'manual', provider: 'claude', model: 'first' },
    { permissionMode: 'full-auto' },
  );
  await vi.waitFor(() => expect(tab.status).toBe('idle'));
  await engine.switchWorker(tab.id, 'claude', 'second');
  expect(tab.permissionMode).toBe('accept-edits');
  expect(tab.fullAuto).toBe(false);
  await engine.setPermissionMode(tab.id, 'plan');
  await engine.switchWorker(tab.id, 'claude', 'third');
  expect(tab.permissionMode).toBe('plan');
  await engine.switchWorker(tab.id, 'claude', 'first');
  expect(tab.permissionMode).toBe('auto');
  await engine.switchWorker(tab.id, 'claude', 'second');
  expect(tab.permissionMode).toBe('plan');
  await engine.close(tab.id);
});

test('unsupported modes are rejected before starting work or changing saved permissions', async () => {
  const { engine, adapters } = makeEngine();
  const tab = await engine.createTab('C:/proj', 'invalid');
  await expect(
    engine.submit(tab.id, 'work', { kind: 'manual', provider: 'gemini', model: null }, { permissionMode: 'auto' }),
  ).rejects.toThrow('explicit');
  expect(tab.status).toBe('drafting');
  expect(adapters.gemini.calls).toHaveLength(0);
  await expect(engine.setPermissionMode(tab.id, 'invalid' as PermissionMode)).rejects.toThrow('Invalid');
  await engine.close(tab.id);
  await expect(engine.setPermissionMode(tab.id, 'full-auto')).rejects.toThrow();
});

for (const mode of ['auto', 'plan'] as const)
  test(mode + ' failures stay on the chosen worker for review', async () => {
    const { engine, adapters } = makeEngine({ autoEscalate: true });
    adapters.gemini.run = async function* () {
      yield* failEvents('failed-mode', 'Mode is unavailable');
    };
    adapters.codex.run = async function* () {
      yield* failEvents('failed-mode', 'Mode is unavailable');
    };
    const tab = await engine.createTab('C:/proj', 'failed mode');
    await engine.submit(
      tab.id,
      'work',
      { kind: 'manual', provider: mode === 'auto' ? 'codex' : 'gemini', model: null },
      { permissionMode: mode },
    );
    await vi.waitFor(() => expect(tab.status).toBe('failed'));
    expect(tab.escalations).toBe(0);
    expect(tab.permissionMode).toBe(mode);
    await engine.close(tab.id);
  });
