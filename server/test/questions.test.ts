import { expect, test, vi } from 'vitest';
import { questionServer } from '../src/adapters/questions.js';
import type { InputPrompt } from '../src/adapters/types.js';

test('disconnecting an MCP question cancels the pending callback without inventing an answer', async () => {
  let waiting = false;
  let cancelled = false;
  const server = await questionServer({
    cwd: process.cwd(),
    prompt: '',
    purpose: 'work',
    model: null,
    fullAuto: false,
    allowedCommands: [],
    requestInput: async (_prompt, signal) => {
      waiting = true;
      return new Promise((resolve) =>
        signal?.addEventListener(
          'abort',
          () => {
            cancelled = true;
            resolve({ decision: 'deny' });
          },
          { once: true },
        ),
      );
    },
  });
  const ac = new AbortController();
  try {
    const response = fetch(server.url, {
      method: 'POST',
      signal: ac.signal,
      body: JSON.stringify({
        id: 1,
        method: 'tools/call',
        params: { name: 'ask_council_user', arguments: { questions: [{ id: 'q', question: 'Proceed?' }] } },
      }),
    }).catch(() => undefined);
    await vi.waitFor(() => expect(waiting).toBe(true));
    ac.abort();
    await response;
    await vi.waitFor(() => expect(cancelled).toBe(true));
  } finally {
    await server.close();
  }
});

test('MCP questions preserve multiple question ids, custom text and multiple selections', async () => {
  let prompt: InputPrompt | undefined;
  const server = await questionServer({
    cwd: process.cwd(),
    prompt: '',
    purpose: 'work',
    model: null,
    fullAuto: false,
    allowedCommands: [],
    requestInput: async (value) => {
      prompt = value;
      return { decision: 'answer', answers: { confirm: ['No'], targets: ['Server', 'Client'], name: ['Custom name'] } };
    },
  });
  const post = async (method: string, params: unknown) =>
    (
      await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
    ).json();
  try {
    expect((await post('initialize', {})).result.capabilities).toHaveProperty('tools');
    expect((await post('tools/list', {})).result.tools[0].name).toBe('ask_council_user');
    const questions = [
      { id: 'confirm', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'targets', question: 'Targets?', multiSelect: true, options: [{ label: 'Server' }, { label: 'Client' }] },
      { id: 'name', question: 'Name?' },
    ];
    const result = await post('tools/call', { name: 'ask_council_user', arguments: { questions } });
    expect(prompt?.questions?.map((q) => q.id)).toEqual(['confirm', 'targets', 'name']);
    expect(JSON.parse(result.result.content[0].text).answers).toEqual({
      confirm: ['No'],
      targets: ['Server', 'Client'],
      name: ['Custom name'],
    });
    expect((await fetch(server.url + '-wrong', { method: 'POST', body: '{}' })).status).toBe(404);
  } finally {
    await server.close();
  }
});

test('dismissed MCP questions return an explicit decline rather than invented answers', async () => {
  const server = await questionServer({
    cwd: process.cwd(),
    prompt: '',
    purpose: 'work',
    model: null,
    fullAuto: false,
    allowedCommands: [],
    requestInput: async () => ({ decision: 'deny' }),
  });
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      body: JSON.stringify({
        id: 1,
        method: 'tools/call',
        params: { name: 'ask_council_user', arguments: { questions: [{ id: 'q', question: 'Proceed?' }] } },
      }),
    });
    const data = await response.json();
    expect(JSON.parse(data.result.content[0].text)).toMatchObject({ declined: true });
  } finally {
    await server.close();
  }
});
