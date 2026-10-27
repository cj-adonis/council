import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { runCodexInteractive, runGeminiInteractive } from '../src/adapters/interactive.js';
import type { AdapterEvent, InputReply, RunOptions } from '../src/adapters/types.js';

const fixture = fileURLToPath(new URL('./fixtures/interactive-cli.mjs', import.meta.url));

test('Gemini exposes native always-allow scopes and returns the exact selected option', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-always-'));
  const marker = path.join(dir, 'approved');
  let apply!: (mode: 'full-auto') => Promise<void>;
  const events: AdapterEvent[] = [];
  for await (const event of runGeminiInteractive({
    cwd: dir, prompt: 'test', purpose: 'work', model: null, fullAuto: false, allowedCommands: [],
    registerPermissionMode: async (control) => { apply = control; },
    requestInput: async (prompt) => {
      expect(prompt.options).toEqual(expect.arrayContaining([
        { id: 'allow-session', label: 'Allow for this session', decision: 'allow' },
        { id: 'allow-save', label: 'Allow this command for all future sessions', decision: 'allow' },
      ]));
      // The control channel remains usable while the CLI is waiting for approval.
      await apply('full-auto');
      return { decision: 'allow', optionId: 'allow-save' };
    },
  }, { cmd: process.execPath, args: [fixture, 'gemini', marker, 'always'] })) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'result', isError: false });
  expect(JSON.parse(fs.readFileSync(marker + '.permission', 'utf8')))
    .toEqual({ outcome: { outcome: 'selected', optionId: 'allow-save' } });
});

test('file approval exposes the proposed diff before the action is allowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-file-approval-'));
  const marker = path.join(dir, 'proposed.txt');
  let reviewed = false;
  for await (const _ of runCodexInteractive(
    {
      cwd: dir,
      prompt: 'test',
      purpose: 'work',
      model: null,
      fullAuto: false,
      allowedCommands: [],
      requestInput: async (prompt) => {
        expect(fs.existsSync(marker)).toBe(false);
        expect(prompt.input).toMatchObject({ proposedChanges: [{ path: marker, diff: '+ proposed file content' }] });
        reviewed = true;
        return { decision: 'allow', optionId: 'allow' };
      },
    },
    { cmd: process.execPath, args: [fixture, 'codex', marker, 'file'] },
  )) {
    /* drain */
  }
  expect(reviewed).toBe(true);
  expect(fs.readFileSync(marker, 'utf8')).toBe('approved');
});
for (const provider of ['codex', 'gemini'] as const) {
  test(`${provider}: a real child pauses for approval, receives the decision, and finishes the same session`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-live-input-'));
    const marker = path.join(dir, 'approved.txt');
    let answer!: (reply: InputReply) => void;
    const prompts: string[] = [];
    const options: RunOptions = {
      cwd: dir,
      prompt: 'test',
      purpose: 'work',
      model: null,
      fullAuto: false,
      allowedCommands: [],
      requestInput: async (prompt) => {
        prompts.push(prompt.kind);
        if (prompt.kind === 'question') return { decision: 'answer', answers: { format: ['JSON'] } };
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    };
    const events: AdapterEvent[] = [];
    const run = provider === 'codex' ? runCodexInteractive : runGeminiInteractive;
    const collect = (async () => {
      for await (const event of run(options, { cmd: process.execPath, args: [fixture, provider, marker] }))
        events.push(event);
    })();
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'), { timeout: 30_000 });
    expect(fs.existsSync(marker)).toBe(false);
    answer({ decision: 'allow', optionId: provider === 'codex' ? 'allow' : 'allow-one' });
    await collect;
    expect(fs.readFileSync(marker, 'utf8')).toBe('approved');
    expect(fs.readFileSync(marker + '.closed', 'utf8')).toBe('flushed');
    expect(events.filter((event) => event.type === 'session')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      isError: false,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(prompts).toEqual(provider === 'codex' ? ['approval', 'question'] : ['approval']);
    if (provider === 'codex') {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool',
          name: 'command_execution',
          input: expect.objectContaining({ command: 'write test marker' }),
        }),
      );
      const changes = events.filter((event) => event.type === 'tool' && event.name === 'file_change');
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ input: [{ path: marker, kind: 'add' }] });
    }
  });

  test(`${provider}: denial never performs the requested action`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-live-deny-'));
    const marker = path.join(dir, 'not-approved.txt');
    const run = provider === 'codex' ? runCodexInteractive : runGeminiInteractive;
    const events: AdapterEvent[] = [];
    for await (const event of run(
      {
        cwd: dir,
        prompt: 'test',
        purpose: 'work',
        model: null,
        fullAuto: false,
        allowedCommands: [],
        requestInput: async () => ({ decision: 'deny' }),
      },
      { cmd: process.execPath, args: [fixture, provider, marker] },
    ))
      events.push(event);
    expect(fs.existsSync(marker)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', isError: false });
  });

  test(`${provider}: a disconnected CLI terminates the pending turn instead of hanging`, async () => {
    const events: AdapterEvent[] = [];
    const run = provider === 'codex' ? runCodexInteractive : runGeminiInteractive;
    for await (const event of run(
      {
        cwd: process.cwd(),
        prompt: 'test',
        purpose: 'work',
        model: null,
        fullAuto: false,
        allowedCommands: [],
        requestInput: async () => ({ decision: 'deny' }),
      },
      { cmd: process.execPath, args: [fixture, provider, 'unused', 'crash'] },
    ))
      events.push(event);
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      isError: true,
      text: expect.stringContaining('CLI exited (7)'),
    });
  });
}
