import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { WebSocketServer } from 'ws';
import { PROVIDERS, type CliHealth, type Provider } from './adapters/types.js';
import { permissionMode } from './adapters/permissions.js';
import { detectedBudgets, detectedModels } from './config/detect.js';
import type { SettingsStore } from './config/settings.js';
import type { PricingStore, PriceTable } from './ledger/pricing.js';
import { isAllowedHost, isAllowedOrigin } from './origin.js';
import type { SubmitMode, TaskEngine } from './tasks/engine.js';
import { defaultBranch } from './worktrees/git.js';
import { attachWebSocket } from './ws.js';
import { findPlans, findSkills } from './discovery/plans.js';
import { browseDirectory, discoverProjects, pickNativeFolder } from './discovery/projects.js';

export interface ServerDeps {
  engine: TaskEngine;
  settings: SettingsStore;
  pricing: PricingStore;
  health: (fresh?: boolean) => Promise<Record<Provider, CliHealth>>;
  /** Built client to serve at `/`; API only when omitted. */
  clientDist?: string;
}

export interface CouncilServer {
  server: http.Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

const MAX_BODY = 1024 * 1024;

async function readJson(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) throw new HttpError(415, 'request bodies must be sent as application/json');
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
    return parsed as Json;
  } catch (err) {
    throw new HttpError(400, `invalid JSON body: ${(err as Error).message}`);
  }
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, `${name} is required`);
  return v;
}

function provider(v: unknown): Provider {
  if (typeof v !== 'string' || !(PROVIDERS as readonly string[]).includes(v)) throw new HttpError(400, `provider must be one of ${PROVIDERS.join(', ')}`);
  return v as Provider;
}

function modelOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function submitMode(v: unknown): SubmitMode {
  if (!v || typeof v !== 'object') return { kind: 'auto' };
  const m = v as Json;
  if (m.kind === 'manual') return { kind: 'manual', provider: provider(m.provider), model: modelOf(m.model) };
  return { kind: 'auto' };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export function createServer(deps: ServerDeps): CouncilServer {
  const { engine } = deps;

  async function api(method: string, url: URL, req: http.IncomingMessage): Promise<{ status: number; body: unknown }> {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const [, resource, id, action] = parts;
    const body = method === 'POST' || method === 'PUT' ? await readJson(req) : {};

    if (resource === 'health' && method === 'GET') return { status: 200, body: await deps.health(url.searchParams.get('refresh') === '1') };

    if (resource === 'settings') {
      if (id === 'detect-models' && method === 'POST') {
        const health = await deps.health(true);
        const update = detectedModels(deps.settings.get(), health);
        return { status: 200, body: await deps.settings.update(update) };
      }
      if (id === 'detect-budgets' && method === 'POST') {
        const update = detectedBudgets(deps.settings.get(), await deps.health());
        return { status: 200, body: await deps.settings.update(update) };
      }
      if (method === 'GET') return { status: 200, body: deps.settings.get() };
      if (method === 'PUT') {
        // `recentProjects` has its own endpoint; a settings form holding a stale copy must not shorten the list.
        const { recentProjects: _ignored, ...editable } = body;
        return { status: 200, body: await deps.settings.update(editable) };
      }
    }

    if (resource === 'pricing') {
      if (method === 'GET') return { status: 200, body: deps.pricing.get() };
      if (method === 'PUT') return { status: 200, body: await deps.pricing.update(body as PriceTable) };
    }

    if (resource === 'budgets' && method === 'GET') return { status: 200, body: await engine.budgets() };

    if (resource === 'plans' && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      let root = process.cwd();
      if (projectId) {
        const found = deps.settings.get().recentProjects.find((r) => engine.projectIdFor(r) === projectId);
        if (found) root = found;
      }
      const [plans, skills] = await Promise.all([findPlans(root), findSkills(root)]);
      return { status: 200, body: { plans, skills } };
    }

    if (resource === 'skills' && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      const root = projectId
        ? deps.settings.get().recentProjects.find((r) => engine.projectIdFor(r) === projectId) ?? process.cwd()
        : process.cwd();
      return { status: 200, body: { skills: await findSkills(root) } };
    }

    if (resource === 'routing' && method === 'GET') {
      return { status: 200, body: engine.routing(url.searchParams.get('projectId') ?? undefined) };
    }

    if (resource === 'projects') {
      if (id && /^[0-9a-f]{12}$/.test(id) && method === 'GET' && !action) {
        const root = deps.settings.get().recentProjects.find((candidate) => engine.projectIdFor(candidate) === id);
        if (!root) throw new HttpError(404, `unknown project ${id}`);
        const stat = await fs.stat(root).catch(() => null);
        if (!stat?.isDirectory()) throw new HttpError(404, 'workspace folder no longer exists');
        // Recent projects were already validated when opened. Restoring one should
        // not run Git commands just to display its saved tabs.
        const tabs = await engine.loadProject(root);
        return { status: 200, body: { projectId: id, root, defaultBranch: null, tabs } };
      }
      if (id && /^[0-9a-f]{12}$/.test(id) && action === 'branch' && method === 'GET') {
        const root = deps.settings.get().recentProjects.find((candidate) => engine.projectIdFor(candidate) === id);
        if (!root) throw new HttpError(404, `unknown project ${id}`);
        return { status: 200, body: { defaultBranch: await defaultBranch(root).catch(() => null) } };
      }
      if (id === 'discover' && method === 'GET') {
        const found = await discoverProjects();
        return { status: 200, body: { currentCwd: process.cwd(), projects: found } };
      }
      if (id === 'browse' && method === 'GET') {
        const dir = url.searchParams.get('dir') ?? undefined;
        return { status: 200, body: await browseDirectory(dir) };
      }
      if (id === 'pick-native' && method === 'POST') {
        const initial = typeof body.initial === 'string' ? body.initial : undefined;
        return { status: 200, body: await pickNativeFolder(initial) };
      }
      if (method === 'GET') {
        return {
          status: 200,
          body: deps.settings.get().recentProjects.map((root) => ({ root, projectId: engine.projectIdFor(root) })),
        };
      }
      if (method === 'POST') {
        const requested = str(body.path, 'path');
        const stat = await fs.stat(requested).catch(() => null);
        if (!stat?.isDirectory()) throw new HttpError(400, 'path does not exist or is not a directory');
        const root = path.resolve(requested);
        await deps.settings.addRecentProject(root);
        const tabs = await engine.loadProject(root);
        return { status: 200, body: { projectId: engine.projectIdFor(root), root, defaultBranch: null, tabs } };
      }
    }

    if (resource === 'tabs') {
      if (!id) {
        if (method === 'GET') {
          const projectId = url.searchParams.get('projectId') ?? undefined;
          return { status: 200, body: engine.listTabs(projectId) };
        }
        if (method === 'POST') {
          const tab = await engine.createTab(str(body.projectRoot, 'projectRoot'), typeof body.title === 'string' ? body.title : '');
          return { status: 201, body: tab };
        }
      } else {
        const tab = engine.getTab(id);
        if (!tab) throw new HttpError(404, `unknown tab ${id}`);
        if (!action && method === 'GET') return { status: 200, body: tab };
        if (!action && method === 'DELETE') {
          if (tab.status !== 'closed') throw new HttpError(409, 'close the tab before deleting it');
          await engine.delete(id);
          return { status: 200, body: { id } };
        }
        if (method === 'POST') {
          switch (action) {
            case 'submit':
              return {
                status: 200,
                body: await engine.submit(id, str(body.text, 'text'), submitMode(body.mode), {
                  fullAuto: typeof body.fullAuto === 'boolean' ? body.fullAuto : undefined,
                  permissionMode: body.permissionMode === undefined ? undefined : permissionMode(body.permissionMode),
                }),
              };
            case 'start':
              return {
                status: 200,
                body: await engine.start(id, body.provider ? { provider: provider(body.provider), model: modelOf(body.model) } : undefined),
              };
            case 'send':
              return {
                status: 200,
                body: await engine.send(id, str(body.text, 'text'), {
                  fullAuto: typeof body.fullAuto === 'boolean' ? body.fullAuto : undefined,
                  permissionMode: body.permissionMode === undefined ? undefined : permissionMode(body.permissionMode),
                }),
              };
            case 'permissions':
              return { status: 200, body: await engine.setPermissionMode(id, permissionMode(body.permissionMode)) };
            case 'input': {
              const requestId = str(body.requestId, 'requestId');
              if (!tab.pendingInputs?.some((p) => p.id === requestId)) throw new HttpError(409, 'This input request is no longer pending');
              if (!['allow', 'deny', 'answer'].includes(String(body.decision))) throw new HttpError(400, 'Invalid input decision');
              return { status: 200, body: await engine.answerInput(id, requestId, { decision: body.decision as 'allow' | 'deny' | 'answer', optionId: typeof body.optionId === 'string' ? body.optionId : undefined, answers: body.answers as Record<string, string[]> | undefined }) };
            }
            case 'clear-context':
              return { status: 200, body: await engine.clearContext(id) };
            case 'escalate':
              return { status: 200, body: await engine.escalate(id) };
            case 'switch':
              return { status: 200, body: await engine.switchWorker(id, provider(body.provider), modelOf(body.model)) };
            case 'close':
              return { status: 200, body: await engine.close(id) };
            case 'stop':
              return { status: 200, body: await engine.stop(id) };
            default:
              break;
          }
        }
      }
    }

    throw new HttpError(404, `no route for ${method} ${url.pathname}`);
  }

  async function serveStatic(url: URL, res: http.ServerResponse): Promise<void> {
    const dist = deps.clientDist;
    if (!dist) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'client not built; run npm run build' }));
      return;
    }
    const root = path.resolve(dist);
    let target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (target !== root && !target.startsWith(root + path.sep)) target = path.join(root, 'index.html');
    let file = target;
    let stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.isDirectory()) {
      const hasExtension = path.extname(url.pathname) !== '';
      if (hasExtension && !stat) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      file = path.join(root, 'index.html');
      stat = await fs.stat(file).catch(() => null);
      if (!stat) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('client not built');
        return;
      }
    }
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(await fs.readFile(file));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Council only answers requests addressed to localhost' }));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD' && !isAllowedOrigin(req.headers.origin)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'cross-origin requests are not allowed' }));
        return;
      }
      api(method, url, req)
        .then(({ status, body }) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        })
        .catch((err: unknown) => {
          const status = err instanceof HttpError ? err.status : 400;
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: message }));
        });
      return;
    }
    serveStatic(url, res).catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
  });

  let wss: WebSocketServer | undefined;

  return {
    server,
    listen(port, host = '127.0.0.1') {
      wss = attachWebSocket(server, engine);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const client of wss?.clients ?? []) client.terminate();
        wss?.close();
        server.close(() => resolve());
      });
    },
  };
}
