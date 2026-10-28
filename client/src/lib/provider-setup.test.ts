// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Health } from '../components/Health';
import { Home } from '../components/Home';
import type { CliHealth, Provider } from '../types';

vi.mock('../api', () => ({ api: { discoverProjects: async () => ({ currentCwd: '', projects: [] }) } }));

let host: HTMLDivElement;
let root: Root;
const health: Record<Provider, CliHealth> = {
  gemini: { installed: true, authed: true, authSource: 'login', models: ['flash'], modelSource: 'defaults', error: 'CLI version check timed out after 10000 ms; version is unknown' },
  codex: { installed: true, authed: false, version: '1.2.3' },
  claude: { installed: false, authed: false },
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

test('provider cards explain installation, login, suggested models and nonblocking version warnings', async () => {
  const refresh = vi.fn();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await act(async () => root.render(createElement(Health, { health, onRefresh: refresh })));
  const gemini = host.querySelector('article[aria-label="Gemini"]')!;
  expect(gemini.textContent).toContain('Ready');
  expect(gemini.textContent).toContain('Saved login detected');
  expect(gemini.textContent).toContain('Built-in suggestions');
  expect(gemini.querySelector('details')?.open).toBe(false);
  expect(gemini.textContent).toContain('does not block tasks');
  expect(host.querySelector('article[aria-label="Codex"]')?.textContent).toContain('Sign in needed');
  expect(host.querySelector('article[aria-label="Claude"]')?.textContent).toContain('Install needed');
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy codex login"]')!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith('codex login');
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Check again')!.click());
  expect(refresh).toHaveBeenCalledOnce();
});

test('first-run checking does not claim providers are missing and disables duplicate checks', async () => {
  const refresh = vi.fn();
  await act(async () => root.render(createElement(Health, { health: null, checking: true, onRefresh: refresh })));
  expect(host.querySelectorAll('article')).toHaveLength(3);
  expect(host.textContent).not.toContain('Install needed');
  expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
  expect(host.querySelector('button')?.disabled).toBe(true);
  await act(async () => root.render(createElement(Health, { health, checking: false, onRefresh: refresh })));
  expect(host.querySelector('button')?.disabled).toBe(false);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('1 of 3 providers ready');
});

test('the first-run home shows providers before opening a project and guides an empty setup', async () => {
  const props = { projects: [], project: null, openTabs: 0, notes: [], health, onOpenProject: vi.fn(), onNewTab: vi.fn(), onSettings: vi.fn(), onRefresh: vi.fn() };
  await act(async () => root.render(createElement(Home, { ...props, available: ['gemini'] })));
  expect(host.querySelector('[aria-label="AI provider setup"]')).not.toBeNull();
  expect(host.textContent).toContain('Open a project');
  await act(async () => root.render(createElement(Home, { ...props, available: [], health: { gemini: { installed: false, authed: false }, codex: { installed: false, authed: false }, claude: { installed: false, authed: false } } })));
  expect(host.textContent).toContain('Connect your first AI provider');
  expect(host.querySelectorAll('.provider-command')).toHaveLength(6);
});
