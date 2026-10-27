import { expect, test, vi } from 'vitest';
const { sdk } = vi.hoisted(() => ({ sdk: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk }));
import { runClaudeInteractive } from '../src/adapters/claude-interactive.js';
import type { AdapterEvent, InputReply, RunOptions } from '../src/adapters/types.js';
import { claudePermission, PERMISSION_MODES } from '../src/adapters/permissions.js';
import { makeEngine } from './helpers/engineSetup.js';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

const bashRules: PermissionUpdate[] = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'node --version' }], behavior: 'allow', destination: 'localSettings' },
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'node --version' }], behavior: 'allow', destination: 'session' },
];

for (const mode of PERMISSION_MODES)
  test(`Claude SDK receives ${mode} on session resume`, async () => {
    sdk.mockImplementation(({ options }) => {
      expect(options.permissionMode).toBe(claudePermission(mode));
      expect(options.allowDangerouslySkipPermissions).not.toBe(true);
      expect(options.resume).toBe('saved-session');
      if (mode === 'plan') expect(options.allowedTools).toEqual([]);
      return Object.assign(
        (async function* () {
          if (mode === 'plan') {
            const result = await options.canUseTool('ExitPlanMode', {}, { signal: new AbortController().signal });
            expect(result.behavior).toBe('deny');
          }
          yield { type: 'result', result: 'done', is_error: false, usage: {} };
        })(),
        { close: vi.fn() },
      );
    });
    const ask = vi.fn();
    for await (const _ of runClaudeInteractive({
      cwd: process.cwd(),
      prompt: 'test',
      model: null,
      purpose: 'work',
      resumeId: 'saved-session',
      fullAuto: true,
      permissionMode: mode,
      allowedCommands: ['Bash(*)'],
      requestInput: ask,
    })) {
      /* drain */
    }
    expect(ask).not.toHaveBeenCalled();
  });

test('Claude native callbacks preserve yes/no, multiple choices, multi-select, and custom answers', async () => {
  let nativeReply: unknown;
  const close = vi.fn();
  sdk.mockImplementation(({ options }) => {
    const messages = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-live' };
      nativeReply = await options.canUseTool(
        'AskUserQuestion',
        {
          questions: [
            { question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
            { question: 'Format?', options: [{ label: 'JSON' }, { label: 'Text' }] },
            { question: 'Targets?', multiSelect: true, options: [{ label: 'Server' }, { label: 'Client' }] },
            { question: 'Name?', options: [] },
          ],
        },
        { signal: new AbortController().signal },
      );
      yield {
        type: 'result',
        result: 'Answers received',
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    })();
    return Object.assign(messages, { close });
  });
  const events: AdapterEvent[] = [];
  for await (const event of runClaudeInteractive({
    cwd: process.cwd(),
    prompt: 'Ask first',
    model: null,
    purpose: 'work',
    fullAuto: false,
    allowedCommands: [],
    requestInput: async (prompt) => {
      expect(prompt.questions?.map((q) => q.id)).toEqual(['0', '1', '2', '3']);
      expect(prompt.questions?.[2]?.multiSelect).toBe(true);
      return {
        decision: 'answer',
        answers: { '0': ['No'], '1': ['JSON'], '2': ['Server', 'Client'], '3': ['Custom name'] },
      };
    },
  }))
    events.push(event);
  expect(nativeReply).toMatchObject({
    behavior: 'allow',
    updatedInput: {
      answers: { 'Proceed?': 'No', 'Format?': 'JSON', 'Targets?': ['Server', 'Client'], 'Name?': 'Custom name' },
    },
  });
  expect(events.at(-1)).toMatchObject({ type: 'result', isError: false });
  expect(close).toHaveBeenCalledOnce();
});

for (const decision of ['allow', 'deny'] as const)
  test(`Claude native ${decision} is returned to the original waiting tool`, async () => {
    let result: unknown;
    sdk.mockImplementation(({ options }) =>
      Object.assign(
        (async function* () {
          result = await options.canUseTool(
            'Bash',
            { command: 'node --version' },
            { signal: new AbortController().signal },
          );
          yield { type: 'result', result: 'Done', usage: {} };
        })(),
        { close: vi.fn() },
      ),
    );
    const opts: RunOptions = {
      cwd: process.cwd(),
      prompt: 'test',
      purpose: 'work',
      model: null,
      fullAuto: false,
      allowedCommands: [],
      requestInput: async () => ({ decision, optionId: decision }) as InputReply,
    };
    for await (const _ of runClaudeInteractive(opts)) {
      /* drain */
    }
    expect(result).toMatchObject(
      decision === 'allow' ? { behavior: 'allow', updatedInput: { command: 'node --version' } } : { behavior: 'deny' },
    );
    expect(sdk.mock.calls.at(-1)?.[0].options.permissionMode).toBe('acceptEdits');
  });

test('dismissing a Claude question denies the call instead of answering for the user', async () => {
  let result: unknown;
  sdk.mockImplementation(({ options }) =>
    Object.assign(
      (async function* () {
        result = await options.canUseTool(
          'AskUserQuestion',
          { questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
          { signal: new AbortController().signal },
        );
        yield { type: 'result', result: 'Dismissed', usage: {} };
      })(),
      { close: vi.fn() },
    ),
  );
  for await (const _ of runClaudeInteractive({
    cwd: process.cwd(),
    prompt: 'test',
    purpose: 'work',
    model: null,
    fullAuto: false,
    allowedCommands: [],
    requestInput: async () => ({ decision: 'deny' }),
  })) {
    /* drain */
  }
  expect(result).toMatchObject({ behavior: 'deny' });
});

for (const choice of ['allow', 'remember-0', 'remember-1', 'deny'])
  test(`Claude Bash ${choice} returns only the selected native permission update`, async () => {
    let result: unknown;
    const ask = vi.fn(async (prompt) => {
      expect(prompt.description).toBe('This command requires approval');
      expect(prompt.options).toEqual([
        { id: 'allow', label: 'Allow once', decision: 'allow' },
        { id: 'remember-0', label: 'Always allow for this project: Bash(node --version)', decision: 'allow' },
        { id: 'remember-1', label: 'Allow for this session: Bash(node --version)', decision: 'allow' },
        { id: 'deny', label: 'Deny', decision: 'deny' },
      ]);
      return { decision: choice === 'deny' ? 'deny' as const : 'allow' as const, optionId: choice };
    });
    sdk.mockImplementation(({ options }) => Object.assign(
      (async function* () {
        result = await options.canUseTool('Bash', { command: 'node --version' }, {
          signal: new AbortController().signal, suggestions: bashRules, decisionReason: 'This command requires approval',
        });
        yield { type: 'result', result: 'Done', usage: {} };
      })(),
      { close: vi.fn() },
    ));
    for await (const _ of runClaudeInteractive({
      cwd: process.cwd(), prompt: 'test', model: null, purpose: 'work', fullAuto: false, allowedCommands: [], requestInput: ask,
    })) { /* drain */ }
    expect(ask).toHaveBeenCalledOnce();
    if (choice === 'deny') expect(result).toMatchObject({ behavior: 'deny' });
    else expect(result).toEqual({
      behavior: 'allow', updatedInput: { command: 'node --version' },
      ...(choice.startsWith('remember-') ? { updatedPermissions: [bashRules[Number(choice.slice(9))]] } : {}),
    });
    if (choice === 'deny') expect(result).not.toHaveProperty('updatedPermissions');
  });

for (const scenario of [
  { name: 'no native suggestions', suggestions: [] },
  { name: 'native suppression', suggestions: bashRules, suppressAlwaysAllowRule: true },
  { name: 'mode changes', suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] },
  { name: 'replacing existing rules', suggestions: [{ type: 'replaceRules', rules: [], behavior: 'allow', destination: 'localSettings' }] },
])
  test(`Claude never offers remembered approval for ${scenario.name}`, async () => {
    let result: unknown;
    sdk.mockImplementation(({ options }) => Object.assign(
      (async function* () {
        result = await options.canUseTool('Bash', { command: 'node --version' }, { signal: new AbortController().signal, ...scenario });
        yield { type: 'result', result: 'Done', usage: {} };
      })(),
      { close: vi.fn() },
    ));
    for await (const _ of runClaudeInteractive({
      cwd: process.cwd(), prompt: 'test', model: null, purpose: 'work', fullAuto: false, allowedCommands: [],
      requestInput: async prompt => {
        expect(prompt.options?.map(option => option.id)).toEqual(['allow', 'deny']);
        return { decision: 'allow', optionId: 'remember-0' };
      },
    })) { /* drain */ }
    expect(result).not.toHaveProperty('updatedPermissions');
  });

for (const initialMode of ['default', 'plan', 'full-auto'] as const)
  test(`Claude ${initialMode}: legacy Full auto becomes Auto review and never blanket-approves callbacks`, async () => {
    sdk.mockClear();
    const { engine, adapters } = makeEngine({ autoEscalate: false });
    const setPermissionMode = vi.fn(async (_mode: string) => {});
    const close = vi.fn();
    const command = { command: 'cd "C:/project" && grep -n "## " README.md | head -40' };
    const question = { questions: [{ question: 'Which target?', options: [{ label: 'Server' }, { label: 'Client' }] }] };
    const replies: unknown[] = [];
    sdk.mockImplementation(({ prompt, options }) => {
      expect(options.permissionMode).toBe(claudePermission(initialMode));
      expect(options.allowDangerouslySkipPermissions).not.toBe(true);
      return Object.assign(
        (async function* () {
          const messages = [];
          for await (const message of prompt) messages.push(message);
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatchObject({ type: 'user', message: { role: 'user', content: expect.stringContaining('start') } });
          yield { type: 'system', subtype: 'init', session_id: 'live-claude', permissionMode: claudePermission(initialMode) };
          if (initialMode === 'plan')
            replies.push(await options.canUseTool('AskUserQuestion', question, { signal: new AbortController().signal }));
          else
            replies.push(await options.canUseTool('Bash', command, { signal: new AbortController().signal }));
          replies.push(await options.canUseTool('Bash', command, { signal: new AbortController().signal }));
          replies.push(await options.canUseTool('AskUserQuestion', question, { signal: new AbortController().signal }));
          yield { type: 'result', result: 'Done', usage: {} };
          throw new Error('The adapter must stop consuming the streaming session after its result');
        })(),
        { close, setPermissionMode },
      );
    });
    adapters.claude.run = runClaudeInteractive;
    const tab = await engine.createTab(process.cwd(), 'live Claude permissions');
    try {
      await engine.submit(tab.id, 'start', { kind: 'manual', provider: 'claude', model: null }, { permissionMode: initialMode });
      await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
      const pendingId = tab.pendingInputs![0]!.id;
      if (initialMode !== 'full-auto') {
        setPermissionMode.mockRejectedValueOnce(new Error('Mode change rejected'));
        await expect(engine.setPermissionMode(tab.id, 'full-auto')).rejects.toThrow('Mode change rejected');
        expect(tab.permissionMode).toBe(initialMode);
        expect(tab.activePermissionMode).toBe(initialMode);
        expect(tab.pendingInputs![0]!.id).toBe(pendingId);
        await engine.setPermissionMode(tab.id, 'full-auto');
        expect(setPermissionMode).toHaveBeenLastCalledWith('auto');
        expect(tab.activePermissionMode).toBe('auto');
      }
      expect(tab.permissionMode).toBe('auto');
      expect(tab.fullAuto).toBe(false);
      expect(tab.pendingInputs![0]!.id).toBe(pendingId);
      if (initialMode === 'plan') {
        // Native Auto review must not answer a question that was already waiting.
        expect(tab.pendingInputs![0]!.id).toBe(pendingId);
        await engine.answerInput(tab.id, pendingId, { decision: 'answer', answers: { '0': ['Server'] } });
      } else {
        await engine.answerInput(tab.id, pendingId, { decision: 'allow', optionId: 'allow' });
      }
      await vi.waitFor(() => expect(tab.pendingInputs![0]?.kind).toBe('approval'));
      expect(replies).toHaveLength(1);
      await engine.answerInput(tab.id, tab.pendingInputs![0]!.id, { decision: 'allow', optionId: 'allow' });
      await vi.waitFor(() => expect(tab.pendingInputs![0]?.kind).toBe('question'));
      expect(replies).toHaveLength(2);
      expect(replies[1]).toMatchObject({ behavior: 'allow', updatedInput: command });
      expect(tab.worker?.sessionId).toBe('live-claude');
      await engine.answerInput(tab.id, tab.pendingInputs![0]!.id, { decision: 'answer', answers: { '0': ['Client'] } });
      await vi.waitFor(() => expect(tab.status).toBe('idle'));
      expect(replies[2]).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which target?': 'Client' } } });
      expect(tab.pendingInputs).toEqual([]);
      expect(close).toHaveBeenCalledOnce();
      expect(sdk).toHaveBeenCalledTimes(1);
    } finally {
      await engine.close(tab.id);
      sdk.mockClear();
    }
  });

test('unsupported Claude Auto review reports its actual native mode without bypassing policy', async () => {
  const { engine, adapters } = makeEngine({ autoEscalate: true });
  const ask = vi.fn();
  const close = vi.fn();
  sdk.mockImplementation(({ options }) => Object.assign(
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'downgraded', permissionMode: 'acceptEdits' };
      ask();
      await options.canUseTool('Bash', { command: 'echo unexpected' }, { signal: new AbortController().signal });
      yield { type: 'result', result: 'Unexpected completion', usage: {} };
    })(),
    { close },
  ));
  adapters.claude.run = runClaudeInteractive;
  const tab = await engine.createTab(process.cwd(), 'blocked Full auto');
  try {
    await engine.submit(tab.id, 'start', { kind: 'manual', provider: 'claude', model: null }, { permissionMode: 'full-auto' });
    await vi.waitFor(() => expect(tab.status).toBe('failed'));
    expect(ask).not.toHaveBeenCalled();
    expect(tab.pendingInputs ?? []).toEqual([]);
    expect(tab.escalations).toBe(0);
    expect(tab.transcript.some(item => item.text?.includes('Auto review is unavailable'))).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await engine.close(tab.id);
  }
});
