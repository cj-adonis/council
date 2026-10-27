import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runCodexInteractive, runGeminiInteractive } from '../src/adapters/interactive.js';
import { codexPermissions, PERMISSION_MODES } from '../src/adapters/permissions.js';
const fixture = fileURLToPath(new URL('./fixtures/interactive-cli.mjs', import.meta.url));

for (const provider of ['codex', 'gemini'] as const) {
  for (const mode of PERMISSION_MODES.filter((mode) => provider !== 'gemini' || mode !== 'auto')) {
    test(`${provider}: ${mode} is sent over the native protocol when resuming a saved session`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-mode-protocol-'));
      const marker = path.join(dir, 'capture');
      const run = provider === 'codex' ? runCodexInteractive : runGeminiInteractive;
      const events = [];
      for await (const event of run(
        {
          cwd: dir,
          prompt: 'test',
          model: null,
          purpose: 'work',
          resumeId: `${provider}-saved`,
          fullAuto: true,
          permissionMode: mode,
          allowedCommands: [],
          requestInput: async () => ({ decision: 'deny' }),
        },
        { cmd: process.execPath, args: [fixture, provider, marker, 'capture'] },
      ))
        events.push(event);
      expect(events.at(-1)).toMatchObject({ type: 'result', isError: false });
      if (provider === 'codex' && mode === 'plan') {
        expect(events.at(-1)).toMatchObject({ text: 'Plan first, then verify.' });
        expect(
          events
            .filter((event) => event.type === 'text')
            .map((event) => event.text)
            .join(''),
        ).toBe('Plan first, then verify.');
      }
      if (provider === 'codex') {
        expect(JSON.parse(fs.readFileSync(marker + '.start', 'utf8'))).toMatchObject({
          threadId: 'codex-saved',
          ...codexPermissions(mode),
        });
        expect(JSON.parse(fs.readFileSync(marker + '.turn', 'utf8')).collaborationMode).toMatchObject({
          mode: mode === 'plan' ? 'plan' : 'default',
          settings: { model: 'fixture-model' },
        });
      } else
        expect(JSON.parse(fs.readFileSync(marker + '.mode', 'utf8'))).toEqual({
          sessionId: 'gemini-saved',
          modeId: mode === 'accept-edits' ? 'autoEdit' : mode === 'full-auto' ? 'yolo' : mode,
        });
    });
  }
}
