import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { workEvents } from './helpers/fakeAdapter.js';
import WebSocket from 'ws';
import { SettingsStore } from '../src/config/settings.js';
import { PricingStore } from '../src/ledger/pricing.js';
import { createServer, type CouncilServer } from '../src/http.js';
import { makeEngine, type EngineFixture } from './helpers/engineSetup.js';

let fixture: EngineFixture;
let server: CouncilServer;
let base: string;
const healthRequests: (boolean | undefined)[] = [];

test('permission endpoint changes only the mode and rejects unsupported values', async () => {
  const tab = await fixture.engine.createTab('C:/proj', 'permission endpoint');
  const result = await api('POST', `/api/tabs/${tab.id}/permissions`, { permissionMode: 'plan' });
  expect(result.status).toBe(200);
  expect(tab.status).toBe('drafting');
  expect(tab.permissionMode).toBe('plan');
  expect((await api('POST', `/api/tabs/${tab.id}/permissions`, { permissionMode: 'anything' })).status).toBe(400);
  expect(tab.permissionMode).toBe('plan');
  expect((await api('POST', `/api/tabs/${tab.id}/submit`, { text: 'work', mode: { kind: 'manual', provider: 'gemini', model: null }, permissionMode: 'auto' })).status).toBe(400);
  expect(tab.status).toBe('drafting');
  await fixture.engine.close(tab.id);
});

test('Stop endpoint cancels a live prompt and permits another message on the same tab', async () => {
  const original = fixture.adapters.claude.run;
  fixture.adapters.claude.run = async function* (opts) {
    await opts.requestInput!({ kind: 'approval', title: 'Stuck command', options: [{ id: 'allow', label: 'Allow once', decision: 'allow' }] });
    yield* workEvents('cancelled');
  };
  const tab = await fixture.engine.createTab('C:/proj', 'stop via HTTP');
  try {
    await api('POST', `/api/tabs/${tab.id}/submit`, { text: 'start', mode: { kind: 'manual', provider: 'claude', model: null } });
    await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
    const requestId = tab.pendingInputs![0]!.id;
    const stopped = await api('POST', `/api/tabs/${tab.id}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.json).toMatchObject({ status: 'idle', pendingInputs: [] });
    expect((await api('POST', `/api/tabs/${tab.id}/input`, { requestId, decision: 'allow', optionId: 'allow' })).status).toBe(409);
    fixture.adapters.claude.run = original;
    expect((await api('POST', `/api/tabs/${tab.id}/send`, { text: 'New approach' })).status).toBe(200);
    await vi.waitFor(() => expect(tab.status).toBe('idle'));
  } finally { fixture.adapters.claude.run = original; await fixture.engine.close(tab.id); }
});

test('live questions survive browser reconnect and answers are accepted exactly once', async () => {
  const previous = fixture.adapters.gemini.run;
  let received: unknown;
  fixture.adapters.gemini.run = async function* (opts) {
    received = await opts.requestInput!({ kind: 'question', title: 'Proceed?', questions: [{ id: 'proceed', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }] });
    yield* workEvents('live-http-session', 'done', 0);
  };
  const tab = await fixture.engine.createTab('C:/proj', 'live HTTP');
  try {
    await api('POST', `/api/tabs/${tab.id}/submit`, { text: 'ask first', mode: { kind: 'manual', provider: 'gemini', model: null } });
    await vi.waitFor(() => expect(tab.pendingInputs).toHaveLength(1));
    const requestId = tab.pendingInputs![0]!.id;
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const hello = await new Promise<any>((resolve, reject) => {
        const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('No hello received')); }, 5_000);
        ws.on('error', reject);
        ws.on('message', (data) => { const value = JSON.parse(String(data)); if (value.type === 'hello') { clearTimeout(timer); ws.close(); resolve(value); } });
      });
      expect(hello.tabs.find((value: { id: string }) => value.id === tab.id).pendingInputs[0].id).toBe(requestId);
    }
    const foreign = await fetch(`${base}/api/tabs/${tab.id}/input`, { method: 'POST', headers: { origin: 'https://outside.example', 'content-type': 'application/json' }, body: JSON.stringify({ requestId, decision: 'answer', answers: { proceed: ['Yes'] } }) });
    expect(foreign.status).toBe(403);
    expect((await api('POST', `/api/tabs/${tab.id}/input`, { requestId: 'stale', decision: 'deny' })).status).toBe(409);
    expect((await api('POST', `/api/tabs/${tab.id}/input`, { requestId, decision: 'answer', answers: {} })).status).toBe(400);
    const reply = { requestId, decision: 'answer', answers: { proceed: ['No'] } };
    expect((await api('POST', `/api/tabs/${tab.id}/input`, reply)).status).toBe(200);
    expect((await api('POST', `/api/tabs/${tab.id}/input`, reply)).status).toBe(409);
    await vi.waitFor(() => expect(tab.status).toBe('idle'));
    expect(received).toEqual({ decision: 'answer', answers: { proceed: ['No'] } });
    expect(tab.pendingInputs).toEqual([]);
  } finally { await fixture.engine.close(tab.id); fixture.adapters.gemini.run = previous; }
});

beforeAll(async () => {
  fixture = makeEngine();
  const clientDist = path.join(fixture.home, 'dist');
  fs.mkdirSync(path.join(clientDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(clientDist, 'index.html'), '<!doctype html><title>Council</title>');
  fs.writeFileSync(path.join(clientDist, 'assets', 'app.js'), 'console.log(1)');
  server = createServer({
    engine: fixture.engine,
    settings: new SettingsStore(path.join(fixture.home, 'settings.json'), fixture.settings),
    pricing: new PricingStore(path.join(fixture.home, 'pricing.json')),
    health: async (fresh) => {
      healthRequests.push(fresh);
      return {
      claude: { installed: true, version: '2.1.302', authed: true },
      codex: { installed: false, authed: false, error: 'not found' },
      gemini: { installed: true, version: '0.15.3', authed: false },
      };
    },
    clientDist,
  });
  const port = await server.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await server.close();
});

async function api(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

test('GET /api/health returns one entry per provider', async () => {
  const r = await api('GET', '/api/health');
  expect(r.status).toBe(200);
  expect(Object.keys(r.json).sort()).toEqual(['claude', 'codex', 'gemini']);
  expect(r.json.codex).toMatchObject({ installed: false });
});

test('manual provider checks and model sync request fresh health', async () => {
  expect((await api('GET', '/api/health?refresh=1')).status).toBe(200);
  expect(healthRequests.at(-1)).toBe(true);
  await api('GET', '/api/health');
  expect(healthRequests.at(-1)).toBe(false);
  expect((await api('POST', '/api/settings/detect-models')).status).toBe(200);
  expect(healthRequests.at(-1)).toBe(true);
});
test('GET /api/settings returns the settings and PUT merges and persists a change', async () => {
  const before = await api('GET', '/api/settings');
  expect(before.json.autoStart).toBe(false);
  const put = await api('PUT', '/api/settings', { autoStart: true, budgets: { gemini: 5 } });
  expect(put.status).toBe(200);
  expect(put.json.autoStart).toBe(true);
  expect(put.json.budgets).toEqual({ claude: 40, codex: 30, gemini: 5 });
  const after = await api('GET', '/api/settings');
  expect(after.json.autoStart).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(fixture.home, 'settings.json'), 'utf8')).autoStart).toBe(true);
  await api('PUT', '/api/settings', { autoStart: false });
});

test('POST /api/settings/detect-models merges detected models from health into settings', async () => {
  const res = await api('POST', '/api/settings/detect-models');
  expect(res.status).toBe(200);
  expect(res.json.models).toBeDefined();
});

test('POST /api/settings/detect-budgets auto-populates budgets from health', async () => {
  const res = await api('POST', '/api/settings/detect-budgets');
  expect(res.status).toBe(200);
  expect(res.json.budgets).toBeDefined();
});

test('tabs: clear-context resets worker sessionId and appends system note', async () => {
  const t = await api('POST', '/api/tabs', { projectRoot: 'C:/proj', title: 'test-clear' });
  const id = t.json.id;
  await api('POST', `/api/tabs/${id}/submit`, { text: 'do something', mode: { kind: 'manual', provider: 'claude' }, fullAuto: false });
  // Wait for worker to finish or be idle
  await new Promise((r) => setTimeout(r, 100));
  const res = await api('POST', `/api/tabs/${id}/clear-context`);
  expect(res.status).toBe(200);
  expect(res.json.status).toBe('drafting');
  expect(res.json.worker).toBeNull();
  expect(res.json.vote).toBeNull();
  expect(res.json.routing).toBeNull();
  expect(res.json.transcript.some((i: any) => i.kind === 'system' && i.text.includes('Context cleared'))).toBe(true);
});

test('GET /api/plans returns detected plans and skills', async () => {
  const res = await api('GET', '/api/plans');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.json.plans)).toBe(true);
  expect(Array.isArray(res.json.skills)).toBe(true);
});

test('GET /api/skills returns skills without plan data', async () => {
  const res = await api('GET', '/api/skills');
  expect(res.status).toBe(200);
  expect(Array.isArray(res.json.skills)).toBe(true);
  expect(res.json.plans).toBeUndefined();
});

test('GET /api/pricing returns the table and PUT replaces an entry', async () => {
  const r = await api('GET', '/api/pricing');
  expect(r.json.flash).toBeDefined();
  const put = await api('PUT', '/api/pricing', { flash: { inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 2 } });
  expect(put.status).toBe(200);
  expect(put.json.flash).toEqual({ inputPerM: 1, cachedInputPerM: 0.1, outputPerM: 2 });
  expect(put.json.pro).toBeDefined();
});

test('GET /api/routing describes the effective council and available seats', async () => {
  const r = await api('GET', '/api/routing');
  expect(r.status).toBe(200);
  expect(r.json.available).toBeInstanceOf(Array);
  expect(r.json.seats).toBeInstanceOf(Array);
  expect(r.json.notes).toBeInstanceOf(Array);
});

test('GET /api/budgets returns the three providers', async () => {
  const r = await api('GET', '/api/budgets');
  expect(r.status).toBe(200);
  expect(r.json.gemini).toMatchObject({ limit: 30, spent: 0 });
});

test('PUT /api/settings keeps the recent-project list the server maintains', async () => {
  await api('POST', '/api/projects', { path: process.cwd() });
  const before = (await api('GET', '/api/settings')).json.recentProjects as string[];
  expect(before.length).toBeGreaterThan(0);

  // A settings form that loaded before the project was opened still holds the old list.
  const saved = await api('PUT', '/api/settings', { autoStart: true, recentProjects: [] });
  expect(saved.status).toBe(200);
  expect(saved.json.autoStart).toBe(true);
  expect(saved.json.recentProjects).toEqual(before);
});

test('GET /api/projects/:id restores a recent project without waiting for Git metadata', async () => {
  const opened = await api('POST', '/api/projects', { path: process.cwd() });
  expect(opened.status).toBe(200);
  const restored = await api('GET', `/api/projects/${opened.json.projectId}`);
  expect(restored.status).toBe(200);
  expect(restored.json).toMatchObject({
    projectId: opened.json.projectId,
    root: opened.json.root,
    defaultBranch: null,
  });
  expect(restored.json.tabs).toBeInstanceOf(Array);
  const branch = await api('GET', `/api/projects/${opened.json.projectId}/branch`);
  expect(branch.status).toBe(200);
  expect(branch.json).toHaveProperty('defaultBranch');
  expect((await api('GET', '/api/projects/discover')).status).toBe(200);
});

test('tabs: create, list, get, submit; the websocket streams the tab updates', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const messages: any[] = [];
  // Listen before the handshake settles: `hello` can arrive in the same tick as `open`.
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  const created = await api('POST', '/api/tabs', { projectRoot: 'C:/proj', title: 'Rename' });
  expect(created.status).toBe(201);
  expect(created.json.status).toBe('drafting');
  const id = created.json.id as string;

  const list = await api('GET', `/api/tabs?projectId=${created.json.projectId}`);
  expect(list.json.map((t: any) => t.id)).toContain(id);
  expect((await api('GET', `/api/tabs/${id}`)).json.title).toBe('Rename');

  const submitted = await api('POST', `/api/tabs/${id}/submit`, { text: 'rename foo', mode: { kind: 'auto' } });
  expect(submitted.status).toBe(200);
  expect(submitted.json.status).toBe('voting');

  for (let i = 0; i < 100 && !messages.some((m) => m.type === 'tab' && m.tab.id === id && m.tab.status === 'awaiting-start'); i++) {
    await new Promise((r) => setTimeout(r, 30));
  }
  expect(messages[0]?.type).toBe('hello');
  expect(messages[0].tabs).toBeInstanceOf(Array);
  expect(messages[0].budgets.gemini).toBeDefined();
  expect(messages.some((m) => m.type === 'item' && m.tabId === id && m.item.kind === 'vote')).toBe(true);
  const final = messages.filter((m) => m.type === 'tab' && m.tab.id === id).at(-1);
  expect(final.tab.status).toBe('awaiting-start');
  expect(['gemini', 'codex']).toContain(final.tab.worker.provider);

  const started = await api('POST', `/api/tabs/${id}/start`, { provider: 'claude', model: 'claude-sonnet-5-5' });
  expect(started.json.worker).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5-5' });
  for (let i = 0; i < 100 && fixture.engine.getTab(id)?.status !== 'idle'; i++) await new Promise((r) => setTimeout(r, 30));
  expect(fixture.engine.getTab(id)?.status).toBe('idle');

  expect((await api('POST', `/api/tabs/${id}/merge`)).status).toBe(404);

  const closed = await api('POST', `/api/tabs/${id}/close`);
  expect(closed.json.status).toBe('closed');
  ws.close();
});

test('closed tabs can be deleted from disk and disappear from connected clients', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const messages: any[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  try {
    const created = await api('POST', '/api/tabs', { projectRoot: 'C:/proj', title: 'Old tab' });
    const id = created.json.id as string;
    const file = path.join(fixture.home, 'projects', created.json.projectId, 'tabs', `${id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect((await api('DELETE', `/api/tabs/${id}`)).status).toBe(409);
    expect((await api('POST', `/api/tabs/${id}/close`)).status).toBe(200);
    expect((await api('DELETE', `/api/tabs/${id}`)).status).toBe(200);
    expect(fs.existsSync(file)).toBe(false);
    expect(fixture.engine.getTab(id)).toBeUndefined();
    expect((await api('GET', `/api/tabs/${id}`)).status).toBe(404);
    for (let i = 0; i < 20 && !messages.some((m) => m.type === 'deleted' && m.tabId === id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(messages.some((m) => m.type === 'deleted' && m.tabId === id)).toBe(true);
  } finally {
    ws.close();
  }
});

test('POST /api/projects validates the path and registers it as recent', async () => {
  const missing = await api('POST', '/api/projects', { path: path.join(fixture.home, 'nope') });
  expect(missing.status).toBe(400);
  const notRepo = await api('POST', '/api/projects', { path: fixture.home });
  expect(notRepo.status).toBe(400);
  expect(String(notRepo.json.error)).toMatch(/git/i);
});

test('GET /api/projects/discover and browse return directory metadata', async () => {
  const disc = await api('GET', '/api/projects/discover');
  expect(disc.status).toBe(200);
  expect(disc.json.currentCwd).toBeDefined();
  expect(Array.isArray(disc.json.projects)).toBe(true);

  const browse = await api('GET', '/api/projects/browse');
  expect(browse.status).toBe(200);
  expect(browse.json.current).toBeDefined();
  expect(Array.isArray(browse.json.directories)).toBe(true);
});

test('errors are JSON: 404 for unknown routes, 400 for bad bodies and wrong-state actions', async () => {
  expect((await api('GET', '/api/nope')).status).toBe(404);
  expect((await api('POST', '/api/tabs', '{ not json')).status).toBe(400);
  const t = await api('POST', '/api/tabs', { projectRoot: 'C:/proj', title: 'x' });
  const wrong = await api('POST', `/api/tabs/${t.json.id}/start`);
  expect(wrong.status).toBe(400);
  expect(wrong.json.error).toMatch(/drafting/);
  expect((await api('GET', '/api/tabs/does-not-exist')).status).toBe(404);
});

test('cross-origin requests cannot drive the API or the websocket', async () => {
  const evil = await fetch(`${base}/api/tabs`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'http://evil.example' },
    body: JSON.stringify({ projectRoot: 'C:/proj', title: 'pwned' }),
  });
  expect(evil.status).toBe(403);
  const sameOriginOtherPort = await fetch(`${base}/api/budgets`, { headers: { origin: 'http://localhost:5173' } });
  expect(sameOriginOtherPort.status).toBe(200);
  const noJson = await fetch(`${base}/api/tabs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"projectRoot":"C:/proj"}' });
  expect(noJson.status).toBe(415);

  const rejected = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { origin: 'http://evil.example' } });
    ws.on('open', () => {
      ws.close();
      resolve(false);
    });
    ws.on('unexpected-response', () => resolve(true));
    ws.on('error', () => resolve(true));
  });
  expect(rejected).toBe(true);
});

test('serves the built client with an SPA fallback', async () => {
  const index = await fetch(`${base}/`);
  expect(index.status).toBe(200);
  expect(await index.text()).toContain('<title>Council</title>');
  const deep = await fetch(`${base}/settings/anything`);
  expect(await deep.text()).toContain('<title>Council</title>');
  const asset = await fetch(`${base}/assets/app.js`);
  expect(asset.headers.get('content-type')).toMatch(/javascript/);
  expect(await asset.text()).toBe('console.log(1)');
});
