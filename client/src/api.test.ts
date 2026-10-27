import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './api';

describe('client api client', () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockResponse(data: unknown, ok = true, status = 200, statusText = 'OK') {
    mockFetch.mockResolvedValueOnce({
      ok,
      status,
      statusText,
      json: async () => data,
    });
  }

  test('health calls GET /api/health', async () => {
    mockResponse({ claude: { installed: true } });
    const res = await api.health();
    expect(res).toEqual({ claude: { installed: true } });
    expect(mockFetch).toHaveBeenCalledWith('/api/health', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
  });

  test('live input replies target one tab and request without changing permission settings', async () => {
    mockResponse({ id: 'tab-1' });
    await api.answerInput('tab-1', 'request-1', { decision: 'allow', optionId: 'once' });
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/tab-1/input', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'request-1', decision: 'allow', optionId: 'once' }),
    });
  });

  test('permission controls save the exact selected mode without sending a message', async () => {
    mockResponse({ id: 'tab-1', permissionMode: 'plan' });
    await api.setPermissionMode('tab-1', 'plan');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/tab-1/permissions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permissionMode: 'plan' }),
    });
    mockResponse({ id: 'tab-1' });
    await api.submit('tab-1', 'inspect', { kind: 'manual', provider: 'claude', model: null }, 'plan');
    expect(JSON.parse(mockFetch.mock.calls.at(-1)![1].body)).toMatchObject({ permissionMode: 'plan' });
    expect(JSON.parse(mockFetch.mock.calls.at(-1)![1].body)).not.toHaveProperty('fullAuto');
  });

  test('settings and saveSettings', async () => {
    mockResponse({ autoStart: false });
    expect(await api.settings()).toEqual({ autoStart: false });

    mockResponse({ autoStart: true });
    expect(await api.saveSettings({ autoStart: true })).toEqual({ autoStart: true });
    expect(mockFetch).toHaveBeenLastCalledWith('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ autoStart: true }),
    });
  });

  test('detectModels and detectBudgets', async () => {
    mockResponse({ models: { gemini: ['flash'] } });
    await api.detectModels();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/settings/detect-models', {
      method: 'POST',
      headers: {},
      body: undefined,
    });

    mockResponse({ budgets: { gemini: 30 } });
    await api.detectBudgets();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/settings/detect-budgets', {
      method: 'POST',
      headers: {},
      body: undefined,
    });
  });

  test('budgets, skills and routing with and without projectId', async () => {
    mockResponse({});
    await api.budgets();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/budgets', expect.objectContaining({ method: 'GET' }));

    mockResponse({ skills: [] });
    await api.skills();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/skills', expect.objectContaining({ method: 'GET' }));

    mockResponse({ skills: [] });
    await api.skills('proj 1');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/skills?projectId=proj%201', expect.objectContaining({ method: 'GET' }));

    mockResponse({});
    await api.routing();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/routing', expect.objectContaining({ method: 'GET' }));

    mockResponse({});
    await api.routing('proj 2');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/routing?projectId=proj%202', expect.objectContaining({ method: 'GET' }));
  });

  test('project endpoints: projects, restoreProject, projectBranch, discover, browse, pickNativeFolder, openProject', async () => {
    mockResponse([]);
    await api.projects();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/projects', expect.objectContaining({ method: 'GET' }));

    mockResponse({ projectId: 'p1', root: '/p1', defaultBranch: 'main', tabs: [] });
    await api.restoreProject('p1');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/projects/p1', expect.objectContaining({ method: 'GET' }));

    mockResponse({ defaultBranch: 'main' });
    await api.projectBranch('p1');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/projects/p1/branch', expect.objectContaining({ method: 'GET' }));

    mockResponse({ currentCwd: '/', projects: [] });
    await api.discoverProjects();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/projects/discover', expect.objectContaining({ method: 'GET' }));

    mockResponse({ path: '/picked', available: true });
    await api.pickNativeFolder('/init');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/projects/pick-native', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initial: '/init' }),
    });

    mockResponse({ current: '/', parent: null, isGitRepo: false, defaultBranch: null, directories: [] });
    await api.browse();
    expect(mockFetch).toHaveBeenLastCalledWith('/api/projects/browse', expect.objectContaining({ method: 'GET' }));

    mockResponse({});
    await api.browse('/my dir');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/projects/browse?dir=%2Fmy%20dir', expect.objectContaining({ method: 'GET' }));

    mockResponse({ projectId: 'p1', root: '/path', defaultBranch: 'main', tabs: [] });
    await api.openProject('/path');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/path' }),
    });
  });

  test('tab lifecycle: createTab, submit, start, send, clearContext, escalate, switchWorker, close, deleteTab', async () => {
    mockResponse({ id: 't1' });
    await api.createTab('/root', 'My task');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: '/root', title: 'My task' }),
    });

    mockResponse({ id: 't1' });
    await api.submit('t1', 'Do something', { kind: 'auto' }, true);
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/t1/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Do something', mode: { kind: 'auto' }, fullAuto: true }),
    });

    mockResponse({ id: 't1' });
    await api.start('t1', { provider: 'claude', model: 'sonnet' });
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/t1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'claude', model: 'sonnet' }),
    });

    mockResponse({ id: 't1' });
    await api.send('t1', 'next message', { fullAuto: true });
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/t1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'next message', fullAuto: true }),
    });

    mockResponse({ id: 't1' });
    await api.clearContext('t1');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/t1/clear-context', expect.objectContaining({ method: 'POST' }));

    mockResponse({ id: 't1', status: 'idle' });
    await api.stop('t1');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/t1/stop', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });

    mockResponse({ id: 't1' });
    await api.escalate('t1');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/t1/escalate', expect.objectContaining({ method: 'POST' }));

    mockResponse({ id: 't1' });
    await api.switchWorker('t1', 'gemini', 'flash');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/t1/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini', model: 'flash' }),
    });

    mockResponse({ id: 't1' });
    await api.close('t1');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/t1/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    mockResponse({ id: 't1' });
    await api.deleteTab('t1');
    expect(mockFetch).toHaveBeenLastCalledWith('/api/tabs/t1', {
      method: 'DELETE',
      headers: {},
      body: undefined,
    });
  });

  test('error handling extracts json error property or falls back to status text', async () => {
    mockResponse({ error: 'Specific backend error' }, false, 400, 'Bad Request');
    await expect(api.settings()).rejects.toThrow('Specific backend error');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => {
        throw new Error('Not JSON');
      },
    });
    await expect(api.settings()).rejects.toThrow('500 Internal Server Error');
  });
});
