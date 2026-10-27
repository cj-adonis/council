// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PendingInputs } from '../components/PendingInputs';
import type { InputReply, PendingInput } from '../types';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const request: PendingInput = {
  id: 'r1',
  createdAt: new Date().toISOString(),
  kind: 'approval',
  title: 'Approve command',
  tool: 'Bash',
  input: { command: 'node --version' },
  options: [
    { id: 'once', label: 'Allow once', decision: 'allow' },
    { id: 'no', label: 'Deny', decision: 'deny' },
  ],
};

test('native session approval keeps its scope label and sends the selected option id', async () => {
  const answer = vi.fn(async () => {});
  const scoped = { ...request, options: [...request.options!,
    { id: 'session', label: 'Allow for this session', decision: 'allow' as const },
  ] };
  await act(async () => root.render(createElement(PendingInputs, { requests: [scoped], onReply: answer })));
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Allow for this session')!;
  expect(answer).not.toHaveBeenCalled();
  await act(async () => button.click());
  expect(answer).toHaveBeenCalledExactlyOnceWith('r1', { decision: 'allow', optionId: 'session' });
});

test('Claude Always allow shows the exact saved rule and sends its native option id', async () => {
  const answer = vi.fn(async () => {});
  const remembered = { ...request, options: [...request.options!,
    { id: 'remember-0', label: 'Always allow for this project: Bash(node --version)', decision: 'allow' as const },
  ] };
  await act(async () => root.render(createElement(PendingInputs, { requests: [remembered], onReply: answer })));
  expect(answer).not.toHaveBeenCalled();
  const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Always allow for this project: Bash(node --version)')!;
  await act(async () => button.click());
  expect(answer).toHaveBeenCalledExactlyOnceWith('r1', { decision: 'allow', optionId: 'remember-0' });
});

test('file approval renders the proposed diff before any permission decision', async () => {
  const answer = vi.fn(async () => {});
  const patch = {
    ...request,
    title: 'Approve file changes',
    input: { proposedChanges: [{ path: 'src/example.ts', diff: '- old value\n+ new value' }] },
  };
  await act(async () => root.render(createElement(PendingInputs, { requests: [patch], onReply: answer })));
  const preview = host.querySelector('[aria-label="Proposed file changes"]')!;
  expect(preview.textContent).toContain('src/example.ts');
  expect(preview.textContent).toContain('- old value\n+ new value');
  expect(answer).not.toHaveBeenCalled();
});

test('approval requires a click, sends the exact option, and disables double submission', async () => {
  let finish!: () => void;
  const answer = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => root.render(createElement(PendingInputs, { requests: [request], onReply: answer })));
  expect(answer).not.toHaveBeenCalled();
  expect(host.textContent).toContain('node --version');
  const allow = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Allow once')!;
  await act(async () => allow.click());
  expect(answer).toHaveBeenCalledWith('r1', { decision: 'allow', optionId: 'once' });
  expect(allow.disabled).toBe(true);
  await act(async () => allow.click());
  expect(answer).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
    await Promise.resolve();
  });
  await act(async () => root.render(createElement(PendingInputs, { requests: [], onReply: answer })));
  expect(host.textContent).toBe('');
});

test('Deny sends no approval and no expanded permission option', async () => {
  const answer = vi.fn(async () => {});
  await act(async () => root.render(createElement(PendingInputs, { requests: [request], onReply: answer })));
  await act(async () =>
    Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Deny')!
      .click(),
  );
  expect(answer).toHaveBeenCalledWith('r1', { decision: 'deny', optionId: 'no' });
});

test('real UI controls preserve No, single choice, multiple selections, custom text, and request identity on refresh', async () => {
  const questions: PendingInput = {
    id: 'questions',
    createdAt: new Date().toISOString(),
    kind: 'question',
    title: 'Choose',
    questions: [
      { id: 'yesno', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'format', question: 'Format?', options: [{ label: 'JSON' }, { label: 'Text' }] },
      { id: 'targets', question: 'Targets?', multiSelect: true, options: [{ label: 'Server' }, { label: 'Client' }] },
      { id: 'name', question: 'Name?', options: [] },
    ],
  };
  const answer = vi.fn(async (_id: string, _reply: InputReply) => {});
  await act(async () => root.render(createElement(PendingInputs, { requests: [questions], onReply: answer })));
  const send = host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(send.disabled).toBe(true);
  const fields = host.querySelectorAll('fieldset');
  await act(async () =>
    fields[0]!.querySelectorAll('input[type="radio"]')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  await act(async () => (fields[1]!.querySelector('input[type="radio"]') as HTMLInputElement).click());
  await act(async () => {
    for (const checkbox of fields[2]!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) checkbox.click();
  });
  const name = fields[3]!.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Custom project');
    name.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => root.render(createElement(PendingInputs, { requests: [{ ...questions }], onReply: answer })));
  expect(send.disabled).toBe(false);
  expect(answer).not.toHaveBeenCalled();
  await act(async () => send.click());
  expect(answer).toHaveBeenCalledWith('questions', {
    decision: 'answer',
    answers: { yesno: ['No'], format: ['JSON'], targets: ['Server', 'Client'], name: ['Custom project'] },
  });
});

test('dismissing questions does not submit an inferred answer', async () => {
  const answer = vi.fn(async () => {});
  const question: PendingInput = {
    ...request,
    kind: 'question',
    questions: [{ id: 'q', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
  };
  await act(async () => root.render(createElement(PendingInputs, { requests: [question], onReply: answer })));
  await act(async () =>
    Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Dismiss')!
      .click(),
  );
  expect(answer).toHaveBeenCalledWith('r1', { decision: 'deny' });
});

test('custom multi-select answers survive selecting another checkbox', async () => {
  const answer = vi.fn(async () => {});
  const question: PendingInput = {
    ...request,
    kind: 'question',
    questions: [
      { id: 'targets', question: 'Targets?', multiSelect: true, options: [{ label: 'Server' }, { label: 'Client' }] },
    ],
  };
  await act(async () => root.render(createElement(PendingInputs, { requests: [question], onReply: answer })));
  const custom = host.querySelector<HTMLInputElement>('input[type="text"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(custom, 'Other target');
    custom.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(custom.value).toBe('Other target');
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(answer).toHaveBeenCalledWith('r1', { decision: 'answer', answers: { targets: ['Server', 'Other target'] } });
});

test('a custom single-choice answer clears the radio selection instead of sending two conflicting answers', async () => {
  const answer = vi.fn(async () => {});
  const question: PendingInput = {
    ...request,
    kind: 'question',
    questions: [{ id: 'format', question: 'Format?', options: [{ label: 'JSON' }, { label: 'Text' }] }],
  };
  await act(async () => root.render(createElement(PendingInputs, { requests: [question], onReply: answer })));
  const radio = host.querySelector<HTMLInputElement>('input[type="radio"]')!;
  await act(async () => radio.click());
  const custom = host.querySelector<HTMLInputElement>('input[type="text"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(custom, 'YAML');
    custom.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(radio.checked).toBe(false);
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(answer).toHaveBeenCalledWith('r1', { decision: 'answer', answers: { format: ['YAML'] } });
});
