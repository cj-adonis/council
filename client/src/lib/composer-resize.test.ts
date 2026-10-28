// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Composer } from '../components/Composer';
import type { Settings, Tab } from '../types';

vi.mock('../api', () => ({ api: { skills: async () => ({ skills: [] }) } }));
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

async function render(status: 'drafting' | 'idle' = 'drafting') {
  const submit = vi.fn(async () => {});
  const send = vi.fn(async () => {});
  await act(async () => root.render(createElement(Composer, {
    tab: { status, projectId: 'project', transcript: [], fullAuto: false, worker: status === 'idle' ? { provider: 'gemini', model: null } : null } as unknown as Tab,
    settings: { models: { claude: [], codex: [], gemini: [] }, allowedCommands: [] } as unknown as Settings,
    available: ['claude', 'codex', 'gemini'], onSubmit: submit, onSend: send, onSwitch: vi.fn(), onPermissionMode: vi.fn(),
  })));
  return { submit, send, input: host.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!, handle: host.querySelector<HTMLDivElement>('[role="separator"]')! };
}

for (const status of ['drafting', 'idle'] as const) {
  test(`${status}: expanding and collapsing preserves the unsent message`, async () => {
    const { submit, send, input } = await render(status);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep this draft');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Expand input')!;
    const initialHeight = Number.parseInt(input.style.height);
    await act(async () => button.click());
    expect(Number.parseInt(input.style.height)).toBeGreaterThan(initialHeight);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await act(async () => button.click());
    expect(Number.parseInt(input.style.height)).toBe(initialHeight);
    expect(input.value).toBe('Keep this draft');
    expect(submit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
}

test('dragging up enlarges the input, release stops resizing, and keyboard resizing stays within bounds', async () => {
  const { input, handle } = await render();
  Object.defineProperty(handle, 'setPointerCapture', { value: vi.fn() });
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ height: 96 } as DOMRect);
  await act(async () => {
    handle.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientY: 500, bubbles: true }));
    handle.dispatchEvent(new MouseEvent('pointermove', { clientY: 350, bubbles: true }));
  });
  expect(input.style.height).toBe('246px');
  await act(async () => {
    handle.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    handle.dispatchEvent(new MouseEvent('pointermove', { clientY: 200, bubbles: true }));
  });
  expect(input.style.height).toBe('246px');
  for (const key of ['End', 'ArrowUp', 'Home', 'ArrowDown']) {
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    const max = Number(handle.getAttribute('aria-valuemax'));
    expect(Number.parseInt(input.style.height)).toBe(key === 'End' || key === 'ArrowUp' ? max : 96);
  }
});
