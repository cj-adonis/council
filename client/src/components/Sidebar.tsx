import { laneCounts } from '../lib/lanes';
import { noneSetUp, type Availability } from '../lib/routing';
import type { BudgetState, ProjectInfo, Provider, Tab } from '../types';
import { BudgetBars } from './BudgetBars';
import { ProjectPicker } from './ProjectPicker';
import { TabList } from './TabList';
import { ThemeToggle } from './ThemeToggle';

interface Props {
  projects: ProjectInfo[];
  project: ProjectInfo | null;
  onOpenProject: (path: string) => Promise<void>;
  tabs: Tab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCloseTab: (tab: Tab) => Promise<void>;
  onDeleteTab: (tab: Tab) => Promise<void>;
  onNewTab: () => void;
  budgets: Record<Provider, BudgetState> | null;
  resetDay: number;
  available: Availability;
  view: 'tabs' | 'settings';
  onView: (v: 'tabs' | 'settings') => void;
  onHelp: () => void;
  connected: boolean;
  now: Date;
}

export function Sidebar(p: Props) {
  const counts = laneCounts(p.tabs);
  const nothingSetUp = noneSetUp(p.available);
  return (
    <aside className="sidebar">
      <div className="brand">
        <h1>Council</h1>
        <span className={`conn${p.connected ? '' : ' off'}`} title={p.connected ? 'Connected to the local server' : 'Reconnecting…'} role="status" aria-label={p.connected ? 'connected' : 'reconnecting'} />
        <span className="spacer" />
        <ThemeToggle />
        <button className={`iconbtn${p.view === 'settings' ? ' selected' : ''}`} onClick={() => p.onView(p.view === 'settings' ? 'tabs' : 'settings')} title="Settings (Alt+S)" aria-label="Settings" aria-pressed={p.view === 'settings'}>
          ⚙
        </button>
      </div>

      <ProjectPicker projects={p.projects} project={p.project} onOpenProject={p.onOpenProject} />

      <div className="newtab">
        <button onClick={p.onNewTab} disabled={!p.project || nothingSetUp} title={nothingSetUp ? 'No coding CLI is set up yet' : p.project ? 'Create a tab and describe a task' : 'Open a project first'}>
          <span>+ New tab</span>
          <kbd>Alt N</kbd>
        </button>
      </div>

      <TabList tabs={p.tabs} selectedId={p.selectedId} onSelect={p.onSelect} onCloseTab={p.onCloseTab} onDeleteTab={p.onDeleteTab} now={p.now} emptyText={p.project ? (nothingSetUp ? 'Set up a coding CLI to start.' : 'No tabs yet. Create one and describe a task.') : 'Open a project to start.'} />

      <BudgetBars budgets={p.budgets} resetDay={p.resetDay} available={p.available} now={p.now} />

      <div className="foot">
        <span>{counts.working} working</span>
        <span>
          {counts.needsYou} need{counts.needsYou === 1 ? 's' : ''} you
        </span>
        <span className="spacer" />
        <button className="link" onClick={p.onHelp} title="Keyboard shortcuts (Alt+/)">
          Alt+/ shortcuts
        </button>
      </div>
    </aside>
  );
}
