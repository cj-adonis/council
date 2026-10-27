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
import type { BudgetState, CliHealth, EffectiveRouting, ProjectInfo, Provider, Settings as SettingsT, Tab, TranscriptItem } from './types';
import { useNow } from './hooks/useNow';
import { useSocket } from './useSocket';

const DETAILS_KEY = 'council.details';
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
  const [routing, setRouting] = useState<EffectiveRouting | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
    setTabs((prev) => ({ ...prev, ...Object.fromEntries(info.tabs.map((t) => [t.id, t])) }));
    setProjects((prev) => [
      { root: info.root, projectId: info.projectId, defaultBranch: info.defaultBranch },
      ...prev.filter((p) => p.projectId !== info.projectId),
    ]);
    writeStorage(getStorage(), LAST_PROJECT_KEY, info.root);
    if (restoreId) {
      void api.projectBranch(restoreId).then(({ defaultBranch }) => {
        setProject((prev) => prev?.projectId === restoreId ? { ...prev, defaultBranch } : prev);
        setProjects((prev) => prev.map((p) => p.projectId === restoreId ? { ...p, defaultBranch } : p));
      }).catch(() => {});
    }
    // The selection is never cleared here: a tab from another project simply stops being shown (see `selected`),
    // so a deep link that opens its own project keeps its tab even when the initial project load finishes later.
  }, []);

  useEffect(() => {
    api.settings().then(setSettings).catch((e: Error) => onError(e.message));
    api.budgets().then(setBudgets).catch(() => {});
    api
      .projects()
      .then(async (list) => {
        setProjects(list);
        const lastRoot = readStorage(getStorage(), LAST_PROJECT_KEY);
        const target = pickInitialProject(list, lastRoot);
        if (target) await openProject(target.root, target.projectId);
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setInitializing(false));
  }, [onError, openProject]);

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
        .catch(() => {
          if (!cancelled) setHealth(null);
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
      setSelectedId(id);
      writeStorage(getStorage(), LAST_TAB_KEY, id);
    }
    setView('tabs');
  }, []);

  const newTab = useCallback(async () => {
    if (!project || noneSetUp(available)) return;
    try {
      const tab = await api.createTab(project.root, '');
      setTabs((prev) => ({ ...prev, [tab.id]: tab }));
      select(tab.id);
    } catch (err) {
      onError((err as Error).message);
    }
  }, [project, available, select, onError]);

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
        const closed = await api.close(tab.id);
        setTabs((prev) => ({ ...prev, [closed.id]: closed }));
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
      setView('tabs');
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        project={project}
        onOpenProject={openFromUi}
        tabs={projectTabs}
        selectedId={selectedId}
        onSelect={select}
        onCloseTab={closeTab}
        onDeleteTab={deleteTab}
        onNewTab={() => void newTab()}
        budgets={budgets}
        resetDay={settings?.resetDay ?? 1}
        available={available}
        view={view}
        onView={setView}
        onHelp={() => setHelp(true)}
        connected={connected}
        now={now}
      />
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
          <Settings settings={settings} onSaved={setSettings} health={health} onError={onError} />
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
            onTabUpdate={(updated) => setTabs((prev) => ({ ...prev, [updated.id]: updated }))}
          />
        ) : (
          <Home projects={projects} project={project} openTabs={openTabs.length} available={available} notes={routing?.notes ?? []} health={health} onOpenProject={openFromUi} onNewTab={() => void newTab()} onSettings={() => setView('settings')} />
        )}
      </div>
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
      {tabAction && <ConfirmTabAction title={tabAction.tab.title} action={tabAction.action}
        running={['running', 'voting', 'handing-off'].includes(tabAction.tab.status)}
        onCancel={() => setTabAction(null)} onConfirm={confirmTabAction} />}
    </div>
  );
}
