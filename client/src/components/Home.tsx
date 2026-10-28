import { basename } from '../lib/format';
import { useProjectPicker } from '../hooks/useProjectPicker';
import { noneSetUp, type Availability } from '../lib/routing';
import type { CliHealth, ProjectInfo, Provider } from '../types';
import { FolderBrowser } from './FolderBrowser';
import { Health } from './Health';

interface Props {
  projects: ProjectInfo[];
  project: ProjectInfo | null;
  openTabs: number;
  available: Availability;
  /** Plain-language notes on the routing in force (which CLIs are set up, how tiers are filled). */
  notes: string[];
  health: Record<Provider, CliHealth> | null;
  checking?: boolean;
  onRefresh?: () => void;
  onOpenProject: (path: string) => Promise<void>;
  onNewTab: () => void;
  onSettings: () => void;
}

export function Steps() {
  return (
    <div className="steps" aria-label="How a tab works">
      <div className="step">
        <b>1 · Evaluate</b>
        <span>Council seats analyze task complexity (1–5) and self-score their confidence.</span>
      </div>
      <div className="step">
        <b>2 · Route</b>
        <span>The lowest-cost confident seat (≥80%) executes the task, with fallback to deep reasoning models.</span>
      </div>
      <div className="step">
        <b>3 · Review</b>
        <span>The changes land in your checkout, uncommitted. Look them over in your editor or git.</span>
      </div>
    </div>
  );
}

function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="notes" aria-label="Routing notes">
      {notes.map((n) => (
        <div key={n} className="note-row">
          {n}
        </div>
      ))}
    </div>
  );
}

/** What the main pane shows with no tab selected: set up a CLI, get started, or jump back in. */
export function Home({ projects, project, openTabs, available, notes, health, checking, onRefresh, onOpenProject, onNewTab, onSettings }: Props) {
  const { path, setPath, search, setSearch, opening, browsing, setBrowsing, currentCwd, open, recent, discovered } =
    useProjectPicker({ projects, onOpenProject });

  if (noneSetUp(available)) {
    return (
      <main className="home">
        <div className="home-inner home-setup">
          <h2>Connect your first AI provider</h2>
          <p className="lead">
            Install a coding CLI and sign in through its terminal prompt. Council will use that CLI to evaluate tasks and run your chosen worker.
          </p>
          <Health health={health} checking={checking} onRefresh={onRefresh} />
          <p className="muted sm">
            You can manage providers anytime in{' '}
            <button className="link sm" onClick={onSettings}>
              Settings › AI Models &amp; Workers
            </button>
            .
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="home">
      <div className={project ? 'home-inner' : 'home-inner home-setup'}>
        {project ? (
          <>
            <h2>{openTabs > 0 ? 'Pick a tab, or start another' : 'Start the first task'}</h2>
            <p className="lead">
              {openTabs > 0
                ? `${basename(project.root)} has ${openTabs} open tab${openTabs === 1 ? '' : 's'} in the sidebar. Each one is a task with its own worker, editing this checkout in place.`
                : `Create a tab, describe the task, and the council routes it to the cheapest agent that can handle it. Workers follow the project's CLAUDE.md, AGENTS.md or GEMINI.md.`}
            </p>
            <div className="row">
              <button className="primary" onClick={onNewTab}>
                + New tab
              </button>
              <span className="muted sm">
                or press <kbd>Alt</kbd> <kbd>N</kbd>
              </span>
            </div>
            <Steps />
            <Notes notes={notes} />
          </>
        ) : (
          <>
            <h2>Your local AI workspace</h2>
            <p className="lead">
              Open a git checkout. Each tab puts one agent to work in it, following the project's CLAUDE.md, AGENTS.md or GEMINI.md; nothing is committed, so you review the changes as you would your own.
            </p>

            <Health health={health} checking={checking} onRefresh={onRefresh} />

            <div className="card">
              <h3>Open a project</h3>
              {/* Current workspace 1-click button */}
              {currentCwd && (
                <div style={{ marginBottom: '12px' }}>
                  <button
                    type="button"
                    className="primary"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
                    onClick={() => void open(currentCwd)}
                    disabled={opening}
                  >
                    <span>🚀</span>
                    <span>Open Current Workspace: <strong>{basename(currentCwd)}</strong></span>
                  </button>
                  <span className="muted xs mono" style={{ display: 'block', marginTop: '4px' }}>
                    {currentCwd}
                  </span>
                </div>
              )}

              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void open(path);
                }}
              >
                <input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="C:\path\to\checkout"
                  aria-label="Project path"
                  style={{ flex: 1 }}
                />
                <button type="submit" className="primary" disabled={opening || !path.trim()}>
                  Open
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => setBrowsing(true)}
                  disabled={opening}
                  title="Browse folders and Git repositories"
                >
                  📁 Browse Folders
                </button>
              </form>

              {(projects.length > 3 || discovered.length > 0 || search) && (
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search recent or discovered projects…"
                  style={{ fontSize: 'var(--fs-xs)', marginTop: '8px' }}
                />
              )}

              {recent.length > 0 && (
                <div className="recent" aria-label="Recent projects">
                  <span className="section-label">Recent Projects</span>
                  {recent.map((pr) => (
                    <button key={pr.projectId} onClick={() => void open(pr.root)} disabled={opening}>
                      <span className="rrow">
                        <span>{basename(pr.root)}</span>
                        <span className="muted xs">{pr.defaultBranch ?? ''}</span>
                      </span>
                      <span className="path">{pr.root}</span>
                    </button>
                  ))}
                </div>
              )}

              {discovered.length > 0 && (
                <div className="recent" aria-label="Discovered projects" style={{ marginTop: '12px' }}>
                  <span className="section-label">Discovered Repositories</span>
                  {discovered.map((pr) => (
                    <button key={pr.root} onClick={() => void open(pr.root)} disabled={opening}>
                      <span className="rrow">
                        <span>{pr.name}</span>
                        {pr.defaultBranch && <span className="muted xs">{pr.defaultBranch}</span>}
                      </span>
                      <span className="path">{pr.root}</span>
                    </button>
                  ))}
                </div>
              )}

              {search && recent.length === 0 && discovered.length === 0 && (
                <div className="muted sm" style={{ padding: '16px 0', textAlign: 'center' }}>
                  No matching repositories found.
                </div>
              )}
            </div>

            <Steps />
            <Notes notes={notes} />
          </>
        )}
      </div>

      {browsing && (
        <FolderBrowser
          initialDir={currentCwd || project?.root}
          onSelect={(selected) => void open(selected)}
          onClose={() => setBrowsing(false)}
        />
      )}
    </main>
  );
}
