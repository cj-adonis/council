// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TabView } from '../components/TabView';
import type { Settings, Tab } from '../types';

const { stop, send } = vi.hoisted(() => ({ stop: vi.fn(), send: vi.fn() }));
vi.mock('../api', () => ({ api: { stop, send, skills: async () => ({ skills: [] }) } }));
vi.mock('../components/Transcript', () => ({ Transcript: () => null }));
vi.mock('../hooks/useNow', () => ({ useNow: () => new Date() }));

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
  vi.resetAllMocks();
});

function tab(status: Tab['status']): Tab {
  return {
    id: 'stuck-tab', title: 'Stuck task', projectId: 'project', projectRoot: 'C:/project', status,
    worker: { provider: 'claude', model: null, sessionId: 'session' }, transcript: [], pendingInputs: [],
    fullAuto: false, costUsd: 0, stalled: false, escalations: 0, vote: null,
    updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
  } as unknown as Tab;
}
async function render(value: Tab, onTabUpdate = vi.fn(), onError = vi.fn()) {
  await act(async () => root.render(createElement(TabView, {
    tab: value,
    settings: { models: { claude: [], codex: [], gemini: [] }, allowedCommands: [], stallMinutes: 10 } as unknown as Settings,
    available: ['claude', 'codex', 'gemini'], stallSeq: 1, details: false,
    onToggleDetails: vi.fn(), onDelete: vi.fn(), onTabUpdate, onError,
  })));
}

for (const status of ['running', 'voting', 'handing-off'] as const)
  test(`${status}: Stop cancels once and re-enables the composer for another message`, async () => {
    let finish!: (value: Tab) => void;
    stop.mockImplementation(() => new Promise<Tab>(resolve => { finish = resolve; }));
    const update = vi.fn();
    await render(tab(status), update);
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!;
    expect(input.disabled).toBe(true);
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Stop AI"]')!;
    await act(async () => button.click());
    expect(stop).toHaveBeenCalledExactlyOnceWith('stuck-tab');
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(stop).toHaveBeenCalledOnce();
    const idle = tab('idle');
    await act(async () => finish(idle));
    expect(update).toHaveBeenCalledWith(idle);
    await render(idle, update);
    expect(input.disabled).toBe(false);
    expect(host.querySelector('[aria-label="Stop AI"]')).toBeNull();
    send.mockResolvedValue(idle);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Try another approach');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(send).toHaveBeenCalledExactlyOnceWith('stuck-tab', 'Try another approach', undefined);
  });

test('a failed Stop request stays retryable and reports its error', async () => {
  const error = vi.fn();
  stop.mockRejectedValue(new Error('Worker could not be stopped'));
  await render(tab('running'), vi.fn(), error);
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Stop AI"]')!;
  await act(async () => button.click());
  expect(error).toHaveBeenCalledWith('Worker could not be stopped');
  expect(button.disabled).toBe(false);
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')!.disabled).toBe(true);
});
