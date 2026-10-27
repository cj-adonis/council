// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Composer } from '../components/Composer';
import type { Settings, Tab } from '../types';

const { discover } = vi.hoisted(() => ({ discover: vi.fn() }));
vi.mock('../api', () => ({ api: { skills: discover, saveSettings: vi.fn() } }));
const skills = [
  { name: 'review', source: 'agents', path: 'C:/skills/review/SKILL.md' },
  { name: 'compose-ui', source: 'project', path: 'C:/project/tools/skills/compose-ui/SKILL.md' },
];
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  discover.mockResolvedValue({ skills });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

async function render(status: Tab['status'] = 'drafting') {
  const submit = vi.fn(async () => {});
  const send = vi.fn(async () => {});
  await act(async () => root.render(createElement(Composer, {
    tab: { status, projectId: 'project', fullAuto: false, transcript: [], worker: status === 'drafting' ? null : { provider: 'claude', model: null } } as unknown as Tab,
    settings: { models: { claude: [], codex: [], gemini: [] }, allowedCommands: [] } as unknown as Settings,
    available: ['claude', 'codex', 'gemini'], onSubmit: submit, onSend: send, onSwitch: vi.fn(), onPermissionMode: vi.fn(),
  })));
  return { submit, send };
}
async function type(value: string, cursor = value.length) {
  const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.setSelectionRange(cursor, cursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}
async function key(input: HTMLTextAreaElement, value: string) {
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })));
}

test('slash suggestions filter skills and keyboard selection inserts without submitting', async () => {
  const { submit, send } = await render();
  const input = await type('/');
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
  await key(input, 'ArrowDown');
  expect(host.querySelector('[aria-selected="true"]')?.textContent).toContain('/compose-ui');
  await key(input, 'Tab');
  expect(input.value).toBe('/compose-ui ');
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(submit).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  await type('/rev');
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  await key(input, 'Escape');
  expect(host.querySelector('[role="listbox"]')).toBeNull();
});

for (const status of ['drafting', 'idle'] as const)
  test(`${status}: selecting a slash skill sends its instructions and preserves task arguments`, async () => {
    const { submit, send } = await render(status);
    const input = await type('/comp');
    await act(async () => host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(input.value).toBe('/compose-ui ');
    await type('/compose-ui Build checkout');
    await key(input, 'Enter');
    const expected = 'Use the `compose-ui` skill (read `C:/project/tools/skills/compose-ui/SKILL.md`) for this task. Build checkout';
    if (status === 'drafting') expect(submit).toHaveBeenCalledExactlyOnceWith(expected, { kind: 'auto' }, 'accept-edits');
    else expect(send).toHaveBeenCalledExactlyOnceWith(expected, undefined);
    expect(discover).toHaveBeenCalledWith('project');
  });

test('slash browsing works inside a message and completion preserves text on both sides', async () => {
  const { submit } = await render();
  const input = await type('Build checkout with /comp and keep dark mode', 24);
  expect(host.querySelector('[role="listbox"]')).not.toBeNull();
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  await key(input, 'Enter');
  expect(input.value).toBe('Build checkout with /compose-ui and keep dark mode');
  expect(submit).not.toHaveBeenCalled();
  await type('Build checkout\n/');
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
});

test('slash opens a visible loading menu while skill discovery is pending', async () => {
  let finish!: (value: { skills: typeof skills }) => void;
  discover.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await render();
  const input = await type('/');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading skills');
  expect(input.getAttribute('aria-expanded')).toBe('true');
  await act(async () => finish({ skills }));
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
});

test('failed skill discovery is visible and Retry recovers without losing the slash query', async () => {
  discover.mockRejectedValueOnce(new Error('Connection interrupted'));
  await render();
  const input = await type('/comp');
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Connection interrupted');
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry')!;
  await act(async () => retry.click());
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(input.value).toBe('/comp');
});
