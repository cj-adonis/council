import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { Home } from './components/Home';
import { ConfirmTabAction } from './components/ConfirmTabAction';
import { Settings } from './components/Settings';
import { ShortcutHelp } from './components/ShortcutHelp';
import { Sidebar } from './components/Sidebar';
import { TabView } from './components/TabView';
import { basename } from './lib/format';
import { laneOf, stepThrough, visibleOrder } from './lib/lanes';
import {
  formatHash,
  LAST_PROJECT_KEY,
  LAST_TAB_KEY,
  pickInitialProject,
  readHash,
  readStorage,
  readWantedTab,
  writeStorage,
} from './lib/nav';
import { noneSetUp } from './lib/routing';
import { shortcutAction } from './lib/shortcuts';
import type { BudgetState, CliHealth, EffectiveRouting, PermissionMode, ProjectInfo, Provider, Settings as SettingsT, SubmitMode, Tab, TranscriptItem } from './types';
import { useNow } from './hooks/useNow';
import { useSocket } from './useSocket';

const DETAILS_KEY = 'council.details';
const OPEN_PROJECTS_KEY = 'council.openProjects';
/** How often health and the effective routing are re-read, so a CLI signed in while the page is open gets noticed. */
const HEALTH_REFRESH_MS = 60_000;

function readDetailsPref(): boolean {
  try {
    const v = localStorage.getItem(DETAILS_KEY);
    // Open by default only where the pane has its own column (see the 1200px breakpoint in styles.css).
    return v === null ? window.innerWidth > 1200 : v === '1';
  } catch {
    return true;
  }
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function writeHash(next: string) {
  if (location.hash !== next) history.replaceState(null, '', next || location.pathname + location.search);
}

export function App() {
  const [tabs, setTabs] = useState<Record<string, Tab>>({});
  const [budgets, setBudgets] = useState<Record<Provider, BudgetState> | null>(null);
  const [settings, setSettings] = useState<SettingsT | null>(null);
  const [health, setHealth] = useState<Record<Provider, CliHealth> | null>(null);
  const [healthChecking, setHealthChecking] = useState(true);
  const [routing, setRouting] = useState<EffectiveRouting | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [openProjects, setOpenProjects] = useState<ProjectInfo[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [view, setView] = useState<'tabs' | 'settings'>(() => (readHash(location.hash).settings ? 'settings' : 'tabs'));
  /** A tab id from the URL hash or local storage, honoured once that tab is known. */
  const [wantedTab, setWantedTab] = useState<string | null>(() => readWantedTab(location.hash, getStorage()));
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [tabAction, setTabAction] = useState<{ tab: Tab; action: 'close' | 'delete' } | null>(null);
  const [details, setDetails] = useState(readDetailsPref);
  /** Stall notices received per tab, so "Keep waiting" can tell a new stall from the one it answered. */
  const [stallSeq, setStallSeq] = useState<Record<string, number>>({});
  const now = useNow(10_000);

  const onError = useCallback((message: string) => setError(message), []);

  const forgetTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      if (!prev[tabId]) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setStallSeq((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setSelectedId((prev) => prev === tabId ? null : prev);
    setWantedTab((prev) => prev === tabId ? null : prev);
    if (readStorage(getStorage(), LAST_TAB_KEY) === tabId) writeStorage(getStorage(), LAST_TAB_KEY, null);
  }, []);

  const connected = useSocket({
    onHello: (all, b) => {
      setTabs(Object.fromEntries(all.map((t) => [t.id, t])));
      if (b) setBudgets(b);
    },
    onTab: (tab) => setTabs((prev) => ({ ...prev, [tab.id]: tab })),
    onDeleted: forgetTab,
    onItem: (tabId: string, item: TranscriptItem) =>
      setTabs((prev) => {
        const tab = prev[tabId];
        if (!tab) return prev;
        const idx = tab.transcript.findIndex((i) => i.id === item.id);
        const transcript = idx >= 0 ? tab.transcript.map((i, j) => (j === idx ? item : i)) : [...tab.transcript, item];
        return { ...prev, [tabId]: { ...tab, transcript } };
      }),
    onStall: (tabId: string) => setStallSeq((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 })),
    onBudgets: setBudgets,
  });

  const openProject = useCallback(async (path: string, restoreId?: string) => {
    const info = restoreId ? await api.restoreProject(restoreId) : await api.openProject(path);
    setProject({ root: info.root, projectId: info.projectId, defaultBranch: info.defaultBranch });
    setOpenProjects((prev) => prev.some((p) => p.projectId === info.projectId) ? prev : [...prev, { root: info.root, projectId: info.projectId, defaultBranch: info.defaultBranch }]);
    setTabs((prev) => ({ ...prev, ...Object.fromEntries(info.tabs.map((t) => [t.id, t])) }));
    writeStorage(getStorage(), LAST_PROJECT_KEY, info.root);
    void api.projectBranch(info.projectId).then(({ defaultBranch }) => {
      setProject((prev) => prev?.projectId === info.projectId ? { ...prev, defaultBranch } : prev);
      setOpenProjects((prev) => prev.map((p) => p.projectId === info.projectId ? { ...p, defaultBranch } : p));
    }).catch(() => {});
    // The selection is never cleared here: a tab from another project simply stops being shown (see `selected`),
    // so a deep link that opens its own project keeps its tab even when the initial project load finishes later.
  }, []);

  useEffect(() => {
    api.settings().then(setSettings).catch((e: Error) => onError(e.message));
    api.budgets().then(setBudgets).catch(() => {});
    api
      .projects()
      .then(async (list) => {
        const lastRoot = readStorage(getStorage(), LAST_PROJECT_KEY);
        const target = pickInitialProject(list, lastRoot);
        const saved = readStorage(getStorage(), OPEN_PROJECTS_KEY);
        let ids: string[] | null = null;
        if (saved !== null) {
          try {
            const parsed: unknown = JSON.parse(saved);
            if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) ids = parsed;
          } catch { /* use the previous single-workspace preference */ }
        }
        if (ids) {
          const restored = list.filter((p) => ids.includes(p.projectId) && p.projectId !== target?.projectId);
          for (const p of restored) await openProject(p.root, p.projectId).catch(() => {});
          if (target && ids.includes(target.projectId)) await openProject(target.root, target.projectId).catch(() => {});
        } else if (target) await openProject(target.root, target.projectId);
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setInitializing(false));
  }, [onError, openProject]);

  useEffect(() => {
    if (!initializing) writeStorage(getStorage(), OPEN_PROJECTS_KEY, JSON.stringify(openProjects.map((p) => p.projectId)));
  }, [initializing, openProjects]);

  const refreshHealth = useCallback(async (fresh = true) => {
    setHealthChecking(true);
    try {
      setHealth(await api.health(fresh));
      setRouting(await api.routing(project?.projectId));
    } finally {
      setHealthChecking(false);
    }
  }, [project?.projectId]);

  const checkProviders = () => void refreshHealth().catch((err: Error) => onError(`Provider check failed: ${err.message}`));

  // Health and the routing in force (which CLIs are set up) for the open project; re-read now and then.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      api
        .health()
        .then((h) => {
          if (!cancelled) setHealth(h);
          return api.routing(project?.projectId);
        })
        .then((r) => {
          if (!cancelled) setRouting(r);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setHealthChecking(false);
        });
    };
    refresh();
    const t = setInterval(refresh, HEALTH_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [project?.projectId]);

  useEffect(() => {
    if (!wantedTab) return;
    const wanted = tabs[wantedTab];
    if (wanted) {
      setSelectedId(wanted.id);
      writeStorage(getStorage(), LAST_TAB_KEY, wanted.id);
      setWantedTab(null);
      // A link into another project's tab brings that project's sidebar with it.
      if (project && wanted.projectId !== project.projectId) {
        openProject(wanted.projectRoot).catch((e: Error) => onError(e.message));
      }
    } else if (!initializing) {
      // If initial loading finished and the tab does not exist, clear it
      setWantedTab(null);
      writeStorage(getStorage(), LAST_TAB_KEY, null);
    }
  }, [wantedTab, tabs, project, initializing, openProject, onError]);

  useEffect(() => {
    if (wantedTab) return;
    writeHash(formatHash(view, selectedId));
  }, [view, selectedId, wantedTab]);

  useEffect(() => {
    const onHashChange = () => {
      const h = readHash(location.hash);
      if (h.settings) {
        setView('settings');
      } else if (h.tab) {
        setView('tabs');
        setSelectedId(h.tab);
        writeStorage(getStorage(), LAST_TAB_KEY, h.tab);
      } else {
        setView('tabs');
        setSelectedId(null);
        writeStorage(getStorage(), LAST_TAB_KEY, null);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const projectTabs = useMemo(() => Object.values(tabs).filter((t) => project && t.projectId === project.projectId), [tabs, project]);
  const openTabs = useMemo(() => projectTabs.filter((t) => t.status !== 'closed'), [projectTabs]);
  const selectedTab = selectedId ? tabs[selectedId] : undefined;
  /** The selected tab, when it belongs to the open project; a tab from another project is simply not shown. */
  const selected = selectedTab && project && selectedTab.projectId === project.projectId ? selectedTab : undefined;
  const available = routing?.available ?? null;

  const select = useCallback((id: string | null) => {
    if (id) {
      setComposing(false);
      const target = tabs[id];
      const workspace = openProjects.find((p) => p.projectId === target?.projectId);
      if (workspace) {
        setProject(workspace);
        writeStorage(getStorage(), LAST_PROJECT_KEY, workspace.root);
      }
      setSelectedId(id);
      writeStorage(getStorage(), LAST_TAB_KEY, id);
    }
    setView('tabs');
  }, [tabs, openProjects]);

  const newTab = useCallback(async () => {
    if (!project || noneSetUp(available)) return;
    setComposing(true);
    setSelectedId(null);
    setView('tabs');
  }, [project, available]);

  const newSession: Tab | null = composing && project ? {
    id: 'new-session', projectId: project.projectId, projectRoot: project.root, title: '', status: 'drafting',
    worker: null, previousWorkers: [], vote: null, routing: null, transcript: [], costUsd: 0,
    fullAuto: false, escalations: 0, stalled: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } : null;

  const closeTab = useCallback(async (tab: Tab) => {
    setTabAction({ tab, action: 'close' });
  }, []);

  const deleteTab = useCallback(async (tab: Tab) => {
    setTabAction({ tab, action: 'delete' });
  }, []);

  const confirmTabAction = async () => {
    if (!tabAction) return;
    const { tab, action } = tabAction;
    try {
      if (action === 'delete') {
        await api.deleteTab(tab.id);
        forgetTab(tab.id);
      } else {
        await api.close(tab.id);
        await api.deleteTab(tab.id);
        forgetTab(tab.id);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setTabAction(null);
    }
  };

  const toggleDetails = useCallback(() => {
    setDetails((d) => {
      try {
        localStorage.setItem(DETAILS_KEY, d ? '0' : '1');
      } catch {
        /* preference lives for this page only */
      }
      return !d;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutAction(e);
      if (!action) return;
      if (action.type === 'escape') {
        if (help) {
          e.preventDefault();
          setHelp(false);
        }
        return;
      }
      e.preventDefault();
      const order = visibleOrder(projectTabs);
      switch (action.type) {
        case 'new-tab':
          void newTab();
          break;
        case 'settings':
          setView((v) => (v === 'settings' ? 'tabs' : 'settings'));
          break;
        case 'help':
          setHelp((h) => !h);
          break;
        case 'toggle-details':
          toggleDetails();
          break;
        case 'next-tab':
          select(stepThrough(order, selectedId, 1));
          break;
        case 'prev-tab':
          select(stepThrough(order, selectedId, -1));
          break;
        case 'next-attention':
          select(stepThrough(order.filter((t) => laneOf(t) === 'needs-you'), selectedId, 1));
          break;
        case 'prev-attention':
          select(stepThrough(order.filter((t) => laneOf(t) === 'needs-you'), selectedId, -1));
          break;
        case 'jump': {
          const target = order[action.index];
          if (target) select(target.id);
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, projectTabs, selectedId, newTab, select, toggleDetails]);

  const openFromUi = async (p: string) => {
    try {
      await openProject(p);
      setComposing(false);
      setView('tabs');
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className={`app${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      {sidebarOpen ? <Sidebar
        project={project}
        openProjects={openProjects}
        onSelectProject={(workspace) => {
          setComposing(false);
          setProject(workspace);
          setSelectedId(null);
          setView('tabs');
          writeStorage(getStorage(), LAST_PROJECT_KEY, workspace.root);
          writeStorage(getStorage(), LAST_TAB_KEY, null);
        }}
        onCloseProject={(id) => {
          const remaining = openProjects.filter((p) => p.projectId !== id);
          setOpenProjects(remaining);
          if (project?.projectId === id) {
            setComposing(false);
            const next = remaining[0] ?? null;
            setProject(next);
            setSelectedId(null);
            setWantedTab(null);
            writeStorage(getStorage(), LAST_PROJECT_KEY, next?.root ?? null);
            writeStorage(getStorage(), LAST_TAB_KEY, null);
          }
        }}
        onCollapse={() => setSidebarOpen(false)}
        onOpenProject={openFromUi}
        tabs={Object.values(tabs).filter((t) => openProjects.some((p) => p.projectId === t.projectId))}
        selectedId={selectedId}
        onSelect={select}
        onCloseTab={closeTab}
        onNewTab={() => void newTab()}
        budgets={budgets}
        resetDay={settings?.resetDay ?? 1}
        available={available}
        view={view}
        onView={setView}
        onHelp={() => setHelp(true)}
        connected={connected}
        now={now}
      /> : <aside className="sidebar-rail" aria-label="Collapsed sidebar">
        <button className="iconbtn sidebar-expand" onClick={() => setSidebarOpen(true)} aria-label="Expand sidebar" title="Expand sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M13 9l3 3-3 3" />
          </svg>
        </button>
      </aside>}
      <div className="content">
        {!connected && (
          <div className="banner tone-warn" role="status">
            <span>Reconnecting to the local Council server… Nothing is lost; the page catches up when it is back.</span>
          </div>
        )}
        {error && (
          <div className="banner tone-danger" role="alert">
            <span>{error}</span>
            <button className="link sm" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}
        {initializing && (wantedTab || !project) ? (
          <main className="home">
            <div className="home-inner">
              <p className="lead muted">Loading workspace…</p>
            </div>
          </main>
        ) : view === 'settings' && settings ? (
          <Settings settings={settings} onSaved={setSettings} health={health} checking={healthChecking} onRefresh={refreshHealth} onError={onError} />
        ) : newSession && settings ? (
          <TabView key={`new-${newSession.projectId}`} tab={newSession} settings={settings} available={available} stallSeq={0} details={details} onToggleDetails={toggleDetails} onError={onError} onDelete={deleteTab} onClose={closeTab} onCancelCreate={() => setComposing(false)}
            onCreate={async (text: string, mode: SubmitMode, permission: PermissionMode) => {
              try {
                const created = await api.createTab(newSession.projectRoot, '');
                const submitted = await api.submit(created.id, text, mode, permission);
                setTabs((prev) => ({ ...prev, [submitted.id]: submitted }));
                setComposing(false);
                select(submitted.id);
              } catch (err) {
                onError((err as Error).message);
                throw err;
              }
            }} />
        ) : selected && settings ? (
          <TabView
            key={selected.id}
            tab={selected}
            settings={settings}
            available={available}
            stallSeq={stallSeq[selected.id] ?? 0}
            details={details}
            onToggleDetails={toggleDetails}
            onError={onError}
            onDelete={deleteTab}
            onClose={closeTab}
            onTabUpdate={(updated) => setTabs((prev) => ({ ...prev, [updated.id]: updated }))}
          />
        ) : (
          <Home project={project} openTabs={openTabs.length} available={available} notes={routing?.notes ?? []} health={health} checking={healthChecking} onRefresh={checkProviders} onOpenProject={openFromUi} onNewTab={() => void newTab()} onSettings={() => setView('settings')} confidenceThreshold={settings?.confidenceThreshold} />
        )}
      </div>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {tabAction && <ConfirmTabAction title={tabAction.tab.title} action={tabAction.action}
        running={['running', 'voting', 'handing-off'].includes(tabAction.tab.status)}
        onCancel={() => setTabAction(null)} onConfirm={confirmTabAction} />}
    </div>
  );
}
