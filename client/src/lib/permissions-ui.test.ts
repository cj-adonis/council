// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PermissionSelect } from '../components/PermissionSelect';
import { Composer } from '../components/Composer';
import { permissionOptions, tabPermission } from './permissions';
import type { Settings, Tab } from '../types';
vi.mock('../api', () => ({ api: { skills: async () => ({ skills: [] }), saveSettings: vi.fn() } }));
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
async function select(label: string, value: string) {
  if (label === 'Permission mode') {
    const trigger = host.querySelector<HTMLButtonElement>('.permission-trigger')!;
    await act(async () => trigger.click());
    const option = document.querySelector<HTMLButtonElement>('[role="menuitemradio"][data-mode="' + value + '"]')!;
    await act(async () => option.click());
    return;
  }
  const element = host.querySelector('select[aria-label="' + label + '"]') as HTMLSelectElement;
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

test('mode options keep native auto review separate and omit it for Gemini and automatic routing', () => {
  expect(permissionOptions('claude')).toEqual(['default', 'plan', 'accept-edits', 'auto']);
  expect(tabPermission({ fullAuto: true }, 'claude')).toBe('auto');
  expect(permissionOptions('codex')).toContain('auto');
  expect(permissionOptions('gemini')).not.toContain('auto');
  expect(permissionOptions(null)).not.toContain('auto');
  expect(tabPermission({ fullAuto: false })).toBe('accept-edits');
  expect(tabPermission({ fullAuto: true, permissionMode: 'plan' })).toBe('plan');
});

test('a mode choice sends exactly the chosen mode; render does not change permissions', async () => {
  const change = vi.fn();
  await act(async () =>
    root.render(createElement(PermissionSelect, { value: 'accept-edits', provider: 'claude', onChange: change })),
  );
  expect(change).not.toHaveBeenCalled();
  await select('Permission mode', 'plan');
  expect(change).toHaveBeenCalledExactlyOnceWith('plan');
});

test('queued changes show current and next mode; request errors remain visible', async () => {
  const change = vi.fn(async () => {
    throw new Error('Mode unavailable');
  });
  await act(async () =>
    root.render(
      createElement(PermissionSelect, { value: 'full-auto', active: 'plan', provider: 'codex', onChange: change }),
    ),
  );
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Full auto next turn');
  await select('Permission mode', 'default');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Mode unavailable');
});

test('running Claude sessions offer Auto review and explain that pending approvals remain manual', async () => {
  await act(async () =>
    root.render(createElement(PermissionSelect, { value: 'default', active: 'default', provider: 'claude', onChange: vi.fn() })),
  );
  await act(async () => host.querySelector<HTMLButtonElement>('.permission-trigger')!.click());
  expect(document.querySelector('.permission-menu-footer')?.textContent).toContain('Auto review applies immediately');
  expect(document.querySelector('[data-mode="full-auto"]')).toBeNull();
});

test('a legacy Claude Full auto task retries its original prompt using Auto review', async () => {
  const send = vi.fn(async () => {});
  const tab = {
    status: 'failed', projectId: 'project', fullAuto: true,
    worker: { provider: 'claude', model: null },
    transcript: [
      { kind: 'user', text: 'Inspect the allocation screen' },
      { kind: 'error', text: 'Task blocked: Full auto permissions are blocked by Claude settings or policy' },
    ],
  } as unknown as Tab;
  await act(async () => root.render(createElement(Composer, {
    tab, settings: { models: { claude: [], codex: [], gemini: [] }, allowedCommands: [] } as unknown as Settings,
    available: ['claude'], onSubmit: vi.fn(), onSend: send, onSwitch: vi.fn(), onPermissionMode: vi.fn(),
  })));
  expect(host.querySelector('.permission-trigger')?.getAttribute('data-mode')).toBe('auto');
  const retry = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === '🔄 Retry')!;
  expect(send).not.toHaveBeenCalled();
  await act(async () => retry.click());
  expect(send).toHaveBeenCalledExactlyOnceWith('Inspect the allocation screen', { permissionMode: 'auto' });
});

test('draft choices are remembered per provider and model without sending work', async () => {
  const submit = vi.fn();
  const send = vi.fn();
  const tab = {
    status: 'drafting',
    projectId: 'project',
    fullAuto: false,
    transcript: [],
    worker: null,
  } as unknown as Tab;
  const settings = {
    models: { claude: ['first', 'second'], codex: [], gemini: [] },
    allowedCommands: [],
  } as unknown as Settings;
  await act(async () =>
    root.render(
      createElement(Composer, {
        tab,
        settings,
        available: ['claude', 'codex', 'gemini'],
        onSubmit: submit,
        onSend: send,
        onSwitch: vi.fn(),
        onPermissionMode: vi.fn(),
      }),
    ),
  );
  const pick = async (name: string) => {
    const group = host.querySelector('[aria-label="Routing"]')!;
    const button = [...group.querySelectorAll('button')].find((button) => button.textContent?.includes(name))!;
    await act(async () => button.click());
  };
  await pick('Claude');
  await select('Permission mode', 'plan');
  await pick('Codex');
  expect(host.querySelector('.permission-trigger')?.getAttribute('data-mode')).toBe('accept-edits');
  await select('Permission mode', 'full-auto');
  await pick('Claude');
  expect(host.querySelector('.permission-trigger')?.getAttribute('data-mode')).toBe('plan');
  await select('Model', 'second');
  expect(host.querySelector('.permission-trigger')?.getAttribute('data-mode')).toBe('accept-edits');
  await select('Model', '');
  expect(host.querySelector('.permission-trigger')?.getAttribute('data-mode')).toBe('plan');
  expect(submit).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('the menu supports keyboard navigation, Escape, and outside dismissal without changing modes', async () => {
  const change = vi.fn();
  await act(async () =>
    root.render(createElement(PermissionSelect, { value: 'plan', provider: 'claude', onChange: change })),
  );
  const trigger = host.querySelector<HTMLButtonElement>('.permission-trigger')!;
  await act(async () => trigger.click());
  expect(document.activeElement?.getAttribute('data-mode')).toBe('plan');
  await act(async () =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  expect(document.activeElement?.getAttribute('data-mode')).toBe('accept-edits');
  await act(async () =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => trigger.click());
  await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(change).not.toHaveBeenCalled();
});
