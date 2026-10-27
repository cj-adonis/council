import type { BrowseResult, BudgetState, CliHealth, DiscoveredProject, EffectiveRouting, InputReply, ProjectInfo, Provider, Settings, SkillInfo, SubmitMode, Tab } from './types';
import type { PermissionMode } from './types';

async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(route, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      /* keep the status text */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => call<Record<Provider, CliHealth>>('GET', '/api/health'),
  settings: () => call<Settings>('GET', '/api/settings'),
  saveSettings: (partial: Partial<Settings>) => call<Settings>('PUT', '/api/settings', partial),
  detectModels: () => call<Settings>('POST', '/api/settings/detect-models'),
  detectBudgets: () => call<Settings>('POST', '/api/settings/detect-budgets'),
  budgets: () => call<Record<Provider, BudgetState>>('GET', '/api/budgets'),
  skills: (projectId?: string) =>
    call<{ skills: SkillInfo[] }>('GET', projectId ? `/api/skills?projectId=${encodeURIComponent(projectId)}` : '/api/skills'),
  routing: (projectId?: string) => call<EffectiveRouting>('GET', projectId ? `/api/routing?projectId=${encodeURIComponent(projectId)}` : '/api/routing'),
  projects: () => call<ProjectInfo[]>('GET', '/api/projects'),
  restoreProject: (projectId: string) => call<ProjectInfo & { tabs: Tab[] }>('GET', `/api/projects/${encodeURIComponent(projectId)}`),
  projectBranch: (projectId: string) => call<{ defaultBranch: string | null }>('GET', `/api/projects/${encodeURIComponent(projectId)}/branch`),
  discoverProjects: () => call<{ currentCwd: string; projects: DiscoveredProject[] }>('GET', '/api/projects/discover'),
  pickNativeFolder: (initial?: string) =>
    call<{ path: string | null; available: boolean }>('POST', '/api/projects/pick-native', { initial }),
  browse: (dir?: string) =>
    call<BrowseResult>('GET', dir ? `/api/projects/browse?dir=${encodeURIComponent(dir)}` : '/api/projects/browse'),
  openProject: (path: string) => call<ProjectInfo & { tabs: Tab[] }>('POST', '/api/projects', { path }),
  createTab: (projectRoot: string, title: string) => call<Tab>('POST', '/api/tabs', { projectRoot, title }),
  submit: (id: string, text: string, mode: SubmitMode, permission: boolean | PermissionMode) => call<Tab>('POST', `/api/tabs/${id}/submit`, { text, mode, ...(typeof permission === 'boolean' ? { fullAuto: permission } : { permissionMode: permission }) }),
  start: (id: string, pick?: { provider: Provider; model: string | null }) => call<Tab>('POST', `/api/tabs/${id}/start`, pick ?? {}),
  send: (id: string, text: string, opts?: { fullAuto?: boolean; permissionMode?: PermissionMode }) => call<Tab>('POST', `/api/tabs/${id}/send`, { text, ...opts }),
  setPermissionMode: (id: string, permissionMode: PermissionMode) => call<Tab>('POST', `/api/tabs/${id}/permissions`, { permissionMode }),
  answerInput: (id: string, requestId: string, reply: InputReply) => call<Tab>('POST', `/api/tabs/${id}/input`, { requestId, ...reply }),
  clearContext: (id: string) => call<Tab>('POST', `/api/tabs/${id}/clear-context`),
  escalate: (id: string) => call<Tab>('POST', `/api/tabs/${id}/escalate`),
  switchWorker: (id: string, provider: Provider, model: string | null) => call<Tab>('POST', `/api/tabs/${id}/switch`, { provider, model }),
  close: (id: string) => call<Tab>('POST', `/api/tabs/${id}/close`, {}),
  stop: (id: string) => call<Tab>('POST', `/api/tabs/${id}/stop`, {}),
  deleteTab: (id: string) => call<{ id: string }>('DELETE', `/api/tabs/${id}`),
};
